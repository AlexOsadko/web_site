#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Пошук у Єдиному державному реєстрі судових рішень (reyestr.court.gov.ua).

  search(query, **filters) → [{id, url, kind, reg_date, law_date, form, case, court, judge}]
  decision_text(id)        → повний текст рішення (з textarea#txtdepository)

Форма пошуку — POST на головну сторінку реєстру (ASP.NET, cookie сесії з GET).
Режим проби (python3 tools/edrsr.py "запит"): друкує лише технічні дані —
коди відповіді, назви полів форми, кількість результатів і довжину тексту
першого рішення (рішення публічні, але лог тримаємо стислим).
"""
import html as _html
import http.cookiejar
import os
import re
import sys
import time
import urllib.parse
import urllib.request

BASE = "https://reyestr.court.gov.ua"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
TIMEOUT = int(os.environ.get("EDRSR_TIMEOUT", "40") or "40")

# Форма судочинства (CSType) і вид рішення (VRType) — коди реєстру.
CS_TYPES = {"civil": "1", "criminal": "2", "commercial": "3", "admin": "4", "adminoffense": "5"}
VR_TYPES = {"verdict": "1", "resolution": "2", "decision": "3", "order": "4", "ruling": "5"}

_jar = http.cookiejar.CookieJar()
_opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_jar))


def _req(url, data=None, referer=None):
    hdr = {"User-Agent": UA, "Accept-Language": "uk,en;q=0.8",
           "Accept": "text/html,application/xhtml+xml,*/*;q=0.8"}
    if referer:
        hdr["Referer"] = referer
    body = None
    if data is not None:
        body = urllib.parse.urlencode(data).encode("utf-8")
        hdr["Content-Type"] = "application/x-www-form-urlencoded"
        hdr["Origin"] = BASE
    r = _opener.open(urllib.request.Request(url, data=body, headers=hdr), timeout=TIMEOUT)
    raw = r.read()
    return r.status, raw.decode("utf-8", "replace")


def _strip(s):
    s = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", s)
    s = re.sub(r"(?is)<br\s*/?>|</p>|</div>", "\n", s)
    s = re.sub(r"(?s)<[^>]+>", " ", s)
    s = _html.unescape(s)
    s = re.sub(r"[ \t\xa0]+", " ", s)
    return re.sub(r"\n\s*\n+", "\n\n", s).strip()


def form_fields(page):
    """Назви полів форми пошуку (для проби / підлаштування)."""
    return sorted(set(re.findall(r'name="([A-Za-z][\w.\[\]]*)"', page)))


def search(query, cs_type="", vr_type="", date_from="", date_to="", per_page=25):
    """Пошук за текстом рішення. Дати — ДД.ММ.РРРР (дата ухвалення рішення)."""
    status, page = _req(BASE + "/")
    data = {
        "SearchExpression": query,
        "UserCourtCode": "", "ChairmenName": "", "RegNumber": "",
        "RegDateBegin": date_from, "RegDateEnd": date_to,
        "ImportDateBegin": "", "ImportDateEnd": "",
        "CSType": CS_TYPES.get(cs_type, cs_type), "VRType": VR_TYPES.get(vr_type, vr_type),
        "CourtRegion": "", "INSType": "", "CaseNumber": "",
        "Sort": "1", "PagingInfo.ItemsPerPage": str(per_page), "Liga": "true",
    }
    # значення полів за замовчуванням зі сторінки (Liga, Sort, ProviderItem тощо)
    for tag in re.findall(r"(?is)<input[^>]*>", page):
        n = re.search(r'name="([^"]+)"', tag)
        v = re.search(r'value="([^"]*)"', tag)
        if n and n.group(1) not in ("SearchExpression",) and not n.group(1).startswith("a"):
            if re.search(r'type="(checkbox|radio)"', tag) and "checked" not in tag:
                continue
            data.setdefault(n.group(1), _html.unescape(v.group(1)) if v else "")
    for sel in re.findall(r'(?is)<select[^>]*name="([^"]+)"[^>]*>(.*?)</select>', page):
        opt = re.search(r'(?is)<option[^>]*selected[^>]*value="([^"]*)"', sel[1]) or \
            re.search(r'(?is)<option[^>]*value="([^"]*)"[^>]*selected', sel[1])
        if opt and not data.get(sel[0]):
            data[sel[0]] = opt.group(1)
    status, res = _req(BASE + "/", data, referer=BASE + "/")
    rows = parse_results(res)
    if not rows:   # результати можуть віддаватися окремою сторінкою (фільтр у сесії)
        status, res = _req(BASE + "/Page/1", referer=BASE + "/")
        rows = parse_results(res)
    return rows, status, res


def parse_results(page):
    out = []
    for row in re.findall(r"(?is)<tr[^>]*>(.*?)</tr>", page):
        m = re.search(r'href="/Review/(\d+)"', row)
        if not m:
            continue
        cells = [_strip(c) for c in re.findall(r"(?is)<td[^>]*>(.*?)</td>", row)]
        # Типовий порядок колонок: № рішення, Форма рішення, Дата ухвалення,
        # Дата набрання законної сили, Форма судочинства, № справи, Суд, Суддя.
        cells += [""] * (8 - len(cells))
        out.append({"id": m.group(1), "url": f"{BASE}/Review/{m.group(1)}",
                    "kind": cells[1], "reg_date": cells[2], "law_date": cells[3],
                    "form": cells[4], "case": cells[5], "court": cells[6], "judge": cells[7]})
    return out


def decision_text(doc_id):
    status, page = _req(f"{BASE}/Review/{doc_id}", referer=BASE + "/")
    m = re.search(r'(?is)<textarea[^>]*id="txtdepository"[^>]*>(.*?)</textarea>', page)
    if m:
        return _strip(_html.unescape(m.group(1)))
    m = re.search(r'(?is)<div[^>]*id="divdocument"[^>]*>(.*?)</div>\s*</div>', page)
    return _strip(m.group(1)) if m else ""


def probe(query):
    t = time.time()
    try:
        status, page = _req(BASE + "/")
    except Exception as e:
        print(f"GET /: помилка {type(e).__name__}: {str(e)[:120]}")
        return
    print(f"GET /: {status}, {len(page)} символів, {time.time() - t:.1f} с")
    print("captcha на сторінці:", bool(re.search(r"(?i)captcha|recaptcha|turnstile", page)))
    for m in list(re.finditer(r"(?i)captcha", page))[:6]:
        print("  …", re.sub(r"\s+", " ", page[max(0, m.start() - 160):m.end() + 160]))
    print("Скрипти:", re.findall(r'<script[^>]+src="([^"]+)"', page)[:12])
    print("Поля форми:", ", ".join(form_fields(page))[:1500])
    forms = re.findall(r'(?is)<form[^>]*>', page)
    print("Форми:", [re.sub(r"\s+", " ", f)[:160] for f in forms][:5])
    try:
        rows, status, res = search(query)
    except Exception as e:
        print(f"POST пошук: помилка {type(e).__name__}: {str(e)[:120]}")
        return
    print(f"POST пошук: {status}, {len(res)} символів, результатів розібрано: {len(rows)}")
    if not rows:
        for pat in (r"(?i)captcha", r"(?i)validation", r"(?i)помилк|невірн|введіть|код"):
            for m in list(re.finditer(pat, res))[:3]:
                print(f"  [{pat[4:12]}] …", re.sub(r"\s+", " ", res[max(0, m.start() - 150):m.end() + 150]))
        print("Таблиця результатів у відповіді:", "tableSearchResult" in res or "/Review/" in res)
        for pat in (r"(?i)знайдено", r"(?i)документ", r"(?i)divresult|tableresult|SearchResult"):
            for m in list(re.finditer(pat, res))[:2]:
                print(f"  [{pat}] …", re.sub(r"\s+", " ", _strip(res[max(0, m.start() - 200):m.end() + 200]))[:300])
        return
    r0 = rows[0]
    print("Перший результат — колонки:", {k: (len(v) if k not in ("id", "kind", "form", "reg_date") else v)
                                          for k, v in r0.items() if k != "url"})
    m = re.search(r"(?is)знайдено[^<]{0,80}", res)
    print("Лічильник:", _strip(m.group(0)) if m else "—")
    try:
        txt = decision_text(r0["id"])
        print(f"Текст рішення: {len(txt)} символів; початок: {txt[:120]!r}")
    except Exception as e:
        print(f"Текст рішення: помилка {type(e).__name__}")


def probe_variants(query):
    """Кілька варіантів POST — щоб знайти, який параметр заважає пошуку."""
    _, page = _req(BASE + "/")
    defaults = {}
    for tag in re.findall(r"(?is)<input[^>]*>", page):
        n = re.search(r'name="([^"]+)"', tag)
        v = re.search(r'value="([^"]*)"', tag)
        if n:
            defaults[n.group(1)] = (v.group(1) if v else "") + (" [checked]" if "checked" in tag else "")
    print("Значення input за замовчуванням:", {k: v[:40] for k, v in defaults.items()})
    for sel in re.findall(r'(?is)<select[^>]*name="([^"]+)"', page):
        print("select:", sel)
    variants = {
        "мінімум": {"SearchExpression": query},
        "мінімум+Sort0": {"SearchExpression": query, "Sort": "0", "PagingInfo.ItemsPerPage": "25"},
        "Liga=true": {"SearchExpression": query, "Liga": "true", "Sort": "0"},
        "Liga=false": {"SearchExpression": query, "Liga": "false", "Sort": "0"},
        "одне слово": {"SearchExpression": query.split()[0], "Sort": "0"},
    }
    for name, data in variants.items():
        try:
            _req(BASE + "/")
            st, res = _req(BASE + "/", data, referer=BASE + "/")
            tn = re.search(r"TotalNumber = (\d+)", res)
            print(f"{name}: {st}, рядків {len(parse_results(res))}, TotalNumber={tn.group(1) if tn else '?'}, "
                  f"'не знайдено'={'не знайдено' in res}")
        except Exception as e:
            print(f"{name}: помилка {type(e).__name__}")
        time.sleep(2)


if __name__ == "__main__":
    q = " ".join(sys.argv[1:]) or "огляд на стан сп'яніння 130 КУпАП"
    if os.environ.get("EDRSR_VARIANTS"):
        probe_variants(q)
    else:
        probe(q)
