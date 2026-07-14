#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Повідомляє пошукові системи (Bing, Yandex та інші учасники IndexNow) про нові
чи оновлені сторінки — миттєво, через протокол IndexNow.

Ключ IndexNow є ПУБЛІЧНИМ: він лежить у файлі <KEY>.txt у корені сайту, чим
підтверджує право власності. Тому його можна тримати прямо в коді.

Використання:
    python3 tools/indexnow.py [шлях/до/файлу.html ...]
Якщо передано список змінених файлів — надсилаються лише відповідні URL.
Якщо аргументів немає — надсилається головна сторінка та каталог статей.
"""
import sys
import json
import urllib.request

BASE = "https://osadko.online/"
HOST = "osadko.online"
KEY = "fd6086321b78ee49574fa7bb4fd031f3"
KEY_LOCATION = BASE + KEY + ".txt"
ENDPOINT = "https://api.indexnow.org/indexnow"


def path_to_url(path):
    path = path.strip().lstrip("./")
    if not path:
        return None
    if path == "index.html":
        return BASE  # канонічна головна — без index.html
    return BASE + path


def main(argv):
    paths = [a for a in argv if a.endswith(".html")]
    urls = []
    for p in paths:
        u = path_to_url(p)
        if u and u not in urls:
            urls.append(u)
    if not urls:
        urls = [BASE, BASE + "articles/index.html"]
    urls = urls[:10000]

    payload = {
        "host": HOST,
        "key": KEY,
        "keyLocation": KEY_LOCATION,
        "urlList": urls,
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        ENDPOINT, data=data,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            print(f"✓ IndexNow: надіслано {len(urls)} URL, статус HTTP {resp.status}")
            return 0
    except urllib.error.HTTPError as e:
        # 200/202 = ок; інші коди виводимо, але не валимо збірку
        body = e.read().decode("utf-8", "ignore")
        if e.code in (200, 202):
            print(f"✓ IndexNow: надіслано {len(urls)} URL, статус HTTP {e.code}")
            return 0
        print(f"IndexNow відповів HTTP {e.code}: {body}")
        return 0
    except Exception as e:
        print(f"IndexNow: не вдалося надіслати ({e}) — пропускаю.")
        return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
