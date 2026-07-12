#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AI-генератор юридичних статей для сайту адвоката Олександра Осадька.

За заданою темою і категорією викликає модель Claude і створює нову статтю
у форматі даних content/articles/<slug>.json. Згенерована стаття відповідає
тим самим вимогам, що й наявні: SEO-заголовок із ключовим словом, meta-опис,
5–7 змістових розділів зі списками, рівно 3 питання у FAQ, українська мова,
практичний тон «пояснюю просто». Блок «Чим може допомогти адвокат», JSON-LD,
breadcrumbs, ключові слова та «читайте також» додає білдер (tools/build.py) —
тож усі статті лишаються однорідними.

Після створення файлу даних запустіть `python3 tools/build.py`, щоб згенерувати
HTML і автоматично оновити кількість статей на сайті (або передайте --build).

Використання:
    export ANTHROPIC_API_KEY=...
    python3 tools/generate_article.py --topic "Банкрутство фізичної особи" \
            --category business [--slug bankrutstvo-fizosoby] [--build]

Потрібен пакет `anthropic` (див. tools/requirements.txt).
"""
import os, re, sys, json, glob, argparse, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONTENT = os.path.join(ROOT, "content", "articles")

CATS = {
    "civil": "Цивільні справи та борги",
    "family": "Сімейні справи",
    "labor": "Трудові спори",
    "criminal": "Кримінальні справи",
    "military": "Військове право та мобілізація",
    "auto": "ДТП та автоправо",
    "realty": "Нерухомість і спадщина",
    "business": "Бізнес і господарські спори",
    "admin": "Адміністративні спори з держорганами",
    "social": "Пенсійні та соціальні виплати",
    "process": "Судовий процес",
}

DEFAULT_MODEL = "claude-opus-4-8"

# Мапа транслітерації для запасного slug (КМУ 2010, спрощена).
TRANSLIT = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'h', 'ґ': 'g', 'д': 'd', 'е': 'e', 'є': 'ie',
    'ж': 'zh', 'з': 'z', 'и': 'y', 'і': 'i', 'ї': 'i', 'й': 'i', 'к': 'k', 'л': 'l',
    'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
    'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch', 'ю': 'iu',
    'я': 'ia', 'ь': '', "'": '', '’': '',
}


def slugify(text):
    text = text.lower().strip()
    out = []
    for ch in text:
        if ch in TRANSLIT:
            out.append(TRANSLIT[ch])
        elif ch.isalnum() and ord(ch) < 128:
            out.append(ch)
        elif ch in ' _-':
            out.append('-')
    slug = re.sub(r'-+', '-', ''.join(out)).strip('-')
    return slug[:60] or "stattia"


def existing_slugs():
    return {os.path.splitext(os.path.basename(p))[0]
            for p in glob.glob(os.path.join(CONTENT, "*.json"))}


def next_order():
    mx = -1
    for p in glob.glob(os.path.join(CONTENT, "*.json")):
        try:
            with open(p, encoding="utf-8") as f:
                mx = max(mx, json.load(f).get("order", -1))
        except Exception:
            pass
    return mx + 1


SYSTEM_PROMPT = """Ти — досвідчений український юрист-копірайтер, який пише статті для сайту \
адвоката Олександра Осадька. Пишеш виключно українською мовою, простими словами, \
практично і по суті, без «води» та канцеляриту. Не вигадуй конкретних номерів статей \
законів, сум і строків, у яких не впевнений, — формулюй загально («за загальним правилом», \
«у встановлений законом строк»). Уникай гарантій результату.

Ти повертаєш РІВНО ОДИН об'єкт JSON (без markdown-огорожі, без пояснень до чи після) \
за такою схемою:

{
  "slug": "<латиниця, транслітерація теми, слова через дефіс, до 60 символів>",
  "cat": "<код категорії>",
  "title": "<стислий SEO-заголовок із головним ключовим словом, 45–65 символів>",
  "h1": "<розгорнутий заголовок сторінки, може бути довшим за title>",
  "desc": "<meta-опис 130–160 символів: суть + ключові слова + заклик, 1–2 речення>",
  "blocks": [
    {"type": "p", "text": "<вступний абзац, що вводить у проблему>"},
    {"type": "h2", "text": "<підзаголовок розділу>"},
    {"type": "p", "text": "<абзац>"},
    {"type": "ul", "items": ["<пункт>", "<пункт>", "<пункт>"]},
    ...
  ],
  "faq": [
    {"q": "<коротке питання, яке гуглять>", "a": "<стисла відповідь, 1–2 речення>"},
    {"q": "...", "a": "..."},
    {"q": "...", "a": "..."}
  ]
}

Вимоги до вмісту:
- blocks: 1 вступний абзац без заголовка, далі 5–7 розділів. Кожен розділ — це блок \
"h2" (підзаголовок) і після нього 1–2 блоки "p" та/або один список "ul"/"ol". \
Загалом у статті має бути щонайменше один список.
- НЕ додавай у blocks розділ «Чим може допомогти адвокат» чи заклик у кінці — його додає система.
- НЕ додавай у blocks заголовок «Часті запитання» — питання йдуть окремо в полі "faq".
- faq: рівно 3 пари питання–відповідь. Питання — те, що реально шукають у пошуку.
- Тексти в "text" та "items" можуть містити прості теги <strong>...</strong>; інших тегів не використовуй.
- Пиши природною українською; це має читатися як стаття практикуючого адвоката, а не реферат."""


def build_user_prompt(topic, category, slug_hint, taken):
    cat_name = CATS[category]
    taken_list = ", ".join(sorted(taken)) if taken else "(поки немає)"
    hint = f'\nБажаний slug (можеш скоригувати): "{slug_hint}".' if slug_hint else ""
    return (
        f"Напиши статтю на тему: «{topic}».\n"
        f"Категорія: {category} — {cat_name}. Постав саме це значення в поле \"cat\".{hint}\n\n"
        f"Уже наявні slug (не повторюй їх, зроби унікальний): {taken_list}.\n\n"
        f"Поверни лише JSON за схемою із system-повідомлення."
    )


def extract_json(text):
    text = text.strip()
    # Прибрати markdown-огорожу, якщо є.
    m = re.search(r"```(?:json)?\s*(.+?)\s*```", text, re.S)
    if m:
        text = m.group(1).strip()
    # Взяти найбільший блок {...}.
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1:
        raise ValueError("Відповідь не містить JSON-об'єкта")
    return json.loads(text[start:end + 1])


def validate(data, category):
    for key in ("title", "h1", "desc", "blocks", "faq"):
        if not data.get(key):
            raise ValueError(f"У відповіді відсутнє поле '{key}'")
    data["cat"] = category  # категорію задаємо ми, не модель
    blocks = data["blocks"]
    if not any(b.get("type") == "h2" for b in blocks):
        raise ValueError("У статті немає жодного розділу (h2)")
    if not any(b.get("type") in ("ul", "ol") for b in blocks):
        raise ValueError("У статті немає жодного списку")
    for b in blocks:
        t = b.get("type")
        if t in ("p", "h2") and not b.get("text"):
            raise ValueError(f"Порожній блок {t}")
        if t in ("ul", "ol") and not b.get("items"):
            raise ValueError(f"Порожній список {t}")
        if t not in ("p", "h2", "ul", "ol"):
            raise ValueError(f"Недопустимий тип блоку: {t}")
    faq = data["faq"]
    if len(faq) < 3:
        raise ValueError("Потрібно щонайменше 3 питання у FAQ")
    data["faq"] = [{"q": x["q"], "a": x["a"]} for x in faq[:3]]
    return data


def generate(topic, category, slug_hint, model):
    try:
        import anthropic
    except ImportError:
        sys.exit("Потрібен пакет anthropic. Встановіть: pip install -r tools/requirements.txt")

    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("Не задано змінну середовища ANTHROPIC_API_KEY")

    client = anthropic.Anthropic()
    taken = existing_slugs()
    user_prompt = build_user_prompt(topic, category, slug_hint, taken)

    # Стрімимо: стаття може бути довгою, а адаптивне мислення підвищує якість.
    with client.messages.stream(
        model=model,
        max_tokens=8000,
        thinking={"type": "adaptive"},
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_prompt}],
    ) as stream:
        final = stream.get_final_message()

    text = "".join(b.text for b in final.content if b.type == "text")
    data = validate(extract_json(text), category)

    # slug: пріоритет — підказка, потім від моделі, потім із заголовка.
    slug = slugify(slug_hint or data.get("slug") or data["title"])
    base, i = slug, 2
    while slug in taken:
        slug = f"{base}-{i}"
        i += 1
    data["slug"] = slug

    today = datetime.date.today().isoformat()
    data["order"] = next_order()
    data.setdefault("date_published", today)
    data["date_modified"] = today
    # Впорядковуємо ключі для акуратного файлу.
    ordered = {k: data[k] for k in
               ["slug", "cat", "title", "h1", "desc", "order",
                "date_published", "date_modified", "blocks", "faq"]}
    return ordered


def main():
    ap = argparse.ArgumentParser(description="AI-генератор статей для сайту адвоката")
    ap.add_argument("--topic", required=True, help="Тема статті (українською)")
    ap.add_argument("--category", required=True, choices=list(CATS),
                    help="Категорія: " + ", ".join(CATS))
    ap.add_argument("--slug", default="", help="Необов'язковий slug (латиницею)")
    ap.add_argument("--model", default=DEFAULT_MODEL, help=f"Модель (типово {DEFAULT_MODEL})")
    ap.add_argument("--build", action="store_true",
                    help="Одразу перебудувати сайт після генерації")
    args = ap.parse_args()

    os.makedirs(CONTENT, exist_ok=True)
    data = generate(args.topic, args.category, args.slug, args.model)

    path = os.path.join(CONTENT, data["slug"] + ".json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"✓ Створено статтю: {data['title']}")
    print(f"  Файл: content/articles/{data['slug']}.json")
    print(f"  Категорія: {args.category} · розділів: "
          f"{sum(1 for b in data['blocks'] if b['type'] == 'h2')} · FAQ: {len(data['faq'])}")

    if args.build:
        import build
        build.main()
    else:
        print("\nЗапустіть `python3 tools/build.py`, щоб згенерувати HTML і оновити лічильник.")


if __name__ == "__main__":
    main()
