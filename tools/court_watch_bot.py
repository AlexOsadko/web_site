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
# За скільки днів до засідання нагадувати (типово 3, 2, 1; 0 = у день засідання)
REMIND_DAYS = sorted({int(x) for x in re.findall(r"\d+",
                     os.environ.get("COURT_REMIND_DAYS", "3,2,1"))}, reverse=True)
# Шардинг: скільки судів сканувати за один прогін (0 = усі). Решта — наступними
# прогонами (курсор зберігається у стані). Повне покриття за N/шард прогонів.
SHARD_SIZE = int(os.environ.get("COURT_SHARD_SIZE", "0") or "0")
# Швидка відмова недоступних судів (щоб шард не «залипав»).
FETCH_TIMEOUT = int(os.environ.get("COURT_FETCH_TIMEOUT", "12") or "12")
FETCH_TRIES = int(os.environ.get("COURT_FETCH_TRIES", "2") or "2")


def _day_word(n):
    n = abs(int(n))
    if n == 0:
        return "сьогодні"
    if n % 10 == 1 and n % 100 != 11:
        return f"за {n} день"
    if n % 10 in (2, 3, 4) and n % 100 not in (12, 13, 14):
        return f"за {n} дні"
    return f"за {n} днів"

# Cloudflare Worker — приватне сховище списку ПІБ (керується з Telegram-меню).
WORKER_URL = (os.environ.get("COURT_WORKER_URL", "").strip()
              or os.environ.get("BOT_WORKER_URL", "").strip())
WORKER_SECRET = (os.environ.get("COURT_WORKER_SECRET", "").strip()
                 or os.environ.get("BOT_WORKER_SECRET", "").strip())


# Окремий перегляд справ самого адвоката (де він захисник/представник).
ADVOCATE_NAME = os.environ.get("COURT_ADVOCATE", "Осадько Олександр Олексійович").strip()


def post_worker_report(items, kind="advocate", scanned=None):
    """Зберегти у Worker (KV) звіт (advocate|clients) для перегляду з меню.

    scanned — список назв судів, просканованих цього прогону (шардинг): Worker
    оновить лише їхні справи, решту (з інших шардів) збереже.
    """
    if not (WORKER_URL and WORKER_SECRET):
        return
    body = {
        "kind": kind,
        "updated": time.strftime("%d.%m.%Y %H:%M", time.gmtime(time.time() + 3 * 3600)),
        "count": len(items),
        "items": items[:300],
    }
    if scanned:
        body["scanned"] = scanned
    payload = json.dumps(body).encode("utf-8")
    try:
        req = urllib.request.Request(
            WORKER_URL.rstrip("/") + "/court_report", data=payload,
            headers={"X-Auth-Token": WORKER_SECRET, "Content-Type": "application/json",
                     "User-Agent": UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            r.read()
    except Exception as e:
        print(f"Не вдалося зберегти звіт ({kind}):", str(e)[:60])


def build_report(hits):
    """Лише майбутні засідання, за датою, без дублів."""
    today0 = time.mktime(time.strptime(time.strftime("%d.%m.%Y"), "%d.%m.%Y"))
    uniq, seen_keys = [], set()
    for it in hits:
        ts = _hearing_ts(it.get("date"))
        if ts is not None and ts < today0:
            continue
        k = (it.get("matched", ""), it.get("number", ""), it.get("date", ""), it.get("court", ""))
        if k in seen_keys:
            continue
        seen_keys.add(k)
        it["_ts"] = ts if ts is not None else 9e18
        uniq.append(it)
    uniq.sort(key=lambda x: x["_ts"])
    for it in uniq:
        it.pop("_ts", None)
    return uniq


def _hearing_ts(s):
    m = re.match(r"(\d{2})\.(\d{2})\.(\d{4})", (s or "").strip())
    if not m:
        return None
    try:
        return time.mktime(time.strptime(m.group(0), "%d.%m.%Y"))
    except Exception:
        return None


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


def fetch_worker_blocked():
    """Справи, видалені адвокатом у боті (щоб не нагадувати по них).

    Повертає множину ключів «номер|дата|суд» (як itemKey у Worker).
    """
    if not (WORKER_URL and WORKER_SECRET):
        return set()
    try:
        req = urllib.request.Request(
            WORKER_URL.rstrip("/") + "/court_blocked",
            headers={"X-Auth-Token": WORKER_SECRET, "User-Agent": UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read().decode("utf-8"))
        keys = set()
        for kind in ("clients", "advocate"):
            for k in data.get(kind, []) or []:
                if isinstance(k, str):
                    keys.add(k)
        return keys
    except Exception as e:
        print("Список видалених справ із Worker недоступний:", str(e)[:60])
        return set()


def _item_key(rec):
    return "{}|{}|{}".format(
        rec.get("number") or "", rec.get("date") or "", rec.get("court") or "")


def fetch_worker_cases(kind="clients"):
    """Накопичені справи з Worker (усі шарди) — для нагадувань під час шардингу."""
    if not (WORKER_URL and WORKER_SECRET):
        return []
    try:
        req = urllib.request.Request(
            WORKER_URL.rstrip("/") + "/court_cases?kind=" + kind,
            headers={"X-Auth-Token": WORKER_SECRET, "User-Agent": UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            return (json.loads(r.read().decode("utf-8")).get("items") or [])
    except Exception as e:
        print("Накопичені справи з Worker недоступні:", str(e)[:60])
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
    with opener.open(r1, timeout=FETCH_TIMEOUT) as resp:
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
    with opener.open(r2, timeout=FETCH_TIMEOUT) as resp:
        raw = resp.read()
        ctype = resp.headers.get("Content-Type", "")
        enc = "utf-8" if "utf-8" in ctype.lower() else "cp1251"
        text = raw.decode(enc, "replace").strip()
    if text[:1] not in ("[", "{"):
        raise RuntimeError(f"неочікувана відповідь: {text[:80]!r}")
    data = json.loads(text)
    return data if isinstance(data, list) else data.get("data", [])


def fetch_court_retry(csz_url, tries=None):
    # Швидка відмова: багато судів релоковані/недоступні (ТОТ) — не можна на
    # кожному «залипати» ретраями, бо шард стає нескінченним. Мало спроб,
    # короткий таймаут; пропущений суд просканується наступного кола.
    tries = tries if tries is not None else FETCH_TRIES
    delay = 1
    last = None
    for _ in range(tries):
        try:
            return fetch_court(csz_url)
        except Exception as e:  # мережеві збої / тимчасове блокування
            last = e
            time.sleep(delay)
            delay = min(delay * 2, 4)
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
    s = (s or "")
    # уніфікуємо різні апострофи, щоб «Солом'янський»/«Солом’янський» збігались
    s = s.replace("’", "'").replace("ʼ", "'").replace("`", "'")
    return re.sub(r"\s+", " ", s).strip().casefold()


def name_matches(involved, names):
    """Повертає ПІБ зі списку, що зустрічається в «сторонах» СУЦІЛЬНИМ рядком і
    як окремі слова (щоб «Коваль Кіра Вікторівна» не збігалось із «Ковальова…»
    чи зі словами від різних осіб). Інакше None."""
    hay = _norm(involved)
    for nm in names:
        n = _norm(nm)
        if len(n) < 4:
            continue
        start = 0
        while True:
            i = hay.find(n, start)
            if i < 0:
                break
            before = hay[i - 1] if i > 0 else ""
            after = hay[i + len(n)] if i + len(n) < len(hay) else ""
            # межі слова: перед/після ПІБ не має бути літери (напр., «ковальова»)
            if not before.isalpha() and not after.isalpha():
                return nm
            start = i + 1
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


def build_reminder(rec, offset):
    who = rec.get("matched") or (ADVOCATE_NAME if rec.get("_adv") else "")
    lines = [
        f"⏰ <b>Нагадування: засідання {esc(_day_word(offset))}</b>",
        "",
        f"📁 Справа: <b>{esc(rec.get('number'))}</b>",
        f"📅 Дата/час: <b>{esc(rec.get('date'))}</b>",
    ]
    if rec.get("judge"):
        lines.append(f"👨‍⚖️ Суддя: {esc(rec['judge'])}")
    if rec.get("forma"):
        lines.append(f"⚖️ Форма: {esc(rec['forma'])}")
    if rec.get("court"):
        lines.append(f"🏛 Суд: {esc(rec['court'])}")
    if rec.get("courtroom"):
        lines.append(f"🚪 Зал: {esc(rec['courtroom'])}")
    if rec.get("address"):
        lines.append(f"📍 Адреса: {esc(rec['address'])}")
    if rec.get("involved"):
        lines.append(f"👥 Сторони: {esc(rec['involved'])}")
    if rec.get("description"):
        lines.append(f"📋 Суть: {esc(rec['description'])}")
    if who:
        lines.append("")
        lines.append(f"🔎 {esc(who)}")
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
    advocate_hits = []     # окремий звіт «справи адвоката»
    client_hits = []       # окремий звіт «справи клієнтів»

    # Шардинг: цей прогін сканує лише частину судів (решта — наступними прогонами).
    scanned_names = None
    courts_to_scan = courts
    if SHARD_SIZE > 0 and len(courts) > SHARD_SIZE:
        cur = int(st.get("shard_cursor", 0)) % len(courts)
        end = cur + SHARD_SIZE
        courts_to_scan = courts[cur:end]
        if end > len(courts):                      # перенос через кінець списку
            courts_to_scan = courts_to_scan + courts[:end - len(courts)]
        st["shard_cursor"] = end % len(courts)
        scanned_names = [c["name"] for c in courts_to_scan]
        print(f"Шард: {len(courts_to_scan)} судів (позиція {cur}), "
              f"наступний курсор {st['shard_cursor']}; повне коло за "
              f"{-(-len(courts)//SHARD_SIZE)} прогонів")

    for court in courts_to_scan:
        url = csz_url_for(court)
        if not url:
            continue
        try:
            records = fetch_court_retry(url)
        except Exception as e:
            print(f"[{court['name']}] помилка завантаження: {e}")
            continue
        time.sleep(REQUEST_PAUSE)  # ввічлива пауза між судами

        # Окремо: справи, де фігурує сам адвокат (для перегляду з меню).
        # Дані йдуть у приватне сховище (Worker KV), не в логи, тож детально.
        if ADVOCATE_NAME:
            for rec in records:
                if name_matches(rec.get("involved", ""), [ADVOCATE_NAME]):
                    advocate_hits.append({
                        "court": court["name"],
                        "number": rec.get("number", ""),
                        "date": rec.get("date", ""),
                        "judge": rec.get("judge", ""),
                        "involved": rec.get("involved", ""),
                        "description": rec.get("description", ""),
                        "forma": rec.get("forma", ""),
                        "courtroom": rec.get("courtroom", ""),
                        "address": rec.get("add_address", ""),
                    })
        # ВАЖЛИВО: логи публічного репозиторію відкриті, тому сюди НЕ потрапляють
        # ПІБ, номери справ чи текст «сторін» — лише знеособлені лічильники.
        matches = []
        for rec in records:
            who = name_matches(rec.get("involved", ""), names)
            if who:
                matches.append((rec, who))
                client_hits.append({
                    "court": court["name"], "matched": who,
                    "number": rec.get("number", ""), "date": rec.get("date", ""),
                    "judge": rec.get("judge", ""), "involved": rec.get("involved", ""),
                    "description": rec.get("description", ""), "forma": rec.get("forma", ""),
                    "courtroom": rec.get("courtroom", ""), "address": rec.get("add_address", ""),
                })
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

    # Звіти «справи адвоката» і «справи клієнтів» (майбутні, за датою, без дублів).
    # При шардингу Worker зливає лише справи просканованих судів (scanned_names).
    adv = []
    if ADVOCATE_NAME:
        adv = build_report(advocate_hits)
        print(f"Справи адвоката (цей шард): {len(adv)}")
        if not DRY_RUN:
            post_worker_report(adv, "advocate", scanned=scanned_names)
    cli = build_report(client_hits)
    print(f"Справи клієнтів (цей шард): {len(cli)}")
    if not DRY_RUN:
        post_worker_report(cli, "clients", scanned=scanned_names)

    # ── Нагадування за 3-2-1 день до засідання ──
    if REMIND_DAYS:
        today0 = time.mktime(time.strptime(time.strftime("%d.%m.%Y"), "%d.%m.%Y"))
        # Справи, які адвокат прибрав у боті (🗑 у «Нагадуваннях»/«Прихованих») —
        # по них нагадування більше не надсилаємо.
        blocked = fetch_worker_blocked()
        # При шардингу цей прогін бачив лише частину судів — тож для нагадувань
        # беремо ПОВНИЙ накопичений перелік справ із Worker (усі шарди).
        if scanned_names and not DRY_RUN:
            rem_cli = fetch_worker_cases("clients")
            rem_adv = fetch_worker_cases("advocate")
        else:
            rem_cli, rem_adv = cli, adv
        for a in rem_adv:
            a["_adv"] = True
        uniq = {}
        for rec in rem_cli + rem_adv:
            uniq.setdefault((rec.get("number"), rec.get("date")), rec)
        reminded = 0
        for rec in uniq.values():
            if _item_key(rec) in blocked:
                continue
            ts = _hearing_ts(rec.get("date"))
            if ts is None:
                continue
            offset = int(round((ts - today0) / 86400))
            if offset not in REMIND_DAYS:
                continue
            key = hashlib.sha1(
                f"rmd|{rec.get('number')}|{rec.get('date')}|{offset}".encode()
            ).hexdigest()[:16]
            if key in seen:
                continue
            if DRY_RUN or sent >= MAX_ALERTS:
                continue
            try:
                res = tg_send(build_reminder(rec, offset))
                if res.get("ok"):
                    seen[key] = 1
                    sent += 1
                    reminded += 1
                    time.sleep(0.5)
            except Exception:
                print("  Помилка надсилання нагадування.")
        print(f"Нагадувань надіслано: {reminded}")

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
