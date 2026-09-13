#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Разова діагностика: чому бот не показує засідання у конкретному суді/даті.

Env:
  DIAG_CODE    — код суду (типово 1015 — Києво-Святошинський).
  DIAG_DATE    — дата (типово 17.09.2026).
  DIAG_SURNAME — прізвище для пошуку (типово Осадько).

У ПУБЛІЧНІ логи виводимо ЛИШЕ форму написання прізвища адвоката (його власне
ім'я — не таємниця) і булеві прапорці збігу. Клієнтів/номери справ НЕ друкуємо.
"""
import os
import re

import court_watch_bot as b

CODE = os.environ.get("DIAG_CODE", "1015").strip()
DATE = os.environ.get("DIAG_DATE", "17.09.2026").strip()
SUR = os.environ.get("DIAG_SURNAME", "Осадько").strip()
FULL = b.ADVOCATE_NAME

name_re = re.compile(SUR + r"(?:\s+[А-ЯІЇЄҐ][А-Яа-яІЇЄҐіїєґ.ʼ’']*){0,2}")


def main():
    url = f"https://court.gov.ua/sud{CODE}/gromadyanam/csz"
    print(f"Суд sud{CODE} · шукаю дату {DATE} · прізвище {SUR}")
    print(f"Повне ПІБ під наглядом: «{FULL}»")
    recs = b.fetch_court_retry(url)
    print("Усього засідань у суді:", len(recs))

    on_date = [r for r in recs if (r.get("date") or "").startswith(DATE)]
    print(f"Засідань на {DATE}:", len(on_date))

    # Як прізвище пишеться в цьому суді загалом (усі форми) + чи ловить повний матч
    forms = {}
    for r in recs:
        for m in name_re.findall(r.get("involved", "") or ""):
            forms[m.strip()] = forms.get(m.strip(), 0) + 1
    print(f"Форми написання «{SUR}» у цьому суді (як бачить сайт):")
    for f, c in sorted(forms.items(), key=lambda x: -x[1])[:15]:
        ok = b.name_matches(f, [FULL]) is not None
        print(f"   [{c:3d}] «{f}»  → повний-ПІБ-матч: {ok}")

    # Конкретно на потрібну дату
    print(f"--- Записи на {DATE}, де є «{SUR}» ---")
    found = 0
    for r in on_date:
        inv = r.get("involved", "") or ""
        if SUR in inv:
            found += 1
            frags = name_re.findall(inv)
            full_ok = b.name_matches(inv, [FULL]) is not None
            print(f"   час: {r.get('date')} · форма імені: {frags} · "
                  f"бот-би-зматчив(повне ПІБ): {full_ok}")
    if not found:
        print(f"   на {DATE} згадок «{SUR}» не знайдено взагалі.")


if __name__ == "__main__":
    main()
