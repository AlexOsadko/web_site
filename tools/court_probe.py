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
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "uk,en;q=0.8",
    })
    with urllib.request.urlopen(req, timeout=35) as r:
        return r.getcode(), r.read().decode("utf-8", "replace")


def main():
    url = os.environ.get("PROBE_URL") or (sys.argv[1] if len(sys.argv) > 1 else "")
    if not url:
        print("Не задано URL")
        sys.exit(1)
    print("URL:", url)
    try:
        code, html = fetch(url)
    except Exception as e:
        print("Помилка завантаження:", e)
        sys.exit(1)
    print("HTTP:", code, "· довжина HTML:", len(html))

    markers = ["Сторони по справі", "Єдиний унікальний", "Склад суду",
               "Форма судочинства", "Зал судових", "Суть позову",
               "<table", "DataTables", "ajax", "json", "csz"]
    for m in markers:
        print(f"  містить {m!r}: {m.lower() in html.lower()}")

    cases = re.findall(r"\b\d+/\d+/\d\d\b", html)
    print("схожих на номер справи:", len(cases), cases[:6])
    print("<tr> у коді:", html.lower().count("<tr"))
    print("<table> у коді:", html.lower().count("<table"))

    idx = html.find("Сторони по справі")
    if idx < 0:
        idx = html.lower().find("<table")
    if idx >= 0:
        print("---- ВІКНО HTML навколо таблиці ----")
        print(html[max(0, idx - 300): idx + 2600])
    else:
        b = html.lower().find("<body")
        print("---- ПОЧАТОК BODY (таблиці не знайдено — можливо, AJAX) ----")
        print(html[b: b + 2200] if b >= 0 else html[:2200])

    print("---- підозрілі посилання (можливий AJAX-ендпоінт) ----")
    for s in set(re.findall(r'(?:src|href|data-url|url)\s*[:=]\s*["\']([^"\']+)["\']', html)):
        if any(k in s.lower() for k in ("csz", "json", "ajax", "list", "getdata", "handler")):
            print("  ", s)
    print("ГОТОВО")


if __name__ == "__main__":
    main()
