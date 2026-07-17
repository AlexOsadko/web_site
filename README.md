# Сайт адвоката Олександра Осадька

Сайт-візитівка та юридичний контент-хаб адвоката: головна сторінка, велика база
SEO-статей, безкоштовні памʼятки (lead-магніти) і форми заявок із доставкою в Telegram.

**Онлайн:** https://osadko.online

Статичний сайт (без бекенду): чистий HTML/CSS/JS, збірка на Python, хостинг —
GitHub Pages, домен через `CNAME`. Динаміку (заявки, аналітика, captcha) забезпечують
зовнішні сервіси.

## Структура

- `index.html` — головна (надзаголовок, «Про мене», послуги, статті, памʼятки, контакти)
- `content/articles/*.json` — **дані статей (єдине джерело правди)**; наразі 203 статті
- `articles/*.html` — згенеровані сторінки статей і тематичні хаби (**не редагувати руками**)
- `css/style.css` — стилі (світла/темна теми через CSS-змінні; кеш-версія `?v=N`)
- `assets/` — логотип, фото, OG-банери, `ga.js` (аналітика), памʼятки `pamyatka-*.pdf`
- `sitemap.xml`, `robots.txt` — генеруються білдером
- `docs/` — документація й код Cloudflare Worker (див. нижче)
- `tools/` — інструменти генерації та SEO
- `.github/workflows/` — автодеплой і автоматизації (див. нижче)

## Статті: дані + білдер

Статті зберігаються як дані у `content/articles/<slug>.json`. HTML не редагують руками —
його генерує білдер зі спільного шаблону, тож усі статті однорідні.

```bash
python3 tools/build.py
```

Білдер створює сторінки статей і тематичні хаби, каталог, `sitemap.xml` (з реальною
`lastmod` кожної статті), `robots.txt`, і **сам оновлює кількість статей** усюди. Що
додається до кожної статті автоматично:

- SEO-теги, canonical, OG/Twitter;
- розмітка JSON-LD: `Article` (+ `wordCount`, `articleSection`), `BreadcrumbList`, `FAQPage`;
- хлібні крихти, блок FAQ, «Читайте також»;
- **автоперелінкування** — перші згадки ключових фраз стають посиланнями на профільні
  статті (до 8 на статтю, словник у `tools/build.py`).

Категорії: `civil`, `family`, `labor`, `criminal`, `auto`, `realty`, `business`,
`process`, `military`, `social`, `admin`.

## AI-генерація статей

`tools/generate_article.py` викликає Claude і створює нову глибоку статтю за темою та
категорією (7–10 розділів, 1500–2500 слів, 6–8 FAQ, українською, практичний тон).

**Локально:**
```bash
pip install -r tools/requirements.txt
export ANTHROPIC_API_KEY=...
python3 tools/generate_article.py --topic "Банкрутство фізичної особи" --category business --build
```

**Через GitHub (без коду):** Actions → «Створити статтю (AI)» → Run workflow (потрібен
секрет `ANTHROPIC_API_KEY`). Воркфлоу генерує статтю, перебудовує сайт, комітить — і Pages
публікує оновлення.

## Памʼятки (lead-магніти)

У блоці на головній — бібліотека памʼяток «що робити прямо зараз» (`assets/pamyatka-*.pdf`:
ст. 130 КУпАП, ТЦК/повістка, обшук, ДТП, колектори). Доступ до завантаження відкривається
після залишення контакту. Контакт іде в Telegram, а при кліку на конкретну памʼятку —
окреме повідомлення з її назвою (видно, що саме цікавить клієнта). Памʼятки закриті від
індексації в `robots.txt`, щоб їх качали лише через форму.

## Форми та заявки → Telegram

Заявки з форм (консультація, зворотний дзвінок, памʼятки) надсилаються на **Cloudflare
Worker** (`docs/telegram-worker.js`), який пересилає їх у Telegram. Токен бота живе в
секретах воркера, не в коді сайту. Антиспам: Cloudflare **Turnstile** (де є віджет),
honeypot, часова пастка та перевірка `Origin`. Форма зворотного дзвінка — `assets/callback-popup.js`.

## Аналітика та реклама

`assets/ga.js` — Google Analytics 4 з **Consent Mode v2** (банер згоди на cookie) та тег
**Google Ads**; конверсія фіксується в момент успішного надсилання заявки.

## SEO та автоматизація

- `sitemap.xml` автоматично надсилається в Google, а зміни — в **IndexNow** (Bing/Yandex)
  при кожному деплої (`tools/indexnow.py`, `tools/submit_sitemap.py` + воркфлоу).
- Темна/світла тема — перемикач у шапці (localStorage + `prefers-color-scheme`, без блимання).

### Воркфлоу (`.github/workflows/`)

- `pages.yml` — деплой на GitHub Pages при пуші в `main`
- `generate-article.yml` — AI-генерація статті (ручний запуск)
- `submit-sitemap.yml` — надсилання sitemap у Google
- `indexnow.yml` — пінг IndexNow (Bing/Yandex)

Sitemap/IndexNow тригеряться і після бот-комітів генератора статей (через `workflow_run`).

## Налаштування (секрети)

- **GitHub → Actions secrets:** `ANTHROPIC_API_KEY` (для AI-генерації).
- **Cloudflare Worker secrets:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
  `TURNSTILE_SECRET`, `ALLOWED_ORIGIN` (= `https://osadko.online`).

## Локальний перегляд

```bash
python3 -m http.server 8000   # → http://localhost:8000
```
