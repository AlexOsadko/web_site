# SEO та функції сайту osadko.online

Технічний опис того, що реалізовано на сайті: SEO, конверсія та AI-генерація
статей. Документ підтримується разом із кодом.

---

## 1. Повне технічне SEO

### Семантика та структура
- **Semantic HTML** — `<header>`, `<main>`, `<section>`, `<nav>`, `<article>`,
  `<footer>`; коректна ієрархія заголовків **H1 → H2 → H3** (по одному H1 на
  сторінці).
- **ЧПУ-структура URL** — людиночитні адреси без параметрів:
  `/articles/rozirvannya-shlyubu.html`, `/zrazky/`. Slug-и генеруються
  транслітерацією заголовка (`tools/ai_article.py → slugify`, `tools/build.py`).
- **Наскрізна перелінковка** — `tools/build.py` автоматично проставляє
  внутрішні посилання на перші згадки ключових фраз (`autolink_blocks`,
  `LINK_TERMS`, ліміт `MAX_AUTOLINKS`) + блок «Схожі теми» (`build_related_html`)
  на кожній статті.

### Мета-теги та соцмережі
- **Meta Title / Description** — унікальні на кожній сторінці.
- **Canonical** — `<link rel="canonical">` на кожній сторінці (самопосилання).
- **Open Graph** — `og:type`, `og:title`, `og:description`, `og:url`,
  `og:site_name`, `og:locale=uk_UA`, `og:image` (1200×630, крос-безпечний банер).
- **Twitter Cards** — `summary_large_image` з `twitter:title/description/image`.
- **Favicon** — `assets/logo-mark.png`.

### Структуровані дані (JSON-LD, Schema.org)
Головна сторінка (`index.html`) — граф `@graph`:
- **WebSite** — назва, мова, зв'язок із видавцем;
- **Attorney / LegalService / LocalBusiness** — назва, телефон, email, адреса
  (`PostalAddress`), `geo`, `openingHoursSpecification`, `areaServed`
  (Київ + Україна), `knowsAbout`, `sameAs`;
- **OfferCatalog → Service** — 10 послуг (консультації, представництво в судах,
  сімейні, кримінальні, ДТП, військове, нерухомість/спадщина, трудові,
  господарські, адміністративні);
- **Person** — Олександр Осадько (адвокат), `worksFor` → бізнес.

Сторінки статей (генерує `tools/build.py`):
- **Article** — заголовок, опис, дати публікації/зміни, автор `Person`;
- **FAQPage** — блок питань-відповідей (розширені сніпети в Google);
- **BreadcrumbList** — «хлібні крихти» для навігації у видачі.

Каталог статей — **CollectionPage / WebPage** + **BreadcrumbList**.

### Індексація
- **XML Sitemap** — `sitemap.xml`, 216 URL, `lastmod` = дата збірки
  (`tools/build.py → write_sitemap`).
- **robots.txt** — `Allow: /` + посилання на sitemap.
- **Google Search Console** — авто-сабміт sitemap через сервісний акаунт
  (`tools/submit_sitemap.py`, воркфлоу `.github/workflows/submit-sitemap.yml`).
- **IndexNow (Bing/Yandex)** — миттєвий пінг про нові/змінені сторінки
  (`tools/indexnow.py`, `.github/workflows/indexnow.yml`, ключ у корені сайту).

---

## 2. Конверсія

- **Форми захоплення лідів** — головна форма консультації (`#leadForm`) +
  спливаюче вікно «Замовити дзвінок» (`assets/callback-popup.js`) на всіх
  сторінках. Дані йдуть на Cloudflare Worker → Telegram.
- **Sticky-CTA для мобільних** — липка нижня панель (`.mcta`) з кнопками
  «Подзвонити» + «Консультація»; з'являється після прокручування, ховається
  біля секції контактів.
- **Плаваючі кнопки месенджерів** — FAB (`.fab`): дзвінок, **Telegram**,
  **WhatsApp**, **Viber** + анімована кнопка «нагору».
- **Кнопка дзвінка** — `tel:` у шапці контактів, у FAB та в мобільній панелі.
- **Антиспам** — Cloudflare Turnstile + перевірка Origin + honeypot на боці
  Worker'а (`docs/telegram-worker.js`).

---

## 3. AI-генерація статей (Claude API)

Скрипт `tools/ai_article.py` генерує повноцінну SEO-статтю через Anthropic SDK
(модель `claude-opus-4-8`, адаптивне мислення, стрімінг).

**Що робить модель:**
1. аналізує **пошуковий намір** за темою й ключем;
2. формує **структуру** (H1 → H2 → H3), логіку розділів;
3. генерує **Meta Title / Description**, повний матеріал **2000–5000 слів**,
   практичні блоки (покроково, помилки, строки), **6–8 FAQ**;
4. пропонує **alt-тексти** ілюстрацій та якорі **внутрішніх посилань**;
5. повертає **строгий JSON** у схемі сайту → зберігається у
   `content/articles/<slug>.json`, звідки його підхоплює `tools/build.py`.

**Встановлення й ключ:**
```bash
pip install "anthropic>=0.40"
export ANTHROPIC_API_KEY="sk-ant-..."
```

**Запуск:**
```bash
# згенерувати й одразу перезібрати сайт
python3 tools/ai_article.py \
    --topic "Оскарження податкового повідомлення-рішення" \
    --cat business \
    --keyword "оскарження ППР адвокат" \
    --build

# лише подивитися результат, без запису
python3 tools/ai_article.py --topic "..." --cat family --dry-run
```

**Категорії (`--cat`):** family, criminal, civil, admin, business, military,
labor, auto, realty, social, process.

**Після генерації:**
```bash
python3 tools/build.py                     # зібрати сторінки + оновити sitemap
git add -A && git commit -m "Нова стаття" && git push origin HEAD:main
```
Пуш автоматично тригерить сабміт sitemap (Google) та IndexNow (Bing/Yandex).

> Примітка: `internal_links` та `image_alt` зберігаються у JSON як метадані для
> ревʼю. Наскрізну перелінковку у тілі статті додатково робить `build.py`
> автоматично (`autolink_blocks`).

---

## Робочий процес (single source of truth)

```
content/articles/*.json   ← джерело (руками або через ai_article.py)
        │
        ▼  python3 tools/build.py
articles/*.html, articles/index.html, index.html, sitemap.xml, robots.txt
        │
        ▼  git push origin HEAD:main
GitHub Pages (osadko.online)  +  auto: submit-sitemap.yml, indexnow.yml
```
