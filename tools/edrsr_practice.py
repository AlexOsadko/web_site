#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Практика з ЄДРСР за темою (бот: «📚 Практика → 🔎 Пошук практики»).

1. Claude перетворює тему адвоката на пошукові вирази для реєстру й форму
   судочинства (КУпАП — без касації: остання інстанція апеляційна).
2. Пошук у ЄДРСР (tools/edrsr.py): Верховний Суд (касація) і апеляція,
   рішення з 2018 року, за релевантністю.
3. Тягнемо тексти найкращих кандидатів, Claude відбирає до 3 рішень, що ПРЯМО
   стосуються питання, і стисло пояснює позицію суду — лише з тексту рішення,
   з номером справи, датою й посиланням.

Env: VS_QUERY, TELEGRAM_BOT_TOKEN, TELEGRAM_REVIEW_CHAT, ANTHROPIC_API_KEY.
Лог — лише лічильники (тема пошуку не є персональними даними, але й її не друкуємо).
"""
import html as _html
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import edrsr  # noqa: E402
from vs_practice_query import ask_claude, tg_send  # noqa: E402

QUERY = os.environ.get("VS_QUERY", "").strip()
MAX_SEND = int(os.environ.get("EDRSR_MAX", "3") or "3")
PER_SEARCH = 8          # кандидатів з кожного пошуку
TEXT_LIMIT = 14000      # символів тексту рішення для аналізу

PLAN_SYSTEM = """Ти допомагаєш адвокату шукати судову практику в ЄДРСР (повнотекстовий пошук
reyestr.court.gov.ua). За темою адвоката поверни ЛИШЕ JSON без пояснень:
{"queries": ["…", "…"], "cs_type": "N"}
- queries: 2 пошукові вирази з 2–5 ключових слів, як вони трапляються в тексті рішень
  (без лапок і операторів; номер статті — числом, напр. «130 КУпАП огляд медичний заклад»).
  Перший — вужчий (точніше про суть питання), другий — ширший.
- cs_type: форма судочинства: "1" цивільне, "2" кримінальне, "3" господарське,
  "4" адміністративне, "5" справи про адміністративні правопорушення (КУпАП), "" якщо неясно."""

PICK_SYSTEM = """Ти — помічник адвоката-практика. Тобі дають тему пошуку і тексти судових рішень
з ЄДРСР. Відбери до {n} рішень, які ПРЯМО стосуються питання адвоката (не просто тієї ж статті),
найкорисніші — першими (Верховний Суд вище за апеляцію; свіжіші вище за старі).
Для кожного відібраного напиши блок УКРАЇНСЬКОЮ, без markdown:

<b>{{суд}}, {{дата}}, справа № {{номер}}</b>
Позиція: що саме вирішив суд у цьому питанні і чому (2–4 речення, лише з тексту).
Цитата: одне ключове речення з мотивувальної частини дослівно, у лапках.
Для практики: як цим скористатися (1–2 пункти з «— »).
[ID:{{id}}]

Суд, дату, номер справи бери ТІЛЬКИ з тексту рішення. Нічого не вигадуй.
Якщо жодне рішення прямо не стосується питання — відповідай одним словом НЕМАЄ."""


def send_long(text):
    """Безпечний HTML (дозволено лише <b>) частинами до ~3900 символів."""
    safe = _html.escape(text, quote=False).replace("&lt;b&gt;", "<b>").replace("&lt;/b&gt;", "</b>")
    parts, cur = [], ""
    for block in safe.split("\n\n"):
        if len(cur) + len(block) + 2 > 3900 and cur:
            parts.append(cur)
            cur = ""
        cur += block + "\n\n"
    if cur.strip():
        parts.append(cur)
    for p in parts:
        try:
            tg_send(p.strip())
        except Exception:
            tg_send(_html.escape(re.sub(r"</?b>", "", p.strip()), quote=False))
        time.sleep(0.5)


def plan(query):
    raw = ask_claude(PLAN_SYSTEM, f"Тема адвоката: {query}", max_tokens=400)
    m = re.search(r"\{.*\}", raw or "", re.S)
    try:
        p = json.loads(m.group(0)) if m else {}
    except ValueError:
        p = {}
    qs = [q.strip() for q in p.get("queries", []) if isinstance(q, str) and q.strip()][:2]
    if not qs:   # запасний варіант — сама тема без службових слів
        qs = [re.sub(r"\b(ст|ч|п)\.\s*", "", query)]
    cs = str(p.get("cs_type", "")).strip()
    return qs, cs if cs in ("1", "2", "3", "4", "5") else ""


def gather(queries, cs):
    """Кандидати: касація (крім КУпАП) і апеляція, з 2018 р., за релевантністю."""
    instances = ["2"] if cs == "5" else ["3", "2"]
    seen, out = set(), []
    for q in queries:
        for ins in instances:
            try:
                rows = search_ins(q, cs, ins)
            except Exception as e:
                print(f"Пошук: помилка {type(e).__name__}")
                continue
            print(f"Пошук (інстанція {ins}): кандидатів {len(rows)}")
            for r in rows[:PER_SEARCH]:
                if r["id"] not in seen:
                    seen.add(r["id"])
                    r["ins"] = ins
                    out.append(r)
            time.sleep(1.5)   # ввічлива пауза для реєстру
    # касація першою, далі апеляція; у межах — як віддав реєстр (релевантність)
    out.sort(key=lambda r: 0 if r["ins"] == "3" else 1)
    return out


def search_ins(query, cs, ins):
    edrsr._req(edrsr.BASE + "/")
    data = {"SearchExpression": query, "Sort": "0", "PagingInfo.ItemsPerPage": "25",
            "INSType": ins, "RegDateBegin": "01.01.2018"}
    if cs:
        data["CSType"] = cs
    _, res = edrsr._req(edrsr.BASE + "/", data, referer=edrsr.BASE + "/")
    return edrsr.parse_results(res)


def main():
    if not QUERY:
        print("Порожній VS_QUERY.")
        return
    queries, cs = plan(QUERY)
    print(f"Пошукових виразів: {len(queries)}, форма: {cs or '—'}")
    cands = gather(queries, cs)[:12]
    docs = []
    for r in cands:
        try:
            txt = edrsr.decision_text(r["id"])
        except Exception as e:
            print(f"Текст: помилка {type(e).__name__}")
            continue
        if len(txt) > 500:
            docs.append((r, txt))
        time.sleep(1)
    print(f"Текстів рішень: {len(docs)}")
    q = _html.escape(QUERY)
    if not docs:
        tg_send(f"📚 <b>ЄДРСР</b> · за темою «{q}» рішень не знайшов. "
                "Спробуйте інші слова (напр. лише статтю й ключове поняття).")
        return
    body = "\n\n".join(
        f"=== Рішення ID {r['id']} ({'Верховний Суд/касація' if r['ins'] == '3' else 'апеляція'}; "
        f"{r['kind']}; {r['reg_date']}) ===\n{txt[:TEXT_LIMIT]}" for r, txt in docs)
    out = ask_claude(PICK_SYSTEM.format(n=MAX_SEND),
                     f"Тема адвоката: {QUERY}\n\n{body}", max_tokens=4000)
    if not out or out.strip().startswith("НЕМАЄ"):
        tg_send(f"📚 <b>ЄДРСР</b> · за темою «{q}» переглянув {len(docs)} рішень ВС і апеляції — "
                "жодне прямо не стосується питання. Спробуйте сформулювати інакше.")
        print("Релевантних: 0")
        return
    # [ID:…] → посилання на рішення в реєстрі
    out = re.sub(r"\[ID:\s*(\d+)\]", lambda m: f"🔗 {edrsr.BASE}/Review/{m.group(1)}", out)
    n = len(re.findall(r"/Review/\d+", out))
    send_long(f"<b>📚 ЄДРСР · практика за темою «{QUERY}»</b>\n"
              f"переглянуто рішень: {len(docs)} (ВС і апеляція, з 2018 р.)\n\n" + out)
    print(f"Надіслано рішень: {n}")


if __name__ == "__main__":
    main()
