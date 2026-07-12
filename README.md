# Сайт адвоката Олександра Осадька

Мінімалістичний сайт: головна сторінка (про мене, послуги, статті, контакти) та база SEO-статей.

Сайт опубліковано: https://alexosadko.github.io/web_site/

## Структура

- `index.html` — головна сторінка
- `content/articles/*.json` — **дані статей (єдине джерело правди)**
- `articles/*.html` — згенеровані сторінки статей (не редагувати вручну)
- `articles/index.html` — каталог статей (генерується)
- `css/style.css` — стилі
- `assets/logo-mark.svg` — логотип; `assets/photo.jpg` — **фото адвоката (додати вручну)**
- `sitemap.xml`, `robots.txt` — генеруються білдером
- `tools/` — інструменти генерації (див. нижче)
- `.github/workflows/pages.yml` — автодеплой на GitHub Pages при пуші в `main`
- `.github/workflows/generate-article.yml` — генерація нової статті через AI (ручний запуск)

## Статті: дані + білдер

Статті зберігаються як дані у `content/articles/<slug>.json`. HTML не редагують руками —
його генерує білдер зі спільного шаблону, тож усі статті однорідні (SEO-теги, JSON-LD,
breadcrumbs, FAQ, ключові слова, «читайте також»).

```bash
python3 tools/build.py
```

Білдер генерує сторінки статей, каталог, `sitemap.xml`, `robots.txt` і **автоматично
оновлює кількість статей** усюди, де вона згадується (головна + каталог). Тобто після
додавання нової статті лічильник змінюється сам.

### Додати статтю вручну

Створіть `content/articles/<slug>.json` за схемою (див. будь-який наявний файл) і запустіть
`python3 tools/build.py`.

## AI-генерація статей

`tools/generate_article.py` викликає модель Claude і створює нову статтю за темою та
категорією. Стаття відповідає тим самим вимогам, що й решта (заголовок із ключем,
meta-опис, 5–7 розділів зі списками, 3 питання FAQ, українська, практичний тон).

### Локально

```bash
pip install -r tools/requirements.txt
export ANTHROPIC_API_KEY=...
python3 tools/generate_article.py --topic "Банкрутство фізичної особи" --category business --build
```

Категорії: `civil`, `family`, `labor`, `criminal`, `auto`, `realty`, `business`, `process`.

### Через GitHub (без коду)

1. Один раз додайте секрет `ANTHROPIC_API_KEY` у **Settings → Secrets and variables → Actions**.
2. **Actions → «Створити статтю (AI)» → Run workflow**, введіть тему і категорію.

Воркфлоу згенерує статтю, перебудує сайт, закомітить зміни — і GitHub Pages опублікує оновлення.

## Що потрібно доробити

1. Покласти фото в `assets/photo.jpg` (портретна орієнтація, приблизно 3:4).
2. Замінити номер телефону-заглушку `+38 (000) 000-00-00` в `index.html` на справжній.
3. Додати секрет `ANTHROPIC_API_KEY` для AI-генерації статей (якщо потрібна).

## Локальний перегляд

```bash
python3 -m http.server 8000
```

і перейти на http://localhost:8000
