#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Одноразова генерація прикладів оригінальних постів (чернеток) для оцінки якості.
Нічого не публікує — лише друкує в лог. Використовує ту саму логіку, що й бот
(tools/telegram_news_bot.py: generate_original). Потрібен ANTHROPIC_API_KEY.

Запуск: Actions → «Приклади чернеток (Telegram)» → Run workflow.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import telegram_news_bot as bot  # noqa: E402


def main():
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("ПОМИЛКА: не задано ANTHROPIC_API_KEY")
        sys.exit(1)
    try:
        n = max(1, min(8, int(os.environ.get("SAMPLE_COUNT", "4") or "4")))
    except Exception:
        n = 4
    print(f"Модель: {bot.SUMMARY_MODEL} · чернеток: {n}\n")
    for i in range(n):
        # seq*5 дає різні тип+сферу для різноманіття
        o = bot.generate_original({"seq": i * 5, "orig_recent": []})
        print("=" * 64)
        if not o:
            print(f"[{i + 1}] генерація не вдалася (див. помилку вище)")
            continue
        print(f"[{i + 1}] тип: {o['type']}  ·  сфера: {o['area']}")
        print()
        print(o["headline"])
        print()
        print(o["body"])
        print()
        print(" ".join(o["tags"]))
    print("=" * 64)
    print("ГОТОВО")


if __name__ == "__main__":
    main()
