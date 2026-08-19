#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Бот відстеження судових справ за ПІБ.

Джерело даних — офіційні сторінки судів «Список справ, призначених до розгляду»
(court.gov.ua). Для кожного суду виконується той самий сценарій, що й у браузері:
GET сторінки CSZ (набрати cookie сесії) → POST /new.php (JSON зі списком засідань).
Відповідь містить: date (дата/час), judge (склад суду), number (єдиний унікальний
номер справи), involved (сторони), description (суть), forma, add_address, courtroom.

Бот фільтрує засідання за списком ПІБ (клієнти або сам адвокат як захисник) і
надсилає СПОВІЩЕННЯ ПРИВАТНО адвокату (адвокатська таємниця — НЕ в канал).
Уже надіслані засідання запам'ятовуються у .court-bot/state.json, тож повторно
не дублюються; нова дата/суддя у тій самій справі = нове сповіщення.

Конфігурація (змінні середовища):
  TELEGRAM_BOT_TOKEN   — токен бота (обов'язково).
  COURT_ALERT_CHAT     — Telegram id адвоката (типово = TELEGRAM_REVIEW_CHAT).
  TELEGRAM_REVIEW_CHAT — запасне джерело id адвоката.
  COURT_WATCH          — JSON: {"names":[...], "courts":[{"name":..,"url":..}, ...]}
                         url — сторінка «...gromadyanam/csz» відповідного суду.
  COURT_WATCH_NAMES    — (як запасний варіант) ПІБ через новий рядок або кому.
  COURT_WATCH_URLS     — (як запасний варіант) по рядку "Назва|URL" або лише URL.
  COURT_DRY_RUN=1      — не надсилати й не зберігати стан (лише лог).
  COURT_MAX_ALERTS     — запобіжник від флуду за один запуск (типово 25).
"""
import hashlib
import http.cookiejar
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

STATE_PATH = ".court-bot/state.json"
REGISTRY_PATH = os.path.join(os.path.dirname(__file__), "court_registry.json")

# Єдиний домен, що віддає дані БУДЬ-ЯКОГО суду за кодом sudNNNN (перевірено:
# GET /sudNNNN/gromadyanam/csz → сесія → POST /new.php повертає саме цей суд).
MAIN_HOST = "https://court.gov.ua"


def csz_url_for(court):
    """CSZ-URL суду: за явним url або за 4-значним кодом через court.gov.ua."""
    url = (court.get("url") or "").strip()
    if url:
        return url
    code = str(court.get("code") or "").strip()
    if code:
        return f"{MAIN_HOST}/sud{code}/gromadyanam/csz"
    return ""

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
CHAT = (os.environ.get("COURT_ALERT_CHAT", "").strip()
        or os.environ.get("TELEGRAM_REVIEW_CHAT", "").strip())
DRY_RUN = os.environ.get("COURT_DRY_RUN", "").strip() in ("1", "true", "True")
MAX_ALERTS = int(os.environ.get("COURT_MAX_ALERTS", "25") or "25")
# Пауза між запитами до court.gov.ua (щоб не навантажувати сервер і не блокуватись)
REQUEST_PAUSE = float(os.environ.get("COURT_REQUEST_PAUSE", "1.0") or "1.0")

# Cloudflare Worker — приватне сховище списку ПІБ (керується з Telegram-меню).
WORKER_URL = (os.environ.get("COURT_WORKER_URL", "").strip()
              or os.environ.get("BOT_WORKER_URL", "").strip())
WORKER_SECRET = (os.environ.get("COURT_WORKER_SECRET", "").strip()
                 or os.environ.get("BOT_WORKER_SECRET", "").strip())


def fetch_worker_names():
    """ПІБ зі списку у Worker (KV). Керується з Telegram-меню бота."""
    if not (WORKER_URL and WORKER_SECRET):
        return []
    try:
        req = urllib.request.Request(
            WORKER_URL.rstrip("/") + "/court_names",
            headers={"X-Auth-Token": WORKER_SECRET, "User-Agent": UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read().decode("utf-8"))
        return [n.strip() for n in data.get("names", []) if n.strip()]
    except Exception as e:
        print("Список ПІБ із Worker недоступний:", str(e)[:60])
        return []


# ─────────────────────────── конфігурація ────────────────────────────
def load_registry():
    """Вбудований перелік судів (код + назва) — сканується, коли у COURT_WATCH
    не задано власного списку `courts` (модель «перелік, що зростає»)."""
    try:
        with open(REGISTRY_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        courts = data.get("courts", data) if isinstance(data, dict) else data
        out = []
        for c in courts:
            code = str(c.get("code") or "").strip()
            if code:
                out.append({"name": (c.get("name") or f"суд {code}").strip(),
                            "code": code,
                            "auto_url": (c.get("auto_url") or "").strip()})
        return out
    except Exception as e:
        print("Реєстр судів недоступний:", e)
        return []


def load_config():
    """Повертає (names[list], courts[list]). Суд — це {name, code|url, auto_url}.
    Якщо у COURT_WATCH немає `courts` — беремо вбудований реєстр (усі його суди)."""
    raw = os.environ.get("COURT_WATCH", "").strip()
    if raw:
        try:
            cfg = json.loads(raw)
            names = [n.strip() for n in cfg.get("names", []) if n.strip()]
            courts = []
            for c in cfg.get("courts", []):
                entry = {"name": (c.get("name") or "").strip(),
                         "url": (c.get("url") or "").strip(),
                         "code": str(c.get("code") or "").strip(),
                         "auto_url": (c.get("auto_url") or "").strip()}
                if entry["url"] or entry["code"]:
                    entry["name"] = entry["name"] or entry["url"] or f"суд {entry['code']}"
                    courts.append(entry)
            # Без явного списку судів — скануємо вбудований реєстр (якщо не вимкнено)
            if not courts and cfg.get("use_registry", True):
                courts = load_registry()
            return names, courts
        except Exception as e:
            print("COURT_WATCH — некоректний JSON:", e)
    # Запасний варіант — прості змінні
    names = []
    for chunk in re.split(r"[\n,]", os.environ.get("COURT_WATCH_NAMES", "")):
        if chunk.strip():
            names.append(chunk.strip())
    courts = []
    for line in os.environ.get("COURT_WATCH_URLS", "").splitlines():
        line = line.strip()
        if not line:
            continue
        if "|" in line:
            nm, _, url = line.partition("|")
            courts.append({"name": nm.strip(), "url": url.strip()})
        else:
            courts.append({"name": line, "url": line})
    if not courts and names:  # лише ПІБ у простих змінних → беремо реєстр
        courts = load_registry()
    return names, courts


# ─────────────────────── завантаження списку справ ────────────────────
def fetch_court(csz_url):
    """Сценарій як у браузері: GET CSZ (cookie) → POST /new.php. Повертає list."""
    parts = urllib.parse.urlsplit(csz_url)
    origin = f"{parts.scheme}://{parts.netloc}"
    new_php = origin + "/new.php"
    m = re.search(r"/sud(\d{4})", csz_url)
    crt = m.group(1) if m else ""
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    # Крок 1 — сторінка CSZ, щоб отримати cookie сесії
    r1 = urllib.request.Request(csz_url, headers={
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "uk,en;q=0.8",
    })
    with opener.open(r1, timeout=40) as resp:
        resp.read()
    # Крок 2 — POST /new.php з тим самим cookie й Referer
    body = urllib.parse.urlencode({"q_court_id": crt}).encode()
    r2 = urllib.request.Request(new_php, data=body, headers={
        "User-Agent": UA,
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "uk,en;q=0.8",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "Origin": origin,
        "Referer": csz_url,
    })
    with opener.open(r2, timeout=40) as resp:
        raw = resp.read()
        ctype = resp.headers.get("Content-Type", "")
        enc = "utf-8" if "utf-8" in ctype.lower() else "cp1251"
        text = raw.decode(enc, "replace").strip()
    if text[:1] not in ("[", "{"):
        raise RuntimeError(f"неочікувана відповідь: {text[:80]!r}")
    data = json.loads(text)
    return data if isinstance(data, list) else data.get("data", [])


def fetch_court_retry(csz_url, tries=4):
    delay = 2
    last = None
    for _ in range(tries):
        try:
            return fetch_court(csz_url)
        except Exception as e:  # мережеві збої / тимчасове блокування
            last = e
            time.sleep(delay)
            delay = min(delay * 2, 16)
    raise last


# ───────────── автопризначення справ («Призначено склад суду») ─────────
_TAG = re.compile(r"<[^>]+>")
_AUTO_COLS = ("number", "reg_date", "judge", "involved", "description",
              "panel_date")  # порядок стовпців таблиці #bank


def _strip(cell):
    return re.sub(r"\s+", " ", _TAG.sub(" ", str(cell or ""))).strip()


def _date_range(days_back):
    """Повертає рядок 'DD.MM.YYYY~DD.MM.YYYY' від (сьогодні-days_back) до завтра."""
    now = time.time()
    start = time.strftime("%d.%m.%Y", time.localtime(now - days_back * 86400))
    end = time.strftime("%d.%m.%Y", time.localtime(now + 86400))
    return f"{start}~{end}"


# Скільки днів назад дивитись автопризначення (стан визначення складу суду).
AUTO_DAYS = int(os.environ.get("COURT_AUTO_DAYS", "120") or "120")


def _dt_params(start, length, sid, cspec, date, searchable=(0, 0, 1, 1, 0, 0)):
    n = len(searchable)
    p = [("sEcho", "1"), ("iColumns", str(n)), ("sColumns", ""),
         ("iDisplayStart", str(start)), ("iDisplayLength", str(length))]
    for i in range(n):
        p.append((f"mDataProp_{i}", str(i)))
    p += [("sSearch", ""), ("bRegex", "false")]
    for i in range(n):
        p.append((f"sSearch_{i}", ""))
        p.append((f"bRegex_{i}", "false"))
        p.append((f"bSearchable_{i}", "true" if searchable[i] else "false"))
    p.append(("iSortingCols", "0"))
    for i in range(n):
        p.append((f"bSortable_{i}", "false"))
    # додаткові параметри з fnServerParams b(a)
    p += [("q_ver", "arbitr"), ("date", date), ("sid", sid), ("cspec", cspec)]
    return p


def fetch_auto(list_auto_url, days_back=None):
    """«Список автопризначенних справ» → POST /post_test2.php (DataTables,
    server-side). Повертає list словників з ключами _AUTO_COLS."""
    date = _date_range(days_back if days_back is not None else AUTO_DAYS)
    parts = urllib.parse.urlsplit(list_auto_url)
    origin = f"{parts.scheme}://{parts.netloc}"
    endpoint = origin + "/post_test2.php"
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    # Крок 1 — сторінка (cookie + значення sid/cspec)
    r1 = urllib.request.Request(list_auto_url, headers={
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "uk,en;q=0.8",
    })
    with opener.open(r1, timeout=40) as resp:
        html = resp.read().decode("cp1251", "replace")
    sid = ""
    m = re.search(r'id=["\']ust["\'][^>]*>(.*?)<', html, re.S)
    if m:
        sid = _strip(m.group(1))
    cspec = ""
    m = re.search(r'id=["\']cspec["\'][^>]*>(.*?)<', html, re.S)
    if m:
        cspec = _strip(m.group(1))

    def one(start, length):
        body = urllib.parse.urlencode(_dt_params(start, length, sid, cspec, date)).encode()
        r2 = urllib.request.Request(endpoint, data=body, headers={
            "User-Agent": UA,
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Accept-Language": "uk,en;q=0.8",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
            "Origin": origin,
            "Referer": list_auto_url,
        })
        with opener.open(r2, timeout=40) as resp:
            raw = resp.read()
            ct = resp.headers.get("Content-Type", "")
            enc = "utf-8" if "utf-8" in ct.lower() else "cp1251"
            txt = raw.decode(enc, "replace").strip()
        if txt[:1] != "{":
            raise RuntimeError(f"неочікувана відповідь: {txt[:80]!r}")
        return json.loads(txt)

    out = []
    first = one(0, 1000)
    total = int(first.get("iTotalDisplayRecords") or first.get("iTotalRecords") or 0)
    rows = first.get("aaData", []) or []
    out.extend(rows)
    # За потреби добираємо решту сторінок (запобіжник — до 30 сторінок)
    page = 0
    while len(out) < total and rows and page < 30:
        page += 1
        nxt = one(len(out), 1000)
        rows = nxt.get("aaData", []) or []
        if not rows:
            break
        out.extend(rows)
    result = []
    for row in out:
        rec = {_AUTO_COLS[i]: _strip(row[i]) for i in range(min(len(row), len(_AUTO_COLS)))}
        result.append(rec)
    return result


def fetch_auto_retry(list_auto_url, tries=4):
    delay = 2
    last = None
    for _ in range(tries):
        try:
            return fetch_auto(list_auto_url)
        except Exception as e:
            last = e
            time.sleep(delay)
            delay = min(delay * 2, 16)
    raise last


# ───────────────────────────── збіг ПІБ ──────────────────────────────
def _norm(s):
    return re.sub(r"\s+", " ", (s or "")).strip().casefold()


def name_matches(involved, names):
    """Повертає ПІБ зі списку, що зустрічається в «сторонах», інакше None."""
    hay = _norm(involved)
    for nm in names:
        n = _norm(nm)
        if not n:
            continue
        if n in hay:
            return nm
        # Гнучкий збіг: усі слова ПІБ присутні (порядок/по-батькові не критичні)
        toks = [t for t in n.split(" ") if len(t) > 1]
        if len(toks) >= 2 and all(t in hay for t in toks):
            return nm
    return None


# ─────────────────────────────── стан ────────────────────────────────
def load_state():
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"seen": {}, "last_run": ""}


def save_state(st):
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False, indent=1)


def rec_key(court_url, rec):
    base = "|".join([
        court_url,
        (rec.get("number") or "").strip(),
        (rec.get("date") or "").strip(),
        (rec.get("judge") or "").strip(),
    ])
    return hashlib.sha1(base.encode("utf-8")).hexdigest()[:16]


def auto_key(court_url, rec):
    base = "auto|" + "|".join([
        court_url,
        (rec.get("number") or "").strip(),
        (rec.get("panel_date") or "").strip(),
        (rec.get("judge") or "").strip(),
    ])
    return hashlib.sha1(base.encode("utf-8")).hexdigest()[:16]


# ─────────────────────────────── Telegram ────────────────────────────
def tg_send(text):
    url = f"https://api.telegram.org/bot{TOKEN}/sendMessage"
    payload = json.dumps({
        "chat_id": CHAT,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }).encode("utf-8")
    req = urllib.request.Request(url, data=payload,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def esc(s):
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def build_message(court_name, rec, matched):
    lines = [
        "⚖️ <b>Судова справа — засідання призначено</b>",
        "",
        f"📁 Справа: <b>{esc(rec.get('number'))}</b>",
    ]
    if rec.get("date"):
        lines.append(f"📅 Дата/час: <b>{esc(rec['date'])}</b>")
    if rec.get("judge"):
        lines.append(f"👨‍⚖️ Суддя: {esc(rec['judge'])}")
    lines.append(f"🏛 Суд: {esc(court_name)}")
    if rec.get("involved"):
        lines.append(f"👥 Сторони: {esc(rec['involved'])}")
    if rec.get("description"):
        lines.append(f"📋 Суть: {esc(rec['description'])}")
    if rec.get("forma"):
        lines.append(f"⚖️ Форма: {esc(rec['forma'])}")
    if rec.get("courtroom"):
        lines.append(f"🚪 Зал/каб.: {esc(rec['courtroom'])}")
    if rec.get("add_address"):
        lines.append(f"📍 Адреса: {esc(rec['add_address'])}")
    lines.append("")
    lines.append(f"🔎 Знайдено за: <i>{esc(matched)}</i>")
    return "\n".join(lines)


def build_status_message(court_name, rec, matched):
    """Повідомлення про автоматичний розподіл справи («Призначено склад суду»)."""
    lines = [
        "🧩 <b>Судова справа — призначено склад суду</b>",
        "",
        f"📁 Справа: <b>{esc(rec.get('number'))}</b>",
    ]
    if rec.get("judge"):
        lines.append(f"👨‍⚖️ Склад суду: {esc(rec['judge'])}")
    if rec.get("panel_date"):
        lines.append(f"📅 Дата визначення складу: <b>{esc(rec['panel_date'])}</b>")
    if rec.get("reg_date"):
        lines.append(f"🗓 Дата реєстрації: {esc(rec['reg_date'])}")
    lines.append(f"🏛 Суд: {esc(court_name)}")
    if rec.get("involved"):
        lines.append(f"👥 Сторони: {esc(rec['involved'])}")
    if rec.get("description"):
        lines.append(f"📋 Суть: {esc(rec['description'])}")
    lines.append("")
    lines.append(f"🔎 Знайдено за: <i>{esc(matched)}</i>")
    return "\n".join(lines)


# ─────────────────────────────── main ────────────────────────────────
def main():
    if not TOKEN and not DRY_RUN:
        print("Немає TELEGRAM_BOT_TOKEN"); sys.exit(1)
    names, courts = load_config()
    # Додаємо ПІБ зі списку в Worker (керується з Telegram-меню бота)
    wnames = fetch_worker_names()
    if wnames:
        low = {n.lower() for n in names}
        added = 0
        for n in wnames:
            if n.lower() not in low:
                names.append(n)
                low.add(n.lower())
                added += 1
        print(f"Зі списку Telegram-меню: {len(wnames)} (нових: {added})")
    if not names:
        print("Порожній список ПІБ (додайте через меню бота: /menu) — нічого відстежувати.")
        return
    if not courts:  # список ПІБ є (напр. лише з меню) — беремо вбудований реєстр судів
        courts = load_registry()
    if not courts:
        print("Немає жодного суду (реєстр порожній) — нічого відстежувати.")
        return
    print(f"ПІБ під наглядом: {len(names)} · судів: {len(courts)} · "
          f"{'DRY-RUN' if DRY_RUN else 'бойовий'}")

    st = load_state()
    seen = st.setdefault("seen", {})
    sent = 0
    total_new = 0
    first_time = not seen  # перший запуск: фіксуємо поточні засідання

    for court in courts:
        url = csz_url_for(court)
        if not url:
            continue
        try:
            records = fetch_court_retry(url)
        except Exception as e:
            print(f"[{court['name']}] помилка завантаження: {e}")
            continue
        time.sleep(REQUEST_PAUSE)  # ввічлива пауза між судами
        # ВАЖЛИВО: логи публічного репозиторію відкриті, тому сюди НЕ потрапляють
        # ПІБ, номери справ чи текст «сторін» — лише знеособлені лічильники.
        matches = []
        for rec in records:
            who = name_matches(rec.get("involved", ""), names)
            if who:
                matches.append((rec, who))
        new_here = sum(1 for rec, _ in matches if rec_key(url, rec) not in seen)
        total_new += new_here
        print(f"[{court['name']}] засідань: {len(records)} · "
              f"збігів: {len(matches)} · нових: {new_here}")

        for rec, who in matches:
            key = rec_key(url, rec)
            if key in seen:
                continue
            if DRY_RUN:
                continue  # у dry-run нічого не надсилаємо й не зберігаємо
            if sent >= MAX_ALERTS:
                break
            try:
                res = tg_send(build_message(court["name"], rec, who))
                if res.get("ok"):
                    seen[key] = 1
                    sent += 1
                    time.sleep(0.5)
                else:
                    print("  Telegram відмовив (див. приватний чат).")
            except Exception:
                print("  Помилка надсилання сповіщення.")
        if sent >= MAX_ALERTS:
            print("  Досягнуто ліміту сповіщень за запуск — решта наступного разу.")
            break

        # ── (Експериментально) автопризначення «Призначено склад суду» ──
        # Джерело — /post_test2.php суду. Наразі багато судів віддають
        # server-side лише інтерактивному браузеру (повертають 'error'), тож
        # це БЕЗПЕЧНО пропускається й НЕ впливає на відстеження засідань.
        auto_url = court.get("auto_url")
        if auto_url:
            try:
                arecs = fetch_auto_retry(auto_url)
            except Exception as e:
                print(f"[{court['name']}] автопризначення недоступні "
                      f"(пропущено): {str(e)[:60]}")
                arecs = []
            amatches = [(r, w) for r in arecs
                        if (w := name_matches(r.get("involved", ""), names))]
            anew = sum(1 for r, _ in amatches if auto_key(auto_url, r) not in seen)
            total_new += anew
            if arecs:
                print(f"[{court['name']}] автопризначень: {len(arecs)} · "
                      f"збігів: {len(amatches)} · нових: {anew}")
            for rec, who in amatches:
                key = auto_key(auto_url, rec)
                if key in seen or DRY_RUN or sent >= MAX_ALERTS:
                    continue
                try:
                    res = tg_send(build_status_message(court["name"], rec, who))
                    if res.get("ok"):
                        seen[key] = 1
                        sent += 1
                        time.sleep(0.5)
                except Exception:
                    print("  Помилка надсилання сповіщення (статус).")

    st["last_run"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    if not DRY_RUN:
        save_state(st)
    note = " (перший запуск — зафіксовано поточні засідання)" if first_time else ""
    if DRY_RUN:
        print(f"DRY-RUN: нових збігів усього: {total_new} (нічого не надіслано){note}")
    else:
        print(f"Надіслано сповіщень: {sent}{note}")


if __name__ == "__main__":
    main()
