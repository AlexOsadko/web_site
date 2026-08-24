#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Розвідка додаткових джерел для помічника «Практика ВС»:
  • Постанови Пленуму Верховного Суду (на supreme.court.gov.ua),
  • Рішення Конституційного Суду України (ccu.gov.ua).
Перевіряє доступність із раннера, кодування, структуру (посилання, заголовки)
і ШУКАЄ точні адреси розділів (грепом по навігації). Нічого не публікує.
Запуск: Actions → «Пробник джерел (Пленум/КСУ)».
"""
import re
import urllib.request
import urllib.error

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
HDR = {"User-Agent": UA, "Accept-Language": "uk,en;q=0.8",
       "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
       "Accept-Encoding": "identity"}


def fetch(url, timeout=25):
    try:
        req = urllib.request.Request(url, headers=HDR)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.getcode(), r.read()
    except urllib.error.HTTPError as e:
        try:
            return e.code, e.read()
        except Exception:
            return e.code, b""
    except Exception as ex:
        return None, ("ERR:" + str(ex)).encode()


def decode(raw):
    head = raw[:2000].decode("latin-1", "replace").lower()
    if "utf-8" in head:
        return raw.decode("utf-8", "replace")
    if "1251" in head:
        return raw.decode("cp1251", "replace")
    u = raw.decode("utf-8", "replace")
    return raw.decode("cp1251", "replace") if u.count("�") > 20 else u


def strip_tags(s):
    s = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", s)
    s = re.sub(r"(?s)<[^>]+>", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def links_with(html, needle):
    out = []
    for m in re.finditer(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', html, re.I | re.S):
        href, inner = m.group(1), strip_tags(m.group(2))
        if needle.lower() in href.lower() or needle.lower() in inner.lower():
            out.append((inner[:70], href))
    return out


def probe(label, url, needles=()):
    print("=" * 72)
    print(label)
    print("  " + url)
    code, raw = fetch(url)
    if code != 200 or not raw or raw.startswith(b"ERR:"):
        print(f"  ✗ статус {code}; {raw[:120]!r}")
        return None
    html = decode(raw)
    m = re.search(r"(?is)<title[^>]*>(.*?)</title>", html)
    title = strip_tags(m.group(1)) if m else ""
    print(f"  ✓ HTTP {code} · {len(raw)} байт · заголовок: {title[:70]!r}")
    for n in needles:
        found = links_with(html, n)[:8]
        print(f"  посилання з «{n}»: {len(found)}")
        for t, h in found:
            print(f"      · {t}  →  {h}")
    return html


def dump_structure(label, url):
    print("=" * 72)
    print("СТРУКТУРА: " + label)
    print("  " + url)
    code, raw = fetch(url)
    if code != 200 or not raw:
        print(f"  ✗ статус {code}")
        return
    html = decode(raw)
    # класи-кандидати контенту
    classes = sorted(set(c for c in re.findall(r'class="([^"]{0,50})"', html)
                         if re.search(r'detail|content|text|news|article|body|item|node|field', c, re.I)))
    print("  класи-кандидати:", classes[:30])
    m = re.search(r'(?is)<h1[^>]*>(.*?)</h1>', html)
    if m:
        print("  <h1>:", strip_tags(m.group(1))[:100])
    # абзаци
    paras = [strip_tags(p) for p in re.findall(r'(?is)<p[^>]*>(.*?)</p>', html)]
    paras = [p for p in paras if len(p) >= 40]
    print(f"  змістовних <p>: {len(paras)}")
    if paras:
        print("  перший абзац:", paras[0][:220])


def dump_links(label, url, limit=60):
    print("=" * 72)
    print("ПОСИЛАННЯ: " + label)
    print("  " + url)
    code, raw = fetch(url)
    if code != 200 or not raw:
        print(f"  ✗ статус {code}")
        return
    html = decode(raw)
    seen = set()
    n = 0
    for m in re.finditer(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', html, re.I | re.S):
        href, inner = m.group(1), strip_tags(m.group(2))
        if href in seen or len(inner) < 3:
            continue
        seen.add(href)
        # цікавлять посилання, що схожі на документ/сторінку постанови
        if re.search(r'plenium|postanov|/news/|\.pdf|\d{4,}', href, re.I):
            print(f"    {href}  |  {inner[:60]}")
            n += 1
        if n >= limit:
            break


def main():
    # 1) Пленум ВС — знайдена адреса /plenium/
    plen = probe("Пленум ВС — розділ",
                 "https://supreme.court.gov.ua/supreme/pro_sud/plenium/",
                 needles=("постанов", "plenium", "/news/"))
    dump_links("Пленум ВС — усі змістовні посилання",
               "https://supreme.court.gov.ua/supreme/pro_sud/plenium/")
    dump_structure("Пленум ВС — сторінка розділу",
                   "https://supreme.court.gov.ua/supreme/pro_sud/plenium/")

    # 2) КСУ — стрічка новин
    news = probe("КСУ — новини (/news)", "https://ccu.gov.ua/news",
                 needles=("/novyna/",))

    # 3) Структура статті КСУ (беремо перше /novyna/ посилання зі стрічки)
    if news:
        m = re.search(r'href="(/novyna/[^"]+)"', news)
        if m:
            dump_structure("Стаття КСУ", "https://ccu.gov.ua" + m.group(1))

    print("=" * 72)
    print("ГОТОВО")


if __name__ == "__main__":
    main()
