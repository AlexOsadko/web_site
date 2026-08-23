#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Пробник бекенд-API Бази правових позицій ВС (lpd.court.gov.ua).
Сайт — JS-застосунок (SPA), тож дані він тягне окремими запитами до API.
Цей пробник:
  1) завантажує головну й знаходить JS-бандли та можливі config-файли;
  2) читає JS-код і витягує з нього рядки-ендпоінти (/api/…);
  3) тестує знайдені + типові ендпоінти (GET) і показує, чи віддають JSON.
Мета — зрозуміти, чи можна будувати grounded-агент (реальні позиції ВС),
чи API закритий. Нічого не публікує. Запуск: Actions → «Пробник LPD-API».
"""
import re
import time
import urllib.request
import urllib.error
from urllib.parse import urljoin

BASE = "https://lpd.court.gov.ua"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
HDR = {
    "User-Agent": UA,
    "Accept": "*/*",
    "Accept-Language": "uk,en;q=0.8",
    "Accept-Encoding": "identity",
}


def fetch(url, data=None, extra=None, timeout=25, tries=2):
    headers = dict(HDR)
    if extra:
        headers.update(extra)
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers=headers,
                                         method=("POST" if data else "GET"))
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.getcode(), r.headers.get("Content-Type", ""), r.read()
        except urllib.error.HTTPError as e:
            body = b""
            try:
                body = e.read()
            except Exception:
                pass
            ct = e.headers.get("Content-Type", "") if getattr(e, "headers", None) else ""
            return e.code, ct, body
        except Exception as ex:
            last = ex
            if i + 1 < tries:
                time.sleep(1.5 * (i + 1))
    raise last


def show(url, code, ct, raw, limit=220):
    ct0 = (ct.split(";")[0] or "?").strip()
    head = raw[:1]
    is_json = ("json" in ct.lower()) or head in (b"{", b"[")
    mark = "✓" if (code == 200 and raw) else "✗"
    kind = "JSON" if is_json else "html/text"
    snippet = raw[:limit].decode("utf-8", "replace").replace("\n", " ").strip()
    print(f"  {mark} [{code}] {ct0} · {len(raw)}b · {kind}")
    print(f"     {url}")
    if snippet:
        print(f"     ↳ {snippet!r}")


def main():
    print("=" * 72)
    print("1) Головна SPA — шукаємо JS-бандли та config")
    code, ct, raw = fetch(BASE + "/")
    html = raw.decode("utf-8", "replace")
    print(f"   головна: [{code}] {len(raw)}b")
    assets = re.findall(r'(?:src|href)=["\']([^"\']+\.(?:js|json))["\']', html)
    assets = sorted(set(assets))
    print(f"   assets у HTML: {assets}")
    # інколи є вбудований конфіг з базовим URL API
    for m in re.findall(r'(?:apiUrl|baseUrl|API_URL|apiBase)["\']?\s*[:=]\s*["\']([^"\']+)["\']', html, re.I):
        print(f"   inline config → {m}")

    # 2) читаємо JS-бандли, витягуємо api-рядки
    api_candidates = set()
    js_assets = [a for a in assets if a.endswith(".js")]
    # типові імена бандлів на випадок, якщо їх нема в HTML
    for guess in ["/main.js", "/app.js", "/runtime.js", "/polyfills.js"]:
        js_assets.append(guess)
    print("=" * 72)
    print("2) Читаємо JS і шукаємо ендпоінти")
    for a in sorted(set(js_assets)):
        url = urljoin(BASE + "/", a)
        try:
            c, t, r = fetch(url)
            if c != 200 or not r:
                print(f"   JS {url} [{c}] — пропуск")
                continue
            txt = r.decode("utf-8", "replace")
            before = len(api_candidates)
            for mm in re.findall(r'["\'`](/?api/[A-Za-z0-9_\-/{}.]+)["\'`]', txt):
                api_candidates.add(mm)
            for mm in re.findall(r'["\'`](https?://[A-Za-z0-9_\-.]+/api/[A-Za-z0-9_\-/{}.]*)["\'`]', txt):
                api_candidates.add(mm)
            print(f"   JS {url} [{c}] {len(r)}b — нових api-рядків: {len(api_candidates) - before}")
        except Exception as ex:
            print(f"   JS {url} ПОМИЛКА: {ex}")
    print(f"   Усього api-кандидатів із JS: {len(api_candidates)}")
    for c in sorted(api_candidates)[:60]:
        print(f"     · {c}")

    # 3) тестуємо: знайдені + типові здогади + config
    guesses = [
        "/api/search", "/api/positions", "/api/position", "/api/categories",
        "/api/home/search", "/api/lpd/search", "/api/v1/search", "/api/menu",
        "/api/filters", "/api/directions", "/api/practice", "/api/legalpositions",
        "/api/legal-positions", "/api/documents", "/api/document",
        "/assets/config.json", "/config.json", "/appsettings.json", "/assets/appsettings.json",
    ]
    to_test = set(urljoin(BASE + "/", g) for g in guesses)
    for c in api_candidates:
        to_test.add(c if c.startswith("http") else urljoin(BASE + "/", c))
    print("=" * 72)
    print("3) Тестуємо ендпоінти (GET)")
    for url in sorted(to_test):
        try:
            c, t, r = fetch(url)
            show(url, c, t, r)
        except Exception as ex:
            print(f"  ✗ {url} — {ex}")
    print("=" * 72)
    print("ГОТОВО")


if __name__ == "__main__":
    main()
