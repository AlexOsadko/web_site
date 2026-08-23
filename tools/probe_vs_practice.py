#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Пробник джерел практики Верховного Суду: перевіряє, які офіційні джерела
реально віддають контент із GitHub-раннера (HTTP-код, розмір, тип, наявність
характерних слів). Нічого не публікує. Мета — зрозуміти, на що спиратися для
аналітичних оглядів практики ВС (Варіант А), не покладаючись на «памʼять» AI.
Запуск: Actions → «Пробник практики ВС».
"""
import re
import sys
import time
import urllib.request
import urllib.error

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
HEADERS = {
    "User-Agent": UA,
    "Accept-Language": "uk,en;q=0.8",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Encoding": "identity",
}

# Кандидатні джерела практики ВС (від найкориснішого до загального).
SOURCES = [
    ("Судова влада — новини RSS (КОНТРОЛЬ, має працювати)",
     "https://court.gov.ua/press/news/rss"),
    ("База правових позицій ВС (LPD) — головна",
     "https://lpd.court.gov.ua/"),
    ("База правових позицій ВС (LPD) — пошук",
     "https://lpd.court.gov.ua/home/search"),
    ("Верховний Суд — головна",
     "https://supreme.court.gov.ua/supreme/"),
    ("Верховний Суд — прес-центр (новини)",
     "https://supreme.court.gov.ua/supreme/pres-centr/news/"),
    ("Верховний Суд — новини RSS",
     "https://supreme.court.gov.ua/supreme/pres-centr/news/rss"),
    ("Верховний Суд — судова практика (огляди)",
     "https://supreme.court.gov.ua/supreme/pokazniki-diyalnosti/sudova_praktika/"),
    ("Верховний Суд — огляди практики (дайджести)",
     "https://supreme.court.gov.ua/supreme/pokazniki-diyalnosti/sudova_praktika/ogliady/"),
    ("ЄДРСР — головна",
     "https://reyestr.court.gov.ua/"),
]

KEYWORDS = ["практик", "постанов", "правов", "верховн", "оскарж", "огляд", "позиц"]


def fetch(url, tries=3, timeout=25):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
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
                time.sleep(2 * (i + 1))
    raise last


def sniff(raw):
    try:
        text = raw.decode("utf-8", "replace")
    except Exception:
        text = str(raw)
    low = text.lower()
    found = [k for k in KEYWORDS if k in low]
    m = re.search(r"<title[^>]*>(.*?)</title>", text, re.I | re.S)
    title = re.sub(r"\s+", " ", m.group(1)).strip()[:90] if m else ""
    return found, title


def main():
    for name, url in SOURCES:
        print("=" * 72)
        print(name)
        print("  " + url)
        try:
            code, ct, raw = fetch(url)
            found, title = sniff(raw)
            ok = code == 200 and len(raw) > 500
            mark = "✓" if ok else "✗"
            print(f"  {mark} HTTP {code} · {len(raw)} байт · {ct.split(';')[0]}")
            if title:
                print(f"     заголовок: {title!r}")
            print(f"     ключові слова: {found if found else '—'}")
        except Exception as ex:
            print(f"  ✗ ПОМИЛКА: {ex}")
    print("=" * 72)
    print("ГОТОВО")


if __name__ == "__main__":
    main()
