#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Приватний помічник «Практика ВС за запитом» (кілька офіційних джерел).

За темою (VS_QUERY) читає офіційні публікації судів, відбирає матеріали про
постанови/рішення/правові позиції, дотягує текст і робить аналітичний розбір
(AI) — СУВОРО на основі реального опублікованого тексту, з посиланням і
номером справи, як їх подав суд. Нічого не вигадує. Результат надсилає
ПРИВАТНО у TELEGRAM_REVIEW_CHAT.

Джерела:
  • Практика ВС           — supreme.court.gov.ua/supreme/pres-centr/news/
  • Постанови Пленуму ВС  — supreme.court.gov.ua/supreme/pro_sud/postanovi_plenumu/
  • Конституційний Суд    — ccu.gov.ua/news

Режими:
  VS_DRY=1 — розвідка: по кожному джерелу друкує знайдені матеріали й прев'ю
             тексту першої статті. Без AI й надсилання.
  інакше   — повний режим: відбір за темою, розбір, надсилання.

Env: VS_QUERY, VS_DRY, VS_MAX (скільки розборів надіслати, типово 3),
     TELEGRAM_BOT_TOKEN, TELEGRAM_REVIEW_CHAT, ANTHROPIC_API_KEY.
"""
import os
import re
import time
import json
import html as _html
import urllib.request
import urllib.error
import concurrent.futures
from urllib.parse import urljoin

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
HDR = {"User-Agent": UA, "Accept-Language": "uk,en;q=0.8",
       "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
       "Accept-Encoding": "identity"}

# Опис джерел. link_re — які посилання зі стрічки вважати статтями;
# body_scope — контейнер тіла статті (звужуємо, щоб не хапати меню).
SOURCES = [
    {
        "name": "⚖️ Практика ВС",
        "base": "https://supreme.court.gov.ua",
        "listing": "https://supreme.court.gov.ua/supreme/pres-centr/news/",
        "link_re": r'/news/\d+/?',
        "body_scope": r'class="news-open__body"[^>]*>(.*)',
        "date_scope": r'class="news-open__date"[^>]*>(.*?)</div>',
    },
    {
        # Постанови Пленуму — статичний перелік документів; у заголовку лише
        # номер і дата, тож релевантність рахуємо за ТЕКСТОМ (scan_body).
        "name": "⚖️ Постанови Пленуму ВС",
        "base": "https://supreme.court.gov.ua",
        "listing": "https://supreme.court.gov.ua/supreme/pro_sud/postanovi_plenumu/",
        "link_re": r'postanova_plenumu_',
        "body_scope": r'class="container content"[^>]*>(.*)',
        "date_scope": None,
        "scan_body": True,
    },
    {
        "name": "🏛 Конституційний Суд",
        "base": "https://ccu.gov.ua",
        "listing": "https://ccu.gov.ua/news",
        "link_re": r'/novyna/[a-z0-9\-]+',
        "body_scope": r'class="node node-news[^"]*"[^>]*>(.*)',
        "date_scope": None,
    },
]

# Скільки матеріалів щонайбільше з ОДНОГО джерела потрапляє у відповідь.
PER_SOURCE = int(os.environ.get("VS_PER_SOURCE", "2") or "2")
# Джерела зі scan_body (Пленум) читаємо тілами. 0 = сканувати ВЕСЬ архів;
# інакше — обмежити цим числом найсвіжіших. Завантаження — паралельне,
# помірним пулом потоків, щоб не навантажувати сайт суду.
PLENUM_SCAN = int(os.environ.get("VS_PLENUM_SCAN", "0") or "0")
SCAN_WORKERS = max(1, int(os.environ.get("VS_SCAN_WORKERS", "6") or "6"))

QUERY = os.environ.get("VS_QUERY", "").strip()
DRY = os.environ.get("VS_DRY", "").strip() in ("1", "true", "yes")
MAX_ARTICLES = int(os.environ.get("VS_MAX", "5") or "5")


def fetch(url, timeout=30, tries=3):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=HDR)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as ex:
            last = ex
            if i + 1 < tries:
                time.sleep(2 * (i + 1))
    raise last


def decode(raw):
    head = raw[:2000].decode("latin-1", "replace").lower()
    if "utf-8" in head:
        return raw.decode("utf-8", "replace")
    if "1251" in head:
        return raw.decode("cp1251", "replace")
    u = raw.decode("utf-8", "replace")
    return raw.decode("cp1251", "replace") if u.count("�") > 20 else u


def strip_tags(s):
    s = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", s)
    s = re.sub(r"(?s)<[^>]+>", " ", s)
    s = _html.unescape(s)
    return re.sub(r"\s+", " ", s).strip()


def list_articles(html, src):
    items, seen = [], set()
    for m in re.finditer(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', html, re.I | re.S):
        href, inner = m.group(1), strip_tags(m.group(2))
        if not re.search(src["link_re"], href):
            continue
        if len(inner) < 12:
            continue
        # відносні слаги (Пленум) резолвимо саме від адреси стрічки
        url = urljoin(src["listing"], href)
        if url in seen:
            continue
        seen.add(url)
        items.append({"title": inner, "url": url, "src": src["name"]})
    return items


def article_text(html, src):
    scope = html
    if src.get("body_scope"):
        m = re.search("(?is)" + src["body_scope"], html)
        if m:
            scope = m.group(1)
    # абзаци й пункти переліку (операційна частина постанов — у <li>)
    paras = re.findall(r'(?is)<(p|li)[^>]*>(.*?)</\1>', scope)
    good = [t for t in (strip_tags(raw) for _tag, raw in paras) if len(t) >= 40]
    txt = re.sub(r"\s+", " ", " ".join(good)).strip()
    return txt if len(txt) >= 120 else strip_tags(scope)


def article_date(html, src):
    if not src.get("date_scope"):
        return ""
    m = re.search("(?is)" + src["date_scope"], html)
    return strip_tags(m.group(1)) if m else ""


def relevance(text, query):
    q = [w for w in re.split(r"\W+", query.lower()) if len(w) > 3]
    if not q:
        return 0
    low = text.lower()
    return sum(low.count(w) for w in q)


def tg_send(text):
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat = os.environ.get("TELEGRAM_REVIEW_CHAT", "").strip()
    if not (token and chat):
        print("Немає TELEGRAM_BOT_TOKEN/REVIEW_CHAT — не надсилаю.")
        return
    data = json.dumps({"chat_id": chat, "text": text, "parse_mode": "HTML",
                       "disable_web_page_preview": False}).encode("utf-8")
    req = urllib.request.Request("https://api.telegram.org/bot%s/sendMessage" % token,
                                 data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        r.read()


def analyze(title, url, text, src_name):
    import anthropic
    client = anthropic.Anthropic()
    sys_prompt = (
        "Ти — помічник адвоката. Тобі дають РЕАЛЬНИЙ текст офіційної публікації "
        f"суду ({src_name}) про його рішення/постанову. Зроби стислий розбір "
        "УКРАЇНСЬКОЮ:\n"
        "• Питання: у чому суть спору/правова проблема.\n"
        "• Позиція суду: що фактично вирішено (лише те, що є в тексті).\n"
        "• Практичний висновок: що це означає для сторони.\n"
        "СУВОРІ ПРАВИЛА: використовуй ЛИШЕ факти з наданого тексту. Номер справи, "
        "дату, назву палати/органу наводь тільки якщо вони є в тексті. НІЧОГО не "
        "додумуй і не додавай посилань на інші рішення. Якщо в тексті немає "
        "рішення по суті (організаційна новина, анонс, захід) — напиши "
        "'НЕ_РІШЕННЯ'. Стисло, без вступів."
    )
    r = client.messages.create(
        model=os.environ.get("VS_MODEL", "claude-sonnet-5"),
        max_tokens=700,
        system=sys_prompt,
        messages=[{"role": "user",
                   "content": f"Заголовок: {title}\nДжерело: {url}\n\nТекст:\n{text[:6000]}"}],
    )
    return "".join(b.text for b in r.content if getattr(b, "type", "") == "text").strip()


def gather():
    """Збирає статті з усіх джерел (title, url, src, _html лениво не тягнемо)."""
    all_items = []
    for src in SOURCES:
        try:
            html = decode(fetch(src["listing"]))
            items = list_articles(html, src)
            for it in items:
                it["_src"] = src
            all_items.extend(items)
            print(f"{src['name']}: знайдено {len(items)}")
        except Exception as ex:
            print(f"{src['name']}: помилка стрічки — {ex}")
    return all_items


def _scan_body(it, src, query):
    """Завантажує тіло однієї постанови, витягує текст і рахує релевантність.
    Викликається паралельно; коротший таймаут, щоб одна сторінка не блокувала пул."""
    try:
        art = decode(fetch(it["url"], timeout=15))
        it["_text"] = article_text(art, src)
        it["_date"] = article_date(art, src)
        it["_score"] = relevance(it["_text"], query)
    except Exception as ex:
        print("скан тіла не вдався", it["url"], ex)
        it["_score"] = 0
    return it


def select(items, query):
    """Відбирає найрелевантніші матеріали з кожного джерела.

    Для звичайних джерел (ВС, КСУ) релевантність — за заголовком.
    Для джерел зі scan_body (Пленум) заголовок неінформативний (лише номер/дата),
    тож вантажимо тіло постанов і рахуємо релевантність за текстом, кешуючи текст
    у it['_text'] (щоб не тягнути двічі). За замовчуванням скануємо ВЕСЬ архів
    (цінні — старіші, змістовні постанови), паралельно пулом потоків. З кожного
    джерела беремо щонайбільше PER_SOURCE матеріалів; далі — ліміт MAX_ARTICLES."""
    picked = []
    for src in SOURCES:
        sub = [it for it in items if it["_src"] is src]
        if src.get("scan_body"):
            pool = sub if PLENUM_SCAN <= 0 else sub[:PLENUM_SCAN]
            print(f"{src['name']}: сканую тіла {len(pool)} постанов "
                  f"({SCAN_WORKERS} потоків)…")
            with concurrent.futures.ThreadPoolExecutor(max_workers=SCAN_WORKERS) as pex:
                list(pex.map(lambda it: _scan_body(it, src, query), pool))
            scored = sorted((it for it in pool if it.get("_score", 0) > 0),
                            key=lambda it: it["_score"], reverse=True)
        else:
            for it in sub:
                it["_score"] = relevance(it["title"], query)
            scored = sorted((it for it in sub if it["_score"] > 0),
                            key=lambda it: it["_score"], reverse=True)
        top = scored[:PER_SOURCE]
        print(f"{src['name']}: релевантних {len(scored)}, беремо {len(top)}")
        picked.extend(top)
    picked.sort(key=lambda it: it["_score"], reverse=True)
    return picked[:MAX_ARTICLES]


def main():
    items = gather()

    if DRY:
        print("\n=== РОЗВІДКА (VS_DRY) ===")
        for src in SOURCES:
            sub = [it for it in items if it["_src"] is src][:5]
            print(f"\n### {src['name']} — {len(sub)} прикладів")
            if not sub:
                # діагностика: покажемо сирі посилання зі сторінки
                try:
                    raw = decode(fetch(src["listing"]))
                    hrefs = re.findall(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', raw, re.I | re.S)
                    print("  сирі посилання (перші 14):")
                    for h, t in hrefs[:14]:
                        print(f"    {h}  |  {strip_tags(t)[:50]}")
                except Exception as ex:
                    print("  дамп не вдався:", ex)
                continue
            for it in sub:
                print(f"  • {it['title'][:80]}\n    {it['url']}")
            if sub:
                try:
                    art = decode(fetch(sub[0]["url"]))
                    txt = article_text(art, src)
                    print(f"  прев'ю тексту ({len(txt)} симв.): {txt[:300]}")
                    nums = re.findall(r"№?\s?\d+/\d+/\d+(?:/\d+)?", txt)
                    print(f"  номери справ: {nums[:6]} · дата: {article_date(art, src)}")
                except Exception as ex:
                    print("  прев'ю не вдалося:", ex)
        print("\nГОТОВО (розвідка)")
        return

    if not QUERY:
        print("Порожній VS_QUERY.")
        return
    print(f"Запит: {QUERY!r}")
    top = select(items, QUERY)
    if not top:
        tg_send(f"🔎 <b>Практика судів</b>\nЗа темою «{_html.escape(QUERY)}» серед свіжих "
                f"офіційних публікацій ВС, Пленуму ВС і КСУ нічого релевантного не знайшов. "
                f"Спробуйте іншими словами.")
        print("Нічого релевантного.")
        return

    sent = 0
    for it in top:
        try:
            src = it["_src"]
            # тіло могли вже завантажити на етапі відбору (scan_body)
            txt = it.get("_text")
            date = it.get("_date", "")
            if txt is None:
                art = decode(fetch(it["url"]))
                txt = article_text(art, src)
                date = article_date(art, src)
            if len(txt) < 200:
                continue
            summary = analyze(it["title"], it["url"], txt, src["name"])
            if "НЕ_РІШЕННЯ" in summary:
                continue
            msg = (f"{src['name']} · <b>за темою «{_html.escape(QUERY)}»</b>\n\n"
                   f"<b>{_html.escape(it['title'])}</b>\n"
                   + (f"<i>{_html.escape(date)}</i>\n" if date else "")
                   + f"\n{_html.escape(summary)}\n\n"
                   f"🔗 Джерело: {it['url']}")
            tg_send(msg[:4000])
            sent += 1
        except Exception as ex:
            print("Помилка обробки", it["url"], ex)
    if not sent:
        tg_send(f"🔎 <b>Практика судів</b>\nЗа темою «{_html.escape(QUERY)}» релевантні "
                f"публікації є, але серед них немає розборів рішень по суті.")
    print(f"Надіслано розборів: {sent}")


if __name__ == "__main__":
    main()
