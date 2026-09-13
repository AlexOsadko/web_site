#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Перевірка «свіжості» судів у реєстрі (паралельна, швидка).

Для кожного суду з court_registry.json робить той самий запит, що й бот
(сторінка CSZ → POST /new.php), і класифікує:
  ok    — віддав валідний список засідань (записів ≥ 0);
  empty — валідна відповідь, але 0 засідань (норм для малих судів);
  fail  — помилка/недоступність (перейменований, релокований, ТОТ тощо).

Перевіряє кілька судів одночасно (потоки), тож весь реєстр — за кілька хвилин.
Пише компактний звіт tools/_courts_health/report.txt рядками
«code|status|count|name» (без ПІБ — лише публічні назви й лічильники);
воркфлоу його комітить. Наприкінці друкує зведення й перелік проблемних.

Env: COURT_HC_WORKERS (потоків, типово 8), COURT_FETCH_TIMEOUT,
COURT_FETCH_TRIES — успадковуються з court_watch_bot.
"""
import os
from concurrent.futures import ThreadPoolExecutor, as_completed

import court_watch_bot as b

WORKERS = int(os.environ.get("COURT_HC_WORKERS", "8") or "8")
OUTDIR = "tools/_courts_health"


def check(court):
    code = str(court.get("code") or "").zfill(4)
    name = court.get("name") or ""
    url = b.csz_url_for(court)
    if not url:
        return code, "fail", "", name
    try:
        recs = b.fetch_court_retry(url)
        count = len(recs)
        return code, ("ok" if count > 0 else "empty"), count, name
    except Exception:
        return code, "fail", "", name


def main():
    courts = b.load_registry()
    total = len(courts)
    print(f"Судів у реєстрі: {total} · потоків: {WORKERS}")
    results = {}
    n_ok = n_empty = n_fail = done = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(check, c): c for c in courts}
        for fut in as_completed(futs):
            code, status, count, name = fut.result()
            results[code] = f"{code}|{status}|{count}|{name}"
            done += 1
            if status == "ok":
                n_ok += 1
            elif status == "empty":
                n_empty += 1
            else:
                n_fail += 1
                print(f"  FAIL {code} · {name}")
            if done % 100 == 0:
                print(f"… {done}/{total} (ok {n_ok}, empty {n_empty}, fail {n_fail})")

    os.makedirs(OUTDIR, exist_ok=True)
    rows = [results[k] for k in sorted(results)]
    with open(f"{OUTDIR}/report.txt", "w", encoding="utf-8") as f:
        f.write("\n".join(rows) + "\n")
    print(f"\nЗВЕДЕННЯ: ok {n_ok} · empty {n_empty} · fail {n_fail} · усього {total}")
    print(f"Звіт: {OUTDIR}/report.txt")


if __name__ == "__main__":
    main()
