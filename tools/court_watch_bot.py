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
import html as _html
import http.cookiejar
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

try:
    # Додавання засідань у Google Calendar. Модуль лежить поруч; вмикається сам,
    # лише коли задано секрети GOOGLE_CALENDAR_SA + GOOGLE_CALENDAR_ID. Якщо його
    # чи бібліотеки немає — бот працює як раніше (календар просто пропускається).
    import gcal
except Exception:
    gcal = None

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
# Пріоритетні суди — скануються в КОЖНОМУ прогоні, поза чергою шардів:
# усі суди м. Києва (26xx) і Київської області (10xx), плюс Київський
# апеляційний, господарські суди Києва/області й апеляційний господарський.
PRIORITY_PREFIXES = tuple(p.strip() for p in os.environ.get(
    "COURT_PRIORITY_PREFIXES", "10,26").split(",") if p.strip())
PRIORITY_CODES = {c.strip().zfill(4) for c in os.environ.get(
    "COURT_PRIORITY_CODES", "4824,5011,5012,5033").split(",") if c.strip()}
# Суд, що не відповів DEAD_AFTER прогонів поспіль (ТОТ, релокація), далі
# пропускаємо й перепробовуємо раз на DEAD_RETRY_DAYS — щоб він не з'їдав
# час кожного прогону. Пріоритетні суди не пропускаються ніколи.
DEAD_AFTER = int(os.environ.get("COURT_DEAD_AFTER", "3") or "3")
DEAD_RETRY_DAYS = float(os.environ.get("COURT_DEAD_RETRY_DAYS", "7") or "7")
# Ліміт часу на сканування (хв): після нього бот зупиняє обхід і штатно
# зберігає знайдене (GitHub обриває job через 6 год — тоді губилось усе).
TIME_BUDGET_MIN = float(os.environ.get("COURT_TIME_BUDGET_MIN", "0") or "0")
# Які засідання додавати в Google Calendar БЕЗ кнопки підтвердження:
#   own     — лише власні справи адвоката (як було раніше);
#   tracked — власні + справи під наглядом за номером (типово: номер справи
#             однозначний, тезок бути не може);
#   all     — усі збіги, зокрема лише за ПІБ клієнта (можливі тезки).
# Решта приходить із кнопкою «📅 Додати в календар», як і раніше.
GCAL_AUTO = (os.environ.get("GCAL_AUTO", "tracked").strip().lower() or "tracked")
# Позначка «🆕 Нова справа» в календарі в день, коли бот уперше побачив справу.
# Типово вимкнена; вмикається змінною GCAL_NEW_CASE=1.
GCAL_NEW_CASE = os.environ.get("GCAL_NEW_CASE", "0").strip() not in ("0", "false", "no", "")
MAX_NEW_CASE_EVENTS = int(os.environ.get("GCAL_NEW_CASE_MAX", "15") or "15")


def is_priority(court):
    code = str(court.get("code") or "").zfill(4)
    return code in PRIORITY_CODES or (code[:2] in PRIORITY_PREFIXES and len(code) == 4)


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

# Відомі варіанти написання ПІБ адвоката, які теж треба ловити (суди інколи
# помиляються — напр. по-батькові «Олександрович» замість «Олексійович»).
# Керується env COURT_ADVOCATE_ALIASES (варіанти через «|»). Це власне ім'я
# адвоката, не персональні дані клієнтів.
ADVOCATE_ALIASES = [a.strip() for a in os.environ.get(
    "COURT_ADVOCATE_ALIASES", "Осадько Олександр Олександрович").split("|")
    if a.strip()]


def kyiv_now_str():
    """Поточний час за Києвом «дд.мм.рррр гг:хв» (з урахуванням літнього/зимового часу)."""
    try:
        from zoneinfo import ZoneInfo
        import datetime as _dt
        return _dt.datetime.now(ZoneInfo("Europe/Kyiv")).strftime("%d.%m.%Y %H:%M")
    except Exception:
        return time.strftime("%d.%m.%Y %H:%M", time.gmtime(time.time() + 2 * 3600))


# ───────────────────────── групи судів ─────────────────────────
# Кожна група має режим: always (щоразу), rotate (по черзі, шардами) або off
# (не перевіряти). Режими задаються у вебзастосунку (Worker KV) і приходять через
# /court_cfg. Суди, де вже є засідання адвоката/клієнтів або справа під наглядом
# за номером («суди ваших справ»), скануються ЩОРАЗУ незалежно від режиму групи.
GROUPS = [
    ("kyiv", "Київ і Київська область"),
    ("gen_n", "Загальні суди: Північ"),
    ("gen_w", "Загальні суди: Захід"),
    ("gen_s", "Загальні суди: Південь"),
    ("gen_e", "Загальні суди: Схід"),
    ("gen_c", "Загальні суди: Центр"),
    ("app", "Апеляційні суди"),
    ("adm", "Адміністративні суди"),
    ("gos", "Господарські суди"),
    ("other", "Інші суди"),
]
GROUP_DEFAULT = {"kyiv": "always"}   # решта груп типово — rotate
_REGION_OF = {
    "10": "kyiv", "26": "kyiv",
    "06": "gen_n", "18": "gen_n", "25": "gen_n",
    "03": "gen_w", "07": "gen_w", "09": "gen_w", "13": "gen_w", "17": "gen_w",
    "19": "gen_w", "22": "gen_w", "24": "gen_w",
    "08": "gen_s", "14": "gen_s", "15": "gen_s", "21": "gen_s",
    "04": "gen_e", "05": "gen_e", "12": "gen_e", "20": "gen_e",
    "02": "gen_c", "11": "gen_c", "16": "gen_c", "23": "gen_c",
}


def court_group(court):
    """Група суду: спеціалізація за назвою, інакше регіон за першими цифрами коду."""
    name = (court.get("name") or "").lower()
    if "адміністративн" in name:
        return "adm"
    if "господарськ" in name:
        return "gos"
    if "апеляційн" in name:
        return "app"
    code = str(court.get("code") or "").strip()
    if not code.isdigit():
        return "other"
    return _REGION_OF.get(code.zfill(4)[:2], "other")


def group_modes(cfg_groups):
    """Режими всіх груп: задані у Worker поверх типових."""
    modes = {gid: GROUP_DEFAULT.get(gid, "rotate") for gid, _ in GROUPS}
    for gid, mode in (cfg_groups or {}).items():
        if gid in modes and mode in ("always", "rotate", "off"):
            modes[gid] = mode
    return modes


def fetch_worker_cfg():
    """Налаштування прогону з Worker: режими груп і «суди ваших справ».
    Старий Worker (без /court_cfg) → ({}, None): працюємо з типовими режимами."""
    if not (WORKER_URL and WORKER_SECRET):
        return {}, None
    try:
        req = urllib.request.Request(
            WORKER_URL.rstrip("/") + "/court_cfg",
            headers={"X-Auth-Token": WORKER_SECRET, "User-Agent": UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read().decode("utf-8"))
        groups = data.get("groups") if isinstance(data.get("groups"), dict) else {}
        own = data.get("own_courts")
        return groups, ([str(x) for x in own] if isinstance(own, list) else None)
    except Exception as e:
        print("Налаштування груп із Worker недоступні (типові режими):", str(e)[:60])
        return {}, None


def post_worker_stats(stats):
    """Статистика прогону для вебзастосунку (лічильники, без персональних даних)."""
    if not (WORKER_URL and WORKER_SECRET):
        return
    try:
        req = urllib.request.Request(
            WORKER_URL.rstrip("/") + "/court_stats",
            data=json.dumps(stats).encode("utf-8"),
            headers={"X-Auth-Token": WORKER_SECRET, "Content-Type": "application/json",
                     "User-Agent": UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            r.read()
    except Exception as e:
        print("Не вдалося зберегти статистику прогону:", str(e)[:60])


def _case_prefix(num):
    """Перші цифри ядра номера справи («204» для 204/14022/26) — код суду у номері."""
    core = _case_core(num)
    return core.split("/")[0] if core else ""


def learn_prefix(prefix_map, court, records):
    """Запам'ятати, який префікс номерів справ належить суду першої інстанції
    (апеляційні пропускаємо: там номери чужих судів). Потрібен переконливий збіг."""
    if "апеляційн" in (court.get("name") or "").lower():
        return
    code = str(court.get("code") or "").strip()
    if not code:
        return
    cnt = {}
    for rec in records:
        pfx = _case_prefix(rec.get("number", ""))
        if pfx:
            cnt[pfx] = cnt.get(pfx, 0) + 1
    total = sum(cnt.values())
    if total < 5:
        return
    top = max(cnt, key=cnt.get)
    if cnt[top] / total >= 0.6:
        prefix_map[top] = code


def post_worker_report(items, kind="advocate", scanned=None):
    """Зберегти у Worker (KV) звіт (advocate|clients) для перегляду з меню.

    scanned — список назв судів, просканованих цього прогону (шардинг): Worker
    оновить лише їхні справи, решту (з інших шардів) збереже.
    """
    if not (WORKER_URL and WORKER_SECRET):
        return
    body = {
        "kind": kind,
        "updated": kyiv_now_str(),
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


def fetch_worker_cases_tracked():
    """Номери справ під наглядом (Telegram-меню «📌 Стежити за справою», Worker KV)."""
    if not (WORKER_URL and WORKER_SECRET):
        return []
    try:
        req = urllib.request.Request(
            WORKER_URL.rstrip("/") + "/court_names",
            headers={"X-Auth-Token": WORKER_SECRET, "User-Agent": UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read().decode("utf-8"))
        return [n.strip() for n in data.get("cases", []) if str(n).strip()]
    except Exception as e:
        print("Список справ із Worker недоступний:", str(e)[:60])
        return []


def _case_base(num):
    """«757/12345/26-ц» → «757/12345/26»: основа номера без літерного суфікса, без пробілів."""
    n = re.sub(r"[\u2010-\u2015\u2212]", "-", str(num or "")).casefold()
    n = re.sub(r"\s+", "", n).lstrip("№")
    n = re.sub(r"-[^\d/]+$", "", n)          # «-ц», «-к», «-а» тощо в кінці
    return n


def _case_core(num):
    """Ядро номера «ККК/НННН/РР» (код суду/номер/рік). Знаходить його і в
    «757/12345/26-ц», і в номері провадження «1-кп/757/12345/26»."""
    m = re.search(r"(\d{2,4})/(\d{1,7})/(\d{2})(?!\d)", _case_base(num))
    return f"{m.group(1)}/{int(m.group(2))}/{m.group(3)}" if m else ""


def case_matches(number, tracked):
    """Повертає номер зі списку стеження, якщо засідання саме в цій справі. Інакше None.
    Порівнюємо ядро «код суду/номер/рік» — префікс «1-кп/» і суфікс «-ц»/«-к»
    не заважають (суди пишуть номер справи і номер провадження по-різному)."""
    core = _case_core(number)
    if not core:
        return None
    for t in tracked:
        if _case_core(t) == core:
            return t
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
                entry = {"name": (c.get("name") or f"суд {code}").strip(),
                         "code": code,
                         "auto_url": (c.get("auto_url") or "").strip()}
                # Явний url (для судів, у яких немає /csz на court.gov.ua —
                # напр. регіональний піддомен). csz_url_for надасть перевагу йому.
                url = (c.get("url") or "").strip()
                if url:
                    entry["url"] = url
                # Особливий тип джерела (напр. "kas" — портал Київського
                # апеляційного з пошуком за стороною замість /new.php).
                kind = (c.get("kind") or "").strip()
                if kind:
                    entry["kind"] = kind
                out.append(entry)
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


# ───────────── Київський апеляційний суд (власний портал kas.gov.ua) ─────────
# Суд не підключений до court.gov.ua (/sud4824/... → 404). Графік засідань він
# публікує на порталі з HTML-формою пошуку, де є поле «Сторона у справі».
# Тож замість «усіх засідань суду» шукаємо за кожним ПІБ під наглядом і беремо
# лише майбутні засідання (пошук без дати повертає і всю історію справ).
KAS_URL = "https://www.kas.gov.ua/CourtPortal.WebSite/Home/GraficZasidan"
KAS_TIMEOUT = max(FETCH_TIMEOUT, 60)  # відповідь із сотнею рядків — ~20 с
KAS_PAUSE = float(os.environ.get("COURT_KAS_PAUSE", "3") or "3")   # с між пошуками
KAS_TRIES = int(os.environ.get("COURT_KAS_TRIES", "3") or "3")     # спроб на ПІБ


def _kas_opener():
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


_KAS_HDR = {"User-Agent": UA, "Accept-Language": "uk,en;q=0.8",
            "Accept": "text/html,application/xhtml+xml,*/*;q=0.8"}


def kas_alive(url=KAS_URL):
    """Чи відкривається форма «Графік засідань» (для щоденного healthcheck)."""
    try:
        with _kas_opener().open(urllib.request.Request(url, headers=_KAS_HDR),
                                timeout=KAS_TIMEOUT) as r:
            return "litigant" in r.read().decode("utf-8", "replace")
    except Exception:
        return False


def _kas_terms(names):
    """Пошукові запити: «Прізвище Ім'я» (без по-батькові — портал шукає підрядок,
    а описки в по-батькові не губитимуть справ; точний збіг перевірить
    name_matches). Дублікати й однослівні записи відкидаємо."""
    out, low = [], set()
    for nm in names:
        words = (nm or "").split()
        if len(words) < 2:
            continue
        term = " ".join(words[:2])
        if term.lower() not in low:
            low.add(term.lower())
            out.append(term)
    return out


def _kas_rows(text):
    rows = []
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", text, re.S | re.I):
        cells = [_html.unescape(" ".join(re.sub(r"<[^>]+>", " ", c).split()))
                 for c in re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S | re.I)]
        if len(cells) >= 8:
            rows.append(cells)
    return rows


def fetch_kas(names, url=KAS_URL):
    """Майбутні засідання Київського апеляційного за ПІБ із names — у форматі
    записів court.gov.ua (number/date/judge/involved/description/courtroom)."""
    opener = _kas_opener()
    for attempt in range(KAS_TRIES):
        try:
            with opener.open(urllib.request.Request(url, headers=_KAS_HDR),
                             timeout=KAS_TIMEOUT) as r:
                r.read()
            break
        except Exception:
            if attempt == KAS_TRIES - 1:
                raise
            time.sleep(KAS_PAUSE * (attempt + 2))
    parts = urllib.parse.urlsplit(url)
    hdr = dict(_KAS_HDR, **{"Content-Type": "application/x-www-form-urlencoded",
                            "Referer": url,
                            "Origin": f"{parts.scheme}://{parts.netloc}"})
    today0 = time.mktime(time.strptime(time.strftime("%d.%m.%Y"), "%d.%m.%Y"))
    out, keys = [], set()
    for term in _kas_terms(names):
        body = urllib.parse.urlencode({
            "case_number": "", "session_date": "", "main_judge": "",
            "litigant": term, "doc_class": "", "Search": "Шукати"}).encode()
        # Портал слабкий: на серію запитів може відповісти 503. Кожен ПІБ —
        # до KAS_TRIES спроб із наростаючою паузою; якщо всі невдалі, весь суд
        # вважається незавантаженим (Worker збереже раніше відомі справи).
        text, last = None, None
        for attempt in range(KAS_TRIES):
            try:
                req = urllib.request.Request(url, data=body, headers=hdr)
                with opener.open(req, timeout=KAS_TIMEOUT) as r:
                    text = r.read().decode("utf-8", "replace")
                if "litigant" not in text:  # не сторінка порталу — збій
                    raise RuntimeError("неочікувана відповідь порталу")
                break
            except Exception as e:
                last, text = e, None
                time.sleep(KAS_PAUSE * (attempt + 2))
        if text is None:
            raise last
        for c in _kas_rows(text):
            ts = _hearing_ts(c[2])
            if ts is None or ts < today0:
                continue  # минулі засідання (історія) не потрібні
            rec = {
                "number": c[0] or c[1],
                "date": f"{c[2]} {c[3]}".strip(),
                "courtroom": c[4],
                "judge": c[5],
                "involved": c[6],
                "description": c[7],
                "forma": "",
                "add_address": "",
            }
            k = (rec["number"], rec["date"])
            if k not in keys:
                keys.add(k)
                out.append(rec)
        time.sleep(KAS_PAUSE)  # ввічлива пауза між пошуками (портал слабкий)
    return out


def fetch_kas_retry(names):
    # Повтори вже всередині fetch_kas (на кожен ПІБ) — тут без зайвого кола.
    return fetch_kas(names)


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
        # ПІБ під наглядом має бути щонайменше з 2 слів (прізвище + ім'я).
        # Одиничне поширене слово («Іван», «Ольга», коротке прізвище) збігалося б
        # із безліччю чужих справ — тому такі записи ІГНОРУЄМО (захист від
        # хибних спрацювань: чужі справи більше не потраплятимуть у сповіщення/
        # календар). Реальні ПІБ (3 слова) від цього не страждають.
        if len(n) < 6 or len(n.split()) < 2:
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


# Гнучке впізнавання ПІБ САМОГО адвоката. Суди часто пишуть його з описками чи
# у відмінку: «Осадько Олександра Олексійович», «Осадько Олександр Олександрович»
# тощо — точний збіг такі пропускає. Прізвище «Осадько» рідкісне, тож дозволяємо
# змінні закінчення в імені (корінь «Олександр») і по-батькові (тип «Олекс…ович»)
# без ризику хибних збігів. Керується env COURT_ADVOCATE_RE (за потреби).
_ADV_RE = re.compile(
    os.environ.get("COURT_ADVOCATE_RE", r"осадьк\w+\s+олександр\w*\s+олекс\w*ович"))


def advocate_matches(involved):
    """True, якщо у «сторонах» фігурує сам адвокат (з допуском описок/відмінків)."""
    return bool(_ADV_RE.search(_norm(involved)))


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
def tg_send(text, reply_markup=None):
    url = f"https://api.telegram.org/bot{TOKEN}/sendMessage"
    body = {
        "chat_id": CHAT,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    if reply_markup is not None:
        body["reply_markup"] = reply_markup
    payload = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=payload,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def _gcal_key(court_name, rec):
    """Короткий стабільний ключ справи для callback-кнопок (≤64 байти)."""
    raw = f"{rec.get('number', '')}|{rec.get('date', '')}|{court_name}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def gcal_stash_pending(gkey, court_name, rec, chat_id, message_id):
    """Відкласти у Worker клієнтську справу, що чекає підтвердження в календар."""
    if not (WORKER_URL and WORKER_SECRET):
        return
    body = json.dumps({
        "key": gkey, "court": court_name,
        "chat_id": chat_id, "message_id": message_id,
        "rec": {k: rec.get(k, "") for k in (
            "number", "date", "judge", "involved", "description",
            "forma", "courtroom", "add_address")},
    }).encode("utf-8")
    try:
        req = urllib.request.Request(
            WORKER_URL.rstrip("/") + "/gcal_stash", data=body,
            headers={"X-Auth-Token": WORKER_SECRET,
                     "Content-Type": "application/json", "User-Agent": UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            r.read()
    except Exception as e:
        print("Календар: не вдалося відкласти на підтвердження:", str(e)[:60])


def _tg_edit_markup(chat_id, message_id, label):
    """Оновити статус-кнопку під сповіщенням (напр. «✅ Додано в календар»)."""
    if not (chat_id and message_id):
        return
    try:
        payload = json.dumps({
            "chat_id": chat_id, "message_id": message_id,
            "reply_markup": {"inline_keyboard": [[
                {"text": label, "callback_data": "cnoop"}]]},
        }).encode("utf-8")
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{TOKEN}/editMessageReplyMarkup",
            data=payload, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=20) as r:
            r.read()
    except Exception:
        pass


def drain_gcal_approved():
    """Додати у Google Calendar клієнтські справи, які адвокат підтвердив кнопкою
    у боті (Worker тримає чергу підтверджених). Викликається на початку прогону."""
    if DRY_RUN or gcal is None or not gcal.enabled():
        return
    if not (WORKER_URL and WORKER_SECRET):
        return
    try:
        req = urllib.request.Request(
            WORKER_URL.rstrip("/") + "/gcal_approved",
            headers={"X-Auth-Token": WORKER_SECRET, "User-Agent": UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            items = json.loads(r.read().decode("utf-8")).get("items", [])
    except Exception as e:
        print("Календар: черга підтверджень недоступна:", str(e)[:60])
        return
    added = 0
    print(f"Календар: підтверджених у черзі — {len(items)}")
    for it in items:
        rec = it.get("rec", {}) or {}
        is_deadline = rec.get("kind") == "deadline"
        try:
            if is_deadline:
                # Процесуальний строк із команди бота /strok — подія на весь день.
                ok = gcal.add_deadline(rec.get("number", ""), rec.get("title", ""),
                                       rec.get("date", ""), rec.get("note", ""))
            else:
                ok = gcal.add_event(it.get("court", ""), rec)
        except Exception:
            ok = False
        if ok is None:
            print("Календар: подію пропущено (не розпізнано дату).")
        if ok:
            added += 1
            _tg_edit_markup(it.get("chat_id"), it.get("message_id"),
                            "✅ Строк у календарі" if is_deadline
                            else "✅ Додано в календар")
            try:
                ack = json.dumps({"key": it.get("key")}).encode("utf-8")
                req = urllib.request.Request(
                    WORKER_URL.rstrip("/") + "/gcal_ack", data=ack,
                    headers={"X-Auth-Token": WORKER_SECRET,
                             "Content-Type": "application/json", "User-Agent": UA})
                with urllib.request.urlopen(req, timeout=20) as r:
                    r.read()
            except Exception:
                pass


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


def post_worker_newcase(court_name, rec, reliable):
    """Передати у Worker нову справу – для списку «Нові справи» у вебзастосунку.
    Дані йдуть у приватне сховище (KV), у логи нічого не друкуємо. True/False."""
    if not (WORKER_URL and WORKER_SECRET):
        return False
    body = json.dumps({
        "number": rec.get("number", ""), "court": court_name, "reliable": bool(reliable),
        "found": time.strftime("%d.%m.%Y", time.gmtime(time.time() + 2 * 3600)),
        "date": rec.get("date", ""), "judge": rec.get("judge", ""),
        "involved": rec.get("involved", ""), "description": rec.get("description", ""),
    }).encode("utf-8")
    try:
        req = urllib.request.Request(
            WORKER_URL.rstrip("/") + "/court_newcase", data=body,
            headers={"X-Auth-Token": WORKER_SECRET,
                     "Content-Type": "application/json", "User-Agent": UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            r.read()
        return True
    except Exception:
        return False


def _case_hash(number):
    """Знеособлений ключ справи для стану (state.json лежить у відкритому
    репозиторії, тож самих номерів справ туди не пишемо)."""
    core = _case_core(number) or _case_base(number)
    if not core:
        return ""
    return hashlib.sha1(("case|" + core).encode("utf-8")).hexdigest()[:16]


def gcal_auto_for(is_own, who):
    """Чи додавати це засідання в календар без підтвердження кнопкою."""
    if is_own:
        return True
    if GCAL_AUTO == "all":
        return True
    return GCAL_AUTO == "tracked" and str(who or "").startswith("справа № ")


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
    # Завжди стежимо за самим адвокатом і відомими варіантами написання його ПІБ
    # (щоб помилки судів у по-батькові тощо не «губилися»).
    low = {n.lower() for n in names}
    for n in [ADVOCATE_NAME] + ADVOCATE_ALIASES:
        if n and n.lower() not in low:
            names.append(n)
            low.add(n.lower())
    # Справи під наглядом за номером: з Telegram-меню та з секрету COURT_WATCH ("cases")
    tracked = fetch_worker_cases_tracked()
    try:
        _cfg = json.loads(os.environ.get("COURT_WATCH", "") or "{}")
        for c in (_cfg.get("cases", []) if isinstance(_cfg, dict) else []):
            if str(c).strip() and str(c).strip() not in tracked:
                tracked.append(str(c).strip())
    except Exception:
        pass
    if tracked:
        print(f"Справ під наглядом за номером: {len(tracked)}")
    if not names and not tracked:
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
    # ПІБ клієнтів без самого адвоката: за ними справа йде у «Справи клієнтів»
    # навіть тоді, коли адвокат теж зазначений у сторонах.
    _own = {n.lower() for n in [ADVOCATE_NAME] + ADVOCATE_ALIASES}
    client_names = [n for n in names if n.lower() not in _own]

    # «Нова справа»: пам'ятаємо (знеособлено) справи, які бот уже бачив. Перший
    # запуск із цією функцією лише фіксує наявні справи (з поточних збігів і з
    # накопиченого у Worker переліку), щоб календар не засипало позначками.
    seed_known = "known_cases" not in st
    known = st.setdefault("known_cases", {})
    if seed_known and not DRY_RUN:
        for it in fetch_worker_cases("clients") + fetch_worker_cases("advocate"):
            h = _case_hash(it.get("number", ""))
            if h:
                known[h] = 1
        print(f"Нові справи: зафіксовано вже відомих — {len(known)}")
    new_case_marked = 0

    def note_new_case(court_name, rec, who=""):
        """Справу бачимо вперше → позначка «🆕 Нова справа» в календарі."""
        nonlocal new_case_marked
        h = _case_hash(rec.get("number", ""))
        if not h or h in known or DRY_RUN:
            return
        if seed_known:
            known[h] = 1
            return
        if new_case_marked >= MAX_NEW_CASE_EVENTS:
            return  # решта наступним прогоном
        # Надійний збіг: адвокат у сторонах або справа під наглядом за номером.
        sure = (advocate_matches(rec.get("involved", ""))
                or str(who or "").startswith("справа № "))
        # Список «Нові справи» у вебзастосунку (Worker) ведеться завжди; позначка
        # в календарі – лише коли ввімкнено GCAL_NEW_CASE (типово вимкнена).
        # Справу вважаємо врахованою, якщо вдалося хоча б одне з двох.
        posted = post_worker_newcase(court_name, rec, sure)
        marked = False
        if GCAL_NEW_CASE and gcal is not None and gcal.enabled():
            try:
                marked = bool(gcal.add_new_case(court_name, rec, unverified=not sure))
            except Exception:
                print("  Календар: помилка позначки нової справи (пропущено).")
        if posted or marked or not (WORKER_URL and WORKER_SECRET or GCAL_NEW_CASE):
            known[h] = 1
            new_case_marked += 1

    # Шардинг: цей прогін сканує лише частину судів (решта — наступними прогонами).
    # scanned_ok — назви судів, які цього прогону завантажилися УСПІШНО. Саме їх
    # (а не всі спробувані!) шлемо у Worker як scanned: суд, що впав по timeout,
    # НЕ потрапляє сюди → Worker зберігає його раніше відомі справи, а не обнуляє.
    # Це рятує від катастрофи, коли court.gov.ua блокує масу запитів і повний
    # прогін «знаходить 0» — тепер порожнеча не затирає накопичений перелік.
    scanned_ok = []
    t_start = time.time()
    fails = st.setdefault("court_fail", {})  # код суду → {"n": поспіль невдач, "ts": остання спроба}
    # ── План обходу: групи судів, «суди ваших справ», шардинг ──
    cfg_groups, own_names = fetch_worker_cfg()
    modes = group_modes(cfg_groups)
    if own_names is None and not DRY_RUN:
        # Старий Worker: беремо суди з накопичених звітів (майбутні засідання).
        own_names = [it.get("court", "") for it in
                     fetch_worker_cases("advocate") + fetch_worker_cases("clients")]
    own_set = {n for n in (own_names or []) if n}
    # Суд справи під наглядом за номером — за вивченим префіксом номера.
    prefix_map = st.setdefault("case_prefix", {})
    own_codes = {prefix_map[p] for p in (_case_prefix(t) for t in tracked) if p in prefix_map}

    def _code(c):
        return str(c.get("code") or "").strip()

    def own_court(c):
        return c["name"] in own_set or (_code(c) and _code(c) in own_codes)

    def is_prio(c):
        if own_court(c):
            return True
        g = modes.get(court_group(c), "rotate")
        return g == "always" or (g != "off" and _code(c).zfill(4) in PRIORITY_CODES)

    active = [c for c in courts if own_court(c) or modes.get(court_group(c), "rotate") != "off"]
    priority = [c for c in active if is_prio(c)]
    rotation = [c for c in active if not is_prio(c)]
    courts_to_scan = priority + rotation
    shard_mode = False
    cur = 0
    wrapped = False
    # Ручна перевірка окремих судів: COURT_ONLY_CODES="4824,4811" — без шардингу.
    only = {c.strip().zfill(4) for c in os.environ.get("COURT_ONLY_CODES", "").split(",")
            if c.strip()}
    if only:
        courts_to_scan = [c for c in courts if str(c.get("code") or "").zfill(4) in only]
        print(f"Лише вибрані суди: {len(courts_to_scan)}")
    elif SHARD_SIZE > 0 and len(rotation) > SHARD_SIZE:
        shard_mode = True
        cur = int(st.get("shard_cursor", 0)) % len(rotation)
        end = cur + SHARD_SIZE
        shard = rotation[cur:end]
        if end > len(rotation):                    # перенос через кінець списку
            shard = shard + rotation[:end - len(rotation)]
        wrapped = end >= len(rotation)
        st["shard_cursor"] = end % len(rotation)
        if cur == 0 or "cycle_started" not in st:
            st["cycle_started"] = int(time.time())
        courts_to_scan = priority + shard
        print(f"Щоразу: {len(priority)} (з них суди ваших справ: "
              f"{sum(1 for c in priority if own_court(c))}) · шард: {len(shard)} "
              f"судів (позиція {cur}), наступний курсор {st['shard_cursor']}; "
              f"повне коло за {-(-len(rotation)//SHARD_SIZE)} прогонів · "
              f"вимкнено груп: {sum(1 for m in modes.values() if m == 'off')}")
    else:
        print(f"Повний прогін: щоразу {len(priority)} + решта {len(rotation)}")
    outcome = {}   # назва суду → ok | fail | dead (для статистики у застосунку)
    reached = 0    # скільки судів зі списку цього прогону опрацьовано

    # Спершу обробляємо клієнтські справи, які адвокат підтвердив кнопкою у боті
    # (Worker тримає чергу) — додаємо їх у Google Calendar і позначаємо «✅».
    drain_gcal_approved()

    skipped_dead = 0
    for idx, court in enumerate(courts_to_scan):
        reached = idx
        url = csz_url_for(court)
        if not url:
            continue
        if TIME_BUDGET_MIN and time.time() - t_start > TIME_BUDGET_MIN * 60:
            print(f"Ліміт часу {TIME_BUDGET_MIN:g} хв вичерпано — решту судів "
                  f"просканують наступні прогони.")
            break
        code = str(court.get("code") or court["name"])
        f = fails.get(code)
        if (not only and not is_prio(court) and f and f.get("n", 0) >= DEAD_AFTER
                and time.time() - f.get("ts", 0) < DEAD_RETRY_DAYS * 86400):
            skipped_dead += 1
            outcome[court["name"]] = "dead"
            continue
        try:
            if court.get("kind") == "kas":
                records = fetch_kas_retry(names)
            else:
                records = fetch_court_retry(url)
        except Exception as e:
            print(f"[{court['name']}] помилка завантаження: {e}")
            fails[code] = {"n": (f or {}).get("n", 0) + 1, "ts": int(time.time())}
            outcome[court["name"]] = "fail"
            continue
        fails.pop(code, None)
        scanned_ok.append(court["name"])  # суд завантажився — його справи актуальні
        outcome[court["name"]] = "ok"
        learn_prefix(prefix_map, court, records)
        time.sleep(REQUEST_PAUSE)  # ввічлива пауза між судами

        # Окремо: справи, де фігурує сам адвокат (для перегляду з меню).
        # Дані йдуть у приватне сховище (Worker KV), не в логи, тож детально.
        if ADVOCATE_NAME:
            for rec in records:
                if advocate_matches(rec.get("involved", "")):
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
            inv = rec.get("involved", "") or ""
            who = name_matches(inv, names)
            adv = advocate_matches(inv)
            # Справа під наглядом за номером — незалежно від того, хто в сторонах.
            if not who and tracked:
                cm = case_matches(rec.get("number", ""), tracked)
                if cm:
                    who = "справа № " + cm
            # Власна справа адвоката з опискою в ПІБ теж має спрацьовувати.
            if adv and not who:
                who = ADVOCATE_NAME
            if who:
                matches.append((rec, who))
                # У «Справи клієнтів» — коли є збіг за КЛІЄНТСЬКИМ ПІБ, навіть якщо
                # адвокат теж у сторонах (тоді справа є в обох звітах).
                cli = who if not adv else (name_matches(inv, client_names)
                                           or (who if who.startswith("справа № ") else None))
                if cli:
                    client_hits.append({
                        "court": court["name"], "matched": cli,
                        "number": rec.get("number", ""), "date": rec.get("date", ""),
                        "judge": rec.get("judge", ""), "involved": rec.get("involved", ""),
                        "description": rec.get("description", ""), "forma": rec.get("forma", ""),
                        "courtroom": rec.get("courtroom", ""), "address": rec.get("add_address", ""),
                    })
        new_here = sum(1 for rec, _ in matches if rec_key(url, rec) not in seen)
        total_new += new_here
        for rec, who in matches:
            note_new_case(court["name"], rec, who)
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
            # Власна справа адвоката (він фігурує за своїм ПІБ або відомим
            # варіантом) — надійна, додається в календар АВТОМАТИЧНО. Інакше це
            # збіг лише за ПІБ клієнта (можливі тезки) — НЕ додаємо самі, а
            # надсилаємо з кнопкою «Додати в календар» для підтвердження.
            is_own = advocate_matches(rec.get("involved", ""))
            markup = None
            gkey = None
            # Автоматичне додавання (GCAL_AUTO): власні справи завжди; справи під
            # наглядом за номером типово; збіги лише за ПІБ — тільки в режимі all.
            # Додаємо ДО сповіщення, щоб одразу показати статус під повідомленням.
            # events.import ідемпотентний — повтори не дублюють подію.
            cal_done = False
            if gcal_auto_for(is_own, who) and gcal is not None and gcal.enabled():
                try:
                    cal_done = bool(gcal.add_event(court["name"], rec))
                    if cal_done:
                        print("  Календар: засідання додано/оновлено автоматично.")
                except Exception:
                    print("  Календар: помилка (пропущено).")
            if cal_done and not is_own:
                markup = {"inline_keyboard": [[
                    {"text": "✅ Додано в календар", "callback_data": "cnoop"}]]}
            elif not is_own:
                gkey = _gcal_key(court["name"], rec)
                markup = {"inline_keyboard": [[
                    {"text": "📅 Додати в календар", "callback_data": f"gcaladd:{gkey}"},
                    {"text": "✖️ Ні", "callback_data": f"gcalskip:{gkey}"},
                ]]}
            try:
                res = tg_send(build_message(court["name"], rec, who),
                              reply_markup=markup)
                if res.get("ok"):
                    seen[key] = 1
                    sent += 1
                    time.sleep(0.5)
                    if gkey:
                        m = res.get("result", {}) or {}
                        gcal_stash_pending(gkey, court["name"], rec,
                                           (m.get("chat") or {}).get("id"),
                                           m.get("message_id"))
                else:
                    print("  Telegram відмовив (див. приватний чат).")
            except Exception:
                print("  Помилка надсилання сповіщення.")
            # Справи, не додані автоматично, потраплять у календар після
            # підтвердження кнопкою (їх обробляє drain_gcal_approved).
        if sent >= MAX_ALERTS:
            print("  Досягнуто ліміту сповіщень за запуск — решта наступного разу.")
            reached = idx + 1
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
                        if (w := (name_matches(r.get("involved", ""), names)
                                  or (("справа № " + c) if (c := case_matches(r.get("number", ""), tracked)) else None)))]
            anew = sum(1 for r, _ in amatches if auto_key(auto_url, r) not in seen)
            total_new += anew
            for r, w in amatches:
                note_new_case(court["name"], r, w)
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

    else:
        reached = len(courts_to_scan)
    # Прогін обірвано (ліміт часу або сповіщень): курсор повертаємо на перший
    # неопрацьований суд шарда, щоб він не чекав ціле коло.
    if shard_mode and reached < len(courts_to_scan):
        done_in_shard = max(0, reached - len(priority))
        st["shard_cursor"] = (cur + done_in_shard) % len(rotation)
        wrapped = wrapped and st["shard_cursor"] < cur

    # Звіти «справи адвоката» і «справи клієнтів» (майбутні, за датою, без дублів).
    # Worker зливає ЛИШЕ справи успішно завантажених судів (scanned_ok); решту
    # (не завантажені або з інших шардів) зберігає. Якщо цього прогону не вдалося
    # ЖОДЕН суд — звіт НЕ чіпаємо взагалі, щоб порожнеча не стерла накопичене.
    if skipped_dead:
        print(f"Пропущено недоступних судів (не відповідали {DEAD_AFTER}+ разів поспіль, "
              f"повторна спроба раз на {DEAD_RETRY_DAYS:g} дн.): {skipped_dead}")
    adv, cli = [], []
    if not scanned_ok:
        print("Жодного суду не проскановано успішно — звіт не оновлюю "
              "(зберігаю попередній перелік).")
    else:
        if ADVOCATE_NAME:
            adv = build_report(advocate_hits)
            print(f"Справи адвоката (цей шард): {len(adv)}")
            if not DRY_RUN:
                post_worker_report(adv, "advocate", scanned=scanned_ok)
        cli = build_report(client_hits)
        print(f"Справи клієнтів (цей шард): {len(cli)}")
        if not DRY_RUN:
            post_worker_report(cli, "clients", scanned=scanned_ok)

    # ── Нагадування за 3-2-1 день до засідання ──
    if REMIND_DAYS:
        today0 = time.mktime(time.strptime(time.strftime("%d.%m.%Y"), "%d.%m.%Y"))
        # Справи, які адвокат прибрав у боті (🗑 у «Нагадуваннях»/«Прихованих») —
        # по них нагадування більше не надсилаємо.
        blocked = fetch_worker_blocked()
        # Цей прогін бачив лише частину судів (шард) або міг не завантажити деякі
        # через timeout — тож для нагадувань беремо ПОВНИЙ накопичений перелік
        # справ із Worker (усі шарди разом). Локальні cli/adv — лише запасний
        # варіант у dry-run, коли до Worker не звертаємось.
        if not DRY_RUN:
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
    if new_case_marked:
        print(f"Нових справ позначено: {new_case_marked}")

    st["last_run"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    if shard_mode and wrapped:
        st["cycle_done"] = int(time.time())
    if not DRY_RUN:
        save_state(st)
        if not only:
            names_by_gid = dict(GROUPS)
            gstat = {gid: {"id": gid, "name": names_by_gid[gid], "mode": modes[gid], "total": 0,
                           "planned": 0, "ok": 0, "fail": 0} for gid, _ in GROUPS}
            for c in courts:
                gstat[court_group(c)]["total"] += 1
            for c in courts_to_scan:
                g = gstat[court_group(c)]
                g["planned"] += 1
                res = outcome.get(c["name"])
                if res == "ok":
                    g["ok"] += 1
                elif res == "fail":
                    g["fail"] += 1
            code_name = {str(c.get("code") or "").strip(): c["name"] for c in courts}
            tracked_courts = {t: code_name.get(prefix_map.get(_case_prefix(t), ""), "")
                              for t in tracked}
            dead_names = [c["name"] for c in courts
                          if (fails.get(str(c.get("code") or c["name"])) or {}).get("n", 0) >= DEAD_AFTER]
            post_worker_stats({
                "ts": int(time.time()),
                "updated": kyiv_now_str(),
                "duration": int(time.time() - t_start),
                "full": not shard_mode,
                "planned": len(courts_to_scan),
                "ok": len(scanned_ok),
                "failed": sum(1 for v in outcome.values() if v == "fail"),
                "dead": skipped_dead,
                "cut": max(0, len(courts_to_scan) - reached),
                "always": len(priority),
                "own": sorted(c["name"] for c in priority if own_court(c)),
                "rotation": len(rotation),
                "shard": SHARD_SIZE if shard_mode else len(rotation),
                "cursor": st.get("shard_cursor", 0) if shard_mode else len(rotation),
                "wrapped": bool(wrapped) or not shard_mode,
                "cycle_started": st.get("cycle_started", 0),
                "cycle_done": st.get("cycle_done", 0),
                "groups": [g for g in gstat.values() if g["total"]],
                "scanned": scanned_ok,
                "dead_names": dead_names,
                "tracked_courts": tracked_courts,
            })
    note = " (перший запуск — зафіксовано поточні засідання)" if first_time else ""
    if DRY_RUN:
        print(f"DRY-RUN: нових збігів усього: {total_new} (нічого не надіслано){note}")
    else:
        print(f"Надіслано сповіщень: {sent}{note}")


if __name__ == "__main__":
    main()
