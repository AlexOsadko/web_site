#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Додавання судових засідань у Google Calendar (через службовий акаунт).

Вмикається САМО, лише коли задано обидва секрети середовища:
  GOOGLE_CALENDAR_SA  — вміст JSON-ключа службового акаунта (рядок JSON).
  GOOGLE_CALENDAR_ID  — ID календаря, до якого надано доступ службовому акаунту
                        (email цього календаря або «...@group.calendar.google.com»).

Необов'язкові:
  GCAL_TIMEZONE     — часовий пояс подій, типово «Europe/Kyiv».
  GCAL_EVENT_HOURS  — тривалість події у годинах, типово 1.
  GCAL_REMINDERS    — попап-нагадування у хвилинах через кому, типово «1440,120»
                      (за добу і за 2 год). «0» або порожньо — без нагадувань.
  GCAL_DEADLINE_REMINDERS — нагадування про процесуальний строк (подія на весь
                      день), хвилини до початку дня через кому. Типово «3780,900»:
                      за 3 дні о 09:00 і напередодні о 09:00.

Крім засідань (add_event), модуль створює події на весь день:
  add_deadline  — процесуальний строк (команда бота /strok);
  add_new_case  — позначка «нова справа» в день, коли бот уперше побачив справу.

Ідемпотентність: iCalUID детермінований (номер+дата+суддя+суд), тож повторні
прогони НЕ дублюють подію — events.import оновлює наявну. Перепризначення на іншу
дату/суддю дає новий UID → нову подію (стару Google лишає як минулу).

Приватність: у публічні логи НЕ виводимо ПІБ/номери справ — лише знеособлені
повідомлення про помилки. Дані потрапляють тільки у приватний календар адвоката.
"""
import datetime
import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

_SA_RAW = os.environ.get("GOOGLE_CALENDAR_SA", "").strip()
_CAL_ID = os.environ.get("GOOGLE_CALENDAR_ID", "").strip()
_TZ = os.environ.get("GCAL_TIMEZONE", "Europe/Kyiv").strip() or "Europe/Kyiv"
_HOURS = float(os.environ.get("GCAL_EVENT_HOURS", "1") or "1")
_REMINDERS = [int(x) for x in re.findall(r"\d+",
              os.environ.get("GCAL_REMINDERS", "1440,120")) if int(x) > 0]

_DL_REMINDERS = [int(x) for x in re.findall(r"\d+",
                 os.environ.get("GCAL_DEADLINE_REMINDERS", "") or "3780,900")
                 if 0 < int(x) <= 40320]

_TOKEN_URL = "https://oauth2.googleapis.com/token"
_SCOPE = "https://www.googleapis.com/auth/calendar.events"

# Кеш access-token у межах одного запуску процесу.
_tok = {"value": "", "exp": 0}
_info = None
_disabled = False  # якщо ключ/бібліотека несправні — вимикаємось «тихо» на прогін


def enabled():
    return bool(_SA_RAW and _CAL_ID) and not _disabled


def _load_info():
    global _info, _disabled
    if _info is not None:
        return _info
    try:
        _info = json.loads(_SA_RAW)
        if not _info.get("client_email") or not _info.get("private_key"):
            raise ValueError("ключ без client_email/private_key")
    except Exception as e:
        _disabled = True
        print("Календар вимкнено: некоректний GOOGLE_CALENDAR_SA:", str(e)[:60])
        _info = None
    return _info


def _access_token():
    global _disabled
    now = int(time.time())
    if _tok["value"] and now < _tok["exp"]:
        return _tok["value"]
    info = _load_info()
    if not info:
        return ""
    try:
        # google-auth ставиться у workflow; імпорт — ліниво, щоб бот не падав,
        # якщо календар не налаштований (бібліотеки може не бути).
        from google.auth import crypt, jwt
    except Exception as e:
        _disabled = True
        print("Календар вимкнено: немає бібліотеки google-auth:", str(e)[:60])
        return ""
    try:
        signer = crypt.RSASigner.from_service_account_info(info)
        payload = {"iss": info["client_email"], "scope": _SCOPE,
                   "aud": _TOKEN_URL, "iat": now, "exp": now + 3600}
        assertion = jwt.encode(signer, payload)
        if isinstance(assertion, bytes):
            assertion = assertion.decode("ascii")
        data = urllib.parse.urlencode({
            "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
            "assertion": assertion,
        }).encode()
        req = urllib.request.Request(_TOKEN_URL, data=data)
        with urllib.request.urlopen(req, timeout=20) as r:
            tok = json.loads(r.read().decode("utf-8"))
        _tok["value"] = tok.get("access_token", "")
        _tok["exp"] = now + int(tok.get("expires_in", 3600)) - 60
        return _tok["value"]
    except Exception as e:
        print("Календар: не вдалося отримати токен:", str(e)[:80])
        return ""


def _parse_dt(s):
    """('2026-10-05', '15:00') або ('2026-10-05', None) з рядка court.gov.ua.
    Повертає None, якщо дату не розпізнано."""
    m = re.search(r"(\d{2})\.(\d{2})\.(\d{4})(?:[^\d]{1,3}(\d{1,2}):(\d{2}))?",
                  (s or "").strip())
    if not m:
        return None
    d, mo, y = m.group(1), m.group(2), m.group(3)
    date = f"{y}-{mo}-{d}"
    if m.group(4) and m.group(5):
        hh = int(m.group(4)); mm = int(m.group(5))
        if 0 <= hh <= 23 and 0 <= mm <= 59:
            return date, f"{hh:02d}:{mm:02d}"
    return date, None


def _add_hours(date, hm, hours):
    """Повертає (date, 'HH:MM') зсунуте на hours годин (у межах доби)."""
    hh, mm = (int(x) for x in hm.split(":"))
    total = hh * 60 + mm + int(round(hours * 60))
    total %= 24 * 60  # засідання коротке; доба не переходить у практиці
    return date, f"{total // 60:02d}:{total % 60:02d}"


def _uid(court_name, rec):
    base = "|".join([
        (rec.get("number") or "").strip(),
        (rec.get("date") or "").strip(),
        (rec.get("judge") or "").strip(),
        (court_name or "").strip(),
    ])
    return "court-" + hashlib.sha1(base.encode("utf-8")).hexdigest()[:24] + "@osadko.online"


def add_event(court_name, rec):
    """Створити/оновити подію засідання. Повертає True/False/None(вимкнено).

    rec — той самий словник, що й у боті: number, date, judge, involved,
    description, forma, courtroom, add_address (або address)."""
    if not enabled():
        return None
    parsed = _parse_dt(rec.get("date"))
    if not parsed:
        return None  # без розпізнаної дати подію не створюємо
    date, hm = parsed
    token = _access_token()
    if not token:
        return False

    number = (rec.get("number") or "").strip()
    summary = "⚖️ " + (number or "Судове засідання")
    if court_name:
        summary += " — " + court_name

    loc_parts = []
    if rec.get("add_address") or rec.get("address"):
        loc_parts.append((rec.get("add_address") or rec.get("address")).strip())
    if rec.get("courtroom"):
        loc_parts.append("зал/каб. " + rec["courtroom"].strip())
    location = ", ".join(p for p in loc_parts if p)

    desc = []
    if rec.get("judge"):
        desc.append("Суддя: " + rec["judge"].strip())
    if court_name:
        desc.append("Суд: " + court_name)
    if rec.get("forma"):
        desc.append("Форма: " + rec["forma"].strip())
    if rec.get("involved"):
        desc.append("Сторони: " + rec["involved"].strip())
    if rec.get("description"):
        desc.append("Суть: " + rec["description"].strip())

    event = {
        "iCalUID": _uid(court_name, rec),
        "summary": summary,
        "location": location,
        "description": "\n".join(desc),
        "source": {"title": "Бот відстеження справ", "url": "https://osadko.online/"},
    }
    if hm:
        _, end_hm = _add_hours(date, hm, _HOURS)
        event["start"] = {"dateTime": f"{date}T{hm}:00", "timeZone": _TZ}
        event["end"] = {"dateTime": f"{date}T{end_hm}:00", "timeZone": _TZ}
    else:
        # Час не вказано — подія на весь день (кінець = наступний день, вимога API).
        y, mo, d = (int(x) for x in date.split("-"))
        nxt = time.strftime("%Y-%m-%d", time.localtime(
            time.mktime((y, mo, d, 12, 0, 0, 0, 0, -1)) + 86400))
        event["start"] = {"date": date}
        event["end"] = {"date": nxt}
    if _REMINDERS:
        event["reminders"] = {"useDefault": False,
                              "overrides": [{"method": "popup", "minutes": m}
                                            for m in _REMINDERS]}

    return _import(event, token)


def _import(event, token):
    """events.import: створити або оновити подію за її iCalUID. True/False."""
    url = ("https://www.googleapis.com/calendar/v3/calendars/"
           + urllib.parse.quote(_CAL_ID, safe="") + "/events/import")
    body = json.dumps(event).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            r.read()
        return True
    except urllib.error.HTTPError as e:
        # Знеособлено: без ПІБ/номера у публічних логах — лише код і причина.
        print(f"Календар: подію не додано (HTTP {e.code}).")
        return False
    except Exception as e:
        print("Календар: подію не додано:", str(e)[:60])
        return False


def _iso_date(s):
    """«05.12.2026» або «2026-12-05» → «2026-12-05». None, якщо дати немає."""
    s = (s or "").strip()
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        y, mo, d = m.group(1), m.group(2), m.group(3)
    else:
        m = re.search(r"(\d{2})\.(\d{2})\.(\d{4})", s)
        if not m:
            return None
        d, mo, y = m.group(1), m.group(2), m.group(3)
    try:
        return datetime.date(int(y), int(mo), int(d)).isoformat()
    except ValueError:
        return None


def today_kyiv():
    """Сьогоднішня дата за часовим поясом календаря («2026-11-21»)."""
    try:
        from zoneinfo import ZoneInfo
        return datetime.datetime.now(ZoneInfo(_TZ)).date().isoformat()
    except Exception:
        return (datetime.datetime.utcnow() + datetime.timedelta(hours=2)).date().isoformat()


def add_allday(uid_base, summary, date, description="", reminders=None):
    """Подія на весь день. Ідемпотентна за uid_base. True/False/None(вимкнено
    або дату не розпізнано)."""
    if not enabled():
        return None
    day = _iso_date(date)
    if not day:
        return None
    token = _access_token()
    if not token:
        return False
    y, mo, d = (int(x) for x in day.split("-"))
    nxt = (datetime.date(y, mo, d) + datetime.timedelta(days=1)).isoformat()
    event = {
        "iCalUID": hashlib.sha1(uid_base.encode("utf-8")).hexdigest()[:24] + "@osadko.online",
        "summary": summary,
        "description": description,
        "start": {"date": day},
        "end": {"date": nxt},
        "transparency": "transparent",  # не займає час у календарі
        "source": {"title": "Бот відстеження справ", "url": "https://osadko.online/"},
        "reminders": {"useDefault": False,
                      "overrides": [{"method": "popup", "minutes": m}
                                    for m in (reminders or [])]},
    }
    return _import(event, token)


def add_deadline(number, title, due, note=""):
    """Процесуальний строк: подія на весь день у останній день строку з
    нагадуваннями заздалегідь (GCAL_DEADLINE_REMINDERS)."""
    number = (number or "").strip()
    title = (title or "").strip() or "Процесуальний строк"
    day = _iso_date(due)
    if not day:
        return None
    desc = ["Останній день строку."]
    if number:
        desc.append("Справа: " + number)
    if note:
        desc.append("Розрахунок: " + note.strip())
    summary = "⏳ Строк: " + title + (" – " + number if number else "")
    return add_allday("deadline|" + number + "|" + day + "|" + title,
                      summary, day, "\n".join(desc), _DL_REMINDERS)


def add_new_case(court_name, rec, day=None, unverified=False):
    """Позначка «нова справа» в день, коли бот уперше побачив справу. Одна на
    справу в суді: повторний виклик оновлює ту саму подію, а не створює другу."""
    number = (rec.get("number") or "").strip()
    if not number:
        return None
    desc = []
    if court_name:
        desc.append("Суд: " + court_name)
    if rec.get("judge"):
        desc.append("Суддя: " + rec["judge"].strip())
    if rec.get("involved"):
        desc.append("Сторони: " + rec["involved"].strip())
    if rec.get("description"):
        desc.append("Суть: " + rec["description"].strip())
    if rec.get("date"):
        desc.append("Найближче засідання: " + rec["date"].strip())
    if unverified:
        # Збіг лише за ПІБ клієнта: можливий тезка, тож просимо перевірити.
        desc.insert(0, "Знайдено за збігом ПІБ – перевірте, чи це ваш клієнт.")
    summary = ("🆕 Нова справа " + ("(перевірити) " if unverified else "") + number
               + (" – " + court_name if court_name else ""))
    return add_allday("newcase|" + number + "|" + (court_name or ""),
                      summary, day or today_kyiv(), "\n".join(desc), [])
