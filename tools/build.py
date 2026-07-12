#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Канонічний білдер сайту адвоката Олександра Осадька.

Єдине джерело правди — файли даних content/articles/<slug>.json.
Скрипт генерує зі спільного шаблону:
  • articles/<slug>.html   — SEO-сторінка кожної статті (JSON-LD, FAQ, breadcrumbs, keywords, «читайте також»);
  • articles/index.html    — каталог статей із фільтром за категоріями;
  • index.html             — оновлює лічильник статей на головній (кількість змінюється автоматично);
  • sitemap.xml, robots.txt — для індексації в пошукових системах.

Кількість статей на сайті обчислюється автоматично з кількості файлів даних
і підставляється всюди, де вона згадується. Тобто після додавання нової статті
(вручну або через AI-генератор tools/generate_article.py) достатньо перезапустити
цей скрипт — і сайт оновиться сам.

Використання:
    python3 tools/build.py
"""
import os, re, json, glob, html

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONTENT = os.path.join(ROOT, "content", "articles")
ART = os.path.join(ROOT, "articles")
BASE_URL = "https://alexosadko.github.io/web_site/"
ART_BASE_URL = BASE_URL + "articles/"
DATE_LABEL = "Липень 2026"

# ---------- КАТЕГОРІЇ ----------
CATS = {
    "civil":    "Цивільні справи та борги",
    "family":   "Сімейні справи",
    "labor":    "Трудові спори",
    "criminal": "Кримінальні справи",
    "auto":     "ДТП та автоправо",
    "realty":   "Нерухомість і спадщина",
    "business": "Бізнес і господарські спори",
    "process":  "Судовий процес",
}
SHORT_CAT = {
    "civil": "Борги та договори", "family": "Сімейне право", "labor": "Трудові спори",
    "criminal": "Кримінальні справи", "auto": "ДТП та авто", "realty": "Нерухомість",
    "business": "Бізнес", "process": "Судовий процес",
}
ORDER = ["civil", "family", "labor", "criminal", "auto", "realty", "business", "process"]

KW_BASE = {
    "civil": "стягнення боргу, цивільний адвокат, позов, договір, відшкодування шкоди",
    "family": "сімейний адвокат, розлучення, аліменти, поділ майна, батьківські права",
    "labor": "трудовий спір, незаконне звільнення, невиплата зарплати, трудовий адвокат",
    "criminal": "кримінальний адвокат, захисник, допит, обшук, запобіжний захід",
    "auto": "автоюрист, ДТП, позбавлення прав, страхове відшкодування, оскарження штрафу",
    "realty": "нерухомість, спадщина, заповіт, купівля квартири, земельні спори",
    "business": "адвокат для бізнесу, господарський спір, договір, ФОП, стягнення боргу",
    "process": "судовий процес, позовна заява, апеляція, виконавче провадження, адвокат у суді",
}
CAT_NOTE = {
    "civil": "тут важливо правильно зібрати докази, дотримати строків і грамотно сформулювати вимоги.",
    "family": "тут на кону не лише майно, а й стосунки з близькими та інтереси дітей.",
    "labor": "тут діють скорочені строки й особливі гарантії, а роботодавець зазвичай має юриста.",
    "criminal": "тут кожне слово має значення, а помилка на початку може коштувати свободи.",
    "auto": "тут результат часто залежить від процедури оформлення та фіксації обставин.",
    "realty": "тут ціна помилки висока, а угоду чи спадщину можуть оскаржити роками пізніше.",
    "business": "тут важливо передбачити ризики заздалегідь і діяти на випередження.",
    "process": "тут виграє той, хто знає процедуру і не пропускає процесуальних строків.",
}
NOTE_LINK = '<a href="../index.html#contacts">зв\'яжіться зі мною</a>'

# Головна: 6 обраних статей у секції «Статті» (curated).
FEATURED = ["yak-povernuty-borh", "rozirvannya-shlyubu", "pershyi-dopyt",
            "nezakonne-zvilnennya", "dtp-algorytm", "spadschyna-pryynyaty"]

# Плаваючі кнопки швидкого зв'язку (однакові на всіх сторінках).
FAB_HTML = """<div class="fab" aria-label="Швидкий зв'язок">
  <a class="fab-btn fab-tg" href="https://t.me/adv_osadko" target="_blank" rel="noopener" aria-label="Telegram">
    <svg viewBox="0 0 24 24"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
  </a>
  <a class="fab-btn fab-wa" href="https://wa.me/380934664443" target="_blank" rel="noopener" aria-label="WhatsApp">
    <svg viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.885-9.885 9.885M20.52 3.449C18.24 1.245 15.24 0 12.045 0 5.463 0 .104 5.359.101 11.945c0 2.096.548 4.142 1.588 5.945L0 24l6.335-1.652a11.882 11.882 0 005.71 1.446h.005c6.585 0 11.946-5.359 11.949-11.945a11.821 11.821 0 00-3.479-8.4"/></svg>
  </a>
  <a class="fab-btn fab-vb" href="viber://chat?number=%2B380934664443" aria-label="Viber">
    <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
  </a>
  <button class="fab-btn fab-top" type="button" onclick="window.scrollTo({top:0,behavior:'smooth'})" aria-label="Нагору">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>
  </button>
</div>"""


def esc(s):
    return html.escape(s)


def plural_uk(n, forms):
    """forms = (one, few, many): 1 стаття / 2 статті / 5 статей."""
    n = abs(int(n))
    if n % 10 == 1 and n % 100 != 11:
        return forms[0]
    if 2 <= n % 10 <= 4 and not (12 <= n % 100 <= 14):
        return forms[1]
    return forms[2]


def strip_tags(s):
    return re.sub(r"<[^>]+>", "", s)


def reading_time(body_html):
    words = len(strip_tags(body_html).split())
    return max(2, round(words / 160))


# ---------- ЗАВАНТАЖЕННЯ ДАНИХ ----------
def load_articles():
    arts = []
    for path in glob.glob(os.path.join(CONTENT, "*.json")):
        with open(path, encoding="utf-8") as f:
            a = json.load(f)
        a.setdefault("order", 10_000)
        if a["cat"] not in CATS:
            raise ValueError(f"{path}: невідома категорія '{a['cat']}'")
        arts.append(a)
    # Стабільний, детермінований порядок: спочатку за полем order, потім за slug.
    arts.sort(key=lambda a: (a["order"], a["slug"]))
    return arts


# ---------- РЕНДЕР ТІЛА СТАТТІ ----------
def blocks_to_html(blocks):
    out = []
    for b in blocks:
        t = b["type"]
        if t == "h2":
            out.append(f"  <h2>{b['text']}</h2>")
        elif t == "p":
            out.append(f"  <p>{b['text']}</p>")
        elif t in ("ul", "ol"):
            items = "\n".join(f"    <li>{i}</li>" for i in b["items"])
            out.append(f"  <{t}>\n{items}\n  </{t}>")
    return "\n\n".join(out)


def closing_blocks(cat, h1):
    topic = h1[0].lower() + h1[1:]
    return [
        {"type": "h2", "text": "Чим може допомогти адвокат"},
        {"type": "p", "text": f"Питання, як-от «{topic.rstrip('.')}», рідко бувають типовими: "
                              f"{CAT_NOTE[cat]} Адвокат Олександр Осадько проаналізує вашу ситуацію, "
                              f"чесно оцінить перспективи, підготує документи і візьме на себе спілкування "
                              f"із судом та іншою стороною. Це економить час, гроші й нерви, а головне — "
                              f"підвищує шанси на результат. Щоб отримати пораду саме для вашого випадку, "
                              + NOTE_LINK + "."},
    ]


def build_faq_html(faq):
    out = []
    for item in faq:
        out.append(f'''    <details>
      <summary>{esc(item["q"])}</summary>
      <p>{esc(item["a"])}</p>
    </details>''')
    return "\n".join(out)


def build_related_html(cur_slug, cat, allmeta):
    same = [a for a in allmeta if a["cat"] == cat and a["slug"] != cur_slug]
    rest = [a for a in allmeta if a["cat"] != cat and a["slug"] != cur_slug]
    pick = (same + rest)[:3]
    out = []
    for a in pick:
        out.append(f'''      <a class="related-card" href="{a['slug']}.html">
        <span class="cat cat-{a['cat']}">{esc(SHORT_CAT[a['cat']])}</span>
        <h3>{esc(a['title'])}</h3>
      </a>''')
    return "\n".join(out)


def build_jsonld(a, faq):
    slug, cat, title, desc, h1 = a["slug"], a["cat"], a["title"], a["desc"], a["h1"]
    url = ART_BASE_URL + slug + ".html"
    article = {
        "@type": "Article", "headline": h1, "description": desc, "inLanguage": "uk",
        "datePublished": a.get("date_published", "2026-07-01"),
        "dateModified": a.get("date_modified", "2026-07-11"),
        "author": {"@type": "Person", "name": "Олександр Осадько", "jobTitle": "Адвокат"},
        "publisher": {"@type": "Person", "name": "Адвокат Олександр Осадько"},
        "mainEntityOfPage": {"@type": "WebPage", "@id": url},
    }
    crumbs = {
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Головна", "item": BASE_URL},
            {"@type": "ListItem", "position": 2, "name": "Статті", "item": ART_BASE_URL},
            {"@type": "ListItem", "position": 3, "name": CATS[cat], "item": ART_BASE_URL + "index.html"},
            {"@type": "ListItem", "position": 4, "name": title, "item": url},
        ],
    }
    faqpage = {
        "@type": "FAQPage",
        "mainEntity": [
            {"@type": "Question", "name": item["q"],
             "acceptedAnswer": {"@type": "Answer", "text": item["a"]}}
            for item in faq
        ],
    }
    graph = {"@context": "https://schema.org", "@graph": [article, crumbs, faqpage]}
    return json.dumps(graph, ensure_ascii=False)


ARTICLE_PAGE = """<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{title} — адвокат Олександр Осадько</title>
  <meta name="description" content="{desc}">
  <meta name="keywords" content="{kw}">
  <link rel="canonical" href="{url}">
  <meta name="robots" content="index, follow">
  <meta property="og:type" content="article">
  <meta property="og:title" content="{title}">
  <meta property="og:description" content="{desc}">
  <meta property="og:url" content="{url}">
  <meta property="og:site_name" content="Адвокат Олександр Осадько">
  <meta property="og:locale" content="uk_UA">
  <meta name="twitter:card" content="summary">
  <link rel="icon" type="image/svg+xml" href="../assets/logo-mark.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,800&family=Inter:wght@300;400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="../css/style.css">
  <script type="application/ld+json">{jsonld}</script>
</head>
<body>

<header class="site-header">
  <div class="container header-inner">
    <a href="../index.html" class="brand">
      <span class="brand-mark"><img src="../assets/logo-mark.svg" alt="Логотип адвоката Осадька"></span>
      Осадько
    </a>
    <nav class="site-nav">
      <a href="../articles/index.html">Статті</a>
      <a href="../index.html#contacts" class="nav-cta">Консультація</a>
    </nav>
  </div>
</header>

<main class="article-page">
  <nav class="crumbs" aria-label="Хлібні крихти">
    <a href="../index.html">Головна</a><span>/</span>
    <a href="index.html">Статті</a><span>/</span>
    <a href="index.html#{cat}">{catname}</a><span>/</span>
    <span class="cur">{crumb}</span>
  </nav>
  <span class="cat cat-{cat}">{catname}</span>
  <h1>{h1}</h1>
  <p class="meta-line">Оновлено: {date} · <span>⏱ {read} хв читання</span> · Адвокат Олександр Осадько</p>

{body}

  <h2 id="faq">Часті запитання</h2>
  <div class="faq">
{faq}
  </div>

  <p class="article-note">
    Ця стаття має загальний інформаційний характер і не є юридичною
    консультацією. Кожна ситуація індивідуальна — щоб отримати пораду саме для
    вашого випадку, <a href="../index.html#contacts">зв'яжіться з адвокатом</a>.
  </p>

  <aside class="related">
    <h2>Читайте також</h2>
    <div class="related-grid">
{related}
    </div>
  </aside>
</main>

{fab}

<footer class="site-footer">
  <div class="container footer-inner">
    <span class="brand">
      <span class="brand-mark" style="width:28px;height:28px"><img src="../assets/logo-mark.svg" alt=""></span>
      Осадько
    </span>
    <span>© <span id="year"></span> Адвокат Олександр Осадько. Усі права захищено.</span>
  </div>
</footer>

<script>document.getElementById('year').textContent = new Date().getFullYear();</script>

</body>
</html>
"""


def render_article(a, allmeta):
    faq = a.get("faq", [])
    full_blocks = a["blocks"] + closing_blocks(a["cat"], a["h1"])
    body = blocks_to_html(full_blocks)
    kw = f"{a['title'].lower()}, адвокат, юрист, {KW_BASE[a['cat']]}, Україна, консультація адвоката"
    repl = {
        "{title}": esc(a["title"]), "{desc}": esc(a["desc"]), "{kw}": esc(kw),
        "{url}": ART_BASE_URL + a["slug"] + ".html", "{jsonld}": build_jsonld(a, faq),
        "{cat}": a["cat"], "{catname}": CATS[a["cat"]], "{crumb}": esc(a["title"]),
        "{h1}": esc(a["h1"]), "{date}": DATE_LABEL, "{read}": str(reading_time(body)),
        "{body}": body, "{faq}": build_faq_html(faq), "{related}": build_related_html(a["slug"], a["cat"], allmeta),
        "{fab}": FAB_HTML,
    }
    page = ARTICLE_PAGE
    for k, v in repl.items():
        page = page.replace(k, v)
    return page


# ---------- КАТАЛОГ articles/index.html ----------
def render_catalog(arts):
    n = len(arts)
    groups_html = []
    for cat in ORDER:
        items = [a for a in arts if a["cat"] == cat]
        if not items:
            continue
        cards = []
        for a in items:
            cards.append(f'''      <a class="mini-card reveal" href="{a['slug']}.html">
        <span class="cat cat-{cat}">{esc(SHORT_CAT[cat])}</span>
        <h3>{esc(a['title'])}</h3>
        <p>{esc(a['desc'])}</p>
        <span class="more">Читати →</span>
      </a>''')
        groups_html.append(f'''    <div class="cat-group" data-cat="{cat}">
      <div class="cat-group-head">
        <span class="cat cat-{cat}">{esc(SHORT_CAT[cat])}</span>
        <h2>{esc(CATS[cat])}</h2>
        <span class="count">{len(items)} {plural_uk(len(items), ("стаття","статті","статей"))}</span>
      </div>
      <div class="cat-grid">
{chr(10).join(cards)}
      </div>
    </div>''')

    filter_btns = ['      <button class="active" data-f="all">Усі</button>']
    for cat in ORDER:
        if any(a["cat"] == cat for a in arts):
            filter_btns.append(f'      <button data-f="{cat}">{esc(SHORT_CAT[cat])}</button>')

    materials = plural_uk(n, ("матеріал", "матеріали", "матеріалів"))
    return f'''<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Статті — Олександр Осадько, адвокат</title>
  <meta name="description" content="Юридичні статті адвоката Олександра Осадька: борги та договори, сімейне право, трудові спори, кримінальні справи, ДТП, нерухомість, бізнес і судовий процес.">
  <link rel="canonical" href="{ART_BASE_URL}index.html">
  <link rel="icon" type="image/svg+xml" href="../assets/logo-mark.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,800&family=Inter:wght@300;400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="../css/style.css">
</head>
<body>

<header class="site-header">
  <div class="container header-inner">
    <a href="../index.html" class="brand">
      <span class="brand-mark"><img src="../assets/logo-mark.svg" alt="Логотип адвоката Осадька"></span>
      Осадько
    </a>
    <nav class="site-nav">
      <a href="../index.html#about">Про мене</a>
      <a href="../index.html#services">Послуги</a>
      <a href="index.html">Статті</a>
      <a href="../index.html#contacts" class="nav-cta">Консультація</a>
    </nav>
  </div>
</header>

<main>
  <section class="catalog-hero">
    <div class="container">
      <a href="../index.html" class="back-link">← На головну</a>
      <h1>Статті</h1>
      <p>Пояснюю правові питання простою мовою — {n} {materials} про борги, сім'ю, роботу, кримінальні справи, ДТП, нерухомість і бізнес. Оберіть тему нижче.</p>
      <div class="cat-filter" id="filter">
{chr(10).join(filter_btns)}
      </div>
    </div>
  </section>

  <section class="catalog">
    <div class="container" id="groups">
{chr(10).join(groups_html)}
    </div>
  </section>
</main>

{FAB_HTML}

<footer class="site-footer">
  <div class="container footer-inner">
    <span class="brand">
      <span class="brand-mark" style="width:28px;height:28px"><img src="../assets/logo-mark.svg" alt=""></span>
      Осадько
    </span>
    <span>© <span id="year"></span> Адвокат Олександр Осадько. Усі права захищено.</span>
  </div>
</footer>

<script>
  document.getElementById('year').textContent = new Date().getFullYear();
  // Фільтр за категоріями
  const btns = document.querySelectorAll('#filter button');
  const groups = document.querySelectorAll('#groups .cat-group');
  btns.forEach(b => b.addEventListener('click', () => {{
    btns.forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    const f = b.dataset.f;
    groups.forEach(g => g.style.display = (f === 'all' || g.dataset.cat === f) ? '' : 'none');
  }}));
  // Поява при скролі
  const io = new IntersectionObserver((e) => {{
    e.forEach(x => {{ if (x.isIntersecting) {{ x.target.classList.add('in'); io.unobserve(x.target); }} }});
  }}, {{ threshold: 0.08 }});
  document.querySelectorAll('.reveal').forEach(el => io.observe(el));
</script>
</body>
</html>
'''


# ---------- ОНОВЛЕННЯ ЛІЧИЛЬНИКА НА ГОЛОВНІЙ ----------
def update_homepage_count(n):
    """Оновлює лише кількість статей на index.html (обрані картки лишаються без змін)."""
    idx_path = os.path.join(ROOT, "index.html")
    with open(idx_path, encoding="utf-8") as f:
        idx = f.read()
    materials = plural_uk(n, ("матеріал", "матеріали", "матеріалів"))
    articles_word = plural_uk(n, ("статтю", "статті", "статей"))
    idx, c1 = re.subn(r"Усього \d+ матеріал\w* за темами\.",
                      f"Усього {n} {materials} за темами.", idx)
    idx, c2 = re.subn(r"Переглянути всі \d+ стат\w+ →",
                      f"Переглянути всі {n} {articles_word} →", idx)
    with open(idx_path, "w", encoding="utf-8") as f:
        f.write(idx)
    return c1, c2


# ---------- SITEMAP + ROBOTS ----------
def write_sitemap(arts):
    urls = [BASE_URL, ART_BASE_URL + "index.html"]
    urls += [ART_BASE_URL + a["slug"] + ".html" for a in arts]
    lastmod = max((a.get("date_modified", "2026-07-11") for a in arts), default="2026-07-11")
    body = "\n".join(
        f"  <url><loc>{u}</loc><lastmod>{lastmod}</lastmod>"
        f"<changefreq>monthly</changefreq><priority>{'1.0' if u == BASE_URL else '0.7'}</priority></url>"
        for u in urls
    )
    xml = ('<?xml version="1.0" encoding="UTF-8"?>\n'
           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
           + body + "\n</urlset>\n")
    with open(os.path.join(ROOT, "sitemap.xml"), "w", encoding="utf-8") as f:
        f.write(xml)


def write_robots():
    txt = ("User-agent: *\n"
           "Allow: /\n\n"
           f"Sitemap: {BASE_URL}sitemap.xml\n")
    with open(os.path.join(ROOT, "robots.txt"), "w", encoding="utf-8") as f:
        f.write(txt)


# ---------- ГОЛОВНИЙ ПРОХІД ----------
def main():
    os.makedirs(ART, exist_ok=True)
    arts = load_articles()
    n = len(arts)

    for a in arts:
        page = render_article(a, arts)
        with open(os.path.join(ART, a["slug"] + ".html"), "w", encoding="utf-8") as f:
            f.write(page)

    with open(os.path.join(ART, "index.html"), "w", encoding="utf-8") as f:
        f.write(render_catalog(arts))

    c1, c2 = update_homepage_count(n)
    write_sitemap(arts)
    write_robots()

    missing_slug = [s for s in FEATURED if s not in {a["slug"] for a in arts}]
    print(f"Побудовано статей: {n}")
    print(f"Оновлено лічильник на головній: секція={c1}, кнопка={c2}")
    if missing_slug:
        print(f"⚠ Обрані статті відсутні в даних: {missing_slug}")
    print("Готово: articles/, articles/index.html, index.html, sitemap.xml, robots.txt")


if __name__ == "__main__":
    main()
