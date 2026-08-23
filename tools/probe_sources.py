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


def main():
    # 1) Пленум ВС — шукаємо розділ у навігації сайту ВС
    probe("Верховний Суд — про суд (шукаємо Пленум)",
          "https://supreme.court.gov.ua/supreme/pro_sud/",
          needles=("plenum", "плен", "постанов"))
    for u in [
        "https://supreme.court.gov.ua/supreme/pro_sud/plenum_verhovnogo_sudu/",
        "https://supreme.court.gov.ua/supreme/pro_sud/postanovy_plenumu/",
        "https://supreme.court.gov.ua/supreme/pokazniki-diyalnosti/plenum/",
    ]:
        probe("Пленум ВС (спроба адреси)", u, needles=("постанов", "плен"))

    # 2) КСУ — головна + новини/рішення
    probe("Конституційний Суд — головна",
          "https://ccu.gov.ua/",
          needles=("novyn", "новин", "rishen", "рішенн", "act", "doccatalog"))
    for u in [
        "https://ccu.gov.ua/novyny",
        "https://ccu.gov.ua/akty",
        "https://ccu.gov.ua/rishennya-vysnovky",
        "https://ccu.gov.ua/dovidnyk/rishennya",
    ]:
        probe("КСУ (спроба адреси)", u, needles=("рішенн", "висновок", "справ"))

    print("=" * 72)
    print("ГОТОВО")


if __name__ == "__main__":
    main()
