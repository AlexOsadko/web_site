#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Вбудувати сторінку вебзастосунку (webapp/app.html) у worker/worker.js.

Запускати після кожної зміни webapp/app.html:  python3 tools/build_webapp.py
Потім оновити код воркера в Cloudflare (Edit code → вставити worker.js → Deploy).
"""
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "webapp", "app.html")
DST = os.path.join(ROOT, "worker", "worker.js")


def main():
    with open(SRC, encoding="utf-8") as f:
        html = f.read()
    with open(DST, encoding="utf-8") as f:
        js = f.read()
    lit = json.dumps(html, ensure_ascii=False).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    block = "/*APP_HTML_BEGIN*/const APP_HTML = " + lit + ";/*APP_HTML_END*/"
    new, n = re.subn(r"/\*APP_HTML_BEGIN\*/.*?/\*APP_HTML_END\*/", lambda _: block, js, flags=re.S)
    if n != 1:
        raise SystemExit("У worker.js не знайдено позначок APP_HTML_BEGIN/APP_HTML_END")
    with open(DST, "w", encoding="utf-8") as f:
        f.write(new)
    print("Сторінку вбудовано: %d символів" % len(html))


if __name__ == "__main__":
    main()
