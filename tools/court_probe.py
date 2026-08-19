#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Пробник структури сторінки «Список справ, призначених до розгляду» суду
(court.gov.ua). Нічого не зберігає — лише друкує діагностику, щоб на її основі
написати надійний парсер бота відстеження справ.

Запуск: Actions → «Пробник суду (Список справ)» → Run workflow (можна вказати URL).
"""
import os
import re
import sys
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")


def fetch(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "text/html,application/json,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "uk,en;q=0.8",
        "X-Requested-With": "XMLHttpRequest",
    })
    with urllib.request.urlopen(req, timeout=35) as r:
        raw = r.read()
        ctype = r.headers.get("Content-Type", "")
        # court.gov.ua віддає windows-1251 (якщо не вказано інше)
        enc = "utf-8" if "utf-8" in ctype.lower() else "cp1251"
        try:
            text = raw.decode(enc, "replace")
        except Exception:
            text = raw.decode("cp1251", "replace")
        return r.getcode(), ctype, text


def main():
    url = os.environ.get("PROBE_URL") or (sys.argv[1] if len(sys.argv) > 1 else "")
    if not url:
        print("Не задано URL")
        sys.exit(1)
    print("URL:", url)
    try:
        code, ctype, text = fetch(url)
    except Exception as e:
        print("Помилка завантаження:", e)
        sys.exit(1)
    print("HTTP:", code, "· Content-Type:", ctype, "· довжина:", len(text))

    stripped = text.lstrip()
    is_json = "json" in ctype.lower() or stripped[:1] in ("{", "[")
    if is_json:
        import json
        try:
            data = json.loads(text)
        except Exception as e:
            print("Не JSON:", e)
            print(text[:1500]); return
        print("Тип JSON:", type(data).__name__)
        if isinstance(data, dict):
            print("Ключі:", list(data.keys()))
            rows = data.get("data") or data.get("aaData") or data.get("rows") or []
        else:
            rows = data
        print("Рядків:", len(rows) if isinstance(rows, list) else "—")
        if isinstance(rows, list) and rows:
            print("---- ПЕРШІ 2 РЯДКИ ----")
            print(json.dumps(rows[:2], ensure_ascii=False, indent=2)[:2500])
        print("ГОТОВО")
        return

    # HTML-гілка
    for m in ["Сторони по справі", "Єдиний унікальний", "Склад суду",
              "Форма судочинства", "<table", "DataTables", "ajax", "json"]:
        print(f"  містить {m!r}: {m.lower() in text.lower()}")
    print("<tr>:", text.lower().count("<tr"), "· <table>:", text.lower().count("<table"))
    print("---- підозрілі посилання (можливий AJAX-ендпоінт) ----")
    for s in set(re.findall(r'(?:src|href|data-url|url)\s*[:=]\s*["\']([^"\']+)["\']', text)):
        if any(k in s.lower() for k in ("csz", "json", "ajax", "list", "auto_cases", "getdata")):
            print("  ", s)
    idx = text.lower().find("<table")
    if idx >= 0:
        print("---- ВІКНО HTML ----")
        print(text[max(0, idx - 200): idx + 2400])
    print("ГОТОВО")


if __name__ == "__main__":
    main()
