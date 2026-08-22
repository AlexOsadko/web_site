#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Одноразова перевірка «здоров'я» RSS-стрічок: для кожного джерела показує,
скільки записів вдалося прочитати (через ту саму fetch_feed, що й бот).
Нічого не публікує. Запуск: Actions → «Перевірка стрічок (Telegram)».
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import telegram_news_bot as bot  # noqa: E402


def main():
    feeds = bot.load_feeds()
    ok = 0
    print(f"Перевіряю {len(feeds)} стрічок…\n")
    for source, url, scope in feeds:
        try:
            fp = bot.fetch_feed(url)
            n = len(fp.entries)
            if n:
                ok += 1
                print(f"✓ [{scope}] {source}: {n} записів")
            else:
                bz = getattr(fp, "bozo_exception", "")
                print(f"✗ [{scope}] {source}: 0 записів — {bz}")
                # діагностика: що саме віддає сервер + чи рятує санітайзер
                try:
                    import re as _re
                    import feedparser as _fpmod
                    raw = bot._fetch_raw(url)
                    head = raw[:200].decode("utf-8", "replace").replace("\n", " ")
                    print(f"    ↳ {len(raw)} байт; початок: {head!r}")
                    txt = raw.decode("utf-8", "replace")
                    ents = sorted(set(_re.findall(r"&([A-Za-z][A-Za-z0-9]*);", txt)))
                    print(f"    ↳ іменовані сутності: {ents}")
                    san = bot._sanitize_xml(raw)
                    fp3 = _fpmod.parse(san)
                    print(f"    ↳ після санітизації: {len(fp3.entries)} записів; "
                          f"bozo={getattr(fp3, 'bozo_exception', '')}")
                except Exception as fx:
                    print(f"    ↳ діагностика не вдалася: {fx}")
        except Exception as ex:
            print(f"✗ [{scope}] {source}: помилка — {ex}")
    print(f"\nПрацюють: {ok}/{len(feeds)}")


if __name__ == "__main__":
    main()
