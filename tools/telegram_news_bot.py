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
UA = "Mozilla/5.0 (compatible; OsadkoNewsBot/1.0; +https://osadko.online)"

TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
CHANNEL = os.environ.get("TELEGRAM_CHANNEL", "").strip()
MAX_PER_RUN = int(os.environ.get("BOT_MAX_PER_RUN", "1") or "1")
DAILY_MAX = int(os.environ.get("BOT_DAILY_MAX", "15") or "15")
# постимо лише свіже: записи, старші за MAX_AGE_HOURS, ігноруються (щоб не
# «вивалити» весь архів стрічки/сайту при першому запуску)
MAX_AGE_HOURS = int(os.environ.get("BOT_MAX_AGE_HOURS", "72") or "72")
SHOW_PREVIEW = os.environ.get("BOT_SHOW_PREVIEW", "1").strip() not in ("0", "false", "no")
DRY_RUN = os.environ.get("BOT_DRY_RUN", "").strip() in ("1", "true", "yes")


def load_feeds():
    feeds = []
    if not os.path.exists(FEEDS_FILE):
        return feeds
    for line in open(FEEDS_FILE, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "|" in line:
            cat, url = line.split("|", 1)
            feeds.append((cat.strip(), url.strip()))
        else:
            feeds.append(("Новини", line))
    return feeds


def load_state():
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            st = json.load(f)
            st.setdefault("seen", [])
            st.setdefault("day", "")
            st.setdefault("count", 0)
            return st
    except Exception:
        return {"seen": [], "day": "", "count": 0}


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


def tg_send(item):
    own = "osadko.online" in (item.get("link") or "")   # власна стаття із сайту
    head = "✍️" if own else "📰"
    cta = "Читати статтю" if own else "Читати джерело"
    src = "Адвокат Осадько" if own else item["source"]
    msg = f"{head} <b>{esc(item['title'])}</b>"
    if item["desc"]:
        msg += f"\n\n{esc(item['desc'])}"
    msg += f"\n\n🔗 <a href=\"{esc(item['link'])}\">{cta}</a>"
    if src:
        msg += f" · <i>{esc(src)}</i>"
    msg += "\n\n" + " ".join(classify(item["title"], item["desc"]))
    if DRY_RUN:
        print("[DRY] postnu:", item["title"][:80])
        return True
    api = f"https://api.telegram.org/bot{TOKEN}/sendMessage"
    data = urllib.parse.urlencode({
        "chat_id": CHANNEL,
        "text": msg,
        "parse_mode": "HTML",
        "disable_web_page_preview": "false" if SHOW_PREVIEW else "true",
    }).encode()
    try:
        with urllib.request.urlopen(api, data=data, timeout=30) as r:
            j = json.load(r)
            return bool(j.get("ok"))
    except urllib.error.HTTPError as e:
        print("Telegram HTTP error:", e.code, e.read().decode("utf-8", "ignore")[:300])
        return False
    except Exception as e:
        print("Telegram error:", e)
        return False


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
    remaining_day = max(0, DAILY_MAX - int(st.get("count", 0)))
    print(f"Добовий ліміт: {st['count']}/{DAILY_MAX} (лишилось {remaining_day}).")
    if remaining_day <= 0:
        print("Добовий ліміт вичерпано — нічого не постимо.")
        if not DRY_RUN:
            save_state(st)
        return

    seen = set(st.get("seen", []))
    candidates = []
    for source, url in feeds:
        try:
            fp = feedparser.parse(url, agent=UA)
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
                candidates.append({
                    "id": eid, "ts": ts, "source": source,
                    "title": clean(getattr(e, "title", ""), 200),
                    "desc": clean(getattr(e, "summary", ""), 300),
                    "link": getattr(e, "link", "") or eid,
                })
        except Exception as ex:
            print(f"⚠ помилка стрічки {source} — {url}: {ex}")

    # найсвіжіші зверху
    candidates.sort(key=lambda c: c["ts"], reverse=True)
    limit = min(MAX_PER_RUN, remaining_day)
    to_post = candidates[:limit]
    print(f"Нових кандидатів: {len(candidates)}; постимо цього запуску: {len(to_post)}.")

    posted = 0
    for c in to_post:
        if not c["title"]:
            continue
        ok = tg_send(c)
        if ok and not DRY_RUN:
            seen.add(c["id"])
            st["seen"].append(c["id"])
            st["count"] = int(st.get("count", 0)) + 1
            posted += 1
            time.sleep(3)
        elif ok and DRY_RUN:
            posted += 1
        else:
            print("Не вдалося опублікувати:", c["title"][:60])

    print(f"Опубліковано: {posted}. Разом за добу: {st['count']}/{DAILY_MAX}.")
    if not DRY_RUN:
        save_state(st)


if __name__ == "__main__":
    main()
