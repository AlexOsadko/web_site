#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Автопостинг новин у Telegram-канал.

Читає RSS-стрічки (загальні + юридичні) зі списку tools/telegram_feeds.txt,
бере найсвіжіші ще не опубліковані записи й постить у канал у форматі:
    📰 Заголовок
    короткий опис
    🔗 Читати джерело · Джерело

Стан (уже опубліковані посилання + добовий лічильник) зберігається у
.telegram-bot/state.json і комітиться воркфлоу назад у репозиторій.

Змінні середовища:
  TELEGRAM_BOT_TOKEN  — токен бота від @BotFather                (обов'язково)
  TELEGRAM_CHANNEL    — @username каналу або числовий chat_id     (обов'язково)
  BOT_MAX_PER_RUN     — макс. постів за один запуск (типово 1)
  BOT_DAILY_MAX       — макс. постів на добу (типово 15)
  BOT_SHOW_PREVIEW    — "0" щоб вимкнути прев'ю посилання (типово увімкнено)
  BOT_DRY_RUN         — "1" — лише лог, без публікації і без запису стану
"""
import os, sys, re, json, html, time, datetime
import urllib.request, urllib.parse, urllib.error
import feedparser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_DIR = os.path.join(ROOT, ".telegram-bot")
STATE_FILE = os.path.join(STATE_DIR, "state.json")
FEEDS_FILE = os.path.join(ROOT, "tools", "telegram_feeds.txt")
SEEN_KEEP = 1200            # скільки останніх посилань пам'ятати (щоб не дублювати)
# Браузерний User-Agent: частина сайтів віддає боту анти-бот HTML замість RSS
# (звідси «not well-formed»). Зі звичайним браузерним UA стрічки читаються.
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
FEED_HEADERS = {"Accept": "application/rss+xml, application/atom+xml, "
                          "application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8",
                "Accept-Language": "uk,en;q=0.8",
                # без стиснення: деякі сайти віддають brotli, який feedparser
                # не розпаковує → «not well-formed». identity = сирий XML.
                "Accept-Encoding": "identity"}

TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
CHANNEL = os.environ.get("TELEGRAM_CHANNEL", "").strip()
MAX_PER_RUN = int(os.environ.get("BOT_MAX_PER_RUN", "1") or "1")
DAILY_MAX = int(os.environ.get("BOT_DAILY_MAX", "15") or "15")
# постимо лише свіже: записи, старші за MAX_AGE_HOURS, ігноруються (щоб не
# «вивалити» весь архів стрічки/сайту при першому запуску)
MAX_AGE_HOURS = int(os.environ.get("BOT_MAX_AGE_HOURS", "72") or "72")
# AI-резюме простою мовою (потрібен ANTHROPIC_API_KEY). Якщо ключа немає або
# виклик не вдався — постимо звичайний опис зі стрічки (fallback).
SUMMARY_MODEL = os.environ.get("BOT_SUMMARY_MODEL", "claude-sonnet-5").strip()
# кнопка «Написати адвокату» під кожним постом (inline-кнопка з посиланням)
CONTACT_URL = os.environ.get("BOT_CONTACT_URL", "https://osadko.online/kontakty/").strip()
CONTACT_LABEL = os.environ.get("BOT_CONTACT_LABEL", "⚖️ Консультація адвоката").strip()
# кнопку «до адвоката» показуємо не на кожному пості, а кожен N-й (правила
# реклами адвокатської діяльності + модерація Telegram Ads). 0 = ніколи.
CTA_EVERY = int(os.environ.get("BOT_CTA_EVERY", "4") or "4")

# --- оригінальні (авторські) пости: міфи / помилки / інструкції / поради ---
# Кожен ORIGINAL_EVERY-й запуск замість новини генерує оригінальний пост.
ORIGINAL_EVERY = int(os.environ.get("BOT_ORIGINAL_EVERY", "2") or "2")
# Куди йдуть оригінальні пости. За замовчуванням — на ПЕРЕВІРКУ у приватний чат
# (id від @userinfobot; спершу напишіть боту /start). Це запобіжник: авторський
# юридичний текст від імені адвоката краще прочитати перед публікацією.
REVIEW_CHAT = os.environ.get("TELEGRAM_REVIEW_CHAT", "").strip()
# Режим миттєвих кнопок через Cloudflare Worker (вебхук). Якщо задано BOT_WORKER_URL —
# чернетки реєструються у воркері (він шле їх у чат перевірки й миттєво реагує на
# кнопки), а бот НЕ опитує getUpdates (бо ввімкнено вебхук Telegram).
WORKER_URL = os.environ.get("BOT_WORKER_URL", "").strip()
WORKER_SECRET = os.environ.get("BOT_WORKER_SECRET", "").strip()
# Увімкніть, щоб публікувати оригінальні пости одразу в канал без перевірки.
ORIGINAL_AUTOPOST = os.environ.get("BOT_ORIGINAL_AUTOPOST", "").strip() in ("1", "true", "yes")
# Мінімальний інтервал між ПУБЛІКАЦІЯМИ контенту (хв). Скрипт може запускатися
# часто (щоб швидко обробляти натискання кнопок «Опублікувати/Відхилити» під
# чернетками), але новини/авторські пости виходять не частіше цього інтервалу.
CONTENT_INTERVAL_MIN = int(os.environ.get("BOT_CONTENT_INTERVAL_MIN", "120") or "120")
# Примусово згенерувати авторську чернетку цього запуску (ігнорує чергу й
# інтервал) — для ручної кнопки «згенерувати чернетку зараз» у workflow.
FORCE_ORIGINAL = os.environ.get("BOT_FORCE_ORIGINAL", "").strip() in ("1", "true", "yes")
# Скільки авторських чернеток згенерувати за примусовий запуск (наперед).
FORCE_COUNT = int(os.environ.get("BOT_FORCE_ORIGINAL_COUNT", "1") or "1")

ORIGINAL_TYPES = [
    ("міф", "розвінчання поширеного юридичного міфу: спершу сам міф, тоді як є насправді"),
    ("помилка", "типова процесуальна помилка та чому вона має значення (без конкретної справи)"),
    ("інструкція", "покрокова практична інструкція: що робити у типовій ситуації"),
    ("порада", "коротка практична порада: на що звернути увагу, щоб не втратити право чи строк"),
]
ORIGINAL_AREAS = [
    "сімейне право", "трудові спори", "кримінальні справи", "цивільні справи та борги",
    "адміністративні спори з держорганами", "ДТП та автоправо", "нерухомість і спадщина",
    "бізнес і господарські спори", "пенсійні та соціальні виплати",
    "військове право та мобілізація", "захист прав споживачів", "судовий процес",
]
# Канонічні хештеги (єдиний стиль — з підкресленнями), щоб авторські пости мали
# ті самі рубрики, що й новини. Ключ — назва сфери/типу вище.
AREA_TAGS = {
    "сімейне право": "#сімейне_право",
    "трудові спори": "#трудове_право",
    "кримінальні справи": "#кримінальне",
    "цивільні справи та борги": "#цивільне_право",
    "адміністративні спори з держорганами": "#адміністративне_право",
    "ДТП та автоправо": "#автоправо",
    "нерухомість і спадщина": "#нерухомість",
    "бізнес і господарські спори": "#бізнес_право",
    "пенсійні та соціальні виплати": "#соцвиплати",
    "військове право та мобілізація": "#військове_право",
    "захист прав споживачів": "#права_споживачів",
    "судовий процес": "#судова_практика",
}
TYPE_TAGS = {
    "міф": "#міф",
    "помилка": "#процесуальні_помилки",
    "інструкція": "#інструкція",
    "порада": "#порада",
}
SHOW_PREVIEW = os.environ.get("BOT_SHOW_PREVIEW", "1").strip() not in ("0", "false", "no")
DRY_RUN = os.environ.get("BOT_DRY_RUN", "").strip() in ("1", "true", "yes")
# Фільтрувати ЗАГАЛЬНІ стрічки за правовою релевантністю (типово увімкнено).
FILTER_GENERAL = os.environ.get("BOT_FILTER_GENERAL", "1").strip() not in ("0", "false", "no")


def load_feeds():
    """Повертає список (джерело, url, scope). scope: 'general' — загальні
    новини (фільтруються за правовою релевантністю), інакше 'legal' — юридичні
    стрічки (публікуються без фільтра). Третя колонка в рядку необов'язкова:
    `Джерело | https://... | general`."""
    feeds = []
    if not os.path.exists(FEEDS_FILE):
        return feeds
    for line in open(FEEDS_FILE, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "|" in line:
            parts = [p.strip() for p in line.split("|")]
            cat, url = parts[0], parts[1]
            scope = parts[2].lower() if len(parts) > 2 and parts[2] else "legal"
            feeds.append((cat, url, scope))
        else:
            feeds.append(("Новини", line, "legal"))
    return feeds


def load_state():
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            st = json.load(f)
            st.setdefault("seen", [])
            st.setdefault("day", "")
            st.setdefault("count", 0)
            st.setdefault("total", 0)
            st.setdefault("seq", 0)
            st.setdefault("orig_recent", [])
            st.setdefault("pending", {})        # чернетки, що чекають рішення (кнопки)
            st.setdefault("update_offset", 0)   # offset для getUpdates
            st.setdefault("last_content_ts", 0)  # коли востаннє постили контент
            st.setdefault("awaiting_edit", "")  # id чернетки, для якої чекаємо новий текст
            st.setdefault("stats", {"generated": 0, "published": 0, "edited": 0, "rejected": 0})
            st.setdefault("decisions", [])      # історія рішень (останні 100)
            return st
    except Exception:
        return {"seen": [], "day": "", "count": 0, "total": 0, "seq": 0,
                "orig_recent": [], "pending": {}, "update_offset": 0,
                "last_content_ts": 0, "awaiting_edit": "",
                "stats": {"generated": 0, "published": 0, "edited": 0, "rejected": 0},
                "decisions": []}


def save_state(st):
    os.makedirs(STATE_DIR, exist_ok=True)
    st["seen"] = st["seen"][-SEEN_KEEP:]
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False, indent=0)


def today_kyiv():
    # Київ = UTC+2/+3; для добового ліміту достатньо UTC+3
    return (datetime.datetime.utcnow() + datetime.timedelta(hours=3)).strftime("%Y-%m-%d")


def clean(text, limit):
    text = re.sub(r"<[^>]+>", "", text or "")   # прибрати HTML-теги
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > limit:
        text = text[:limit - 1].rstrip() + "…"
    return text


def esc(t):
    return html.escape(t or "", quote=False)


# Тематичні рубрики: якщо у заголовку/описі трапляється ключове слово —
# до поста додається відповідний хештег (для навігації в каналі).
# Порядок = пріоритет; до поста додаємо не більше MAX_TAGS тегів.
TOPIC_TAGS = [
    ("#сімейне_право",   ("розлуч", "шлюб", "алімент", "опік", "усиновл", "поділ майн", "спільн майн", "батьківств", "подружж")),
    ("#автоправо",       ("дтп", "ст. 130", "стаття 130", "купап", "водійськ", "керування у стані", "нетверез")),
    ("#трудове_право",   ("звільнен", "трудов", "працівник", "роботодав", "зарплат", "мобіліз", "військов")),
    ("#кримінальне",     ("кримінальн", "злочин", "підозрюв", "слідств", "вирок", "запобіжн")),
    ("#нерухомість",     ("нерухом", "спадщин", "оренд", "земельн", "квартир")),
    ("#бізнес_право",    ("фоп", "банкрутств", "господарськ", "ліценз", "реєстрація бізнес", "тов ")),
    ("#податки",         ("податк", "дпс", "єдиний податок", "пдв", "мито")),
    ("#соцвиплати",      ("субсиді", "пенсі", "соціальн виплат", "соціальна допомог", "виплат")),
    ("#судова_практика", ("верховн суд", "рішення суду", "апеляц", "касац", "судова практика", "позов", "суд ")),
    ("#законодавство",   ("верховна рада", "кабмін", "законопроєкт", "ухвалив закон", "набирає чинності",
                          "постанова кму", "указ президент", "закон")),
]
MAX_TAGS = 2


def classify(title, desc):
    text = (str(title) + " " + str(desc)).lower()
    tags = []
    for tag, kws in TOPIC_TAGS:
        if any(k in text for k in kws):
            tags.append(tag)
        if len(tags) >= MAX_TAGS:
            break
    return tags or ["#новини"]


# Фільтр правової релевантності для ЗАГАЛЬНИХ стрічок: новина потрапляє в канал
# лише якщо в заголовку/описі є правовий контекст. Юридичні стрічки й ваші
# статті проходять без фільтра. Ширший за TOPIC_TAGS, щоб ловити правові теми.
LEGAL_HINTS = (
    "суд", "закон", "право", "адвокат", "юрист", "прокур", "поліці", "кодекс",
    "кримінал", "позов", "апеляц", "касац", "верховн суд", "конституційн",
    "вирок", "штраф", "санкці", "норматив", "постанов", "указ", "мін'юст",
    "міністерство юстиц", "законопроєкт", "законопроект", "рада ухвалила",
    "набува", "набира", "правоохорон", "слідств", "підозр", "обвинувач",
    "алімент", "спадщин", "розлуч", "звільнен", "трудов", "податк", "мобіліз",
    "тцк", "виконавч провадж", "нотаріус", "реєстрац", "ліценз", "оскарж",
    "компенсац", "відшкодув", "договір", "спадкоєм", "субсиді", "пенсі",
)


def is_legal_relevant(title, desc):
    text = (str(title) + " " + str(desc)).lower()
    return any(k in text for k in LEGAL_HINTS)


def _fetch_raw(url):
    """Повертає сирі байти стрічки через urllib із браузерними заголовками."""
    import urllib.request
    req = urllib.request.Request(url, headers={"User-Agent": UA, **FEED_HEADERS})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.read()


def _sanitize_xml(raw):
    """Лагодить типові дефекти фідів, на яких падає суворий XML-парсер:
    сирі амперсанди (`&` не в межах сутності) і керуючі символи."""
    try:
        text = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)
    except Exception:
        return raw
    text = re.sub(r"&(?!#?\w+;)", "&amp;", text)                 # голі &
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", text)     # керуючі символи
    return text


def fetch_feed(url):
    """Читає RSS з браузерними заголовками. Якщо feedparser не впорався,
    пробуємо: (1) сирі байти через urllib; (2) ті ж байти після санітизації
    (лагодимо биті амперсанди/символи). Це рятує частину «not well-formed»."""
    fp = feedparser.parse(url, agent=UA, request_headers=dict(FEED_HEADERS))
    if not (getattr(fp, "bozo", 0) and not fp.entries):
        return fp
    try:
        raw = _fetch_raw(url)
    except Exception:
        return fp
    fp2 = feedparser.parse(raw)
    if fp2.entries:
        return fp2
    fp3 = feedparser.parse(_sanitize_xml(raw))
    if fp3.entries:
        return fp3
    return fp


SUMMARY_SYS = (
    "Ти — редактор українського Telegram-каналу «Про право простою мовою» для "
    "звичайних людей без юридичної освіти. Тема — будь-яка сфера права (сімейне, "
    "трудове, кримінальне, цивільне, адміністративне тощо), не лише одна. На основі "
    "заголовка й опису підготуй практичний, зрозумілий розбір.\n"
    "СТИЛЬ:\n"
    "• Простою, дружньою мовою, без канцеляриту. Абзаци по 2–3 речення. Загалом "
    "стисло (орієнтир — до ~1000 символів на всі поля разом).\n"
    "• Не цитуй норми на пів екрана — поясни своїми словами; сам закон читач "
    "відкриє за посиланням на джерело.\n"
    "• Фокус на практичному сенсі: що це означає для звичайної людини / сторони.\n"
    "ОБМЕЖЕННЯ (важливо):\n"
    "• Не вигадуй фактів: конкретні дати, суми, номери статей, назви органів "
    "наводь лише якщо вони є у наданому тексті; бракує даних — пиши узагальнено.\n"
    "• НЕ обіцяй результату, не давай статистики виграшів/відсотків, не порівнюй "
    "адвокатів. Формулюй у дусі «показую, як це працює», а не «гарантую результат» "
    "(правила реклами адвокатської діяльності).\n"
    "• Пиши про типові конструкції («у практиці трапляється ситуація, коли…»), а "
    "не про конкретну впізнавану справу з датами й судом (адвокатська таємниця).\n"
    "• Порада — загальна й безпечна (на що звернути увагу, строки, зберегти "
    "документи, за потреби — консультація), без категоричних тверджень про "
    "ситуацію читача.\n"
    "Поверни ЛИШЕ JSON без коментарів і markdown:\n"
    '{"about": "2–4 речення: суть простими словами — що сталося і головне", '
    '"impact": "1–2 речення: кого стосується і що змінюється для людини/сторони", '
    '"advice": "1–2 речення: практична порада — на що звернути увагу / що робити"}'
)


def summarize(title, desc, source):
    """Повертає {'about','impact','advice'} простою мовою або None (fallback на опис)."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return None
    try:
        import anthropic
        client = anthropic.Anthropic()
        r = client.messages.create(
            model=SUMMARY_MODEL,
            max_tokens=900,
            system=SUMMARY_SYS,
            messages=[{"role": "user",
                       "content": f"Заголовок: {title}\nОпис: {desc}\nДжерело: {source}"}],
        )
        text = "".join(b.text for b in r.content if getattr(b, "type", "") == "text")
        m = re.search(r"\{.*\}", text, re.S)
        if not m:
            return None
        data = json.loads(m.group(0))
        if data.get("about"):
            return {"about": str(data.get("about", "")).strip(),
                    "impact": str(data.get("impact", "")).strip(),
                    "advice": str(data.get("advice", "")).strip()}
    except Exception as ex:
        print("summary error:", ex)
    return None


def _send(text, chat, with_cta=False):
    """Низькорівнева відправка повідомлення в заданий чат."""
    if DRY_RUN:
        print("[DRY] →", chat, "| кнопка:", CONTACT_LABEL if with_cta else "—",
              "|", text.split("\n")[0][:70])
        return True
    api = f"https://api.telegram.org/bot{TOKEN}/sendMessage"
    params = {
        "chat_id": chat,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": "false" if SHOW_PREVIEW else "true",
    }
    if with_cta and CONTACT_URL:
        params["reply_markup"] = json.dumps(
            {"inline_keyboard": [[{"text": CONTACT_LABEL, "url": CONTACT_URL}]]},
            ensure_ascii=False)
    data = urllib.parse.urlencode(params).encode()
    try:
        with urllib.request.urlopen(api, data=data, timeout=30) as r:
            return bool(json.load(r).get("ok"))
    except urllib.error.HTTPError as e:
        print("Telegram HTTP error:", e.code, e.read().decode("utf-8", "ignore")[:300])
        return False
    except Exception as e:
        print("Telegram error:", e)
        return False


def tg_call(method, params):
    """Універсальний виклик Telegram Bot API. Повертає розпарсений JSON або None."""
    api = f"https://api.telegram.org/bot{TOKEN}/{method}"
    data = urllib.parse.urlencode(params).encode()
    try:
        with urllib.request.urlopen(api, data=data, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        print(f"Telegram HTTP error ({method}):", e.code,
              e.read().decode("utf-8", "ignore")[:300])
    except Exception as e:
        print(f"Telegram error ({method}):", e)
    return None


def tg_send(item):
    """Пост-новина / стаття (з AI-резюме та посиланням на джерело)."""
    own = "osadko.online" in (item.get("link") or "")   # власна стаття із сайту
    head = "✍️" if own else "📰"
    cta = "Читати статтю" if own else "Читати джерело"
    src = "Адвокат Осадько" if own else item["source"]
    s = summarize(item["title"], item["desc"], src)
    msg = f"{head} <b>{esc(item['title'])}</b>"
    if s:
        msg += f"\n\n{esc(s['about'])}"
        if s.get("impact"):
            msg += f"\n\n💡 <b>Що це означає для вас:</b> {esc(s['impact'])}"
        if s.get("advice"):
            msg += f"\n\n⚖️ <b>Порада:</b> {esc(s['advice'])}"
    elif item["desc"]:
        msg += f"\n\n{esc(item['desc'])}"
    msg += f"\n\n🔗 <a href=\"{esc(item['link'])}\">{cta}</a>"
    if src:
        msg += f" · <i>{esc(src)}</i>"
    msg += "\n\n" + " ".join(classify(item["title"], item["desc"]))
    return _send(msg, CHANNEL, with_cta=bool(item.get("_cta")))


ORIGINAL_SYS = (
    "Ти — автор українського Telegram-каналу «Про право простою мовою» (веде адвокат). "
    "Пишеш ОДИН оригінальний освітній пост заданого типу у заданій сфері права.\n"
    "СТИЛЬ:\n"
    "• Перший рядок — сильний заголовок, зрозумілий ще до «розгорнути».\n"
    "• 600–1200 символів. Абзаци по 2–3 речення. Проста, дружня мова, без канцеляриту.\n"
    "• Емодзі — лише як маркери списку за потреби, не як прикраса. Жодних стін тексту.\n"
    "• Останній рядок природно підводить до думки, що з деталями допоможе адвокат — "
    "БЕЗ прямого «телефонуйте зараз».\n"
    "ОБМЕЖЕННЯ (критично):\n"
    "• Не вигадуй конкретних номерів статей, точних строків, сум чи назв органів. Якщо "
    "згадуєш норму — загально («закон передбачає…»), без цифр, у яких не впевнений. Пиши "
    "про загальні принципи й типові ситуації, а не про конкретну впізнавану справу.\n"
    "• НЕ обіцяй результату, без статистики виграшів і порівнянь адвокатів; дух — "
    "«показую, як це працює», а не «гарантую».\n"
    "У тексті НЕ став хештегів — рубрики додаються автоматично.\n"
    "ФОРМАТ ВІДПОВІДІ (суворо): перший рядок — заголовок. Далі порожній рядок. "
    "Далі — тіло поста (абзаци розділяй порожнім рядком). Жодних JSON, лапок-"
    "огорток, markdown чи службових підписів — лише сам пост."
)


def generate_original(st):
    """Генерує оригінальний пост (міф/помилка/інструкція/порада) або None."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("Немає ANTHROPIC_API_KEY — оригінальний пост не згенеровано.")
        return None
    seq = int(st.get("seq", 0))
    t_name, t_desc = ORIGINAL_TYPES[seq % len(ORIGINAL_TYPES)]
    area = ORIGINAL_AREAS[(seq // len(ORIGINAL_TYPES)) % len(ORIGINAL_AREAS)]
    recent = st.get("orig_recent", [])
    avoid = "; ".join(recent[-8:]) if recent else "—"
    user = (f"Тип поста: {t_name} — {t_desc}\nСфера права: {area}\n"
            f"Уникай тем, близьких до нещодавніх: {avoid}\n"
            "Обери конкретну вузьку тему в межах сфери і напиши пост.")
    try:
        import anthropic
        client = anthropic.Anthropic()
        r = client.messages.create(model=SUMMARY_MODEL, max_tokens=2000,
                                    system=ORIGINAL_SYS,
                                    messages=[{"role": "user", "content": user}])
        text = "".join(b.text for b in r.content if getattr(b, "type", "") == "text").strip()
        if not text:
            return None
        # Формат plain-text: 1-й рядок — заголовок, далі порожній рядок і тіло.
        # (Надійніше за JSON — не ламається на переносах рядків.)
        parts = text.split("\n", 1)
        headline = parts[0].strip().strip('"').strip("«»").lstrip("#").strip()
        body = parts[1].strip() if len(parts) > 1 else ""
        # прибрати зайві порожні рядки на початку тіла
        body = re.sub(r"\n{3,}", "\n\n", body).strip()
        if not headline or not body:
            return None
        # єдиний стиль хештегів (з підкресленнями): рубрика сфери + тип поста
        tags = [t for t in (AREA_TAGS.get(area), TYPE_TAGS.get(t_name)) if t]
        return {"type": t_name, "area": area,
                "headline": headline, "body": body, "tags": tags}
    except Exception as ex:
        print("original gen error:", ex)
        return None


def render_original(o):
    """Готовий текст авторського поста (заголовок + тіло + хештеги)."""
    msg = f"<b>{esc(o['headline'])}</b>\n\n{esc(o['body'])}"
    if o.get("tags"):
        msg += "\n\n" + " ".join(o["tags"])
    return msg


def post_original(o, chat, with_cta=False, review=False):
    msg = render_original(o)
    if review:
        msg = ("🧪 <b>ЧЕРНЕТКА — перевірте перед публікацією.</b>\n"
               f"<i>тип: {esc(o['type'])} · {esc(o['area'])}</i>\n\n") + msg
    return _send(msg, chat, with_cta=with_cta)


def _parse_post_text(text):
    """Розбирає текст поста: 1-й рядок — заголовок, далі — тіло."""
    text = (text or "").strip()
    parts = text.split("\n", 1)
    headline = parts[0].strip().strip('"').strip("«»").lstrip("#").strip()
    body = parts[1].strip() if len(parts) > 1 else ""
    body = re.sub(r"\n{3,}", "\n\n", body).strip()
    return headline, body


def _draft_keyboard(pid):
    return {"inline_keyboard": [
        [{"text": "✅ Опублікувати в канал", "callback_data": f"pub:{pid}"}],
        [{"text": "✏️ Редагувати", "callback_data": f"edit:{pid}"},
         {"text": "🗑 Відхилити", "callback_data": f"rej:{pid}"}],
    ]}


def _send_draft_message(draft, st, pid, header=""):
    """Надсилає (чи повторно надсилає) повідомлення-чернетку з кнопками
    [✅ Опублікувати] [✏️ Редагувати] [🗑 Відхилити] і оновлює запис у st['pending'].
    draft — dict із headline/body/tags/type/area."""
    body_text = render_original(draft)
    text = (header + "🧪 <b>ЧЕРНЕТКА — перевірте перед публікацією.</b>\n"
            f"<i>тип: {esc(draft['type'])} · {esc(draft['area'])}</i>\n\n") + body_text
    resp = tg_call("sendMessage", {
        "chat_id": REVIEW_CHAT, "text": text, "parse_mode": "HTML",
        "disable_web_page_preview": "true",
        "reply_markup": json.dumps(_draft_keyboard(pid), ensure_ascii=False),
    })
    if not (resp and resp.get("ok")):
        return False
    mid = resp["result"]["message_id"]
    pend = st.setdefault("pending", {})
    rec = pend.get(pid, {})
    rec.update({"headline": draft["headline"], "body": draft["body"],
                "tags": draft.get("tags", []), "type": draft["type"], "area": draft["area"],
                "review_chat": REVIEW_CHAT, "review_msg": mid, "text": body_text})
    pend[pid] = rec
    # не даємо переліку розростатися нескінченно
    if len(pend) > 50:
        for k in sorted(pend)[:-50]:
            pend.pop(k, None)
    return True


def send_review_draft(o, st):
    """Створює чернетку авторського поста у чаті перевірки (з кнопками)."""
    pid = str(int(time.time() * 1000))          # унікальний id чернетки
    if DRY_RUN:
        print("[DRY] чернетка →", REVIEW_CHAT, "|", o["headline"][:60])
        return True
    ok = _send_draft_message(o, st, pid)
    if ok:
        _bump_stat(st, "generated")
    return ok


def register_with_worker(o):
    """Режим вебхука: реєструє чернетку у Cloudflare Worker, який сам надішле її
    в чат перевірки з кнопками й миттєво реагуватиме на натискання."""
    if DRY_RUN:
        print("[DRY] чернетка → worker:", o["headline"][:60])
        return True
    try:
        payload = json.dumps({"headline": o["headline"], "body": o["body"],
                              "tags": o.get("tags", []), "type": o["type"],
                              "area": o["area"]}).encode()
        req = urllib.request.Request(
            WORKER_URL.rstrip("/") + "/register", data=payload,
            headers={"Content-Type": "application/json", "X-Auth-Token": WORKER_SECRET})
        with urllib.request.urlopen(req, timeout=30) as r:
            return bool(json.load(r).get("ok"))
    except Exception as e:
        print("worker register error:", e)
        return False


def deliver_draft(o, st):
    """Доставляє чернетку на перевірку: через Worker (миттєві кнопки) або
    напряму через бот (опитування getUpdates)."""
    if WORKER_URL:
        return register_with_worker(o)
    return send_review_draft(o, st)


def _bump_stat(st, key):
    stats = st.setdefault("stats", {"generated": 0, "published": 0,
                                    "edited": 0, "rejected": 0})
    stats[key] = stats.get(key, 0) + 1


def _log_decision(st, action, draft):
    log = st.setdefault("decisions", [])
    log.append({"ts": int(time.time()), "action": action,
                "type": draft.get("type", ""), "area": draft.get("area", ""),
                "headline": (draft.get("headline", "") or "")[:80]})
    st["decisions"] = log[-100:]      # тримаємо історію останніх 100 рішень


def stats_text(st):
    s = st.setdefault("stats", {"generated": 0, "published": 0,
                                "edited": 0, "rejected": 0})
    pend = len(st.get("pending", {}))
    return ("📊 <b>Статистика авторських постів</b>\n"
            f"• Згенеровано чернеток: {s.get('generated', 0)}\n"
            f"• Опубліковано: {s.get('published', 0)}\n"
            f"• Відредаговано: {s.get('edited', 0)}\n"
            f"• Відхилено: {s.get('rejected', 0)}\n"
            f"• Чекають рішення: {pend}\n"
            f"• Новин у каналі (всього постів): {int(st.get('total', 0))}")


def process_approvals(st):
    """Опитує оновлення (getUpdates): натискання кнопок під чернетками
    (опублікувати / редагувати / відхилити), надісланий виправлений текст
    та команду /stats. Викликається щоразу — тому реакція швидка."""
    if WORKER_URL:
        return   # кнопки обробляє Cloudflare Worker (вебхук); getUpdates не чіпаємо
    if DRY_RUN or not TOKEN:
        return
    resp = tg_call("getUpdates", {"offset": int(st.get("update_offset", 0)),
                                  "timeout": 0, "limit": 50})
    if not (resp and resp.get("ok")):
        return
    updates = resp.get("result", [])
    if not updates:
        return
    pend = st.setdefault("pending", {})
    handled = 0
    for upd in updates:
        st["update_offset"] = upd["update_id"] + 1
        cq = upd.get("callback_query")
        m = upd.get("message")

        # --- натискання кнопок під чернеткою ---
        if cq:
            data = cq.get("data", "") or ""
            msg = cq.get("message", {}) or {}
            chat = (msg.get("chat") or {}).get("id")
            mid = msg.get("message_id")
            action, _, pid = data.partition(":")
            draft = pend.get(pid)
            if action == "pub":
                if not draft:
                    tg_call("answerCallbackQuery", {"callback_query_id": cq["id"],
                            "text": "Чернетку не знайдено (уже оброблена)."})
                    continue
                total = int(st.get("total", 0))
                cta = CTA_EVERY > 0 and ((total + 1) % CTA_EVERY == 0)
                if _send(draft["text"], CHANNEL, with_cta=cta):
                    st["total"] = total + 1
                    _bump_stat(st, "published")
                    _log_decision(st, "published", draft)
                    pend.pop(pid, None)
                    tg_call("answerCallbackQuery", {"callback_query_id": cq["id"],
                            "text": "Опубліковано в канал ✅"})
                    if chat and mid:
                        tg_call("editMessageText", {
                            "chat_id": chat, "message_id": mid, "parse_mode": "HTML",
                            "disable_web_page_preview": "true",
                            "text": "✅ <b>Опубліковано в канал</b>\n\n" + draft["text"]})
                    handled += 1
                else:
                    tg_call("answerCallbackQuery", {"callback_query_id": cq["id"],
                            "text": "Не вдалося опублікувати, спробуйте ще раз."})
            elif action == "rej":
                if draft:
                    _bump_stat(st, "rejected")
                    _log_decision(st, "rejected", draft)
                pend.pop(pid, None)
                tg_call("answerCallbackQuery", {"callback_query_id": cq["id"],
                        "text": "Відхилено 🗑"})
                if draft and chat and mid:
                    tg_call("editMessageText", {
                        "chat_id": chat, "message_id": mid, "parse_mode": "HTML",
                        "disable_web_page_preview": "true",
                        "text": "🗑 <b>Відхилено</b>\n\n" + draft["text"]})
                handled += 1
            elif action == "edit":
                if not draft:
                    tg_call("answerCallbackQuery", {"callback_query_id": cq["id"],
                            "text": "Чернетку не знайдено (уже оброблена)."})
                    continue
                st["awaiting_edit"] = pid
                tg_call("answerCallbackQuery", {"callback_query_id": cq["id"],
                        "text": "Надішліть виправлений текст"})
                # прибираємо кнопки зі старого повідомлення, щоб не плутатись
                if chat and mid:
                    tg_call("editMessageText", {
                        "chat_id": chat, "message_id": mid, "parse_mode": "HTML",
                        "disable_web_page_preview": "true",
                        "text": "✏️ <b>Редагування…</b> Надішліть новий текст нижче.\n\n"
                                + draft["text"]})
                tg_call("sendMessage", {"chat_id": REVIEW_CHAT, "parse_mode": "HTML",
                        "text": "✏️ Надішліть <b>виправлений текст поста</b> одним "
                                "повідомленням: перший рядок — заголовок, далі — текст "
                                "(хештеги додам сам). Щоб скасувати — /cancel."})
                handled += 1
            continue

        # --- звичайне повідомлення від вас (редагування / команди) ---
        if m:
            chat = (m.get("chat") or {}).get("id")
            if str(chat) != str(REVIEW_CHAT):
                continue
            body = (m.get("text") or "").strip()
            awaiting = st.get("awaiting_edit", "")
            if awaiting:
                if body.lower() in ("/cancel", "cancel", "скасувати"):
                    draft = pend.get(awaiting)
                    st["awaiting_edit"] = ""
                    if draft:                       # повертаємо кнопки без змін
                        _send_draft_message(draft, st, awaiting,
                                            header="↩️ <b>Редагування скасовано.</b>\n\n")
                    handled += 1
                    continue
                draft = pend.get(awaiting)
                if not draft:
                    st["awaiting_edit"] = ""
                    tg_call("sendMessage", {"chat_id": REVIEW_CHAT,
                            "text": "Чернетку не знайдено — редагування скасовано."})
                    continue
                headline, new_body = _parse_post_text(body)
                if not headline or not new_body:
                    tg_call("sendMessage", {"chat_id": REVIEW_CHAT,
                            "text": "Потрібні заголовок (1-й рядок) і текст. "
                                    "Надішліть ще раз або /cancel."})
                    continue
                draft["headline"] = headline
                draft["body"] = new_body
                st["awaiting_edit"] = ""
                _bump_stat(st, "edited")
                _log_decision(st, "edited", draft)
                _send_draft_message(draft, st, awaiting,
                                    header="✏️ <b>Оновлена чернетка.</b>\n\n")
                handled += 1
                continue
            if body.lower() in ("/stats", "статистика"):
                tg_call("sendMessage", {"chat_id": REVIEW_CHAT, "parse_mode": "HTML",
                        "text": stats_text(st)})
                handled += 1
                continue
    if handled:
        print(f"Оброблено подій керування: {handled}.")


def entry_id(e):
    return (getattr(e, "link", "") or getattr(e, "id", "") or getattr(e, "title", "")).strip()


def main():
    if not TOKEN or not CHANNEL:
        print("ERROR: TELEGRAM_BOT_TOKEN / TELEGRAM_CHANNEL не задані (додайте в Secrets).")
        sys.exit(1)
    feeds = load_feeds()
    if not feeds:
        print("ERROR: порожній список стрічок —", FEEDS_FILE)
        sys.exit(1)

    st = load_state()
    d = today_kyiv()
    if st.get("day") != d:
        st["day"] = d
        st["count"] = 0

    # 1) Спершу — обробка натискань кнопок під чернетками (швидко, щоразу).
    process_approvals(st)

    # 2) Контент постимо не частіше, ніж CONTENT_INTERVAL_MIN (запуски бувають
    #    частими заради кнопок, але новини мають виходити в спокійному темпі).
    now = time.time()
    if not FORCE_ORIGINAL and (now - float(st.get("last_content_ts", 0))) < CONTENT_INTERVAL_MIN * 60:
        left = int(CONTENT_INTERVAL_MIN - (now - float(st.get("last_content_ts", 0))) / 60)
        print(f"Ще рано для нового контенту (лишилось ~{max(0, left)} хв). "
              "Кнопки оброблено, вихід.")
        if not DRY_RUN:
            save_state(st)
        return

    seq = int(st.get("seq", 0))

    # Примусова генерація кількох авторських чернеток наперед (workflow:
    # force_original + force_count). Усі йдуть у чат перевірки з кнопками.
    if FORCE_ORIGINAL:
        made = 0
        for _ in range(max(1, FORCE_COUNT)):
            o = generate_original(st)
            if not o:
                break
            seqv = int(st.get("seq", 0))
            if REVIEW_CHAT and not ORIGINAL_AUTOPOST:
                ok, tgt = deliver_draft(o, st), "перевірка"
            elif ORIGINAL_AUTOPOST:
                total = int(st.get("total", 0))
                cta = CTA_EVERY > 0 and ((total + 1) % CTA_EVERY == 0)
                ok, tgt = post_original(o, CHANNEL, with_cta=cta), "канал"
                if ok and not DRY_RUN:
                    st["total"] = total + 1
            else:
                print("Немає TELEGRAM_REVIEW_CHAT і BOT_ORIGINAL_AUTOPOST=0 — "
                      "нікуди слати чернетку.")
                break
            if not ok:
                break
            print(f"Чернетка [{made + 1}] → {tgt}: {o['headline'][:60]}")
            if not DRY_RUN:
                rec = st.get("orig_recent", [])
                rec.append(f"{o['type']}:{o['headline'][:40]}")
                st["orig_recent"] = rec[-20:]
                st["seq"] = seqv + 1
            made += 1
        if made and not DRY_RUN:
            st["last_content_ts"] = now
        print(f"Згенеровано авторських чернеток: {made}.")
        if not DRY_RUN:
            save_state(st)
        return

    # чергування: кожен ORIGINAL_EVERY-й вихід — оригінальний (авторський) пост
    if ORIGINAL_EVERY > 0 and (seq % ORIGINAL_EVERY == 0):
        o = generate_original(st)
        if o:
            if REVIEW_CHAT and not ORIGINAL_AUTOPOST:
                # чернетка з кнопками [✅ Опублікувати] [🗑 Відхилити]
                ok, tgt = deliver_draft(o, st), "перевірка"
            elif ORIGINAL_AUTOPOST:
                total = int(st.get("total", 0))
                cta = CTA_EVERY > 0 and ((total + 1) % CTA_EVERY == 0)
                ok, tgt = post_original(o, CHANNEL, with_cta=cta), "канал"
                if ok and not DRY_RUN:
                    st["total"] = total + 1
            else:
                print("Оригінальний пост згенеровано, але не задано TELEGRAM_REVIEW_CHAT "
                      "і BOT_ORIGINAL_AUTOPOST=0 — публікую новину цього запуску.")
                # зрушуємо чергу, щоб не застрягнути на оригіналі й далі йшли новини
                if not DRY_RUN:
                    st["seq"] = seq + 1
                ok = False
            if ok:
                print(f"Оригінальний пост → {tgt}: {o['headline'][:60]}")
                if not DRY_RUN:
                    rec = st.get("orig_recent", [])
                    rec.append(f"{o['type']}:{o['headline'][:40]}")
                    st["orig_recent"] = rec[-20:]
                    st["seq"] = seq + 1
                    st["last_content_ts"] = now
                    save_state(st)
                return
            print("Оригінальний пост не відправлено — публікую новину цього запуску.")
        else:
            print("Оригінальний пост не готовий — публікую новину цього запуску.")

    remaining_day = max(0, DAILY_MAX - int(st.get("count", 0)))
    print(f"Добовий ліміт: {st['count']}/{DAILY_MAX} (лишилось {remaining_day}).")
    if remaining_day <= 0:
        print("Добовий ліміт вичерпано — нічого не постимо.")
        if not DRY_RUN:
            save_state(st)
        return

    seen = set(st.get("seen", []))
    candidates = []
    skipped_irrelevant = 0
    for source, url, scope in feeds:
        try:
            fp = fetch_feed(url)
            if getattr(fp, "bozo", 0) and not fp.entries:
                print(f"⚠ стрічка недоступна: {source} — {url} ({getattr(fp,'bozo_exception','')})")
                continue
            print(f"✓ {source}: {len(fp.entries)} записів")
            for e in fp.entries[:15]:
                eid = entry_id(e)
                if not eid or eid in seen:
                    continue
                ts = 0
                for k in ("published_parsed", "updated_parsed"):
                    if getattr(e, k, None):
                        ts = time.mktime(getattr(e, k))
                        break
                # пропускаємо застарілі записи (за наявності дати)
                if ts and (time.time() - ts) > MAX_AGE_HOURS * 3600:
                    continue
                title = clean(getattr(e, "title", ""), 200)
                desc = clean(getattr(e, "summary", ""), 300)
                # ЗАГАЛЬНІ стрічки — лише правово релевантні новини (щоб канал
                # лишався «про право», а не дублював загальну політику).
                if FILTER_GENERAL and scope == "general" and not is_legal_relevant(title, desc):
                    skipped_irrelevant += 1
                    continue
                candidates.append({
                    "id": eid, "ts": ts, "source": source,
                    "title": title, "desc": desc,
                    "link": getattr(e, "link", "") or eid,
                })
        except Exception as ex:
            print(f"⚠ помилка стрічки {source} — {url}: {ex}")
    if skipped_irrelevant:
        print(f"Відфільтровано загальних новин без правового контексту: {skipped_irrelevant}.")

    # найсвіжіші зверху
    candidates.sort(key=lambda c: c["ts"], reverse=True)
    limit = min(MAX_PER_RUN, remaining_day)
    to_post = candidates[:limit]
    print(f"Нових кандидатів: {len(candidates)}; постимо цього запуску: {len(to_post)}.")

    posted = 0
    for c in to_post:
        if not c["title"]:
            continue
        total = int(st.get("total", 0))
        c["_cta"] = CTA_EVERY > 0 and ((total + 1) % CTA_EVERY == 0)
        ok = tg_send(c)
        if ok and not DRY_RUN:
            seen.add(c["id"])
            st["seen"].append(c["id"])
            st["count"] = int(st.get("count", 0)) + 1
            st["total"] = total + 1
            st["seq"] = int(st.get("seq", 0)) + 1
            posted += 1
            time.sleep(3)
        elif ok and DRY_RUN:
            posted += 1
        else:
            print("Не вдалося опублікувати:", c["title"][:60])

    print(f"Опубліковано: {posted}. Разом за добу: {st['count']}/{DAILY_MAX}.")
    if posted and not DRY_RUN:
        st["last_content_ts"] = now   # відлік інтервалу до наступного контенту
    if not DRY_RUN:
        save_state(st)


if __name__ == "__main__":
    main()
