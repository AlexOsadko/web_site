#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AI-генератор юридичних статей на Claude API (Anthropic SDK).

Аналізує пошуковий намір за темою, формує структуру, генерує Meta Title,
Meta Description, H1–H3, повний матеріал на 2000–5000 слів, FAQ, alt-тексти
й підказки внутрішніх посилань — і зберігає готовий JSON у content/articles/,
звідки його підхоплює tools/build.py.

ВИМОГИ:
    pip install "anthropic>=0.40"
    export ANTHROPIC_API_KEY="sk-ant-..."

ПРИКЛАД:
    python3 tools/ai_article.py \
        --topic "Оскарження податкового повідомлення-рішення" \
        --cat business \
        --keyword "оскарження ППР адвокат" \
        --build            # одразу перезібрати сайт

    python3 tools/ai_article.py --topic "..." --cat family --dry-run   # без запису

КАТЕГОРІЇ (cat): family, criminal, civil, admin, business, military,
                 labor, auto, realty, social, process
"""
import argparse
import datetime
import json
import os
import re
import sys

MODEL = "claude-opus-4-8"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ART_DIR = os.path.join(ROOT, "content", "articles")

CATS = ["family", "criminal", "civil", "admin", "business",
        "military", "labor", "auto", "realty", "social", "process"]

# ── Транслітерація заголовка у ЧПУ-slug ──────────────────────────────────
_TRANSLIT = {
    'а':'a','б':'b','в':'v','г':'h','ґ':'g','д':'d','е':'e','є':'ie','ж':'zh',
    'з':'z','и':'y','і':'i','ї':'i','й':'i','к':'k','л':'l','м':'m','н':'n',
    'о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'kh','ц':'ts',
    'ч':'ch','ш':'sh','щ':'shch','ь':'','ю':'iu','я':'ia',"'":'','’':'','ʼ':'',
}


def slugify(title):
    s = title.lower().strip()
    out = []
    for ch in s:
        if ch in _TRANSLIT:
            out.append(_TRANSLIT[ch])
        elif ch.isascii() and (ch.isalnum()):
            out.append(ch)
        elif ch in " -_":
            out.append("-")
    slug = re.sub(r"-+", "-", "".join(out)).strip("-")
    return slug[:70] or "stattia"


def next_order():
    mx = 0
    for f in os.listdir(ART_DIR):
        if f.endswith(".json"):
            try:
                mx = max(mx, int(json.load(open(os.path.join(ART_DIR, f)))["order"]))
            except Exception:
                pass
    return mx + 1


def existing_slugs():
    return {f[:-5] for f in os.listdir(ART_DIR) if f.endswith(".json")}


# ── Промпт ───────────────────────────────────────────────────────────────
SYSTEM = """\
Ти — досвідчений український юридичний копірайтер і SEO-фахівець. Пишеш для \
сайту адвоката (osadko.online) українською мовою: точно, практично, без води, \
доступною мовою для звичайних людей. Не вигадуєш номерів статей законів, які не \
певен; формулюєш загальні, але коректні правові орієнтири. Ніколи не даєш \
стовідсоткових гарантій результату. Дотримуєшся структури й обсягу, які просять."""

USER_TMPL = """\
Підготуй SEO-статтю на тему: «{topic}».
Категорія сайту: {cat}.
Головний пошуковий запит (ключ): «{keyword}».

СПОЧАТКУ подумки проаналізуй пошуковий намір: що саме хоче знати людина, яка \
шукає це в Google, які підпитання в неї виникають, які помилки вона робить. \
Потім напиши повноцінний матеріал.

ВИМОГИ ДО ОБСЯГУ ТА СТРУКТУРИ:
- обсяг основного тексту: 2000–5000 слів;
- чітка ієрархія: один H1, розділи H2, за потреби підрозділи H3;
- практичні блоки: покрокові дії, списки, типові помилки, строки, коли \
  потрібен адвокат;
- 6–8 питань у FAQ з ґрунтовними відповідями;
- природні входження ключа та синонімів (без переспаму).

ПОВЕРНИ ВІДПОВІДЬ СУВОРО як ОДИН JSON-об'єкт (без коментарів, без markdown-огорожі) \
за такою схемою:
{{
  "title":  "Meta Title, до 60 символів",
  "h1":     "Заголовок H1 сторінки",
  "desc":   "Meta Description, 140–160 символів",
  "blocks": [
     {{"type":"p",  "text":"абзац"}},
     {{"type":"h2", "text":"заголовок розділу"}},
     {{"type":"h3", "text":"підзаголовок"}},
     {{"type":"ul", "items":["пункт","пункт"]}}
  ],
  "faq": [ {{"q":"питання","a":"відповідь"}} ],
  "image_alt": ["alt-текст для ілюстрації 1", "alt-текст 2"],
  "internal_links": [ {{"anchor":"якір у тексті","topic":"на яку суміжну тему"}} ]
}}
У "blocks" НЕ дублюй H1 (він окремо). Перший блок — вступний абзац (type:p)."""


def extract_json(text):
    """Дістає JSON-об'єкт із відповіді (на випадок обгортки чи пояснень)."""
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    start = text.find("{")
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return json.loads(text[start:i + 1])
    raise ValueError("Не вдалося розпарсити JSON із відповіді моделі.")


def generate(topic, cat, keyword):
    try:
        import anthropic
    except ImportError:
        sys.exit("Потрібен пакет anthropic: pip install \"anthropic>=0.40\"")
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("Не задано ANTHROPIC_API_KEY (export ANTHROPIC_API_KEY=sk-ant-...).")

    client = anthropic.Anthropic()
    prompt = USER_TMPL.format(topic=topic, cat=cat, keyword=keyword or topic)

    # Стрімимо (велика відповідь), адаптивне мислення для якісної структури.
    with client.messages.stream(
        model=MODEL,
        max_tokens=16000,
        thinking={"type": "adaptive"},
        system=SYSTEM,
        messages=[{"role": "user", "content": prompt}],
    ) as stream:
        final = stream.get_final_message()

    text = "".join(b.text for b in final.content if b.type == "text")
    return extract_json(text)


def to_record(data, cat, slug):
    today = datetime.date.today().isoformat()
    # лишаємо тільки блоки відомих типів
    blocks = [b for b in data.get("blocks", [])
              if b.get("type") in ("p", "h2", "h3", "ul", "ol")]
    rec = {
        "slug": slug,
        "cat": cat,
        "title": data["title"].strip(),
        "h1": data.get("h1", data["title"]).strip(),
        "desc": data["desc"].strip(),
        "order": next_order(),
        "date_published": today,
        "date_modified": today,
        "blocks": blocks,
        "faq": data.get("faq", []),
    }
    # метадані (не заважають build.py; корисні для ревʼю та alt-текстів)
    if data.get("image_alt"):
        rec["image_alt"] = data["image_alt"]
    if data.get("internal_links"):
        rec["internal_links"] = data["internal_links"]
    return rec


def main():
    ap = argparse.ArgumentParser(description="AI-генератор статей на Claude API")
    ap.add_argument("--topic", required=True, help="Тема статті")
    ap.add_argument("--cat", required=True, choices=CATS, help="Категорія сайту")
    ap.add_argument("--keyword", default="", help="Головний пошуковий запит")
    ap.add_argument("--slug", default="", help="ЧПУ (за замовчуванням — з title)")
    ap.add_argument("--dry-run", action="store_true", help="Не записувати, лише показати")
    ap.add_argument("--build", action="store_true", help="Після запису перезібрати сайт")
    args = ap.parse_args()

    print(f"→ Генерую статтю: «{args.topic}» (cat={args.cat})…", file=sys.stderr)
    data = generate(args.topic, args.cat, args.keyword)

    slug = args.slug or slugify(data.get("h1") or data["title"])
    if slug in existing_slugs():
        slug = f"{slug}-{next_order()}"
    rec = to_record(data, args.cat, slug)

    words = sum(len(b.get("text", "").split()) for b in rec["blocks"])
    words += sum(len(" ".join(b.get("items", [])).split()) for b in rec["blocks"])
    print(f"✓ Готово: {slug}  (~{words} слів, FAQ:{len(rec['faq'])})", file=sys.stderr)
    print(f"  Title: {rec['title']}", file=sys.stderr)
    print(f"  Desc:  {rec['desc']}", file=sys.stderr)

    if args.dry_run:
        print(json.dumps(rec, ensure_ascii=False, indent=2))
        return

    path = os.path.join(ART_DIR, slug + ".json")
    json.dump(rec, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"  Записано: {os.path.relpath(path, ROOT)}", file=sys.stderr)

    if args.build:
        import subprocess
        subprocess.run([sys.executable, os.path.join(ROOT, "tools", "build.py")], check=True)


if __name__ == "__main__":
    main()
