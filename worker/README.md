# Бот «Судові засідання та практика» — Cloudflare Worker

Код: [`worker.js`](./worker.js). Воркер у Cloudflare — **osadko-telegram-bot**.

Що робить:
- приймає вебхук Telegram і миттєво відповідає на кнопки меню суду: повний список,
  справи клієнтів і адвоката, список клієнтів, додати клієнта, нагадування,
  терміновий прогін, додавання засідань у Google Календар;
- **🔎 Пошук практики** — запускає GitHub Action `vs-practice.yml` за темою;
- **📰 Свіжа практика** — позачергово запускає добірку `practice-digest.yml`
  (щоранку вона приходить сама);
- службові ендпоінти для GitHub Actions `court-watch.yml` (список ПІБ, звіти,
  календар) — захищені спільним секретом `AUTH_TOKEN`.

Інші воркери: [`chat/`](./chat/) — чат на сайті (`osadko-chat`).

## Змінні воркера (Settings → Variables and Secrets)

| Ім'я | Тип | Призначення |
|---|---|---|
| `KV` | KV binding | сховище стану бота |
| `TELEGRAM_BOT_TOKEN` | Secret | токен бота |
| `REVIEW_CHAT` | Text | ваш Telegram id |
| `AUTH_TOKEN` | Secret | спільний секрет із GitHub (`BOT_WORKER_SECRET`) |
| `WEBHOOK_SECRET` | Secret | секрет вебхука Telegram |
| `GH_TOKEN` | Secret | GitHub-токен для термінового прогону |
| `GH_DISPATCH_TOKEN` | Secret | GitHub-токен (Actions: Read and write) для пошуку практики й добірки |

Змінні від колишнього каналу (`TELEGRAM_CHANNEL`, `CONTACT_URL`, `CONTACT_LABEL`,
`CTA_EVERY`) більше не використовуються — їх можна видалити.

## Як оновити код
1. Відкрийте https://raw.githubusercontent.com/AlexOsadko/web_site/main/worker/worker.js → Cmd+A, Cmd+C.
2. Cloudflare → **osadko-telegram-bot → Edit code** → Cmd+A, Delete, Cmd+V → **Deploy**.
3. Надішліть боту `/start` — оновиться меню.
