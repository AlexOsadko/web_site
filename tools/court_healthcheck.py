#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Перевірка «свіжості» судів у реєстрі (послідовна, «ввічлива»).

Для кожного суду з court_registry.json робить той самий запит, що й бот
(сторінка CSZ → POST /new.php), і класифікує:
  ok    — віддав валідний список засідань (записів ≥ 0);
  empty — валідна відповідь, але 0 засідань (норм для малих судів);
  fail  — помилка/недоступність (перейменований, релокований, ТОТ тощо).

ВАЖЛИВО: court.gov.ua має захист від навантаження — паралельні запити масово
блокуються (дають хибні «fail»). Тому перевіряємо ПОСЛІДОВНО з паузою, як бот.
Проміжно дописуємо звіт tools/_courts_health/report.txt кожні кілька судів, щоб
часткові дані зберігались навіть при обриві; воркфлоу комітить фінальний файл.

Env: COURT_HC_PAUSE (пауза між судами, типово 0.4), COURT_FETCH_TIMEOUT,
COURT_FETCH_TRIES — успадковуються з court_watch_bot.
"""
import os
import time

import court_watch_bot as b

PAUSE = float(os.environ.get("COURT_HC_PAUSE", "0.4") or "0.4")
OUTDIR = "tools/_courts_health"
FLUSH_EVERY = 25


def _write(rows):
    os.makedirs(OUTDIR, exist_ok=True)
    with open(f"{OUTDIR}/report.txt", "w", encoding="utf-8") as f:
        f.write("\n".join(rows) + "\n")


def main():
    courts = b.load_registry()
    total = len(courts)
    print(f"Судів у реєстрі: {total} · послідовно, пауза {PAUSE}с")
    rows = []
    n_ok = n_empty = n_fail = 0
    for i, court in enumerate(courts, 1):
        code = str(court.get("code") or "").zfill(4)
        name = court.get("name") or ""
        url = b.csz_url_for(court)
        status, count = "fail", ""
        if url:
            try:
                recs = b.fetch_court_retry(url)
                count = len(recs)
                status = "ok" if count > 0 else "empty"
            except Exception:
                status = "fail"
        if status == "ok":
            n_ok += 1
        elif status == "empty":
            n_empty += 1
        else:
            n_fail += 1
            print(f"  FAIL {code} · {name}")
        rows.append(f"{code}|{status}|{count}|{name}")
        if i % FLUSH_EVERY == 0:
            _write(rows)
            print(f"… {i}/{total} (ok {n_ok}, empty {n_empty}, fail {n_fail})")
        time.sleep(PAUSE)

    _write(rows)
    print(f"\nЗВЕДЕННЯ: ok {n_ok} · empty {n_empty} · fail {n_fail} · усього {total}")
    print(f"Звіт: {OUTDIR}/report.txt")


if __name__ == "__main__":
    main()
