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
                # діагностика: що саме віддає сервер (перші ~200 символів)
                try:
                    raw = bot._fetch_raw(url)
                    head = raw[:200].decode("utf-8", "replace").replace("\n", " ")
                    print(f"    ↳ {len(raw)} байт; початок: {head!r}")
                except Exception as fx:
                    print(f"    ↳ не вдалося завантажити сирі байти: {fx}")
        except Exception as ex:
            print(f"✗ [{scope}] {source}: помилка — {ex}")
    print(f"\nПрацюють: {ok}/{len(feeds)}")


if __name__ == "__main__":
    main()
