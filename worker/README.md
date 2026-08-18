# Миттєві кнопки Telegram через Cloudflare Worker

Робить реакцію на кнопки під чернетками (✅ Опублікувати / ✏️ Редагувати /
🗑 Відхилити) **миттєвою** (секунди замість ~5 хв). Воркер приймає вебхук
Telegram і одразу публікує/редагує/відхиляє. Генерацію чернеток і новини лишає
GitHub Actions (як раніше).

Безкоштовно, always-on, нічого не обслуговувати. Налаштування — разове, ~15 хв.

## Крок 1. Акаунт і KV
1. Зареєструйтесь на **dash.cloudflare.com** (безкоштовно).
2. Ліворуч **Storage & Databases → KV → Create namespace**, назва напр. `osadko-bot`.
   (Це маленьке сховище, де воркер тримає чернетки й статистику.)

## Крок 2. Створити воркер
1. **Compute (Workers) → Create → Worker**. Дайте назву, напр. `osadko-telegram-bot` → **Deploy**.
2. **Edit code** → видаліть шаблон, вставте вміст файлу [`worker.js`](./worker.js) → **Deploy**.
3. **Settings → Bindings → Add → KV namespace**:
   - Variable name: **`KV`**
   - KV namespace: виберіть створений у Кроці 1 → **Save**.

## Крок 3. Змінні та секрети воркера
**Settings → Variables and Secrets** → додайте (Secret — для токенів, Text — для решти):

| Ім'я | Тип | Значення |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Secret | токен бота від @BotFather |
| `TELEGRAM_CHANNEL` | Text | `@pro100_law` |
| `REVIEW_CHAT` | Text | ваш Telegram id (число) |
| `AUTH_TOKEN` | Secret | будь-який довгий випадковий рядок (придумайте) |
| `WEBHOOK_SECRET` | Secret | ще один випадковий рядок (для захисту вебхука) |
| `CONTACT_URL` | Text | `https://osadko.online/kontakty/` |
| `CONTACT_LABEL` | Text | `⚖️ Консультація адвоката` |
| `CTA_EVERY` | Text | `6` |

Після додавання — **Deploy** ще раз. Скопіюйте **URL воркера** (виду
`https://osadko-telegram-bot.<ваш>.workers.dev`).

## Крок 4. Підключити вебхук Telegram
Відкрийте в браузері (підставте свій токен, URL воркера та `WEBHOOK_SECRET`):

```
https://api.telegram.org/bot<ТОКЕН>/setWebhook?url=<URL_ВОРКЕРА>&secret_token=<WEBHOOK_SECRET>
```

Має відповісти `{"ok":true,...}`. З цієї миті кнопки працюють миттєво.
> Перевірити: `https://api.telegram.org/bot<ТОКЕН>/getWebhookInfo`.
> Вимкнути (повернутись до опитування): `.../deleteWebhook`.

## Крок 5. Зв'язати GitHub-бота з воркером
Репозиторій → **Settings → Secrets and variables → Actions → New repository secret**:

| Ім'я | Значення |
|---|---|
| `BOT_WORKER_URL` | URL воркера з Кроку 3 |
| `BOT_WORKER_SECRET` | те саме значення, що `AUTH_TOKEN` у воркері |

Готово. Тепер GitHub-бот **реєструє нові чернетки у воркері** (а не шле сам) і
**не опитує getUpdates** — кнопками керує виключно воркер, миттєво.

## Як це працює
- GitHub Actions: новини в канал + генерація чернеток (Anthropic) → кожну готову
  чернетку POST-ить на `URL_воркера/register` (заголовок `X-Auth-Token: AUTH_TOKEN`).
- Воркер: надсилає чернетку вам у чат перевірки з кнопками, зберігає її у KV і
  миттєво реагує на ✅ / ✏️ / 🗑 та команду `/stats`.

## Якщо щось не так
- Кнопки не реагують → перевірте `getWebhookInfo` (має бути ваш URL, без помилок),
  і що `KV` binding named саме `KV`.
- «Чернетку не знайдено» на старих чернетках (які створювались до воркера) — це
  нормально: у KV їх немає. Згенеруйте нові (Actions → force_original).
- Повернутись до опитування щоп'ять хвилин → приберіть секрети `BOT_WORKER_URL`/
  `BOT_WORKER_SECRET` у GitHub і виконайте `deleteWebhook`.
