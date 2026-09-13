#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Разове перенесення всіх МАЙБУТНІХ засідань у Google Calendar.

Бере накопичений у Worker перелік справ (клієнтів + адвоката) і створює для
кожного майбутнього засідання подію в календарі. Ідемпотентно (детермінований
iCalUID у gcal.add_event) — повторний запуск не дублює події, лише оновлює.

Запускається вручну через workflow «Синхронізація засідань у Google Calendar».
Потрібні секрети: BOT_WORKER_URL, BOT_WORKER_SECRET, GOOGLE_CALENDAR_SA,
GOOGLE_CALENDAR_ID. У логи НЕ виводяться ПІБ/номери справ — лише лічильники.
"""
import court_watch_bot as b
import gcal


def main():
    if not gcal.enabled():
        print("Календар не налаштовано (немає GOOGLE_CALENDAR_SA/ID) — вихід.")
        return
    cli = b.fetch_worker_cases("clients")
    adv = b.fetch_worker_cases("advocate")
    print(f"З Worker отримано справ: клієнтів {len(cli)}, адвоката {len(adv)}")
    items = b.build_report(cli + adv)  # лише майбутні, без дублів, за датою
    print(f"Майбутніх засідань до перенесення: {len(items)}")

    ok = fail = skip = 0
    for rec in items:
        r = gcal.add_event(rec.get("court", ""), rec)
        if r is True:
            ok += 1
        elif r is False:
            fail += 1
        else:
            skip += 1  # без розпізнаної дати
    print(f"Календар: додано/оновлено {ok}, помилок {fail}, пропущено {skip}")


if __name__ == "__main__":
    main()
