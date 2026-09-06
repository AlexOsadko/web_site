#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Одноразовий пробник: перебирає кандидатні адреси RSS для джерел, у яких
стара адреса віддавала 404, і показує, яка адреса реально повертає записи.
Нічого не публікує. Запуск: Actions → «Пробник RSS-адрес (Telegram)».
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import telegram_news_bot as bot  # noqa: E402

CANDIDATES = {
    "Судово-юридична газета (sud.ua)": [
        "https://sud.ua/rss",
        "https://sud.ua/feed",
        "https://sud.ua/rss.xml",
        "https://sud.ua/uk/feed",
        "https://sud.ua/ru/rss",
        "https://sud.ua/uk/rss.xml",
        "https://sud.ua/uk/news/rss",
        "https://sud.ua/index.php/uk/rss",
    ],
    "Закон і Бізнес (zib.com.ua)": [
        "https://zib.com.ua/rss.xml",
        "https://zib.com.ua/rss",
        "https://zib.com.ua/ua/rss",
        "https://zib.com.ua/ua/rss/news.xml",
    ],
    "Ракурс (racurs.ua)": [
        "https://racurs.ua/rss",
        "https://racurs.ua/ua/feed",
        "https://racurs.ua/feed/rss",
        "https://racurs.ua/rss.xml",
    ],
    "ЛІГА:Закон (jurliga)": [
        "https://jurliga.ligazakon.net/rss",
        "https://jurliga.ligazakon.net/news/rss",
        "https://jurliga.ligazakon.net/aktualno/rss",
    ],
    # --- Джерела законодавства (органи влади) ---
    "Верховна Рада (rada.gov.ua)": [
        "https://www.rada.gov.ua/news/rss",
        "https://iportal.rada.gov.ua/news/rss",
        "https://rada.gov.ua/rss",
        "https://www.rada.gov.ua/rss/ovu",
        "https://www.rada.gov.ua/news/rss/all",
    ],
    "Кабінет Міністрів (kmu.gov.ua)": [
        "https://www.kmu.gov.ua/rss",
        "https://www.kmu.gov.ua/rss/news",
        "https://www.kmu.gov.ua/news/rss",
        "https://www.kmu.gov.ua/timeline/rss",
    ],
    "Мінʼюст (minjust.gov.ua)": [
        "https://minjust.gov.ua/rss",
        "https://minjust.gov.ua/news/rss",
        "https://minjust.gov.ua/feed",
        "https://minjust.gov.ua/rss.xml",
    ],
    "Президент (president.gov.ua)": [
        "https://www.president.gov.ua/rss/news.xml",
        "https://www.president.gov.ua/news/rss",
        "https://www.president.gov.ua/rss",
    ],
    "Судова влада (court.gov.ua)": [
        "https://court.gov.ua/press/news/rss",
        "https://court.gov.ua/rss",
        "https://court.gov.ua/press/rss",
    ],
    "Опендатабот блог": [
        "https://opendatabot.ua/blog/rss",
        "https://opendatabot.ua/rss",
        "https://opendatabot.ua/blog/feed",
    ],
    # --- НОВІ кандидати: додаткові українські юридичні джерела ---
    "Конституційний Суд (ccu.gov.ua)": [
        "https://ccu.gov.ua/rss.xml",
        "https://ccu.gov.ua/uk/rss.xml",
        "https://ccu.gov.ua/rss",
        "https://ccu.gov.ua/novyny/rss",
        "https://ccu.gov.ua/uk/rss",
    ],
    "Верховний Суд (supreme.court.gov.ua)": [
        "https://supreme.court.gov.ua/supreme/pres-centr/news/rss/",
        "https://supreme.court.gov.ua/rss",
        "https://supreme.court.gov.ua/supreme/rss",
    ],
    "НААУ — адвокати (unba.org.ua)": [
        "https://unba.org.ua/rss",
        "https://unba.org.ua/news?format=feed&type=rss",
        "https://unba.org.ua/feed",
        "https://unba.org.ua/news/rss",
    ],
    "Google News — право (UA, укр.)": [
        "https://news.google.com/rss/search?q=%28%D0%B0%D0%B4%D0%B2%D0%BE%D0%BA%D0%B0%D1%82%20OR%20%D1%81%D1%83%D0%B4%20OR%20%D0%B7%D0%B0%D0%BA%D0%BE%D0%BD%20OR%20%D0%BF%D1%80%D0%B0%D0%B2%D0%BE%29%20when%3A2d&hl=uk&gl=UA&ceid=UA:uk",
    ],
    "Слово і Діло (slovoidilo.ua)": [
        "https://www.slovoidilo.ua/rss/all.xml",
        "https://slovoidilo.ua/rss/all.xml",
        "https://www.slovoidilo.ua/rss.xml",
        "https://slovoidilo.ua/feed",
    ],
    "Українське право (ukrainepravo.com)": [
        "https://ukrainepravo.com/feed/",
        "https://ukrainepravo.com/rss/",
        "https://ukrainepravo.com/feed/rss/",
    ],
    "ЛІГА:Закон — новини (ligazakon.net)": [
        "https://news.ligazakon.net/rss",
        "https://ligazakon.net/rss",
        "https://biz.ligazakon.net/rss",
    ],
}


def main():
    for name, urls in CANDIDATES.items():
        print("=" * 60)
        print(name)
        best = None
        for u in urls:
            try:
                fp = bot.fetch_feed(u)
                n = len(fp.entries)
                mark = "✓" if n else "✗"
                print(f"  {mark} {n:>3} — {u}")
                if n and best is None:
                    best = (u, n)
            except Exception as ex:
                print(f"  ✗   ERR — {u} ({ex})")
        if best:
            print(f"  → РОБОЧА: {best[0]} ({best[1]} записів)")
        else:
            print("  → жодна адреса не спрацювала")
    print("=" * 60)
    print("ГОТОВО")


if __name__ == "__main__":
    main()
