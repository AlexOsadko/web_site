// Бот судової практики (окремий від бота сповіщень про засідання).
// Адвокат пише боту тему → воркер запускає GitHub Action «Практика судів за запитом»
// (vs-practice.yml) → розбори офіційних публікацій ВС, Пленуму ВС і КСУ приходять
// у цей самий чат. Щоранку сюди ж приходить добірка свіжої практики; кнопка
// «📰 Свіжа практика зараз» запускає її позачергово (practice-digest.yml).
// Налаштування — див. README.md поруч.
//
// Змінні воркера:
//   PRACTICE_BOT_TOKEN (Secret) токен нового бота від @BotFather
//   WEBHOOK_SECRET     (Secret) довгий випадковий рядок (захист вебхука й /setup)
//   OWNER_CHAT         (Text)   ваш Telegram id (бот підкаже його на /start)
//   GH_TOKEN           (Secret) токен GitHub із правом запуску Actions для AlexOsadko/web_site
//   GH_REPO            (Text)   опційно, типово AlexOsadko/web_site

const BTN_DIGEST = '📰 Свіжа практика зараз';
const BTN_HELP = '❓ Як користуватися';
const MENU = { keyboard: [[{ text: BTN_DIGEST }, { text: BTN_HELP }]], resize_keyboard: true, is_persistent: true,
  input_field_placeholder: 'Тема, напр.: відмова від огляду ст. 130' };
const HELP =
  'Бот судової практики ⚖️\n\n' +
  '🔎 <b>Пошук:</b> напишіть тему звичайним текстом — напр. «відмова від огляду ст. 130», ' +
  '«аліменти на повнолітню дитину, яка навчається», «обшук без ухвали». Бот шукає в офіційних ' +
  'публікаціях Верховного Суду, Пленуму ВС і Конституційного Суду й за кілька хвилин надсилає ' +
  'до 3 розборів: суть, позиція суду, що це дає на практиці, номер справи й посилання.\n\n' +
  '📰 <b>Щоранку</b> бот сам надсилає сюди 1–3 розбори свіжої практики. ' +
  'Кнопка «' + BTN_DIGEST + '» запускає таку добірку позачергово.\n\n' +
  'Розбори — лише за реальним текстом публікації суду; нічого не вигадується.';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function tg(env, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${env.PRACTICE_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  return r.json().catch(() => ({ ok: false }));
}

// Запуск воркфлоу GitHub Actions (workflow_dispatch). 204 = прийнято.
async function dispatch(env, workflow, inputs) {
  const repo = env.GH_REPO || 'AlexOsadko/web_site';
  const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'osadko-practice-bot',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ ref: 'main', inputs })
  });
  return r.status;
}

function dispatchError(status) {
  if (status === 401) return 'токен GitHub (GH_TOKEN) недійсний або прострочений';
  if (status === 403 || status === 404) return 'у токена GitHub немає права запускати Actions у репозиторії';
  if (status === 422) return 'GitHub не прийняв запуск (воркфлоу не знайдено в main)';
  return `GitHub відповів ${status}`;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/tg' && req.method === 'POST') return onTelegram(req, env);
    if (url.pathname === '/setup') return onSetup(env, url);
    return new Response('osadko practice bot: ok');
  }
};

async function onTelegram(req, env) {
  if (!env.WEBHOOK_SECRET || req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
    return new Response('forbidden', { status: 403 });
  }
  const u = await req.json().catch(() => ({}));
  const m = u.message;
  if (!m || !m.chat) return new Response('ok');
  const chatId = String(m.chat.id);
  if (!env.OWNER_CHAT) {
    await tg(env, 'sendMessage', { chat_id: chatId, text: `Ваш Telegram id: ${chatId}\nВпишіть його у змінну OWNER_CHAT воркера.` });
    return new Response('ok');
  }
  if (chatId !== String(env.OWNER_CHAT)) {
    await tg(env, 'sendMessage', { chat_id: chatId, text: 'Це приватний бот.' });
    return new Response('ok');
  }
  const say = (text, extra) => tg(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...(extra || {}) });
  const text = String(m.text || '').trim();

  if (/^\/(start|help)\b/.test(text) || text === BTN_HELP) {
    await say(HELP, { reply_markup: MENU });
    return new Response('ok');
  }
  if (text === BTN_DIGEST || /^\/digest\b/.test(text)) {
    const st = await dispatch(env, 'practice-digest.yml', { dry: false });
    await say(st === 204
      ? '📰 Запустив добірку. Якщо є нові вартісні рішення — розбори прийдуть сюди за кілька хвилин; якщо нічого нового — бот промовчить.'
      : `Не вдалося запустити добірку: ${dispatchError(st)}.`);
    return new Response('ok');
  }
  if (!text || text.startsWith('/')) {
    await say('Напишіть тему звичайним текстом — напр. «відмова від огляду ст. 130».', { reply_markup: MENU });
    return new Response('ok');
  }
  if (text.length < 4) { await say('Опишіть тему трохи докладніше (кілька слів).'); return new Response('ok'); }

  const query = text.slice(0, 200);
  const st = await dispatch(env, 'vs-practice.yml', { query, dry: false });
  await say(st === 204
    ? `🔎 Шукаю практику за темою «${esc(query)}». Розбори прийдуть сюди за 2–5 хвилин.`
    : `Не вдалося запустити пошук: ${dispatchError(st)}.`);
  return new Response('ok');
}

// Разове налаштування: відкрити /setup?key=WEBHOOK_SECRET
async function onSetup(env, url) {
  if (!env.WEBHOOK_SECRET || url.searchParams.get('key') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
  const me = await tg(env, 'getMe', {});
  const hook = await tg(env, 'setWebhook', {
    url: `${url.origin}/tg`, secret_token: env.WEBHOOK_SECRET, allowed_updates: ['message'], drop_pending_updates: true
  });
  await tg(env, 'setMyCommands', { commands: [
    { command: 'digest', description: 'Свіжа практика зараз' },
    { command: 'help', description: 'Як користуватися' }
  ] });
  const lines = [
    me.ok && hook.ok ? '✅ Готово.' : '❌ Помилка — перевірте PRACTICE_BOT_TOKEN.',
    me.ok ? `Бот: @${me.result.username}` : `getMe: ${JSON.stringify(me)}`,
    `Вебхук: ${JSON.stringify(hook)}`,
    env.OWNER_CHAT ? `OWNER_CHAT: ${env.OWNER_CHAT}` : 'OWNER_CHAT ще не задано: напишіть боту /start — він підкаже ваш id.',
    env.GH_TOKEN ? 'GH_TOKEN: задано' : 'GH_TOKEN ще не задано — пошук і кнопка добірки не працюватимуть.'
  ];
  return new Response(lines.join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
