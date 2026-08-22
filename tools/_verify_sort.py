#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Тимчасова перевірка: тягне ЖИВІ справи з розгорнутого Worker (/court_cases),
застосовує ТУ САМУ логіку сортування, що й Worker у меню бота, і друкує лише
ПОСЛІДОВНІСТЬ ДАТ засідань (без номерів/імен/судів — жодних персональних даних).
Мета — переконатися, що після редеплою перелік іде від найближчого засідання.
Запуск лише через тимчасовий workflow «Перевірка сортування». Видаляється потім.
"""
import os
import re
import json
import datetime
import urllib.request

WORKER = os.environ.get("BOT_WORKER_URL", "").rstrip("/")
SECRET = os.environ.get("BOT_WORKER_SECRET", "")


def fetch_cases(kind):
    req = urllib.request.Request(
        f"{WORKER}/court_cases?kind={kind}", headers={"X-Auth-Token": SECRET})
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data.get("items", [])


def days_until(date_str):
    m = re.search(r"(\d{2})\.(\d{2})\.(\d{4})", date_str or "")
    if not m:
        return None
    target = datetime.date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
    return (target - datetime.date.today()).days


def hearing_ts(date_str):
    m = re.search(r"(\d{2})\.(\d{2})\.(\d{4})(?:\D+(\d{1,2}):(\d{2}))?", date_str or "")
    if not m:
        return None
    hh = int(m.group(4)) if m.group(4) else 0
    mm = int(m.group(5)) if m.group(5) else 0
    return datetime.datetime(int(m.group(3)), int(m.group(2)), int(m.group(1)), hh, mm)


def case_key(it):
    # Порядок, ідентичний caseCmp у worker.js: майбутні (сьогодні+) вгору за
    # зростанням; минулі — свіжіші вище; недатовані — в кінці.
    d = days_until(it.get("date", ""))
    upcoming = d is not None and d >= 0
    ts = hearing_ts(it.get("date", ""))
    if upcoming:
        grp = 0
        sub = ts or datetime.datetime.max
    elif ts is not None:
        grp = 1
        sub = datetime.datetime.max - (ts - datetime.datetime.min)  # свіжіше вище
    else:
        grp = 2
        sub = datetime.datetime.max
    return (grp, sub)


def main():
    if not WORKER or not SECRET:
        print("Немає BOT_WORKER_URL/SECRET — перевірку пропущено.")
        return
    for kind, label in (("advocate", "адвокат"), ("clients", "клієнти")):
        try:
            items = fetch_cases(kind)
        except Exception as ex:
            print(f"[{label}] помилка запиту: {ex}")
            continue
        items.sort(key=case_key)
        print(f"\n=== {label}: {len(items)} справ (порядок, як у меню бота) ===")
        prev = None
        ok = True
        for i, it in enumerate(items, 1):
            d = days_until(it.get("date", ""))
            tag = "недатовано" if d is None else (f"через {d} дн." if d >= 0 else f"{-d} дн. тому")
            print(f"{i:>3}. 📅 {it.get('date','—'):<20} ({tag})")
            # контроль монотонності серед майбутніх
            if d is not None and d >= 0:
                if prev is not None and d < prev:
                    ok = False
                prev = d
        print(f"→ майбутні за зростанням: {'✅ так' if ok else '❌ ні'}")


if __name__ == "__main__":
    main()
