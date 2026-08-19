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

    # Режим HARVEST: зібрати посилання на сайти судів (домен + код sudNNNN)
    if os.environ.get("HARVEST", "").strip():
        try:
            code, ctype, text = fetch(url)
        except Exception as e:
            print("Помилка:", e); sys.exit(1)
        print("HTTP:", code, "· довжина:", len(text))
        hosts = set()
        for h in re.findall(r'https?://([a-z0-9-]+(?:\.[a-z0-9-]+)*\.court\.gov\.ua)', text, re.I):
            hosts.add(h.lower())
        print("Унікальних court.gov.ua хостів:", len(hosts))
        for h in sorted(hosts)[:60]:
            print("  host:", h)
        suds = sorted(set(re.findall(r'/sud(\d{3,5})', text)))
        print("Кодів sudNNNN на сторінці:", len(suds), suds[:40])
        # <option value=...>Назва суду</option> — можливий повний перелік судів
        opts = re.findall(r'<option[^>]*value=["\']([^"\']+)["\'][^>]*>(.*?)</option>',
                          text, re.I | re.S)
        opts = [(v, re.sub(r"\s+", " ", t).strip()) for v, t in opts if v.strip()]
        print("Всього <option>:", len(opts))
        for v, t in opts[:15]:
            print(f"    option value={v!r} → {t[:60]!r}")
        # <select> елементи
        for m in re.finditer(r'<select[^>]*>', text, re.I):
            print("  select:", m.group(0)[:160])
        # Приклади повних href для розуміння формату
        hrefs = re.findall(r'href=["\']([^"\']+)["\']', text)
        sample = [h for h in hrefs if "court.gov.ua" in h or "/sud" in h][:25]
        print("---- приклади href (суди) ----")
        for h in sample:
            print("  ", h)
        # Посилання на набори даних / файли
        data_h = [h for h in hrefs if re.search(
            r'(opendata|dataset|perelik|merezh|\.csv|\.json|\.xml|\.xlsx?|resource|/set/)',
            h, re.I)]
        print("---- посилання на дані/набори ----")
        for h in dict.fromkeys(data_h[:40]):
            print("  ", h)
        print("ГОТОВО")
        return

    # Режим AUTO: діагностика форми автопризначень + виклик /post_test2.php
    if os.environ.get("AUTO", "").strip():
        import http.cookiejar as _cj
        jar = _cj.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        parts = urllib.parse.urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        req = urllib.request.Request(url, headers={"User-Agent": UA,
              "Accept": "text/html,*/*;q=0.8", "Accept-Language": "uk"})
        with opener.open(req, timeout=40) as resp:
            html = resp.read().decode("cp1251", "replace")
        for fid in ("ust", "cspec"):
            m = re.search(rf'id=["\']{fid}["\'][^>]*>(.*?)<', html, re.S)
            print(f"  #{fid} текст:", repr((m.group(1).strip()[:60] if m else None)))
        for fid in ("sdate", "edate", "srch"):
            m = re.search(rf'id=["\']{fid}["\'][^>]*value=["\']([^"\']*)["\']', html)
            print(f"  #{fid} value:", repr(m.group(1) if m else None))
        # знайти input-и всередині форми з датами
        for m in re.finditer(r'<input[^>]*id=["\'](sdate|edate)["\'][^>]*>', html):
            print("  input:", m.group(0)[:160])
        # Повний inline-скрипт навколо post_test2 (шукаємо hash/додаткові поля)
        pidx = html.find("post_test2")
        if pidx >= 0:
            seg = html[max(0, pidx - 2600): pidx + 900]
            # прибрати юнікод-escape для читабельності
            print("---- INLINE навколо post_test2 ----")
            print(seg.replace("\n", " "))
        # шукаємо будь-які згадки hash / token / csrf у html
        for tok in ("hash", "token", "csrf", "post_test"):
            for mm2 in re.finditer(re.escape(tok), html, re.I):
                s = html[max(0, mm2.start() - 60): mm2.start() + 90].replace("\n", " ")
                print(f"  [{tok}] …{s}…")
                break

        # Матриця варіантів запиту до /post_test2.php
        import time as _t
        endpoint = origin + "/post_test2.php"
        m = re.search(r"/sud(\d{4})", url)
        sid = "2604"
        mm = re.search(r'id=["\']ust["\'][^>]*>(.*?)<', html, re.S)
        if mm:
            sid = mm.group(1).strip()

        def dt_params(date_val, extra=None, q_ver="arbitr", cspec="0"):
            n = 6
            searchable = (0, 0, 1, 1, 0, 0)
            p = [("sEcho", "1"), ("iColumns", str(n)), ("sColumns", ""),
                 ("iDisplayStart", "0"), ("iDisplayLength", "100")]
            for i in range(n):
                p.append((f"mDataProp_{i}", str(i)))
            p += [("sSearch", ""), ("bRegex", "false")]
            for i in range(n):
                p += [(f"sSearch_{i}", ""), (f"bRegex_{i}", "false"),
                      (f"bSearchable_{i}", "true" if searchable[i] else "false")]
            p.append(("iSortingCols", "0"))
            for i in range(n):
                p.append((f"bSortable_{i}", "false"))
            p += [("q_ver", q_ver), ("date", date_val), ("sid", sid), ("cspec", cspec)]
            if extra:
                p += extra
            return p

        now = _t.time()
        d1s = _t.strftime("%d.%m.%Y", _t.localtime(now - 120 * 86400))
        d1e = _t.strftime("%d.%m.%Y", _t.localtime(now + 86400))
        d2s = _t.strftime("%Y-%m-%d", _t.localtime(now - 120 * 86400))
        d2e = _t.strftime("%Y-%m-%d", _t.localtime(now + 86400))
        variants = [
            ("dd.mm.yyyy", dt_params(f"{d1s}~{d1e}")),
            ("yyyy-mm-dd", dt_params(f"{d2s}~{d2e}")),
            ("dd.mm +q_court_id", dt_params(f"{d1s}~{d1e}", extra=[("q_court_id", sid)])),
            ("dd.mm q_ver=empty", dt_params(f"{d1s}~{d1e}", q_ver="")),
            ("dd.mm one-day", dt_params(f"{d1e}~{d1e}")),
        ]
        for label, params in variants:
            body = urllib.parse.urlencode(params).encode()
            r2 = urllib.request.Request(endpoint, data=body, headers={
                "User-Agent": UA, "Accept": "application/json, text/javascript, */*; q=0.01",
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "X-Requested-With": "XMLHttpRequest", "Origin": origin, "Referer": url})
            try:
                with opener.open(r2, timeout=40) as resp:
                    raw = resp.read()
                    ct = resp.headers.get("Content-Type", "")
                    enc = "utf-8" if "utf-8" in ct.lower() else "cp1251"
                    txt = raw.decode(enc, "replace")
                head = txt[:70].replace("\n", " ")
                jn = ""
                if txt.strip()[:1] == "{":
                    try:
                        jd = __import__("json").loads(txt)
                        jn = f" · iTotal={jd.get('iTotalRecords')} · aaData={len(jd.get('aaData', []))}"
                    except Exception:
                        pass
                print(f"  [{label}] довж {len(txt)} · {head!r}{jn}")
            except Exception as e:
                print(f"  [{label}] помилка {e}")
        print("ГОТОВО")
        return

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
    # Вікна навколо ключових токенів (init DataTables теж буває в одному рядку)
    for tok in ("assig_ajax", "sAjaxSource", "#bank", "fnServerData",
                "bServerSide", "sServerMethod", ".dataTable("):
        j = text.lower().find(tok.lower())
        if j >= 0:
            print(f"---- ВІКНО навколо {tok} ----")
            print(text[max(0, j - 800): j + 1200].replace("\n", " "))
    idx = text.lower().find("<table")
    if idx >= 0:
        print("---- ВІКНО HTML ----")
        print(text[max(0, idx - 200): idx + 2400])
    print("ГОТОВО")


if __name__ == "__main__":
    main()
