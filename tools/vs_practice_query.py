#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Приватний помічник «Практика ВС за запитом».

За темою (VS_QUERY) читає стрічку новин Верховного Суду
(supreme.court.gov.ua/supreme/pres-centr/news/), відбирає матеріали про
постанови/правові позиції, дотягує текст і робить аналітичний розбір
(AI, Anthropic) — СУВОРО на основі реального опублікованого тексту, з
посиланням і номером справи, як їх подав суд. Нічого не вигадує.
Результат надсилає ПРИВАТНО у TELEGRAM_REVIEW_CHAT.

Режими:
  VS_DRY=1  — лише розвідка структури: друкує знайдені новини (заголовок,
              лінк, дата) і прев'ю тексту першої статті. Без AI й надсилання.
  інакше    — повний режим: відбір за VS_QUERY, розбір, надсилання.

Env: VS_QUERY, VS_DRY, VS_MAX (скільки статей розбирати, типово 3),
     TELEGRAM_BOT_TOKEN, TELEGRAM_REVIEW_CHAT, ANTHROPIC_API_KEY.
"""
import os
import re
import sys
import json
import html as _html
import urllib.request
import urllib.error
from urllib.parse import urljoin

NEWS_URL = "https://supreme.court.gov.ua/supreme/pres-centr/news/"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
HDR = {"User-Agent": UA, "Accept-Language": "uk,en;q=0.8",
       "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
       "Accept-Encoding": "identity"}

QUERY = os.environ.get("VS_QUERY", "").strip()
DRY = os.environ.get("VS_DRY", "").strip() in ("1", "true", "yes")
MAX_ARTICLES = int(os.environ.get("VS_MAX", "3") or "3")


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
                import time
                time.sleep(2 * (i + 1))
    raise last


def decode(raw):
    """Сторінки ВС — здебільшого windows-1251. Визначаємо за <meta charset>
    або за кількістю «замін» при utf-8; інакше — cp1251."""
    head = raw[:2000].decode("latin-1", "replace").lower()
    if "charset=utf-8" in head or "charset=\"utf-8\"" in head:
        return raw.decode("utf-8", "replace")
    if "1251" in head:
        return raw.decode("cp1251", "replace")
    # евристика: пробуємо utf-8, якщо забагато замін — cp1251
    u = raw.decode("utf-8", "replace")
    if u.count("�") > 20:
        return raw.decode("cp1251", "replace")
    return u


def strip_tags(s):
    s = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", s)
    s = re.sub(r"(?s)<[^>]+>", " ", s)
    s = _html.unescape(s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def list_news(html):
    """Витягуємо новини зі сторінки-стрічки: (title, url, date?).
    Гнучко ловимо посилання на детальні сторінки новин."""
    items = []
    seen = set()
    # посилання на детальну новину: .../news/<id>/ з текстом-заголовком
    for m in re.finditer(r'<a[^>]+href="([^"]*/news/\d+/?[^"]*)"[^>]*>(.*?)</a>', html, re.I | re.S):
        href, inner = m.group(1), strip_tags(m.group(2))
        if not inner or len(inner) < 12:
            continue
        url = urljoin(NEWS_URL, href)
        if url in seen:
            continue
        seen.add(url)
        items.append({"title": inner, "url": url})
    return items


def article_text(html):
    """Тіло статті новини ВС — у контейнері <div class="news-open__body">
    (абзаци <p>). Меню/шапка сайту йдуть ДО нього, тож відсікаються."""
    m = re.search(r'(?is)class="news-open__body"[^>]*>(.*)', html)
    scope = m.group(1) if m else html
    paras = re.findall(r'(?is)<p[^>]*>(.*?)</p>', scope)
    good = [t for t in (strip_tags(p) for p in paras) if len(t) >= 40]
    txt = re.sub(r"\s+", " ", " ".join(good)).strip()
    if len(txt) >= 120:
        return txt
    return strip_tags(scope)


def article_date(html):
    m = re.search(r'(?is)class="news-open__date"[^>]*>(.*?)</div>', html)
    return strip_tags(m.group(1)) if m else ""


def relevance(item_text, query):
    q = [w for w in re.split(r"\W+", query.lower()) if len(w) > 3]
    if not q:
        return 0
    low = item_text.lower()
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


def analyze(title, url, text):
    """AI-розбір СУВОРО на основі тексту статті ВС. Без вигадок."""
    import anthropic
    client = anthropic.Anthropic()
    sys_prompt = (
        "Ти — помічник адвоката. Тобі дають РЕАЛЬНИЙ текст новини Верховного Суду "
        "про його ж постанову. Зроби стислий розбір УКРАЇНСЬКОЮ:\n"
        "• Питання: у чому суть спору/правова проблема.\n"
        "• Позиція ВС: що фактично вирішив суд (лише те, що є в тексті).\n"
        "• Практичний висновок: що це означає для сторони.\n"
        "СУВОРІ ПРАВИЛА: використовуй ЛИШЕ факти з наданого тексту. Номер справи, "
        "дату, назву палати наводь тільки якщо вони є в тексті. НІЧОГО не додумуй і "
        "не додавай посилань на інші рішення. Якщо в тексті немає рішення по суті — "
        "напиши: 'НЕ_РІШЕННЯ'. Стисло, без вступів."
    )
    r = client.messages.create(
        model=os.environ.get("VS_MODEL", "claude-sonnet-4-5"),
        max_tokens=700,
        system=sys_prompt,
        messages=[{"role": "user",
                   "content": f"Заголовок: {title}\nДжерело: {url}\n\nТекст:\n{text[:6000]}"}],
    )
    return "".join(b.text for b in r.content if getattr(b, "type", "") == "text").strip()


def main():
    print(f"Читаю стрічку новин ВС: {NEWS_URL}")
    html = decode(fetch(NEWS_URL))
    news = list_news(html)
    print(f"Знайдено новин на сторінці: {len(news)}")

    if DRY:
        print("\n=== РОЗВІДКА СТРУКТУРИ (VS_DRY) ===")
        for i, it in enumerate(news[:15], 1):
            print(f"{i:>2}. {it['title'][:90]}")
            print(f"    {it['url']}")
        for it in news[:3]:
            print(f"\n--- Прев'ю статті: {it['title'][:70]} ---")
            try:
                art = decode(fetch(it["url"]))
                txt = article_text(art)
                print(f"Довжина тексту: {len(txt)} символів")
                print("Початок:", txt[:500])
                nums = re.findall(r"№?\s?\d+/\d+/\d+(?:/\d+)?|справ[аи]\s+№\s?\S+", txt)
                print("Схожі на номери справ:", nums[:8])
                print("Дата:", article_date(art))
            except Exception as ex:
                print("Не вдалося дотягнути статтю:", ex)
        print("\nГОТОВО (розвідка)")
        return

    if not QUERY:
        print("Порожній VS_QUERY — нічого шукати.")
        return
    print(f"Запит: {QUERY!r}")
    ranked = sorted(news, key=lambda it: relevance(it["title"], QUERY), reverse=True)
    top = [it for it in ranked if relevance(it["title"], QUERY) > 0][:MAX_ARTICLES]
    if not top:
        tg_send(f"🔎 <b>Практика ВС</b>\nЗа темою «{_html.escape(QUERY)}» серед свіжих "
                f"новин ВС нічого релевантного не знайшов. Спробуйте іншими словами.")
        print("Нічого релевантного.")
        return

    sent = 0
    for it in top:
        try:
            art = decode(fetch(it["url"]))
            txt = article_text(art)
            if len(txt) < 200:
                continue
            summary = analyze(it["title"], it["url"], txt)
            if "НЕ_РІШЕННЯ" in summary:
                continue
            date = article_date(art)
            msg = (f"⚖️ <b>Практика ВС за темою «{_html.escape(QUERY)}»</b>\n\n"
                   f"<b>{_html.escape(it['title'])}</b>\n"
                   + (f"<i>{_html.escape(date)}</i>\n" if date else "")
                   + f"\n{_html.escape(summary)}\n\n"
                   f"🔗 Джерело: {it['url']}")
            tg_send(msg[:4000])
            sent += 1
        except Exception as ex:
            print("Помилка обробки", it["url"], ex)
    if not sent:
        tg_send(f"🔎 <b>Практика ВС</b>\nЗа темою «{_html.escape(QUERY)}» релевантні новини "
                f"є, але серед них немає розборів рішень по суті.")
    print(f"Надіслано розборів: {sent}")


if __name__ == "__main__":
    main()
