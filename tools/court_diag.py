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


def _initials(nm):
    """Лише ініціали (у публічних логах ПІБ клієнтів не друкуємо): «Б. С. А.»"""
    return " ".join(w[0].upper() + "." for w in nm.split() if w)


def clients():
    """Режим DIAG_CLIENTS=1: звірити засідання на дату зі списком клієнтів бота.

    У лог — ЛИШЕ ініціали й лічильники (репозиторій публічний)."""
    url = f"https://court.gov.ua/sud{CODE}/gromadyanam/csz"
    names, _ = b.load_config()
    for n in b.fetch_worker_names():
        if n.lower() not in {x.lower() for x in names}:
            names.append(n)
    print(f"Суд sud{CODE} · дата {DATE} · ПІБ у списку бота: {len(names)}")
    recs = b.fetch_court_retry(url)
    on_date = [r for r in recs if (r.get("date") or "").startswith(DATE)]
    empty = sum(1 for r in on_date if not (r.get("involved") or "").strip())
    print(f"Усього засідань у суді: {len(recs)} · на {DATE}: {len(on_date)} · "
          f"з них без сторін (поле порожнє/приховане): {empty}")
    any_hit = False
    for k, nm in enumerate(names, 1):
        words = nm.split()
        if len(words) < 2:
            continue
        sur = b._norm(words[0])
        full_all = sum(1 for r in recs if b.name_matches(r.get("involved", ""), [nm]))
        full_day = sum(1 for r in on_date if b.name_matches(r.get("involved", ""), [nm]))
        sur_day = [r for r in on_date if re.search(r"(?<!\w)" + re.escape(sur) + r"(?!\w)",
                                                    b._norm(r.get("involved", "")))]
        stem_day = [r for r in on_date if sur[:-2] and sur[:-2] in b._norm(r.get("involved", ""))]
        if not (full_all or sur_day or stem_day):
            continue
        any_hit = True
        why = []
        for r in sur_day:
            inv = b._norm(r.get("involved", ""))
            i = inv.find(sur)
            tail = inv[i + len(sur): i + len(sur) + 40]
            if re.match(r"\s*[а-яіїєґ]\.\s*[а-яіїєґ]\.", tail):
                why.append("ініціали замість повного імені")
            elif not b.name_matches(r.get("involved", ""), [nm]):
                why.append("ім'я/по батькові написані інакше (описка чи відмінок)")
        if stem_day and not sur_day:
            why.append("прізвище в іншому відмінку чи з опискою")
        print(f"#{k} {_initials(nm)}: повний збіг у суді (усі дати): {full_all}; "
              f"на {DATE}: повний {full_day}, за прізвищем {len(sur_day)}, за коренем {len(stem_day)}"
              + (f" · причина: {', '.join(sorted(set(why)))}" if why else ""))
    if not any_hit:
        print(f"Жодного клієнта зі списку на {DATE} у цьому суді не знайдено "
              f"(ні повністю, ні за прізвищем).")


if __name__ == "__main__":
    if os.environ.get("DIAG_CLIENTS", "").strip() in ("1", "true", "yes"):
        clients()
    else:
        main()
