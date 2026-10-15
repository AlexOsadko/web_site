# Сайт адвоката Олександра Осадька

Сайт адвоката: головна, сторінки послуг, база юридичних статей, памʼятки, контакти,
чат на сайті та форми заявок із доставкою в Telegram. Окремо — генератор договорів
і Telegram-боти для роботи адвоката (судові засідання, судова практика).

**Онлайн:** https://osadko.online

Статичний сайт: HTML/CSS/JS, збірка на Python, хостинг — GitHub Pages з гілки `main`,
домен через `CNAME`. Динаміку (заявки, чат, боти) забезпечують Cloudflare Workers.

## Структура

- `index.html` — головна (редагується вручну)
- `content/articles/*.json` — дані статей (єдине джерело правди), понад 400 статей
- `content/landings/*.json` — дані сторінок послуг
- `articles/`, `poslugy/`, `kontakty/` — згенеровані сторінки (**не редагувати руками**)
- `dogovir/` — генератор договорів про надання правничої допомоги
- `p/` — оплата, `vidguk/` — відгук, `privacy/` — політика конфіденційності,
  `zrazky/`, `docs/index.html` — допоміжні сторінки
- `css/site.css` — спільні стилі (темно-синій + білий, заголовки Source Serif 4);
  `css/style.css`, `css/fonts.css` — базові стилі та шрифти
- `assets/` — `site.js` (спільний скрипт), `chat.js` (чат), `lead-form.js` і
  `callback-popup.js` (форми), `ga.js` (аналітика), фото, памʼятки `pamyatka-*.pdf`
- `sitemap.xml`, `robots.txt`, `llms.txt` — генеруються білдером
- `tools/` — білдер, AI-генерація статей, SEO, скрипти ботів
- `worker/` — код Cloudflare Workers (боти, заявки, чат)
- `docs/*.md` — внутрішні нотатки й інструкції

## Збірка сайту

```bash
python3 tools/build.py
```

Білдер генерує сторінки статей і тематичні хаби, сторінки послуг, контакти,
`sitemap.xml`, `robots.txt`, `llms.txt`. До кожної статті автоматично додаються
SEO-теги, OG, JSON-LD (`Article`, `BreadcrumbList`, `FAQPage`), хлібні крихти, FAQ,
«Читайте також» і автоперелінкування.

Категорії статей: `civil`, `family`, `labor`, `criminal`, `auto`, `realty`,
`business`, `process`, `military`, `social`, `admin`.

## AI-генерація статей

`tools/generate_article.py` створює статтю за темою й категорією через Claude.
Через GitHub: Actions → «Створити статтю (AI)» → Run workflow
(потрібен секрет `ANTHROPIC_API_KEY`).

## Генератор договорів — `dogovir/`

Односторінковий застосунок у браузері: вбудовані DOCX-шаблони (адвокат / ФОП),
реєстр договорів, підпис і КЕП. Версія — `dogovir/version.json`.
Дані клієнтів у репозиторії не зберігаються.

## Чат і заявки → Telegram

- **Чат на сайті** (`assets/chat.js`) — воркер `osadko-chat` + база D1,
  бот @osadko_site_chat_bot. Код і інструкція: `worker/chat/`.
- **Заявки з форм** — воркер `osadko-relay`, бот «osadko.online_Заявки».
  Код і інструкція: `worker/relay/`. У заявці видно канал (Google Ads, пошук,
  соцмережі, напряму), звідки прийшли й першу сторінку візиту (`assets/site.js`).
  Антиспам: Cloudflare Turnstile, honeypot, часова пастка, перевірка `Origin`.

## Бот «Судові засідання та практика»

Воркер `osadko-telegram-bot`, код `worker/worker.js`, інструкція `worker/README.md`.

- відстеження призначених засідань у судах (щогодини);
- «🔎 Пошук практики» — пошук судової практики за запитом;
- «📰 Свіжа практика» і щоранкова добірка.

## Аналітика та реклама

`assets/ga.js` — Google Analytics 4 з Consent Mode v2 і тег Google Ads.
Основна конверсія — заявка з форми; дзвінки, месенджери й чат — другорядні.

## Воркфлоу (`.github/workflows/`)

- `pages.yml` — деплой на GitHub Pages при пуші в `main`
- `generate-article.yml` — AI-генерація статті (ручний запуск)
- `submit-sitemap.yml`, `indexnow.yml` — надсилання sitemap у Google і IndexNow
- `court-watch.yml` — відстеження судових справ (щогодини)
- `vs-practice.yml` — практика судів за запитом
- `practice-digest.yml` — щоденна добірка практики
- `court-healthcheck.yml`, `court-probe.yml`, `court-diag.yml` — перевірка й діагностика
  джерел судів
- `gcal-backfill.yml` — разова синхронізація засідань у Google Calendar

## Секрети

Токени й ключі зберігаються лише в секретах GitHub Actions і Cloudflare Workers,
у коді їх немає.

## Локальний перегляд

```bash
python3 -m http.server 8000   # → http://localhost:8000
```
