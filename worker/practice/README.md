# Бот судової практики

Окремий бот (не той, що надсилає сповіщення про засідання — його **не видаляйте**).

- **Пошук за запитом:** пишете боту тему → за 2–5 хв приходять до 3 розборів
  офіційних публікацій Верховного Суду, Пленуму ВС і Конституційного Суду.
- **Щоденна добірка:** щоранку (~08:12 за Києвом) 1–3 розбори свіжої практики —
  у приватний канал. Кнопка «📰 Свіжа практика зараз» — позачергово.

Як це влаштовано: бот → цей воркер (Cloudflare) → GitHub Actions
(`vs-practice.yml` — пошук, `practice-digest.yml` — добірка) → розбори в Telegram.

## 1. Новий бот
@BotFather → `/newbot` → назва, напр. «Судова практика», username напр.
`osadko_practice_bot` → скопіюйте **токен**.

## 2. Канал
- Канал → ✏️ Редагувати: назва (напр. «⚖️ Практика судів — добірка»), **Тип каналу: Приватний**.
- **Адміністратори → Додати адміністратора** → знайдіть нового бота → дозвіл «Публікувати повідомлення».
- Старого бота з адміністраторів можна прибрати.
- Id каналу: перешліть будь-який пост каналу боту **@userinfobot** → число виду `-100…`.

## 3. Секрети на GitHub
Репозиторій → Settings → Secrets and variables → Actions → New repository secret:

| Назва | Значення |
|---|---|
| `PRACTICE_BOT_TOKEN` | токен нового бота |
| `PRACTICE_CHAT` | id каналу (`-100…`) |

`ANTHROPIC_API_KEY` і `TELEGRAM_REVIEW_CHAT` (ваш id) уже є — вони теж використовуються.

## 4. Токен GitHub для запуску пошуку
GitHub → аватар → Settings → Developer settings → Personal access tokens →
**Fine-grained tokens → Generate new token**: Repository access — *Only select
repositories* → `AlexOsadko/web_site`; Permissions → **Actions: Read and write**.
Скопіюйте токен (показується один раз).

## 5. Воркер у Cloudflare
1. Workers & Pages → Create → Worker → назва `osadko-practice` → Deploy.
2. Edit code → вставте весь вміст [`worker.js`](./worker.js) → Deploy.
3. Settings → Variables and Secrets:

| Ім'я | Тип | Значення |
|---|---|---|
| `PRACTICE_BOT_TOKEN` | Secret | токен нового бота |
| `WEBHOOK_SECRET` | Secret | свій довгий рядок (латиниця й цифри) |
| `OWNER_CHAT` | Text | ваш Telegram id (той самий, що `OWNER_CHAT` у чат-воркері) |
| `GH_TOKEN` | Secret | токен GitHub із кроку 4 |

4. Deploy, потім відкрийте `https://osadko-practice.<акаунт>.workers.dev/setup?key=<WEBHOOK_SECRET>` — має бути «✅ Готово».
5. Напишіть новому боту `/start`.

## Перевірка
- Напишіть боту, напр. «відмова від огляду ст. 130» → «🔎 Шукаю…» → за кілька хвилин розбори.
- «📰 Свіжа практика зараз» → розбори в каналі (якщо є нове).

Обмеження: пошук іде серед **свіжих** публікацій ВС і КСУ (перша сторінка стрічки)
та **всього архіву постанов Пленуму ВС**. Повнотекстового пошуку по ЄДРСР немає.
