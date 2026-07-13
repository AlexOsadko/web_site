#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Надсилає sitemap.xml у Google Search Console через Search Console API.

Викликається з GitHub Actions (.github/workflows/submit-sitemap.yml) після
кожної зміни sitemap.xml. Використовує сервісний акаунт Google, доданий як
власник ресурсу в Search Console.

Змінні середовища (задаються як GitHub Secrets):
  GSC_SA_KEY   — JSON-ключ сервісного акаунта Google (повний вміст файлу).
  GSC_SITE_URL — ресурс у Search Console. Два формати:
                   • URL-префікс:  https://osadko.online/
                   • домен:        sc-domain:osadko.online
  SITEMAP_URL  — (необов'язково) адреса sitemap. За замовчуванням
                 https://osadko.online/sitemap.xml

Якщо GSC_SA_KEY не задано — скрипт тихо завершується (щоб воркфлоу не падав,
поки автоматизацію не налаштовано).
"""
import os
import sys
import json
from urllib.parse import quote

SITEMAP_URL = os.environ.get("SITEMAP_URL", "https://osadko.online/sitemap.xml")


def main():
    key_json = os.environ.get("GSC_SA_KEY", "").strip()
    site_url = os.environ.get("GSC_SITE_URL", "").strip()
    if not key_json or not site_url:
        print("GSC_SA_KEY / GSC_SITE_URL не задано — пропускаю надсилання sitemap.")
        return 0

    try:
        import requests
        import google.auth.transport.requests
        from google.oauth2 import service_account
    except ImportError as e:
        print("Немає залежностей (google-auth, requests):", e)
        return 1

    creds = service_account.Credentials.from_service_account_info(
        json.loads(key_json),
        scopes=["https://www.googleapis.com/auth/webmasters"],
    )
    creds.refresh(google.auth.transport.requests.Request())

    site_enc = quote(site_url, safe="")
    feed_enc = quote(SITEMAP_URL, safe="")
    api = f"https://www.googleapis.com/webmasters/v3/sites/{site_enc}/sitemaps/{feed_enc}"

    resp = requests.put(api, headers={"Authorization": f"Bearer {creds.token}"}, timeout=30)
    if resp.status_code in (200, 204):
        print(f"✓ Sitemap надіслано в Search Console: {SITEMAP_URL} (ресурс {site_url})")
        return 0
    print(f"✗ Помилка надсилання: HTTP {resp.status_code} — {resp.text}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
