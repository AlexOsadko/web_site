#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Щоденна добірка судової практики — у ПРИВАТНИЙ канал адвоката.

Раз на день читає офіційні публікації (Практика ВС, Постанови Пленуму ВС,
Конституційний Суд), бере лише НОВІ матеріали (яких ще не було в каналі),
AI відбирає 1–3 найкорисніші для практики адвоката і робить розбір СУВОРО
за реальним текстом публікації — з номером справи й посиланням, як їх подав суд.
Якщо нічого вартого немає — бот мовчить.

Пріоритет тем: ст. 130 КУпАП і адмінпроцес, сімейне право, кримінальний
процес; решта галузей — якщо рішення справді важливе для практики.

Стан (які матеріали вже розглянуто) — у .practice-bot/state.json, воркфлоу
комітить його назад у репозиторій.

Env: TELEGRAM_BOT_TOKEN, PRACTICE_CHAT (id приватного каналу, напр. -100…),
     ANTHROPIC_API_KEY, PRACTICE_MAX (типово 3), PRACTICE_DRY ("1" — без AI
     й надсилання, лише показати нові матеріали), PRACTICE_MODEL.
"""
import os
import re
import sys
import json
import time
import html as _html
import datetime
import concurrent.futures
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from vs_practice_query import SOURCES, fetch, decode, list_articles, article_text, article_date  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_DIR = os.path.join(ROOT, ".practice-bot")
STATE_FILE = os.path.join(STATE_DIR, "state.json")

MAX_POSTS = int(os.environ.get("PRACTICE_MAX", "3") or "3")
DRY = os.environ.get("PRACTICE_DRY", "").strip() in ("1", "true", "yes")
MODEL = os.environ.get("PRACTICE_MODEL", "claude-opus-5-5").strip()
MAX_CANDIDATES = 25          # скільки нових матеріалів щонайбільше розглядати за раз
SEEN_KEEP = 5000             # скільки адрес пам'ятати

PRIORITY = ("ст. 130 КУпАП (керування в нетверезому стані) та адміністративний процес; "
            "сімейне право (розлучення, аліменти, поділ майна, діти); кримінальний процес "
            "(затримання, обшуки, докази, запобіжні заходи)")


def load_state():
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"seen": [], "initialized": False}


def save_state(st):
    os.makedirs(STATE_DIR, exist_ok=True)
    st["seen"] = st["seen"][-SEEN_KEEP:]
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False, indent=1)


def tg_send(text):
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat = os.environ.get("PRACTICE_CHAT", "").strip()
    if not (token and chat):
        print("Немає TELEGRAM_BOT_TOKEN/PRACTICE_CHAT — не надсилаю.")
        return False
    data = json.dumps({"chat_id": chat, "text": text[:4000], "parse_mode": "HTML",
                       "link_preview_options": {"is_disabled": True}}).encode("utf-8")
    req = urllib.request.Request("https://api.telegram.org/bot%s/sendMessage" % token,
                                 data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read()).get("ok", False)
    except Exception as ex:
        print("Telegram: не вдалося надіслати —", ex)
        return False


def ask_claude(system, user, max_tokens=2000):
    """Один запит до Claude. Повертає текст відповіді або '' (відмова/помилка)."""
    import anthropic
    client = anthropic.Anthropic()
    try:
        r = client.beta.messages.create(
            model=MODEL,
            max_tokens=max_tokens,
            output_config={"effort": "medium"},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            system=system,
            messages=[{"role": "user", "content": user}],
        )
    except anthropic.RateLimitError:
        print("Claude: ліміт запитів — пропускаю.")
        return ""
    except anthropic.APIStatusError as ex:
        print(f"Claude: помилка API {ex.status_code} — {ex.message}")
        return ""
    except anthropic.APIConnectionError:
        print("Claude: немає з'єднання.")
        return ""
    if r.stop_reason == "refusal":
        print("Claude: відмова — пропускаю.")
        return ""
    return "".join(b.text for b in r.content if getattr(b, "type", "") == "text").strip()


def gather_new(st):
    """Нові (ще не розглянуті) матеріали з усіх джерел."""
    seen = set(st["seen"])
    fresh = []
    for src in SOURCES:
        try:
            items = list_articles(decode(fetch(src["listing"])), src)
        except Exception as ex:
            print(f"{src['name']}: помилка стрічки — {ex}")
            continue
        new = [it for it in items if it["url"] not in seen]
        for it in new:
            it["_src"] = src
        print(f"{src['name']}: у стрічці {len(items)}, нових {len(new)}")
        fresh.extend(new)
    return fresh


def load_text(it):
    try:
        raw = decode(fetch(it["url"], timeout=20))
        it["_text"] = article_text(raw, it["_src"])
        it["_date"] = article_date(raw, it["_src"])
    except Exception as ex:
        print("не вдалося завантажити", it["url"], ex)
        it["_text"] = ""
    return it


SELECT_SYS = (
    "Ти — помічник практикуючого адвоката в Україні. Тобі дають перелік СВІЖИХ офіційних "
    "публікацій судів (заголовок і початок тексту). Обери до {n} матеріалів, які містять "
    "рішення/правову позицію суду по суті та мають практичну цінність для адвоката. "
    "Пріоритет: " + PRIORITY + ". З інших галузей права бери лише справді важливі позиції "
    "(зміна практики, відступ від попередньої позиції, роз'яснення Пленуму, рішення КСУ). "
    "Не бери організаційні новини, анонси, заходи, кадрові питання, статистику. "
    "Відповідай ЛИШЕ JSON без пояснень: {{\"picks\": [номери за важливістю]}}; якщо нічого "
    "вартого немає — {{\"picks\": []}}."
)

ANALYZE_SYS = (
    "Ти — помічник адвоката. Тобі дають РЕАЛЬНИЙ текст офіційної публікації суду ({src}) про "
    "його рішення/постанову. Зроби стислий розбір УКРАЇНСЬКОЮ для адвоката-практика, без вступів:\n"
    "Суть: у чому правова проблема (1–2 речення).\n"
    "Позиція суду: що саме вирішено і чому (лише те, що є в тексті).\n"
    "Для практики: як цим скористатися в справах клієнтів (1–3 короткі пункти з «— »).\n"
    "Справа: номер справи, дата, палата/орган — ЛИШЕ якщо вони є в тексті; інакше пропусти рядок.\n"
    "СУВОРІ ПРАВИЛА: використовуй тільки факти з наданого тексту, НІЧОГО не додумуй і не "
    "посилайся на інші рішення. Без Markdown-розмітки (без **, #). Якщо в тексті немає рішення "
    "по суті — відповідай одним словом НЕ_РІШЕННЯ."
)


def pick(cands):
    lines = []
    for i, it in enumerate(cands, 1):
        lines.append(f"{i}. [{it['_src']['name']}] {it['title']}\n{it['_text'][:1200]}")
    out = ask_claude(SELECT_SYS.format(n=MAX_POSTS), "\n\n".join(lines), max_tokens=1500)
    if not out:
        return None                      # помилка/відмова — спробуємо наступного разу
    m = re.search(r"\{.*\}", out, re.S)
    try:
        nums = json.loads(m.group(0)).get("picks", []) if m else []
    except Exception:
        nums = []
    res = []
    for n in nums:
        if isinstance(n, int) and 1 <= n <= len(cands) and cands[n - 1] not in res:
            res.append(cands[n - 1])
    return res[:MAX_POSTS]


def main():
    if not DRY and not (os.environ.get("PRACTICE_CHAT", "").strip() and os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()):
        print("PRACTICE_CHAT або TELEGRAM_BOT_TOKEN не задано — пропускаю запуск (стан не змінюю).")
        return
    st = load_state()
    fresh = gather_new(st)

    # Перший запуск: не вивантажуємо весь архів — запам'ятовуємо наявне,
    # а розглядаємо лише кілька найсвіжіших новин ВС/КСУ (без архіву Пленуму).
    if not st.get("initialized"):
        recent = [it for it in fresh if not it["_src"].get("scan_body")][:12]
        if not DRY:
            st["seen"].extend(it["url"] for it in fresh if it not in recent)
        fresh = recent
        print(f"Перший запуск: архів запам'ятовано, розглядаю {len(fresh)} найсвіжіших.")

    cands = fresh[:MAX_CANDIDATES]
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pex:
        list(pex.map(load_text, cands))
    cands = [it for it in cands if len(it.get("_text", "")) >= 300]
    print(f"Кандидатів із текстом: {len(cands)}")

    if DRY:
        for it in cands:
            print(f"  • {it['_src']['name']} | {it['title'][:90]}\n    {it['url']}")
        print("ГОТОВО (розвідка, стан не змінено)")
        return

    sent = 0
    picks = pick(cands) if cands else []
    if picks is None:
        # AI недоступний — кандидатів не позначаємо, розглянемо їх завтра
        keep = {it["url"] for it in cands}
        fresh = [it for it in fresh if it["url"] not in keep]
        picks = []
        print("Відбір не вдався — кандидати лишаються на наступний запуск.")
    if picks:
        for it in picks:
            summary = ask_claude(ANALYZE_SYS.format(src=it["_src"]["name"]),
                                 f"Заголовок: {it['title']}\nДжерело: {it['url']}\n\nТекст:\n{it['_text'][:9000]}")
            if not summary or "НЕ_РІШЕННЯ" in summary:
                continue
            date = it.get("_date", "")
            msg = (f"{it['_src']['name']}" + (f" · {_html.escape(date)}" if date else "") + "\n"
                   f"<b>{_html.escape(it['title'])}</b>\n\n"
                   f"{_html.escape(summary)}\n\n"
                   f"🔗 <a href=\"{_html.escape(it['url'], quote=True)}\">Текст на сайті суду</a>")
            if tg_send(msg):
                sent += 1
                time.sleep(1.5)

    # усе розглянуте (і надіслане, і відкинуте) більше не повертається
    st["seen"].extend(it["url"] for it in fresh)
    st["initialized"] = True
    st["last_run"] = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    st["last_sent"] = sent
    save_state(st)
    print(f"Надіслано розборів: {sent}")


if __name__ == "__main__":
    main()
