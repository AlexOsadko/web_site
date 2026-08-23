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

    # 2) ГЛИБОКИЙ аналіз головного бандла: шукаємо справжню базу API,
    #    усі хости, шляхи /api/... і контекст навколо них.
    api_candidates = set()
    js_assets = [a for a in assets if a.endswith(".js")]
    if "/static/js/bundle.js" not in js_assets:
        js_assets.append("/static/js/bundle.js")
    print("=" * 72)
    print("2) Глибокий аналіз JS-бандла")
    for a in sorted(set(js_assets)):
        url = urljoin(BASE + "/", a)
        try:
            c, t, r = fetch(url, timeout=60)
            if c != 200 or len(r) < 5000:
                print(f"   JS {url} [{c}] {len(r)}b — не бандл, пропуск")
                continue
            txt = r.decode("utf-8", "replace")
            print(f"   JS {url} [{c}] {len(r)}b — аналізуємо…")
            # усі хости (крім типових CDN/шрифтів)
            hosts = set(re.findall(r'https?://([A-Za-z0-9._\-]+\.[A-Za-z]{2,})', txt))
            skip = ("w3.org", "googleapis.com", "gstatic.com", "schema.org",
                    "reactjs.org", "github.com", "npmjs", "jsdelivr", "unpkg",
                    "cloudflare", "gvt1.com", "mozilla.org", "example.com")
            hosts = sorted(h for h in hosts if not any(s in h for s in skip))
            print(f"     хости в бандлі: {hosts}")
            # усі /api/... шляхи (не лише в лапках)
            paths = sorted(set(re.findall(r'/api/[A-Za-z0-9_\-/{}.:]+', txt)))
            print(f"     шляхи /api/…: {paths[:40]}")
            for p in paths:
                api_candidates.add(p)
            # контекст навколо визначення бази API
            for key in ("baseURL", "BASE_URL", "REACT_APP_", "apiUrl", "API_URL",
                        "axios.create", "process.env"):
                for m in re.finditer(re.escape(key), txt):
                    ctx = txt[max(0, m.start() - 20):m.start() + 90]
                    ctx = re.sub(r"\s+", " ", ctx).strip()
                    print(f"     [{key}] …{ctx}…")
                    break  # лише перший приклад кожного ключа
        except Exception as ex:
            print(f"   JS {url} ПОМИЛКА: {ex}")
    print(f"   Усього шляхів /api/…: {len(api_candidates)}")

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
    # 4) ГОЛОВНЕ: стукаємо у справжній API-хост, знайдений у бандлі.
    API = "https://lpd-api-prod.court.gov.ua"
    print("=" * 72)
    print(f"4) Реальний API-хост: {API}")
    api_paths = [
        "/", "/swagger", "/swagger/index.html", "/swagger/v1/swagger.json",
        "/api-docs", "/openapi.json", "/health",
        "/api", "/api/positions", "/api/categories", "/api/directions",
        "/api/filters", "/api/search", "/api/documents", "/api/menu",
        "/api/legal-positions", "/api/practice", "/api/home/search",
        "/api/v1/positions", "/api/v1/categories", "/api/v1/search",
        "/positions", "/categories", "/search",
    ]
    for p in api_paths:
        url = API + p
        try:
            c, t, r = fetch(url)
            show(url, c, t, r)
        except Exception as ex:
            print(f"  ✗ {url} — {ex}")

    print("=" * 72)
    print("ГОТОВО")


if __name__ == "__main__":
    main()
