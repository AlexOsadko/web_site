#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Пробник структури сторінки «Список справ, призначених до розгляду» суду
(court.gov.ua). Нічого не зберігає — лише друкує діагностику, щоб на її основі
написати надійний парсер бота відстеження справ.

Запуск: Actions → «Пробник суду (Список справ)» → Run workflow (можна вказати URL).
"""
import http.cookiejar
import os
import re
import sys
import urllib.parse
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")


def session_flow(csz_url):
    """Двокроковий сценарій як у браузері: GET сторінки CSZ (отримати cookie),
    потім POST /new.php з тим же cookie та Referer. Повертає (code, ctype, text)."""
    parts = urllib.parse.urlsplit(csz_url)
    origin = f"{parts.scheme}://{parts.netloc}"
    new_php = origin + "/new.php"
    # 4 цифри коду суду з /sudNNNN/
    m = re.search(r"/sud(\d{4})", csz_url)
    crt = m.group(1) if m else ""
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    common = {
        "User-Agent": UA,
        "Accept-Language": "uk,en;q=0.8",
    }
    # Крок 1 — сторінка CSZ (набрати cookie)
    r1 = urllib.request.Request(csz_url, headers={
        **common,
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
    })
    with opener.open(r1, timeout=35) as resp:
        resp.read()
    cookies = "; ".join(f"{c.name}={c.value}" for c in jar)
    print("Cookies після GET CSZ:", cookies[:200] or "(порожньо)")
    # Крок 2 — POST /new.php
    body = urllib.parse.urlencode({"q_court_id": crt}).encode()
    r2 = urllib.request.Request(new_php, data=body, headers={
        **common,
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "Origin": origin,
        "Referer": csz_url,
    })
    with opener.open(r2, timeout=35) as resp:
        raw = resp.read()
        ctype = resp.headers.get("Content-Type", "")
        enc = "utf-8" if "utf-8" in ctype.lower() else "cp1251"
        text = raw.decode(enc, "replace")
        return resp.getcode(), ctype, text


def fetch(url, data=None):
    headers = {
        "User-Agent": UA,
        "Accept": "text/html,application/json,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "uk,en;q=0.8",
        "X-Requested-With": "XMLHttpRequest",
    }
    body = None
    if data is not None:
        body = data.encode("utf-8")
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=body, headers=headers)
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

    # Сесійний режим: GET сторінки CSZ + POST /new.php з cookie і Referer
    if os.environ.get("SESS", "").strip():
        import json as _json
        try:
            c, ct, tx = session_flow(url)
        except Exception as e:
            print("Помилка сесії:", e)
            sys.exit(1)
        print("new.php → HTTP", c, "· Content-Type:", ct, "· довжина:", len(tx))
        print("RAW[:500]:", repr(tx[:500]))
        s = tx.strip()
        if s[:1] in ("[", "{"):
            try:
                dd = _json.loads(s)
                rows = dd if isinstance(dd, list) else dd.get("data", [])
                print("Записів:", len(rows))
                if rows:
                    print("ПЕРШИЙ:", _json.dumps(rows[0], ensure_ascii=False, indent=2)[:1500])
            except Exception as e:
                print("Не JSON:", e)
        print("ГОТОВО")
        return

    # Режим сканування кількох кодів судів: перевірити, чи /new.php глобальний
    ids = os.environ.get("COURT_IDS", "").strip()
    if ids:
        import json as _json
        for cid in [x.strip() for x in ids.split(",") if x.strip()]:
            try:
                c, ct, tx = fetch(url, data=f"q_court_id={cid}")
            except Exception as e:
                print(f"  код {cid}: помилка {e}")
                continue
            n = "—"
            first = ""
            s = tx.strip()
            if s[:1] in ("[", "{"):
                try:
                    dd = _json.loads(s)
                    if isinstance(dd, list):
                        n = len(dd)
                        if dd:
                            first = _json.dumps(dd[0], ensure_ascii=False)[:300]
                except Exception:
                    pass
            print(f"  код {cid}: HTTP {c} · довжина {len(tx)} · записів {n}")
            if first:
                print("     приклад:", first)
        print("ГОТОВО")
        return

    court_id = os.environ.get("COURT_ID", "").strip()
    post = f"q_court_id={court_id}" if court_id else None
    if post:
        print("POST-дані:", post)
    try:
        code, ctype, text = fetch(url, data=post)
    except Exception as e:
        print("Помилка завантаження:", e)
        sys.exit(1)
    print("HTTP:", code, "· Content-Type:", ctype, "· довжина:", len(text))
    print("RAW[:400]:", repr(text[:400]))

    # Гілка для JS-файлу: показати, як будується запит списку справ
    if url.lower().split("?")[0].endswith(".js"):
        print("---- фрагменти JS навколо ключових токенів ----")
        for tok in ("assig_ajax", "ajax", "csz", "gromadyanam",
                    "listpersons", "list_auto", "sEcho", "iDisplay",
                    "aaData", "aoColumns", "getJSON", "hash"):
            i = 0
            shown = 0
            low = text.lower()
            while shown < 3:
                p = low.find(tok.lower(), i)
                if p < 0:
                    break
                seg = text[max(0, p - 120): p + 220].replace("\n", " ")
                print(f"  [{tok}] …{seg}…")
                i = p + 1
                shown += 1
        print("ГОТОВО")
        return

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
    print("---- рядки JS з конфігурацією DataTables/ajax ----")
    for ln in text.splitlines():
        low = ln.lower()
        if any(k in low for k in ("sajaxsource", "ajax", '"url"', "url:", ".php", "assig",
                                  "datatable", "csz", "serverside", "processing")):
            s = ln.strip()
            if s and len(s) < 400:
                print("  |", s)
    # Повний блок навколо виклику assig_ajax.php (параметри запиту)
    j = text.lower().find("assig_ajax")
    if j >= 0:
        print("---- ВІКНО навколо assig_ajax (± параметри) ----")
        print(text[max(0, j - 1400): j + 1600])
    idx = text.lower().find("<table")
    if idx >= 0:
        print("---- ВІКНО HTML ----")
        print(text[max(0, idx - 200): idx + 2400])
    print("ГОТОВО")


if __name__ == "__main__":
    main()
