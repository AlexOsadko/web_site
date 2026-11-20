# Автоматичне надсилання sitemap у Google Search Console

Щоб sitemap.xml **автоматично** надсилався в Search Console після кожної нової
статті, треба один раз налаштувати сервісний акаунт Google. Далі все працює само:
воркфлоу `submit-sitemap.yml` спрацьовує при кожній зміні `sitemap.xml`.

> ⚠️ Це **необов'язково**. sitemap і так оновлюється й деплоїться автоматично, а
> Google після одноразового ручного надсилання sitemap перечитує його сам. Ця
> автоматизація лише прискорює повідомлення Google про зміни.

## Крок 1. Створити сервісний акаунт Google
1. Відкрийте **console.cloud.google.com** → створіть проєкт (або оберіть наявний).
2. **APIs & Services → Library** → знайдіть **Google Search Console API** → **Enable**.
3. **APIs & Services → Credentials → Create credentials → Service account**.
4. Дайте назву (напр. `sitemap-submitter`) → **Create and continue** → **Done**.
5. Відкрийте створений акаунт → вкладка **Keys → Add key → Create new key → JSON**.
6. Завантажиться JSON-файл — це ключ. Скопіюйте **email сервісного акаунта**
   (виду `sitemap-submitter@ваш-проєкт.iam.gserviceaccount.com`).

## Крок 2. Дати акаунту доступ у Search Console
1. **search.google.com/search-console** → ваш ресурс `osadko.online`.
2. **Налаштування (Settings) → Користувачі та дозволи (Users and permissions)**.
3. **Додати користувача** → вставте **email сервісного акаунта** → роль **Власник
   (Owner)** (потрібна саме роль Власника, щоб дозволити надсилання sitemap).

## Крок 3. Додати секрети в GitHub
Репозиторій на GitHub → **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Value |
|---|---|
| `GSC_SA_KEY` | увесь вміст завантаженого JSON-файлу ключа |
| `GSC_SITE_URL` | `sc-domain:osadko.online` (якщо ресурс — домен) або `https://osadko.online/` (якщо ресурс — URL-префікс) |

> Який у вас тип ресурсу — видно в Search Console зверху зліва: «Домен» → використовуйте
> `sc-domain:osadko.online`; «Префікс URL» → `https://osadko.online/`.

## Крок 4. Перевірити
- **Actions → «Надіслати sitemap у Search Console» → Run workflow** (гілка `main`).
- Успіх у логах: `✓ Sitemap надіслано в Search Console`.
- Далі воркфлоу спрацьовуватиме сам щоразу, коли змінюється `sitemap.xml`.

Якщо секрети не задано, воркфлоу не падає — просто пропускає надсилання.
