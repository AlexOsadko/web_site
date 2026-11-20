// Cloudflare Worker — бот «Судові засідання та практика».
// Вебхук Telegram: меню суду (справи клієнтів і адвоката, нагадування, Google
// Календар, терміновий прогін), пошук практики за темою й добірка свіжої практики
// (через GitHub Actions). Плюс службові ендпоінти для court-watch (GitHub Actions).
//
// Прив'язки (Cloudflare → Worker → Settings → Variables):
//   KV Namespace binding:  KV
//   Секрети / змінні:
//     TELEGRAM_BOT_TOKEN  — токен бота (@BotFather)
//     REVIEW_CHAT         — ваш Telegram id (чат адвоката з ботом)
//     AUTH_TOKEN          — спільний секрет із GitHub (BOT_WORKER_SECRET) для службових ендпоінтів
//     WEBHOOK_SECRET      — (опц.) секрет вебхука Telegram (setWebhook secret_token)
//     GH_TOKEN            — токен GitHub для термінового прогону court-watch
//     GH_DISPATCH_TOKEN   — токен GitHub для пошуку практики, добірки й AI-агентів
//     APP_PASSWORD        — пароль вебзастосунку /app (не менше 10 символів); без нього застосунок вимкнено
//     APP_URL             — (опц.) повна адреса застосунку для підказки в боті, напр. https://….workers.dev/app

const esc = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Обрізати задовге поле для показу (щоб повідомлення влазило в ліміт Telegram).
const cut = (s, n) => { s = String(s || ''); return esc(s.length > n ? s.slice(0, n) + '…' : s); };

async function tg(env, method, params) {
  const r = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) }
  );
  return r.json();
}

// Список ПІБ клієнтів для бота відстеження судових справ (приватно в KV).
async function getNames(env) {
  return (await env.KV.get('court_names', 'json')) || [];
}
async function putNames(env, arr) {
  await env.KV.put('court_names', JSON.stringify(arr));
}
// Номери справ під наглядом (стеження за конкретною справою, незалежно від ПІБ).
async function getCaseNums(env) {
  return (await env.KV.get('court_cases', 'json')) || [];
}
async function putCaseNums(env, arr) {
  await env.KV.put('court_cases', JSON.stringify(arr));
}
// «757 / 12345 / 26 – ц» → «757/12345/26-ц»; номер має містити «/» і цифри.
function normCaseNum(t) {
  const v = String(t || '').replace(/[\u2010-\u2015\u2212]/g, '-').replace(/\s*([/-])\s*/g, '$1')
    .replace(/^№\s*/, '').replace(/\s+/g, ' ').trim();
  return /\d/.test(v) && v.includes('/') && v.length <= 40 ? v : '';
}
async function showCaseList(env, prefix = '') {
  const arr = await getCaseNums(env);
  if (!arr.length) {
    return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, parse_mode: 'HTML',
      text: prefix + '📁 Справ під наглядом немає. Натисніть «📌 Стежити за справою» і надішліть номер.',
      reply_markup: { inline_keyboard: [[{ text: '📌 Стежити за справою', callback_data: 'cnadd' }]] } });
  }
  const rows = arr.map((n, i) => [{ text: `🗑 ${i + 1}. ${n}`.slice(0, 60), callback_data: `cndel:${i}` }]);
  rows.push([{ text: '📌 Додати справу', callback_data: 'cnadd' }]);
  return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, parse_mode: 'HTML',
    text: prefix + `📁 <b>Справи під наглядом (${arr.length})</b>\n` +
      arr.map((n, i) => `${i + 1}. <code>${esc(n)}</code>`).join('\n') +
      '\n\nЗасідання в цих справах приходять сповіщенням і видно в «👥 Справи клієнтів».\n🗑 — припинити стеження:',
    reply_markup: { inline_keyboard: rows } });
}
// ── Повістка (SUDPOVISTKA / SMS / Viber): переслане або вставлене повідомлення ──
// «Солом'янський райсуд м.Києва,м.Київ,вул.…,т.(044)….Викликається Осадько О.О. як
//  захисник на 10:00 05.12.2026,зал 1,провадження 757/12345/26,обвинувачений:…,суддя …»
function parseSummons(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!/виклика[єю]ться/i.test(t)) return null;
  const dt = t.match(/(\d{1,2})[:.](\d{2})\s*(?:год\.?\s*)?(\d{2}\.\d{2}\.\d{4})/)
    || t.match(/(\d{2}\.\d{2}\.\d{4})\D{1,12}?(\d{1,2})[:.](\d{2})/);
  const num = t.match(/(?:\d+-[а-яіїєґa-z]+\/)?\d{2,4}\/\d{1,7}\/\d{2}(?:-[а-яіїєґa-z]+)?/i);
  if (!dt || !num) return null;
  let date, time;
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(dt[3] || '')) { time = dt[1].padStart(2, '0') + ':' + dt[2]; date = dt[3]; }
  else { date = dt[1]; time = dt[2].padStart(2, '0') + ':' + dt[3]; }
  const court = (t.match(/^(.*?(?:суд|райсуд)[^,.]*?(?:м\.\s?[А-ЯІЇЄҐ][а-яіїєґʼ'’-]+)?)\s*,/i) || [])[1] || '';
  const addr = (t.match(/^[^,]*,\s*(.*?)(?:,\s*т\.|\.\s*виклика)/i) || [])[1] || '';
  const room = (t.match(/зал(?:і)?\s*№?\s*([\w\-]+)/i) || [])[1] || '';
  const judge = (t.match(/суддя\s+([А-ЯІЇЄҐ][а-яіїєґʼ'’-]+\s*[А-ЯІЇЄҐ]\.\s*[А-ЯІЇЄҐ]\.)/) || [])[1] || '';
  const role = (t.match(/як\s+(захисник\w*|представник\w*|свідок\w*|потерпіл\w*|обвинувачен\w*|відповідач\w*|позивач\w*)/i) || [])[1] || '';
  const party = (t.match(/((?:обвинувачен|підозрюван|позивач|відповідач|потерпіл)[а-яіїєґ]*\s*:\s*[^,]+)/i) || [])[1] || '';
  return { court: court.trim(), number: num[0], date, time, room, judge: judge.replace(/\s*([А-ЯІЇЄҐ]\.)\s*([А-ЯІЇЄҐ]\.)$/, ' $1$2'),
    role, party: party.trim(), address: addr.trim() };
}
function shortHash(s) {
  let h1 = 0x811c9dc5, h2 = 0x1234567;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619) >>> 0; h2 = Math.imul(h2 ^ c, 2246822519) >>> 0; }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 16);
}
async function onSummons(env, sm) {
  const nums = await getCaseNums(env);
  const fresh = !nums.some((x) => x.toLowerCase() === sm.number.toLowerCase());
  if (fresh) { nums.push(sm.number); await putCaseNums(env, nums); }
  const lines = ['📨 <b>Повістку розпізнано</b>', '',
    `📁 Справа: <b>${esc(sm.number)}</b>`, `📅 Дата/час: <b>${esc(sm.date)} ${esc(sm.time)}</b>`];
  if (sm.court) lines.push(`🏛 Суд: ${esc(sm.court)}`);
  if (sm.room) lines.push(`🚪 Зал: ${esc(sm.room)}`);
  if (sm.judge) lines.push(`👨‍⚖️ Суддя: ${esc(sm.judge)}`);
  if (sm.role) lines.push(`🎓 Роль: ${esc(sm.role)}`);
  if (sm.address) lines.push(`📍 Адреса: ${esc(sm.address)}`);
  lines.push('', fresh ? '✅ Справу поставлено на стеження — нові засідання в ній прийдуть сповіщенням.'
    : 'ℹ️ Справа вже була на стеженні.');
  const key = shortHash(sm.number + '|' + sm.date + ' ' + sm.time + '|' + sm.court);
  const r = await tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, parse_mode: 'HTML', text: lines.join('\n'),
    reply_markup: { inline_keyboard: [[
      { text: '📅 Додати в календар', callback_data: `gcaladd:${key}` },
      { text: '✖️ Ні', callback_data: `gcalskip:${key}` }]] } });
  const res = (r && r.result) || {};
  const rec = { number: sm.number, date: `${sm.date} ${sm.time}`, judge: sm.judge, involved: sm.party,
    description: sm.role ? 'Виклик як ' + sm.role : 'Виклик за повісткою', forma: '', courtroom: sm.room, add_address: sm.address };
  await env.KV.put('gcal_pending_' + key, JSON.stringify({ key, court: sm.court, chat_id: (res.chat || {}).id,
    message_id: res.message_id, rec }), { expirationTtl: 60 * 24 * 3600 });
}

// ── Процесуальні строки: /strok <номер> <дата | +N [від дата]> <що подати> ──
// Строк зберігається приватно в KV (court_deadlines) і стає в ту саму чергу
// календаря, що й підтверджені засідання: gcal-add.yml створює подію на весь день.
function kyivToday() {
  const [y, mo, d] = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Kyiv' }).split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d));
}
const fmtDate = (dt) => String(dt.getUTCDate()).padStart(2, '0') + '.'
  + String(dt.getUTCMonth() + 1).padStart(2, '0') + '.' + dt.getUTCFullYear();
function utcDate(d, mo, y) {
  const dt = new Date(Date.UTC(+y, +mo - 1, +d));
  return (dt.getUTCDate() === +d && dt.getUTCMonth() === +mo - 1) ? dt : null;
}
function parseDeadline(arg) {
  let t = String(arg || '').replace(/\s+/g, ' ').trim();
  const sp = t.indexOf(' ');
  if (sp < 0) return null;
  const number = normCaseNum(t.slice(0, sp));
  if (!number) return null;
  t = t.slice(sp + 1).trim();
  let due, calc = '';
  let m = t.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+/);
  if (m) {
    due = utcDate(m[1], m[2], m[3]);
    if (!due) return null;
  } else {
    m = t.match(/^\+\s?(\d{1,3})(?:\s*дн[а-яії]*\.?)?(?:\s+(?:від|з)\s+(\d{2})\.(\d{2})\.(\d{4}))?\s+/i);
    if (!m) return null;
    const from = m[2] ? utcDate(m[2], m[3], m[4]) : kyivToday();
    if (!from) return null;
    due = new Date(from.getTime() + (+m[1]) * 86400000);
    // останній день строку, що припав на суботу чи неділю, – перший робочий день
    while (due.getUTCDay() === 0 || due.getUTCDay() === 6) due = new Date(due.getTime() + 86400000);
    calc = `${m[1]} дн. від ${fmtDate(from)}`;
  }
  const title = t.slice(m[0].length).trim().slice(0, 120);
  if (title.length < 2) return null;
  return { number, date: fmtDate(due), title, calc };
}
const DEADLINE_ASK = '⏳ <b>Процесуальний строк у календар</b>\n'
  + '<code>/strok 757/12345/26 05.12.2026 Відзив на позов</code> – конкретна дата\n'
  + '<code>/strok 757/12345/26 +15 від 20.11.2026 Відзив на позов</code> – порахувати від дати\n'
  + '<code>/strok 757/12345/26 +30 Апеляційна скарга</code> – порахувати від сьогодні\n'
  + 'Якщо останній день випав на вихідний, строк переноситься на понеділок. Усі строки: /stroky';
async function getDeadlines(env) {
  return (await env.KV.get('court_deadlines', 'json')) || [];
}
// Запуск швидкої задачі «лише календар» (тротлінг 20 с — кілька дій обробить один запуск).
async function kickGcal(env) {
  if (!env.GH_TOKEN) return false;
  const last = parseInt((await env.KV.get('gcal_run_at')) || '0', 10);
  if (Date.now() - last < 20000) return true;
  const st = await triggerScan(env, 'gcal-add.yml', {});
  await env.KV.put('gcal_run_at', String(Date.now()));
  return st === 204;
}
async function onDeadline(env, d) {
  const key = shortHash('dl|' + d.number + '|' + d.date + '|' + d.title);
  const lines = ['⏳ <b>Строк записано</b>', '', `📁 Справа: <b>${esc(d.number)}</b>`,
    `📌 ${esc(d.title)}`, `📅 Останній день: <b>${esc(d.date)}</b>`];
  if (d.calc) lines.push(`🧮 ${esc(d.calc)}`);
  const r = await tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, parse_mode: 'HTML', text: lines.join('\n'),
    reply_markup: { inline_keyboard: [[{ text: '⏳ Додаю строк у календар…', callback_data: 'cnoop' }]] } });
  const res = (r && r.result) || {};
  await saveDeadline(env, d, (res.chat || {}).id, res.message_id);
}
async function showDeadlines(env, prefix = '') {
  const list = (await getDeadlines(env)).slice().sort((a, b) => (hearingTs(a.date) || 0) - (hearingTs(b.date) || 0));
  if (!list.length) {
    return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, parse_mode: 'HTML',
      text: prefix + 'Строків немає.\n\n' + DEADLINE_ASK });
  }
  const txt = list.map((x, i) => {
    const n = daysUntil(x.date);
    const left = n === null ? '' : n < 0 ? ` · минув ${-n} дн. тому` : n === 0 ? ' · <b>сьогодні</b>' : ` · через ${n} дн.`;
    return `${i + 1}. <b>${esc(x.date)}</b>${left}\n   ${esc(x.title)} – <code>${esc(x.number)}</code>`;
  }).join('\n');
  const rows = list.map((x, i) => [{ text: `🗑 ${i + 1}. ${x.date} ${x.title}`.slice(0, 60), callback_data: `dldel:${x.key}` }]);
  return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, parse_mode: 'HTML',
    text: prefix + `⏳ <b>Процесуальні строки (${list.length})</b>\n\n${txt}\n\n`
      + '🗑 прибирає строк зі списку бота. Подію в Google Календарі видаліть вручну.',
    reply_markup: { inline_keyboard: rows } });
}

// ── Вивантаження даних для застосунку «Мої судові справи» (/export) ──
// Надсилає в приватний чат JSON-файл: майбутні засідання (адвокат + клієнти),
// справи під наглядом за номером, список клієнтів і строки.
async function sendExport(env) {
  const a = await visibleReport(env, 'advocate');
  const c = await visibleReport(env, 'clients');
  const data = {
    format: 'osadko-court-export', version: 1,
    exported: new Date().toISOString(), updated: a.updated || c.updated || '',
    advocate: a.visible, clients: c.visible,
    tracked: await getCaseNums(env), names: await getNames(env),
    deadlines: await getDeadlines(env),
  };
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Kyiv' });
  const fd = new FormData();
  fd.append('chat_id', String(env.REVIEW_CHAT));
  fd.append('caption', `Дані для застосунку: засідань ${a.visible.length + c.visible.length}, `
    + `справ за номером ${data.tracked.length}, строків ${data.deadlines.length}. `
    + 'Файл містить дані клієнтів – не пересилайте його.');
  fd.append('document', new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }),
    `court-export-${day}.json`);
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`,
    { method: 'POST', body: fd });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) {
    await tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, text: 'Не вдалося надіслати файл експорту. Спробуйте ще раз.' });
  }
}

const CASE_ASK = '📌 Надішліть номер справи, напр. <code>757/12345/26-ц</code> або <code>752/1234/25</code>. '
  + 'Бот стежитиме за засіданнями в ній у всіх судах зі списку. Скасувати — /cancel.';

// Кнопки згруповано за розділами: 📅 Засідання · 📚 Практика · 🗂 Клієнти · 🤖 Агент.
const GROUPS = {
  sess: { title: '📅 <b>Засідання</b>', rows: [
    [{ text: '📑 Повний список', callback_data: 'crepall' }],
    [{ text: '👥 Справи клієнтів', callback_data: 'crepc' }, { text: '⚖️ Справи адвоката', callback_data: 'crep' }],
    [{ text: '🔔 Нагадування', callback_data: 'crem' }, { text: '🔄 Терміновий прогін', callback_data: 'crun' }],
  ] },
  prac: { title: '📚 <b>Практика</b>', rows: [
    [{ text: '🔎 Пошук практики', callback_data: 'cvs' }, { text: '📰 Свіжа практика', callback_data: 'cdig' }],
  ] },
  cli: { title: '🗂 <b>Справи й клієнти під наглядом</b>\n<i>Повістку (SUDPOVISTKA, SMS) достатньо переслати боту — справа стане на стеження сама.</i>', rows: [
    [{ text: '👥 Справи клієнтів', callback_data: 'crepc' }, { text: '⚖️ Справи адвоката', callback_data: 'crep' }],
    [{ text: '📋 Список клієнтів', callback_data: 'clist' }, { text: '➕ Додати клієнта', callback_data: 'cadd' }],
    [{ text: '📁 Справи за номером', callback_data: 'cnlist' }, { text: '📌 Стежити за справою', callback_data: 'cnadd' }],
    [{ text: '🔄 Терміновий прогін', callback_data: 'crun' }],
  ] },
};

function courtMenuKb() {
  return { inline_keyboard: [
    [{ text: '🤖 Завдання агенту (документи + AI)', callback_data: 'cagent' }],
    ...GROUPS.sess.rows, ...GROUPS.prac.rows, ...GROUPS.cli.rows,
  ] };
}

// Підменю розділу (кнопка закріпленої клавіатури або callback cgrp:<розділ>).
async function showGroup(env, g) {
  const gr = GROUPS[g];
  if (!gr) return showCourtMenu(env);
  return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, parse_mode: 'HTML',
    text: gr.title, reply_markup: { inline_keyboard: gr.rows } });
}

// Постійна клавіатура-меню, закріплена біля поля вводу: часті дії + розділи.
function courtReplyKb() {
  return {
    keyboard: [
      [{ text: '📅 Усі засідання' }, { text: '🔔 Найближчі' }],
      [{ text: '🗂 Справи й клієнти' }, { text: '📚 Практика' }, { text: '🤖 Агент' }],
    ],
    resize_keyboard: true,
    input_field_placeholder: 'Оберіть дію (меню можна згорнути ☰)',
  };
}

// Запуск GitHub Action «Відстеження судових справ» на вимогу (workflow_dispatch).
async function triggerScan(env, wfOverride, inputs) {
  const repo = env.GH_REPO || 'AlexOsadko/web_site';
  const wf = wfOverride || env.GH_WORKFLOW || 'court-watch.yml';
  const r = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/${wf}/dispatches`,
    { method: 'POST', headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'osadko-court-bot',
        'Content-Type': 'application/json',
      }, body: JSON.stringify({ ref: 'main', inputs: inputs || (wfOverride ? {} : { dry_run: false }) }) });
  return r.status; // 204 = прийнято
}

// Реєстрація команд бота (список у кнопці ☰ біля поля вводу) — лише для чату адвоката.
async function setupCommands(env) {
  const scope = { type: 'chat', chat_id: env.REVIEW_CHAT };
  await tg(env, 'setMyCommands', { scope, commands: [
    { command: 'menu', description: '⚖️ Меню суду' },
    { command: 'all', description: '📑 Повний список справ' },
    { command: 'clients', description: '👥 Справи клієнтів' },
    { command: 'advocate', description: '⚖️ Справи адвоката' },
    { command: 'reminders', description: '🔔 Нагадування' },
    { command: 'list', description: '📋 Список клієнтів' },
    { command: 'add', description: '➕ Додати клієнта' },
    { command: 'strok', description: '⏳ Строк у календар' },
    { command: 'stroky', description: '⏳ Усі строки' },
    { command: 'export', description: '📤 Дані для застосунку' },
    { command: 'restart', description: '🔄 Терміновий прогін' },
    { command: 'vs', description: '🔎 Практика судів за темою' },
    { command: 'digest', description: '📰 Свіжа практика зараз' },
    { command: 'agent', description: '🤖 Завдання агенту (документи + AI)' },
    { command: 'start', description: '▶️ Старт / головне меню' },
    { command: 'cancel', description: '↩️ Скасувати' },
    { command: 'help', description: 'ℹ️ Довідка' },
  ] });
  await tg(env, 'setChatMenuButton', { chat_id: env.REVIEW_CHAT, menu_button: { type: 'commands' } });
}

// Текст-результат запуску термінового прогону (для кнопки й меню).
async function urgentScan(env) {
  if (!env.GH_TOKEN) {
    return '⚠️ Терміновий прогін не налаштовано: додайте у воркер секрет ' +
      'GH_TOKEN. Планові прогони тричі на день працюють як звичайно.';
  }
  const last = parseInt((await env.KV.get('court_run_at')) || '0', 10);
  if (Date.now() - last < 90000) {
    return '⏳ Прогін уже запущено щойно — зачекайте ~1 хв на результат.';
  }
  const code = await triggerScan(env);
  if (code === 204) {
    await env.KV.put('court_run_at', String(Date.now()));
    return '🔄 Запущено терміновий прогін (клієнти + адвокат). Нові сповіщення про ' +
      'засідання та оновлені списки «Справи клієнтів» / «Справи адвоката» — за ~1 хвилину.';
  }
  return `Не вдалося запустити прогін (код ${code}). Перевірте секрет GH_TOKEN.`;
}

// Приховані (видалені адвокатом) справи — не виводяться й надалі.
function itemKey(it) {
  return `${it.number || ''}|${it.date || ''}|${it.court || ''}`;
}
async function getHidden(env, kind) {
  return (await env.KV.get('court_hidden_' + kind, 'json')) || [];
}
async function addHidden(env, kind, key) {
  const a = await getHidden(env, kind);
  if (!a.includes(key)) { a.push(key); await env.KV.put('court_hidden_' + kind, JSON.stringify(a)); }
}
async function clearHidden(env, kind) {
  await env.KV.delete('court_hidden_' + kind);
}

// Остаточно видалені справи — не показуються ні у списку, ні у «Прихованих»
// (навіть якщо суд знову віддасть їх під час наступного прогону).
async function getDeleted(env, kind) {
  return (await env.KV.get('court_deleted_' + kind, 'json')) || [];
}
async function addDeleted(env, kind, key) {
  const a = await getDeleted(env, kind);
  if (!a.includes(key)) { a.push(key); await env.KV.put('court_deleted_' + kind, JSON.stringify(a)); }
}

// Видимі справи звіту (без прихованих і без остаточно видалених).
async function visibleReport(env, kind) {
  const rep = await env.KV.get('court_report_' + kind, 'json');
  const items = (rep && rep.items) ? rep.items : [];
  const hidden = await getHidden(env, kind);
  const deleted = await getDeleted(env, kind);
  const blocked = new Set([...hidden, ...deleted]);
  const visible = items.filter((it) => !blocked.has(itemKey(it)));
  // Сортуємо за датою засідання: найближче майбутнє — вгорі; далі минулі
  // (свіжіші вище); недатовані — в кінці. Порядок детермінований, тож індекси
  // кнопок (🗑) лишаються коректними в усіх переглядах.
  visible.sort(caseCmp);
  return { updated: rep ? rep.updated : '', visible, hiddenCount: hidden.length };
}

async function removeHiddenAt(env, kind, i) {
  const a = await getHidden(env, kind);
  if (i >= 0 && i < a.length) { a.splice(i, 1); await env.KV.put('court_hidden_' + kind, JSON.stringify(a)); }
}

// Перегляд прихованих справ — кожну можна повернути (♻️) окремо або всі одразу.
async function showHidden(env, kind) {
  const isClients = kind === 'clients';
  const title = isClients ? '📂 <b>Приховані (клієнти)' : '📂 <b>Приховані (адвокат)';
  const hidden = await getHidden(env, kind);
  if (!hidden.length) {
    return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, parse_mode: 'HTML',
      text: `${title}</b>\nПорожньо.`,
      reply_markup: { inline_keyboard: [[{ text: '↩️ Меню', callback_data: 'cmenu' }]] } });
  }
  const rep = await env.KV.get('court_report_' + kind, 'json');
  const byKey = {};
  ((rep && rep.items) || []).forEach((it) => { byKey[itemKey(it)] = it; });
  let txt = `${title}: ${hidden.length}</b>\n<i>♻️ — повернути в список · 🗑 — видалити назавжди</i>\n`;
  const rows = [];
  for (let i = 0; i < hidden.length; i++) {
    const it = byKey[hidden[i]];
    const p = hidden[i].split('|');
    txt += `\n${i + 1}. <b>№ ${esc(it ? it.number : p[0])}</b> · 📅 ${esc(it ? it.date : p[1])}\n` +
      `    🏛 ${esc(it ? it.court : (p[2] || ''))}\n`;
    rows.push([
      { text: `♻️ ${i + 1}`, callback_data: `cunhide1:${kind}:${i}` },
      { text: `🗑 ${i + 1}`, callback_data: `cpurge1:${kind}:${i}` },
    ]);
    if (txt.length > 3400) { txt += '\n… список задовгий.'; break; }
  }
  rows.push([{ text: '♻️ Відновити всі', callback_data: `cunhide:${kind}` }]);
  rows.push([{ text: '🗑 Видалити всі назавжди', callback_data: `cpurge:${kind}` }]);
  rows.push([{ text: '↩️ Меню', callback_data: 'cmenu' }]);
  return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, parse_mode: 'HTML',
    text: txt, disable_web_page_preview: true, reply_markup: { inline_keyboard: rows } });
}

// Днів до засідання за рядком «дд.мм.рррр[ гг:хв]». null — дату не розпізнано.
function daysUntil(dateStr) {
  const m = /(\d{2})\.(\d{2})\.(\d{4})/.exec(dateStr || '');
  if (!m) return null;
  const target = new Date(+m[3], +m[2] - 1, +m[1]);
  const now = new Date();
  const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - t0) / 86400000);
}

// Час засідання (мс) за рядком «дд.мм.рррр[ гг:хв]» — з урахуванням години,
// щоб у межах одного дня раніші засідання йшли вище. null — дату не розпізнано.
function hearingTs(dateStr) {
  const m = /(\d{2})\.(\d{2})\.(\d{4})(?:\D+(\d{1,2}):(\d{2}))?/.exec(dateStr || '');
  if (!m) return null;
  return new Date(+m[3], +m[2] - 1, +m[1], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0).getTime();
}

// Порядок справ за датою засідання: найближче МАЙБУТНЄ (сьогодні або пізніше) —
// вгорі за зростанням; далі МИНУЛІ засідання (свіжіші вище); НЕДАТОВАНІ — в кінці.
function caseCmp(a, b) {
  const da = daysUntil(a && a.date), db = daysUntil(b && b.date);
  const ua = da !== null && da >= 0, ub = db !== null && db >= 0;  // майбутнє/сьогодні?
  if (ua !== ub) return ua ? -1 : 1;                 // майбутні — вище за минулі/недатовані
  const ta = hearingTs(a && a.date), tb = hearingTs(b && b.date);
  if (ta === null && tb === null) return 0;
  if (ta === null) return 1;                          // недатовані — в кінець групи
  if (tb === null) return -1;
  return ua ? (ta - tb) : (tb - ta);                  // майбутні: раніше вгору; минулі: свіжіше вгору
}

// Перелік справ, за якими надійдуть нагадування (найближчі засідання).
// Кожну можна прибрати з нагадувань (🗑 — назавжди, як у «Прихованих»).
async function showReminders(env, page = 0) {
  const list = [];
  for (const kind of ['clients', 'advocate']) {
    const { visible } = await visibleReport(env, kind);
    visible.forEach((it, i) => {
      const d = daysUntil(it.date);
      if (d === null || d < 0) return;   // минулі/нерозпізнані — пропускаємо
      list.push({ kind, gi: i, it, days: d });
    });
  }
  list.sort((a, b) => a.days - b.days);
  // Прибираємо дублі: та сама справа буває і у «клієнтів», і в «адвоката».
  const seen = new Set();
  const uniq = [];
  for (const r of list) {
    const k = itemKey(r.it);
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(r);
  }
  if (!uniq.length) {
    return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, parse_mode: 'HTML',
      text: '🔔 <b>Нагадування</b>\nНемає найближчих засідань. Перелік оновлюється під час прогону.',
      reply_markup: { inline_keyboard: [[{ text: '↩️ Меню', callback_data: 'cmenu' }]] } });
  }
  // Повна інформація по кожній справі одразу; довгий список — по сторінках.
  const PER = 7;
  const pages = Math.max(1, Math.ceil(uniq.length / PER));
  page = Math.min(Math.max(0, page | 0), pages - 1);
  const slice = uniq.slice(page * PER, page * PER + PER);
  let txt = `🔔 <b>Найближчі засідання: ${uniq.length}</b>` +
    (pages > 1 ? ` · стор. ${page + 1}/${pages}` : '') +
    `\n<i>🗑 — прибрати справу з нагадувань</i>\n`;
  const kb = [];
  slice.forEach((r) => {
    const it = r.it;
    const mark = r.days <= 1 ? '🔴' : (r.days <= 3 ? '🟠' : '🗓');
    const when = r.days === 0 ? 'сьогодні' : (r.days === 1 ? 'завтра' : `за ${r.days} дн.`);
    const tag = r.kind === 'clients' ? '👥 клієнт' : '⚖️ адвокат';
    txt += `\n${mark} <b>${when}</b> · № ${esc(it.number)}\n`;
    txt += `    📅 ${esc(it.date)}\n`;
    if (it.matched) txt += `    🔎 ${tag}: <b>${esc(it.matched)}</b>\n`;
    txt += `    🏛 ${cut(it.court, 80)}${it.courtroom ? ' · 🚪 ' + esc(it.courtroom) : ''}\n`;
    const jf = [it.judge, it.forma].filter(Boolean).map(esc).join(' · ');
    if (jf) txt += `    👨‍⚖️ ${jf}\n`;
    if (it.description) txt += `    📋 ${cut(it.description, 180)}\n`;
    if (it.involved) txt += `    👥 ${cut(it.involved, 300)}\n`;
    if (it.address) txt += `    📍 ${cut(it.address, 100)}\n`;
    kb.push([{ text: `🗑 прибрати № ${(it.number || '').slice(0, 18)}`,
              callback_data: `cremdel:${r.kind}:${r.gi}` }]);
  });
  if (pages > 1) {
    const nav = [];
    if (page > 0) nav.push({ text: '◀️ Назад', callback_data: `crempg:${page - 1}` });
    nav.push({ text: `${page + 1}/${pages}`, callback_data: 'cnoop' });
    if (page < pages - 1) nav.push({ text: 'Далі ▶️', callback_data: `crempg:${page + 1}` });
    kb.push(nav);
  }
  kb.push([{ text: '↩️ Меню', callback_data: 'cmenu' }]);
  return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, parse_mode: 'HTML',
    text: txt, disable_web_page_preview: true, reply_markup: { inline_keyboard: kb } });
}

async function showCourtReport(env, kind = 'advocate', page = 0) {
  const isClients = kind === 'clients';
  const title = isClients ? '👥 <b>Справи клієнтів' : '⚖️ <b>Справи адвоката';
  const { updated, visible, hiddenCount } = await visibleReport(env, kind);
  if (!visible.length) {
    const extra = hiddenCount
      ? `Усі справи приховано (${hiddenCount}). `
      : 'Поки немає даних. Звіт оновлюється під час прогону (планового або 🔄 термінового). ';
    const kb = hiddenCount
      ? { inline_keyboard: [[{ text: `📂 Приховані (${hiddenCount})`, callback_data: `chidden:${kind}` }], [{ text: '↩️ Меню', callback_data: 'cmenu' }]] }
      : courtMenuKb();
    return tg(env, 'sendMessage', {
      chat_id: env.REVIEW_CHAT, parse_mode: 'HTML',
      text: `${title}</b>\n${extra}`, reply_markup: kb,
    });
  }
  const PER = 7;
  const pages = Math.max(1, Math.ceil(visible.length / PER));
  page = Math.min(Math.max(0, page | 0), pages - 1);
  const startI = page * PER;
  const slice = visible.slice(startI, startI + PER);
  let txt = `${title}: ${visible.length}</b>` +
    (hiddenCount ? ` <i>(приховано ${hiddenCount})</i>` : '') +
    `\n<i>оновлено: ${esc(updated || '')}</i>` +
    (pages > 1 ? ` · стор. ${page + 1}/${pages}` : '') + '\n';
  const rows = [];
  let row = [];
  slice.forEach((it, j) => {
    const gi = startI + j;
    txt += `\n<b>${gi + 1}. № ${esc(it.number)}</b> · 📅 ${esc(it.date)}\n`;
    if (isClients && it.matched) txt += `    🔎 клієнт: <b>${esc(it.matched)}</b>\n`;
    txt += `    🏛 ${cut(it.court, 90)}${it.courtroom ? ' · 🚪 ' + esc(it.courtroom) : ''}\n`;
    const jf = [it.judge, it.forma].filter(Boolean).map(esc).join(' · ');
    if (jf) txt += `    👨‍⚖️ ${jf}\n`;
    if (it.description) txt += `    📋 ${cut(it.description, 160)}\n`;
    if (it.involved) txt += `    👥 ${cut(it.involved, 200)}\n`;
    if (it.address) txt += `    📍 ${cut(it.address, 120)}\n`;
    row.push({ text: `🗑 ${gi + 1}`, callback_data: `chide:${kind}:${gi}:${page}` });
    if (row.length === 5) { rows.push(row); row = []; }
  });
  if (row.length) rows.push(row);
  if (pages > 1) {
    const nav = [];
    if (page > 0) nav.push({ text: '◀️ Назад', callback_data: `crepp:${kind}:${page - 1}` });
    nav.push({ text: `${page + 1}/${pages}`, callback_data: 'cnoop' });
    if (page < pages - 1) nav.push({ text: 'Далі ▶️', callback_data: `crepp:${kind}:${page + 1}` });
    rows.push(nav);
  }
  if (hiddenCount) rows.push([{ text: `📂 Приховані (${hiddenCount})`, callback_data: `chidden:${kind}` }]);
  rows.push([{ text: '↩️ Меню', callback_data: 'cmenu' }]);
  return tg(env, 'sendMessage', {
    chat_id: env.REVIEW_CHAT, parse_mode: 'HTML', text: txt,
    disable_web_page_preview: true, reply_markup: { inline_keyboard: rows },
  });
}

// Об'єднаний перегляд: справи адвоката + клієнтів в одному повідомленні.
// Лише для читання (приховування/видалення — у відповідних окремих розділах),
// щоб індекси кнопок 🗑 не плутались між двома джерелами.
// Об'єднаний перелік (адвокат + клієнти) без дублів, у порядку показу.
async function allCases(env) {
  const a = await visibleReport(env, 'advocate');
  const c = await visibleReport(env, 'clients');
  const byKey = new Map();
  a.visible.forEach((it) => byKey.set(itemKey(it), { ...it, _src: '⚖️' }));
  c.visible.forEach((it) => {
    const k = itemKey(it);
    if (byKey.has(k)) {                       // справа є і там, і там — позначаємо обидва
      const e = byKey.get(k);
      e._src = '⚖️👥';
      if (!e.matched && it.matched) e.matched = it.matched;
    } else {
      byKey.set(k, { ...it, _src: '👥' });
    }
  });
  return { all: [...byKey.values()].sort(caseCmp), updated: a.updated || c.updated || '',
    hiddenCount: a.hiddenCount + c.hiddenCount };
}

async function showCourtReportAll(env, page = 0) {
  const { all, updated, hiddenCount } = await allCases(env);
  const title = '📑 <b>Повний список справ';
  if (!all.length) {
    return tg(env, 'sendMessage', {
      chat_id: env.REVIEW_CHAT, parse_mode: 'HTML',
      text: `${title}</b>\nПоки немає даних. Перелік оновлюється під час прогону ` +
        '(планового або 🔄 термінового).',
      reply_markup: courtMenuKb(),
    });
  }
  const PER = 7;
  const pages = Math.max(1, Math.ceil(all.length / PER));
  page = Math.min(Math.max(0, page | 0), pages - 1);
  const startI = page * PER;
  const slice = all.slice(startI, startI + PER);
  let txt = `${title}: ${all.length}</b>\n<i>оновлено: ${esc(updated)}</i>` +
    (pages > 1 ? ` · стор. ${page + 1}/${pages}` : '') +
    '\n<i>⚖️ — ваші · 👥 — клієнтів · 🗑 — прибрати зі списку</i>\n';
  slice.forEach((it, j) => {
    const gi = startI + j;
    txt += `\n<b>${gi + 1}. ${it._src} № ${esc(it.number)}</b> · 📅 ${esc(it.date)}\n`;
    if (it.matched) txt += `    🔎 клієнт: <b>${esc(it.matched)}</b>\n`;
    txt += `    🏛 ${cut(it.court, 90)}${it.courtroom ? ' · 🚪 ' + esc(it.courtroom) : ''}\n`;
    const jf = [it.judge, it.forma].filter(Boolean).map(esc).join(' · ');
    if (jf) txt += `    👨‍⚖️ ${jf}\n`;
    if (it.description) txt += `    📋 ${cut(it.description, 160)}\n`;
    if (it.involved) txt += `    👥 ${cut(it.involved, 200)}\n`;
    if (it.address) txt += `    📍 ${cut(it.address, 120)}\n`;
  });
  const rows = [];
  let row = [];
  slice.forEach((it, j) => {
    row.push({ text: `🗑 ${startI + j + 1}`, callback_data: `callhide:${startI + j}:${page}` });
    if (row.length === 4) { rows.push(row); row = []; }
  });
  if (row.length) rows.push(row);
  if (pages > 1) {
    const nav = [];
    if (page > 0) nav.push({ text: '◀️ Назад', callback_data: `crepall:${page - 1}` });
    nav.push({ text: `${page + 1}/${pages}`, callback_data: 'cnoop' });
    if (page < pages - 1) nav.push({ text: 'Далі ▶️', callback_data: `crepall:${page + 1}` });
    rows.push(nav);
  }
  rows.push([
    { text: '⚖️ Лише мої', callback_data: 'crep' },
    { text: '👥 Лише клієнтів', callback_data: 'crepc' },
  ]);
  if (hiddenCount) {
    rows.push([{ text: '📂 Приховані: мої', callback_data: 'chidden:advocate' },
      { text: '📂 Приховані: клієнтів', callback_data: 'chidden:clients' }]);
  }
  rows.push([{ text: '↩️ Меню', callback_data: 'cmenu' }]);
  return tg(env, 'sendMessage', {
    chat_id: env.REVIEW_CHAT, parse_mode: 'HTML', text: txt,
    disable_web_page_preview: true, reply_markup: { inline_keyboard: rows },
  });
}

async function showCourtMenu(env, prefix = '') {
  const arr = await getNames(env);
  const nums = await getCaseNums(env);
  // Закріплюємо меню-клавіатуру біля поля вводу + дублюємо кнопки в повідомленні.
  await tg(env, 'sendMessage', {
    chat_id: env.REVIEW_CHAT, parse_mode: 'HTML',
    text: prefix + '⚖️ <b>Меню суду</b> закріплено внизу ⬇️\nКлієнтів під наглядом: <b>' +
      arr.length + '</b> · справ за номером: <b>' + nums.length + '</b>',
    reply_markup: courtReplyKb(),
  });
}

async function showCourtList(env) {
  const arr = await getNames(env);
  if (!arr.length) {
    return tg(env, 'sendMessage', {
      chat_id: env.REVIEW_CHAT, parse_mode: 'HTML',
      text: 'Список порожній. Натисніть «➕ Додати клієнта».',
      reply_markup: courtMenuKb(),
    });
  }
  const rows = arr.map((n, i) => [
    { text: `✏️ ${i + 1}`, callback_data: `cedit:${i}` },
    { text: `🗑 ${i + 1}`, callback_data: `cdel:${i}` },
  ]);
  rows.push([{ text: '➕ Додати', callback_data: 'cadd' }]);
  const list = arr.map((n, i) => `${i + 1}. ${esc(n)}`).join('\n');
  return tg(env, 'sendMessage', {
    chat_id: env.REVIEW_CHAT, parse_mode: 'HTML',
    text: `📋 <b>Клієнти (${arr.length})</b>\n${list}\n\n✏️ — змінити · 🗑 — видалити:`,
    reply_markup: { inline_keyboard: rows },
  });
}
// Запускає приватний аналіз «Практика ВС за запитом» через GitHub Actions
// (workflow vs-practice.yml). Потрібен секрет GH_DISPATCH_TOKEN у Worker
// (fine-grained PAT з правом Actions: read+write на цей репозиторій).
async function triggerVsPractice(env, query) {
  const token = env.GH_DISPATCH_TOKEN;
  if (!token) return 0;
  const repo = env.GH_REPO || 'AlexOsadko/web_site';
  try {
    const r = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/vs-practice.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'osadko-telegram-bot',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main', inputs: { query } }),
      });
    return r.status;
  } catch (e) {
    return 0;
  }
}

// Запускає пошук практики за темою й відповідає адвокату.
async function runVsSearch(env, query) {
  const status = await triggerVsPractice(env, query);
  const ok = status === 204;
  return tg(env, 'sendMessage', {
    chat_id: env.REVIEW_CHAT, parse_mode: 'HTML',
    text: ok
      ? `🔎 Шукаю практику за темою «${esc(query)}» серед публікацій ВС, Пленуму ВС і КСУ. `
        + `За 2–5 хв надішлю сюди до 3 розборів (або повідомлю, що нічого релевантного немає).`
      : '⚠️ Не вдалося запустити пошук: ' + ghWhy(env, status),
  });
}

// «📰 Свіжа практика» — позачерговий запуск щоденної добірки (practice-digest.yml).
async function runDigest(env) {
  let ok = false, status = 0;
  if (env.GH_DISPATCH_TOKEN) {
    try {
      const r = await fetch(
        `https://api.github.com/repos/${env.GH_REPO || 'AlexOsadko/web_site'}/actions/workflows/practice-digest.yml/dispatches`,
        { method: 'POST', headers: {
            'Authorization': `Bearer ${env.GH_DISPATCH_TOKEN}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'osadko-telegram-bot',
            'Content-Type': 'application/json',
          }, body: JSON.stringify({ ref: 'main', inputs: { dry: false } }) });
      status = r.status;
      ok = r.status === 204;
    } catch (e) { ok = false; }
  }
  return tg(env, 'sendMessage', {
    chat_id: env.REVIEW_CHAT, parse_mode: 'HTML',
    text: ok
      ? '📰 Шукаю свіжу практику ВС, Пленуму ВС і КСУ. Якщо є нові вартісні рішення — за кілька хвилин '
        + 'надішлю сюди до 3 розборів; якщо нічого нового — промовчу. (Щоранку добірка приходить сама.)'
      : '⚠️ Не вдалося запустити добірку: ' + ghWhy(env, status),
  });
}

// ── AI-агент адвоката: документи (Word/PDF/фото) + завдання ──
// Адвокат надсилає один або кілька файлів (можна альбомом) і пише завдання:
// аналіз, заперечення, відзив, апеляція, клопотання… — або тисне кнопку-шаблон.
// Кожен файл лежить у KV окремим ключем agent_file_<message_id> (без гонок при
// альбомах), до 2 год. Завдання (текст + file_id) — у KV під випадковим id лише
// до запуску; воркфлоу agent.yml отримує ЛИШЕ цей id (вхідні дані запуску в
// публічному репозиторії видно всім), забирає завдання через /agent_job і
// видаляє. Текст справи не потрапляє ні в репозиторій, ні в логи.
const AGENT_PRESETS = {
  an: { label: '🔍 Аналіз', task: 'Проаналізуй додані документи: суть, що вирішено або чого просять, '
    + 'строк і порядок оскарження, слабкі місця, аргументи, що робити далі.' },
  ob: { label: '🛡 Заперечення / відзив', task: 'Підготуй процесуальну відповідь на доданий документ '
    + '(відзив на позов, заперечення на апеляційну скаргу чи клопотання, пояснення — що доречно за процесуальним законом).' },
  ap: { label: '📝 Апеляційна скарга', task: 'Підготуй апеляційну скаргу на додане рішення / постанову / ухвалу.' },
  mo: { label: '📨 Клопотання', task: 'Підготуй клопотання, доречне у цій справі за доданими документами '
    + '(запропонуй вид клопотання, якщо з документів це видно).' },
};

function agentKb(caption) {
  const rows = [
    [{ text: AGENT_PRESETS.an.label, callback_data: 'ag:an' }, { text: AGENT_PRESETS.ob.label, callback_data: 'ag:ob' }],
    [{ text: AGENT_PRESETS.ap.label, callback_data: 'ag:ap' }, { text: AGENT_PRESETS.mo.label, callback_data: 'ag:mo' }],
  ];
  if (caption) rows.unshift([{ text: '▶️ Виконати завдання з підпису', callback_data: 'ag:cap' }]);
  rows.push([{ text: '🗑 Скинути файли', callback_data: 'ag:reset' }]);
  return { inline_keyboard: rows };
}

// Файли в роботі: кожен — окремий ключ agent_file_<message_id> (до 2 год).
// Спільного списку немає: паралельні альбоми (Telegram ділить 200 фото на
// альбоми по 10) перезаписували б його один одному, а KV.list бачить нові ключі
// із затримкою. Тож файли збираємо перебором message_id назад від опорного
// (id у чаті йдуть поспіль). Використані не видаляємо (зайві записи в KV) —
// відсікаємо межею agent_floor; самі ключі зникають за 2 год.
const AGENT_MAX = 200;   // файлів на одне завдання
const SCAN = 300;        // скільки id назад переглядати
async function agentFiles(env, ref = 0) {
  const last = parseInt((await env.KV.get('agent_last')) || '0', 10);
  const floor = parseInt((await env.KV.get('agent_floor')) || '0', 10);
  const top = Math.max(ref, last + 30);
  const out = [];
  for (let hi = top; hi > top - SCAN && hi > floor; hi -= 50) {
    const ids = [];
    for (let id = hi; id > hi - 50 && id > floor; id--) ids.push(id);
    const got = await Promise.all(ids.map((id) => env.KV.get('agent_file_' + id, 'json')));
    got.forEach((f, i) => { if (f) out.push({ key: 'agent_file_' + ids[i], ...f }); });
  }
  return out.sort((x, y) => (x.mid || 0) - (y.mid || 0));
}
// Межа: усі файли з id ≤ floor вважаються використаними (наступні id — нові).
async function clearAgentFiles(env, ref = 0, files = null) {
  files = files || await agentFiles(env, ref);
  const floor = Math.max(ref, ...files.map((f) => f.mid || 0));
  await env.KV.put('agent_floor', String(floor), { expirationTtl: 7200 });
  await env.KV.delete('agent_caption');
}

async function askAgent(env) {
  await env.KV.put('court_await', 'agent');
  const n = (await agentFiles(env)).length;
  return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, parse_mode: 'HTML',
    text: '🤖 <b>Завдання агенту</b>\n'
      + '1) Надішліть документи — Word (DOC/DOCX), PDF або фото сторінок (JPG, PNG, HEIC з iPhone); '
      + 'можна кілька файлів чи альбомом фото.\n'
      + '2) Напишіть завдання своїми словами — напр. <i>підготуй відзив на позов, наголоси на пропуску '
      + 'позовної давності</i> — або оберіть кнопку.\n'
      + 'Без файлів теж можна: опишіть справу й що скласти.'
      + (n ? `\n\n📎 Уже завантажено файлів: <b>${n}</b>.` : '')
      + '\nСкасувати — /cancel.',
    reply_markup: n ? agentKb(false) : undefined });
}

// Файл із повідомлення Telegram: документ або найбільше фото.
function msgFile(m) {
  if (m.document) {
    return { file_id: m.document.file_id, name: m.document.file_name || 'document',
      mime: m.document.mime_type || '', size: m.document.file_size || 0 };
  }
  if (Array.isArray(m.photo) && m.photo.length) {
    const p = m.photo[m.photo.length - 1];
    return { file_id: p.file_id, name: 'photo.jpg', mime: 'image/jpeg', size: p.file_size || 0 };
  }
  return null;
}

// Прийом файлу. Одиночний із підписом — одразу в роботу. Альбом (кожне фото —
// окреме оновлення, вони приходять паралельно): відповідає лише «лідер» —
// повідомлення, перед яким немає файлу з того ж альбому; він чекає, поки
// збережуться інші фото, і рахує їх (id ідуть поспіль).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function onAgentFile(env, m, file, caption) {
  if (file.size > 20 * 1024 * 1024) {
    return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT,
      text: '⚠️ Файл більший за 20 МБ — Telegram не дає боту його завантажити. Надішліть менший файл.' });
  }
  const mid = m.message_id;
  const gid = m.media_group_id || '';
  await env.KV.put('agent_file_' + mid, JSON.stringify({ ...file, mid, gid, caption: caption || '' }),
    { expirationTtl: 7200 });
  // agent_last/court_await пише лише одиночний файл або лідер альбому (менше записів у KV)
  const mark = async (top) => {
    const last = parseInt((await env.KV.get('agent_last')) || '0', 10);
    if (top > last) await env.KV.put('agent_last', String(top), { expirationTtl: 7200 });
    if ((await env.KV.get('court_await')) !== 'agent') await env.KV.put('court_await', 'agent');
  };
  if (!gid) {
    await mark(mid);
    if (caption) return startAgent(env, caption, mid);
  }
  let k = 1;
  let cap = caption || '';
  if (gid) {
    await sleep(2500);
    const prev = await env.KV.get('agent_file_' + (mid - 1), 'json');
    if (prev && prev.gid === gid) return;           // не лідер альбому — мовчимо
    for (; k < 10; k++) {
      const f = await env.KV.get('agent_file_' + (mid + k), 'json');
      if (!f || f.gid !== gid) break;
      if (!cap && f.caption) cap = f.caption;
    }
    await mark(mid + k - 1);
    if (cap) await env.KV.put('agent_caption', cap, { expirationTtl: 7200 });
  }
  const n = (await agentFiles(env, mid + k)).length;
  const over = n > AGENT_MAX ? `\n⚠️ Понад ${AGENT_MAX} — в роботу підуть останні ${AGENT_MAX}.` : '';
  return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, parse_mode: 'HTML',
    text: `📎 Отримано${gid ? ` альбом (${k} шт.)` : ''}. Файлів у роботі: <b>${n}</b>.${over}\n`
      + (cap ? `Завдання з підпису: <i>${esc(cap.slice(0, 200))}</i>\n` : '')
      + 'Надішліть ще файли (до 200) або напишіть завдання своїми словами чи оберіть кнопку:',
    reply_markup: agentKb(!!cap) });
}

async function startAgent(env, text, ref = 0) {
  if (!env.GH_DISPATCH_TOKEN) {
    return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, parse_mode: 'HTML',
      text: '⚠️ Не вдалося запустити: ' + ghWhy(env, 0) });
  }
  // невелика пауза: файли щойно надісланого альбому можуть ще зберігатися
  await sleep(1500);
  const found = await agentFiles(env, ref);
  const files = found.slice(-AGENT_MAX).map(({ key, gid, caption, mid, ...f }) => f);
  const id = crypto.randomUUID().replace(/-/g, '');
  await env.KV.put('agent_job_' + id, JSON.stringify({ text, files }), { expirationTtl: 3600 });
  let status = 0;
  try {
    const r = await fetch(
      `https://api.github.com/repos/${env.GH_REPO || 'AlexOsadko/web_site'}/actions/workflows/agent.yml/dispatches`,
      { method: 'POST', headers: {
          'Authorization': `Bearer ${env.GH_DISPATCH_TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'osadko-telegram-bot',
          'Content-Type': 'application/json',
        }, body: JSON.stringify({ ref: 'main', inputs: { job: id } }) });
    status = r.status;
  } catch (e) { status = 0; }
  if (status !== 204) {
    await env.KV.delete('agent_job_' + id);
    return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, parse_mode: 'HTML',
      text: '⚠️ Не вдалося запустити: ' + ghWhy(env, status) + '\nФайли збережено — спробуйте ще раз.' });
  }
  await clearAgentFiles(env, ref, found);
  await env.KV.delete('court_await');
  return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, parse_mode: 'HTML',
    text: `⏳ Працюю над завданням${files.length ? ` (файлів: ${files.length})` : ''}. `
      + 'За 1–5 хв надішлю сюди результат: розбір текстом або готовий DOCX із переліком того, що перевірити.' });
}

// Зрозуміла причина, чому GitHub не прийняв запуск воркфлоу.
function ghWhy(env, status) {
  if (!env.GH_DISPATCH_TOKEN) return 'у Worker немає секрету <code>GH_DISPATCH_TOKEN</code>.';
  if (status === 401) return 'токен <code>GH_DISPATCH_TOKEN</code> недійсний або прострочений.';
  if (status === 403) return 'у токена <code>GH_DISPATCH_TOKEN</code> немає права Actions: Read and write.';
  if (status === 404 || status === 422) return 'GitHub не знайшов воркфлоу в main (оновлення ще не опубліковано) або в токена немає доступу до репозиторію.';
  return status ? `GitHub відповів ${status}.` : 'немає зв\'язку з GitHub.';
}

async function handleUpdate(update, env) {
  // --- натискання кнопок ---
  if (update.callback_query) {
    const cq = update.callback_query;
    const msg = cq.message || {};
    const chat = msg.chat && msg.chat.id;
    const mid = msg.message_id;
    const parts = (cq.data || '').split(':');
    const action = parts[0];
    const pid = parts[1];

    // --- AI-агент: кнопки-шаблони завдань над завантаженими файлами ---
    if (action === 'ag') {
      await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
      if (pid === 'reset') {
        await clearAgentFiles(env, mid);
        await env.KV.delete('court_await');
        return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, text: '🗑 Файли скинуто.' });
      }
      const files = await agentFiles(env, mid);
      if (pid === 'cap') {
        const cap = await env.KV.get('agent_caption');
        if (!cap) return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, text: 'Підпис застарів — напишіть завдання ще раз.' });
        return startAgent(env, cap, mid);
      }
      const pr = AGENT_PRESETS[pid];
      if (!pr) return;
      if (!files.length) {
        return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT,
          text: 'Файлів немає (минуло понад 2 год або вже використані) — надішліть документи ще раз.' });
      }
      return startAgent(env, pr.task, mid);
    }

    // --- прибрати процесуальний строк зі списку бота ---
    if (action === 'dldel') {
      await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
      const list = await getDeadlines(env);
      const gone = list.find((x) => x.key === pid);
      await env.KV.put('court_deadlines', JSON.stringify(list.filter((x) => x.key !== pid)));
      return showDeadlines(env, gone ? `🗑 Прибрано: ${esc(gone.title)} (${esc(gone.date)}).\n\n` : '');
    }

    // --- підтвердження додавання клієнтської справи в Google Calendar ---
    if (action === 'gcaladd' || action === 'gcalskip') {
      await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
      const key = pid;
      const chatId = cq.message && cq.message.chat && cq.message.chat.id;
      const msgId = cq.message && cq.message.message_id;
      const statusKb = (label) => ({ inline_keyboard: [[{ text: label, callback_data: 'cnoop' }]] });
      if (action === 'gcalskip') {
        await env.KV.delete('gcal_pending_' + key);
        const ks = (await env.KV.get('gcal_approved', 'json')) || [];
        if (ks.includes(key)) await env.KV.put('gcal_approved', JSON.stringify(ks.filter((k) => k !== key)));
        return tg(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: statusKb('✖️ Не додано в календар') });
      }
      // gcaladd — підтверджуємо й ставимо в чергу; додасть найближчий прогін
      const pend = await env.KV.get('gcal_pending_' + key, 'json');
      if (!pend) {
        return tg(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: statusKb('⚠️ Застаріло — недоступно') });
      }
      const ks = (await env.KV.get('gcal_approved', 'json')) || [];
      if (!ks.includes(key)) { ks.push(key); await env.KV.put('gcal_approved', JSON.stringify(ks)); }
      await tg(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: statusKb('⏳ Додаю в календар…') });
      // окрема швидка задача «лише календар» (без сканування судів): подія ~за хвилину.
      // Кілька натискань поспіль обробить один запуск (тротлінг 20 с).
      if (env.GH_TOKEN) {
        const last = parseInt((await env.KV.get('gcal_run_at')) || '0', 10);
        if (Date.now() - last >= 20000) {
          const st = await triggerScan(env, 'gcal-add.yml', {});
          await env.KV.put('gcal_run_at', String(Date.now()));
          if (st !== 204) {   // запасний шлях — повний прогін, як раніше
            const l2 = parseInt((await env.KV.get('court_run_at')) || '0', 10);
            if (Date.now() - l2 >= 90000) { await triggerScan(env); await env.KV.put('court_run_at', String(Date.now())); }
          }
        }
      }
      return;
    }

    // --- меню бота відстеження судових справ ---
    if (['cmenu', 'cadd', 'clist', 'cedit', 'cdel', 'crep', 'crepc', 'crepall', 'crun',
         'chide', 'cunhide', 'chidden', 'cunhide1', 'cpurge1', 'cpurge',
         'crem', 'cremdel', 'crempg', 'crepp', 'cnoop', 'cvs', 'cdig',
         'callhide', 'cagent', 'cgrp', 'cnadd', 'cnlist', 'cndel'].includes(action)) {
      await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
      if (action === 'cnoop') return;
      if (action === 'cdig') return runDigest(env);
      if (action === 'cvs') {
        await env.KV.put('court_await', 'vs');
        return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, parse_mode: 'HTML',
          text: '🔎 Напишіть тему для пошуку практики (ВС, Пленум ВС, КСУ) — напр. '
            + '<code>відмова від огляду ст. 130</code>. Скасувати — /cancel.' });
      }
      if (action === 'cmenu') return showCourtMenu(env);
      if (action === 'crep') return showCourtReport(env, 'advocate', 0);
      if (action === 'crepc') return showCourtReport(env, 'clients', 0);
      if (action === 'crepall') return showCourtReportAll(env, parseInt(pid, 10) || 0);
      if (action === 'crepp') {  // перегортання сторінок звіту
        const kind = pid === 'clients' ? 'clients' : 'advocate';
        return showCourtReport(env, kind, parseInt(parts[2], 10) || 0);
      }
      // Приховати / відновити справи у переглядах (не виводяться й надалі).
      if (action === 'chide') {
        const kind = pid === 'clients' ? 'clients' : 'advocate';
        const { visible } = await visibleReport(env, kind);
        const i = parseInt(parts[2], 10);
        const page = parseInt(parts[3], 10) || 0;
        if (!isNaN(i) && visible[i]) await addHidden(env, kind, itemKey(visible[i]));
        return showCourtReport(env, kind, page);
      }
      // 🗑 у «Повному списку»: приховуємо в обох звітах (справа буває в обох);
      // повернути можна з «📂 Приховані».
      if (action === 'callhide') {
        const { all } = await allCases(env);
        const i = parseInt(pid, 10);
        const page = parseInt(parts[2], 10) || 0;
        if (!isNaN(i) && all[i]) {
          const k = itemKey(all[i]);
          if (all[i]._src.includes('⚖️')) await addHidden(env, 'advocate', k);
          if (all[i]._src.includes('👥')) await addHidden(env, 'clients', k);
        }
        return showCourtReportAll(env, page);
      }
      if (action === 'chidden') {
        return showHidden(env, pid === 'clients' ? 'clients' : 'advocate');
      }
      if (action === 'cunhide1') {
        const kind = pid === 'clients' ? 'clients' : 'advocate';
        const i = parseInt(parts[2], 10);
        if (!isNaN(i)) await removeHiddenAt(env, kind, i);
        return showHidden(env, kind);
      }
      if (action === 'cunhide') {
        const kind = pid === 'clients' ? 'clients' : 'advocate';
        await clearHidden(env, kind);
        return showCourtReport(env, kind);
      }
      // Видалити назавжди — прибрати з «Прихованих» і більше ніколи не показувати.
      if (action === 'cpurge1') {
        const kind = pid === 'clients' ? 'clients' : 'advocate';
        const i = parseInt(parts[2], 10);
        const hidden = await getHidden(env, kind);
        if (!isNaN(i) && i >= 0 && i < hidden.length) {
          await addDeleted(env, kind, hidden[i]);
          await removeHiddenAt(env, kind, i);
        }
        return showHidden(env, kind);
      }
      if (action === 'cpurge') {
        const kind = pid === 'clients' ? 'clients' : 'advocate';
        const hidden = await getHidden(env, kind);
        if (hidden.length) {
          const del = await getDeleted(env, kind);
          for (const k of hidden) if (!del.includes(k)) del.push(k);
          await env.KV.put('court_deleted_' + kind, JSON.stringify(del));
          await clearHidden(env, kind);
        }
        return showHidden(env, kind);
      }
      if (action === 'crem') return showReminders(env, 0);
      if (action === 'crempg') return showReminders(env, parseInt(pid, 10) || 0);
      // Прибрати справу з нагадувань назавжди (більше не показувати й не нагадувати).
      // Видаляємо в обох списках, бо справа буває і у «клієнтів», і в «адвоката».
      if (action === 'cremdel') {
        const kind = pid === 'clients' ? 'clients' : 'advocate';
        const i = parseInt(parts[2], 10);
        const { visible } = await visibleReport(env, kind);
        if (!isNaN(i) && visible[i]) {
          const k = itemKey(visible[i]);
          await addDeleted(env, 'clients', k);
          await addDeleted(env, 'advocate', k);
        }
        return showReminders(env);
      }
      if (action === 'cagent') return askAgent(env);
      if (action === 'cgrp') return showGroup(env, pid);
      if (action === 'crun') {
        const txt = await urgentScan(env);
        return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, parse_mode: 'HTML', text: txt });
      }
      if (action === 'clist') return showCourtList(env);
      if (action === 'cnlist') return showCaseList(env);
      if (action === 'cnadd') {
        await env.KV.put('court_await', 'addnum');
        return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, parse_mode: 'HTML', text: CASE_ASK });
      }
      if (action === 'cndel') {
        const nums = await getCaseNums(env);
        const i = parseInt(pid, 10);
        if (isNaN(i) || i < 0 || i >= nums.length) return showCaseList(env);
        const gone = nums.splice(i, 1)[0];
        await putCaseNums(env, nums);
        return showCaseList(env, `🗑 Більше не стежу за справою <code>${esc(gone)}</code>.\n\n`);
      }
      if (action === 'cadd') {
        await env.KV.put('court_await', 'add');
        return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT,
          text: "➕ Надішліть ПІБ клієнта (Прізвище Ім'я По-батькові). Скасувати — /cancel." });
      }
      const arr = await getNames(env);
      const idx = parseInt(pid, 10);
      if (isNaN(idx) || idx < 0 || idx >= arr.length) return showCourtList(env);
      if (action === 'cedit') {
        await env.KV.put('court_await', 'edit:' + idx);
        return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, parse_mode: 'HTML',
          text: `✏️ Поточне: «${esc(arr[idx])}»\nНадішліть нове ПІБ. Скасувати — /cancel.` });
      }
      if (action === 'cdel') {
        const removed = arr.splice(idx, 1)[0];
        await putNames(env, arr);
        await tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, parse_mode: 'HTML',
          text: `🗑 Видалено «${esc(removed)}». Залишилось: <b>${arr.length}</b>.` });
        return showCourtList(env);
      }
      return;
    }

    return;
  }

  // --- звичайні повідомлення (команди й кнопки меню) ---
  if (update.message) {
    const m = update.message;
    const chat = m.chat && m.chat.id;
    if (String(chat) !== String(env.REVIEW_CHAT)) return;
    const body = (m.text || m.caption || '').trim();
    let body2 = '';
    const courtAwait = await env.KV.get('court_await');
    const file = msgFile(m);

    // AI-агент: будь-який файл (Word/PDF/фото) іде в роботу агенту; текст після
    // кнопки «🤖» або поки є завантажені файли — це завдання.
    if (file) return onAgentFile(env, m, file, body);
    // Переслана/вставлена повістка — розпізнати, поставити справу на стеження, запропонувати календар
    {
      const sm = parseSummons(body);
      if (sm) { await env.KV.delete('court_await'); return onSummons(env, sm); }
    }
    const isMenu = /^(📑|👥|⚖️|🔎|📰|📋|🔔|➕|🔄|🤖|📅|📚|🗂|📌|📁)/.test(body)
      || /^(\/|cancel$|скасувати$|меню$)/i.test(body);
    if (courtAwait === 'agent' && body && !isMenu) {
      if (body.length < 10) {
        return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT,
          text: 'Напишіть завдання детальніше (або /cancel).' });
      }
      return startAgent(env, body, m.message_id);
    }

    // Скасування введення (ПІБ клієнта, тема пошуку практики)
    if (/^(\/cancel|cancel|скасувати)$/i.test(body)) {
      await env.KV.delete('court_await');
      if (courtAwait === 'agent') await clearAgentFiles(env, m.message_id);
      return showCourtMenu(env, courtAwait ? '↩️ Скасовано.\n\n' : '');
    }

    // Виклик меню + реєстрація команд бота (кнопка ☰ біля поля вводу)
    if (/^(\/menu|\/court|\/start|\/klienty|\/клієнти|\/клиенти|меню|клієнти)$/i.test(body)) {
      await env.KV.delete('court_await');
      await setupCommands(env);
      return showCourtMenu(env);
    }
    if (/^(\/help|\/довідка|довідка)$/i.test(body)) {
      return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, parse_mode: 'HTML',
        text: 'ℹ️ <b>Команди бота (суд)</b>\n' +
          '/menu — відкрити меню\n/clients — 👥 справи клієнтів\n' +
          '/advocate — ⚖️ справи адвоката\n/reminders — 🔔 нагадування\n' +
          '/list — 📋 список клієнтів\n' +
          '/add — ➕ додати клієнта\n' +
          '/track &lt;номер&gt; — 📌 стежити за справою за номером\n/cases — 📁 справи під наглядом\n' +
          '📨 перешліть боту повістку (SUDPOVISTKA, SMS) — справа стане на стеження, засідання — у календар\n' +
          '/strok &lt;номер&gt; &lt;дата або +N&gt; &lt;що подати&gt; — ⏳ строк у календар\n/stroky — ⏳ усі строки\n' +
          '/export — 📤 файл із даними (резервна копія)\n/app — 📱 адреса вебзастосунку «Мої судові справи»\n' +
          '/restart — 🔄 терміновий прогін\n' +
          '/vs &lt;тема&gt; — 🔎 практика судів за темою (або кнопка «🔎 Пошук практики»)\n' +
          '/digest — 📰 свіжа практика зараз (щоранку приходить сама)\n' +
          '/agent — 🤖 завдання агенту: надішліть Word/PDF і напишіть, що зробити\n' +
          '/cancel — ↩️ скасувати', reply_markup: courtReplyKb() });
    }

    // Процесуальні строки та експорт для застосунку
    if (/^\/(?:stroky|строки|deadlines)$/i.test(body)) {
      await env.KV.delete('court_await');
      return showDeadlines(env);
    }
    {
      const dm = body.match(/^\/(?:strok|строк|deadline)(?:\s+([\s\S]*))?$/i);
      if (dm) {
        await env.KV.delete('court_await');
        const d = parseDeadline(dm[1]);
        if (!d) {
          return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, parse_mode: 'HTML',
            text: (dm[1] ? 'Не розібрав строк. Формат:\n\n' : '') + DEADLINE_ASK });
        }
        return onDeadline(env, d);
      }
    }
    if (/^\/app$/i.test(body)) {
      const base = env.APP_URL || 'адреса вашого воркера + /app';
      return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, text: '📱 Вебзастосунок «Мої судові справи»: ' + base
        + '\nВхід за паролем із секрету APP_PASSWORD. У Safari: Поділитися → На початковий екран.' });
    }
    if (/^\/(?:export|експорт)$/i.test(body)) {
      await env.KV.delete('court_await');
      return sendExport(env);
    }

    // Стеження за справою за номером: /track 757/12345/26-ц, /cases
    {
      const tm = body.match(/^\/(?:track|справа|стежити)(?:\s+([\s\S]*))?$/i);
      if (tm || /^📌/.test(body)) {
        const n = normCaseNum(tm && tm[1]);
        if (!n) {
          await env.KV.put('court_await', 'addnum');
          return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, parse_mode: 'HTML', text: CASE_ASK });
        }
        await env.KV.put('court_await', 'addnum');
        body2 = n;
      }
      if (/^📁/.test(body) || /^\/cases$/i.test(body)) {
        await env.KV.delete('court_await');
        return showCaseList(env);
      }
    }
    if (body2 || (await env.KV.get('court_await')) === 'addnum' && !isMenu) {
      const n = normCaseNum(body2 || body);
      await env.KV.delete('court_await');
      if (!n) {
        await env.KV.put('court_await', 'addnum');
        return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, parse_mode: 'HTML',
          text: 'Це не схоже на номер справи (має містити «/» і цифри, напр. <code>757/12345/26-ц</code>). Надішліть ще раз або /cancel.' });
      }
      const nums = await getCaseNums(env);
      if (nums.some((x) => x.toLowerCase() === n.toLowerCase())) {
        return showCaseList(env, `Справа <code>${esc(n)}</code> уже під наглядом.\n\n`);
      }
      nums.push(n);
      await putCaseNums(env, nums);
      return showCaseList(env, `✅ Стежу за справою <code>${esc(n)}</code>. Перше сповіщення — після найближчого прогону (або натисніть «🔄 Терміновий прогін»).\n\n`);
    }

    // Кнопки закріпленої клавіатури-меню (натискання = звичайне повідомлення)
    if (/^➕/.test(body) || /^(\/add|додати клієнта)$/i.test(body)) {
      await env.KV.put('court_await', 'add');
      return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT,
        text: "➕ Надішліть ПІБ клієнта (Прізвище Ім'я По-батькові). Скасувати — /cancel." });
    }
    if (/^📑/.test(body) || /^📅\s*усі засідання/i.test(body) || /^\/all$/i.test(body) || /повний список/i.test(body)) {
      await env.KV.delete('court_await');
      return showCourtReportAll(env, 0);
    }
    if (/^📋/.test(body) || /^(\/list|список)/i.test(body)) {
      await env.KV.delete('court_await');
      return showCourtList(env);
    }
    if (/^👥/.test(body) || /^\/clients$/i.test(body) || /справи клієнт/i.test(body)) {
      await env.KV.delete('court_await');
      return showCourtReport(env, 'clients');
    }
    if (/^⚖️/.test(body) || /^\/advocate$/i.test(body) || /справи адвоката/i.test(body)) {
      await env.KV.delete('court_await');
      return showCourtReport(env, 'advocate');
    }
    if (/^🔔/.test(body) || /^(\/reminders|\/нагадування)$/i.test(body) || /нагадуванн/i.test(body)) {
      await env.KV.delete('court_await');
      return showReminders(env);
    }
    if (/^🔄/.test(body) || /^(\/run|\/restart|\/перезапуск)$/i.test(body) || /терміновий/i.test(body)) {
      await env.KV.delete('court_await');
      const txt = await urgentScan(env);
      return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, parse_mode: 'HTML', text: txt });
    }

    // Кнопка «🔎 Пошук практики» — просимо тему (стан court_await='vs').
    if (/^🔎/.test(body) || /^пошук практики( вс)?$/i.test(body)) {
      await env.KV.put('court_await', 'vs');
      return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, parse_mode: 'HTML',
        text: '🔎 Напишіть тему для пошуку практики (ВС, Пленум ВС, КСУ) — напр. '
          + '<code>відмова від огляду ст. 130</code>, <code>аліменти на повнолітню дитину</code>, '
          + '<code>обшук без ухвали</code>. Скасувати — /cancel.' });
    }

    // Розділи закріпленої клавіатури → підменю з кнопками.
    if (/^📅/.test(body) || /^засідання$/i.test(body)) {
      await env.KV.delete('court_await');
      return showGroup(env, 'sess');
    }
    if (/^📚/.test(body) || /^практика$/i.test(body)) {
      await env.KV.delete('court_await');
      return showGroup(env, 'prac');
    }
    if (/^🗂/.test(body) || /^клієнти під наглядом$/i.test(body)) {
      await env.KV.delete('court_await');
      return showGroup(env, 'cli');
    }

    // AI-агент: кнопка «🤖 Завдання агенту» закріпленої клавіатури / команда /agent.
    if (/^🤖/.test(body) || /^\/agent$/i.test(body) || /^завдання агенту$/i.test(body)) {
      return askAgent(env);
    }

    // Кнопка «📰 Свіжа практика» / команда /digest — позачергова добірка.
    if (/^📰/.test(body) || /^\/digest$/i.test(body)) {
      await env.KV.delete('court_await');
      return runDigest(env);
    }

    // Команда /вс <тема> — те саме напряму (без \b: у JS вона не працює після
    // кирилиці; вимагаємо пробіл/кінець, щоб «/встановлення» не матчилось).
    {
      const vsm = body.match(/^\/(?:вс|vs)(?:\s+([\s\S]*))?$/i);
      if (vsm) {
        const query = (vsm[1] || '').trim();
        if (!query) {
          await env.KV.put('court_await', 'vs');
          return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, parse_mode: 'HTML',
            text: '🔎 Напишіть тему для пошуку практики (напр. '
              + '<code>поділ майна подружжя</code>). Скасувати — /cancel.' });
        }
        await env.KV.delete('court_await');
        return runVsSearch(env, query);
      }
    }

    // Введення теми для пошуку практики ВС
    if (courtAwait === 'vs') {
      await env.KV.delete('court_await');
      const query = body.replace(/\s+/g, ' ').trim();
      if (query.length < 3 || query.startsWith('/')) {
        return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT,
          text: 'Напишіть тему (кілька слів) або /cancel.' });
      }
      return runVsSearch(env, query);
    }

    // Введення ПІБ для меню суду (додавання / зміна)
    if (courtAwait) {
      const name = body.replace(/\s+/g, ' ').trim();
      if (name.length < 3 || name.startsWith('/')) {
        return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT,
          text: "Надішліть ПІБ (мінімум Прізвище Ім'я) або /cancel." });
      }
      const arr = await getNames(env);
      if (courtAwait === 'add') {
        if (arr.some((n) => n.toLowerCase() === name.toLowerCase())) {
          await env.KV.delete('court_await');
          return showCourtMenu(env, `Таке прізвище вже є («${esc(name)}»).\n\n`);
        }
        arr.push(name);
        await putNames(env, arr);
        await env.KV.delete('court_await');
        return showCourtMenu(env, `✅ Додано «${esc(name)}». Прізвищ: <b>${arr.length}</b>.\n\n`);
      }
      if (courtAwait.startsWith('edit:')) {
        const idx = parseInt(courtAwait.slice(5), 10);
        await env.KV.delete('court_await');
        if (isNaN(idx) || idx < 0 || idx >= arr.length) return showCourtMenu(env);
        const old = arr[idx];
        arr[idx] = name;
        await putNames(env, arr);
        return showCourtMenu(env, `✏️ Змінено «${esc(old)}» → «${esc(name)}».\n\n`);
      }
      await env.KV.delete('court_await');
    }

  }
}

// ═══════════════════ Вебзастосунок «Мої судові справи» ═══════════════════
// Сторінка /app і службові адреси /api/* того самого воркера. Вхід за паролем
// (секрет APP_PASSWORD, не менше 10 символів). Дані ті самі, що бачить бот у KV.
const APP_JSON = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: {
  'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const APP_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache',
  'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; "
    + "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};
async function appSha(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
// Ядро номера справи «код суду/номер/рік» (як _case_core у боті).
function appCaseBase(num) {
  return String(num || '').replace(/[\u2010-\u2015\u2212]/g, '-').toLowerCase().replace(/\s+/g, '')
    .replace(/^№+/, '').replace(/-[^\d/]+$/, '');
}
function appCaseKey(num) {
  const b = appCaseBase(num);
  const m = b.match(/(\d{2,4})\/(\d{1,7})\/(\d{2})(?!\d)/);
  return m ? `${m[1]}/${+m[2]}/${m[3]}` : b;
}
function appCaseQuery(num) {
  const b = appCaseBase(num);
  const m = b.match(/\d{2,4}\/\d{1,7}\/\d{2}(?!\d)/);
  return m ? m[0] : b;
}
// Поставити подію в чергу Google Календаря (ту саму, що й кнопка «📅 Додати в календар»).
async function queueGcal(env, key, court, rec, chatId, messageId) {
  await env.KV.put('gcal_pending_' + key, JSON.stringify({ key, court: court || '', chat_id: chatId || null,
    message_id: messageId || null, rec }), { expirationTtl: 60 * 24 * 3600 });
  const ks = (await env.KV.get('gcal_approved', 'json')) || [];
  if (!ks.includes(key)) { ks.push(key); await env.KV.put('gcal_approved', JSON.stringify(ks)); }
  await kickGcal(env);
}
// Нові справи, які бот побачив уперше (останні 60 днів).
async function getNewCases(env) {
  return ((await env.KV.get('court_newcases', 'json')) || []).filter((x) => { const n = daysUntil(x.found); return n === null || n >= -60; });
}
async function saveDeadline(env, d, chatId, messageId) {
  const key = shortHash('dl|' + d.number + '|' + d.date + '|' + d.title);
  await queueGcal(env, key, '', { kind: 'deadline', number: d.number, date: d.date, title: d.title, note: d.calc || d.note || '' },
    chatId, messageId);
  // список строків: без дублів, без тих, що минули понад 30 днів тому
  const list = (await getDeadlines(env)).filter((x) => x.key !== key && (daysUntil(x.date) ?? 0) >= -30);
  list.push({ key, number: d.number, date: d.date, title: d.title, note: d.calc || d.note || '' });
  await env.KV.put('court_deadlines', JSON.stringify(list.slice(-200)));
  return key;
}

// ── Реєстр судових рішень (лише читання) ──
const REY = 'https://reyestr.court.gov.ua';
const REY_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
function reyUnesc(s) {
  return String(s).replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&laquo;/g, '«').replace(/&raquo;/g, '»').replace(/&ndash;|&mdash;/g, '–').replace(/&amp;/g, '&');
}
const reyCell = (c) => reyUnesc(String(c).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
async function reySearch(caseNumber) {
  const h = { 'User-Agent': REY_UA, 'Accept-Language': 'uk,en;q=0.8' };
  const r0 = await fetch(REY + '/', { headers: h });
  const ck = (r0.headers.getSetCookie ? r0.headers.getSetCookie() : []).map((c) => c.split(';')[0]).join('; ');
  const body = new URLSearchParams({ CaseNumber: caseNumber, Sort: '2', 'PagingInfo.ItemsPerPage': '100', Liga: 'true' });
  const r = await fetch(REY + '/', { method: 'POST', body: body.toString(), headers: { ...h,
    'Content-Type': 'application/x-www-form-urlencoded', Origin: REY, Referer: REY + '/', ...(ck ? { Cookie: ck } : {}) } });
  if (!r.ok) throw new Error('reyestr ' + r.status);
  const html = await r.text();
  const i = html.indexOf('divresult');
  if (i < 0) { if (html.includes('CaseNumber')) return []; throw new Error('reyestr page'); }
  const rows = []; const seen = new Set();
  for (const tr of html.slice(i).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => reyCell(m[1]));
    if (cells.length < 8) continue;
    const id = (tr[1].match(/\/Review\/(\d+)/) || cells[0].match(/(\d{5,})/) || [])[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, form: cells[1], date: cells[2], inForce: cells[3], kind: cells[4], caseNo: cells[5], court: cells[6], judge: cells[7] });
  }
  return rows;
}
async function reyText(id) {
  const r = await fetch(`${REY}/Review/${id}`, { headers: { 'User-Agent': REY_UA, 'Accept-Language': 'uk,en;q=0.8' } });
  if (!r.ok) throw new Error('reyestr ' + r.status);
  const html = await r.text();
  const m = html.match(/id="txtdepository"[^>]*>([\s\S]*?)<\/textarea>/i) || html.match(/id="txtdepository"[^>]*value="([^"]*)"/i);
  if (!m || !m[1]) throw new Error('reyestr text');
  let t = reyUnesc(m[1]).replace(/<\s*(br|\/p|\/div|\/tr|\/h\d)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ');
  t = reyUnesc(t).replace(/[ \t\u00a0]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  return t;
}
// Розбір резолютивної частини: суть, дата наступного засідання, строки, встановлені судом.
// Це підказки для адвоката: у застосунку вони позначені «перевірте за текстом».
const L = 'а-яіїєґ';
function docOperative(text) {
  const re = new RegExp(`(у\\s?х\\s?в\\s?а\\s?л\\s?и\\s?[влт][${L}]{0,2}|п\\s?о\\s?с\\s?т\\s?а\\s?н\\s?о\\s?в\\s?и\\s?[влт][${L}]{0,2}`
    + `|в\\s?и\\s?р\\s?і\\s?ш\\s?и\\s?[влт][${L}]{0,2}|з\\s?а\\s?с\\s?у\\s?д\\s?и\\s?[влт][${L}]{0,2})\\s*:`, 'gi');
  let last = null; let m;
  while ((m = re.exec(text))) last = m;
  return last ? text.slice(last.index + last[0].length).trim() : text.slice(-1500);
}
const docNorm = (s) => String(s).replace(/[’ʼ`]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
function docLabels(op) {
  const t = docNorm(op);
  const rules = [
    ['відмовити у відкритті', 'Відмовлено у відкритті провадження'],
    ['відкрити (апеляційне |касаційне |спрощене |загальне )?(позовне )?провадження', 'Відкрито провадження'],
    ['залишити без руху', 'Залишено без руху'],
    ['повернути (позовну заяву|заяву|апеляційну скаргу|касаційну скаргу|скаргу)', 'Повернуто заявнику'],
    ['закрити підготовче провадження', 'Підготовче закрито, справу призначено до розгляду по суті'],
    ['відкласти', 'Розгляд відкладено'],
    ['зупинити провадження', 'Провадження зупинено'],
    ['закрити провадження', 'Провадження закрито'],
    ['залишити без розгляду', 'Залишено без розгляду'],
    ['позов[^.]{0,120}задовольнити частково', 'Позов задоволено частково'],
    ['позов[^.]{0,120}задовольнити', 'Позов задоволено'],
    ['відмовити (у|в) задоволенні позов', 'У позові відмовлено'],
    ['скаргу[^.]{0,120}залишити без задоволення', 'Скаргу залишено без задоволення'],
    ['скаргу[^.]{0,120}задовольнити', 'Скаргу задоволено'],
    [`забезпеч[${L}]+ позов`, 'Вирішено питання забезпечення позову'],
    ['витребувати', 'Витребувано докази'],
    ['призначити[^.]{0,60}експертиз', 'Призначено експертизу'],
  ];
  let out = [];
  for (const [p, label] of rules) if (new RegExp(p).test(t) && !out.includes(label)) out.push(label);
  if (out.includes('Позов задоволено частково')) out = out.filter((x) => x !== 'Позов задоволено');
  return out.slice(0, 4);
}
const DOC_MONTHS = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
function docFindings(op) {
  const out = [];
  const dmy = `(\\d{1,2})[\\s.]+(${DOC_MONTHS.join('|')}|\\d{1,2})[\\s.]+(\\d{4})`;
  const reA = new RegExp(dmy + `\\s*(?:року|р\\.?)?[^.;]{0,50}?(?<![${L}])(?:о|об)\\s*(\\d{1,2})\\s*(?:[:.]|год\\.?|годині)\\s*(\\d{2})?`, 'i');
  const reB = new RegExp('(\\d{1,2})\\s*(?:[:.]|год\\.?|годину|годині)\\s*(\\d{2})?\\s*(?:хв\\.?|хвилин)?[^.;\\d]{0,40}?' + dmy, 'i');
  const reC = new RegExp(`(?<![${L}])на\\s+` + dmy, 'i');
  const mon = (x) => (/^\d+$/.test(x) ? +x : DOC_MONTHS.indexOf(String(x).toLowerCase()) + 1);
  const today = kyivToday().getTime();
  const short = (p) => { const t = p.trim(); return t.length > 320 ? t.slice(0, 320) + '…' : t; };
  const paras = op.split('\n');
  for (const p of paras) {
    const low = p.toLowerCase();
    if (!(low.includes('засідан') || low.includes('розгляд'))) continue;
    let d; let mo; let y; let hh = null; let mm = 0; let m;
    if ((m = p.match(reA))) { d = +m[1]; mo = mon(m[2]); y = +m[3]; hh = +m[4]; mm = m[5] ? +m[5] : 0; }
    else if ((m = p.match(reB))) { hh = +m[1]; mm = m[2] ? +m[2] : 0; d = +m[3]; mo = mon(m[4]); y = +m[5]; }
    else if (low.includes('призначити') && (m = p.match(reC))) { d = +m[1]; mo = mon(m[2]); y = +m[3]; }
    else continue;
    const dt = utcDate(d, mo, y);
    if (!dt || dt.getTime() < today || (hh !== null && (hh > 23 || mm > 59))) continue;
    const date = fmtDate(dt);
    const time = hh === null ? '' : String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
    if (!out.some((f) => f.kind === 'hearing' && f.date === date && f.time === time)) {
      out.push({ kind: 'hearing', title: 'Засідання ' + date + (time ? ' ' + time : ''), detail: short(p), date, time });
    }
  }
  const subjects = [[`відповід[${L}]* на відзив`, 'Відповідь на відзив'], ['відзив', 'Відзив на позов'], ['заперечен', 'Заперечення'],
    [`усунен[${L}]* недолік`, 'Усунення недоліків'], ['пояснен', 'Письмові пояснення'], ['доказ', 'Подання доказів']];
  const words = [["п'ятнадцят", 15], ['двадцят', 20], ['тридцят', 30], ['десят', 10], ["п'ят", 5], ['сем', 7], ['сім', 7], ['трьох', 3], ['двох', 2]];
  const unit = `[\\s-]*(?:\\(\\s*\\d{1,2}\\s*\\)\\s*)?(?:календарн[${L}]+\\s+|робоч[${L}]+\\s+)?(?:дн|денн|діб)`;
  for (const p of paras) {
    const low = docNorm(p);
    if (!(low.includes('строк') || low.includes('денн') || low.includes('днів'))) continue;
    const subj = subjects.find(([re]) => new RegExp(re).test(low));
    if (!subj) continue;
    let days = 0;
    const n = low.match(new RegExp(`(\\d{1,2})\\s*(?:\\([^)]{0,30}\\)\\s*)?(?:календарн[${L}]+\\s+|робоч[${L}]+\\s+)?(?:дн|денн|діб)`));
    if (n) days = +n[1];
    else for (const [w, v] of words) if (new RegExp(w + `[${L}']*` + unit).test(low)) { days = v; break; }
    if (days < 1 || days > 60) continue;
    if (!out.some((f) => f.kind === 'deadline' && f.title === subj[1])) out.push({ kind: 'deadline', title: subj[1], detail: short(p), days });
  }
  return out;
}
async function docAnalysis(env, id, wantText) {
  let a = await env.KV.get('doc_' + id, 'json');
  let text = '';
  if (!a || wantText) {
    text = await reyText(id);
    const op = docOperative(text);
    const applied = (a && a.applied) || [];
    const titles = (a && a.findings) ? a.findings.map((f) => f.kind + '|' + f.title) : [];
    const findings = docFindings(op);
    // позначки «внесено» переносимо за змістом підказки, а не за її місцем у списку
    const keep = findings.map((f, i) => (applied.some((j) => titles[j] === f.kind + '|' + f.title) ? i : -1)).filter((i) => i >= 0);
    a = { labels: docLabels(op), findings, excerpt: op.slice(0, 2500), applied: keep };
    await env.KV.put('doc_' + id, JSON.stringify(a), { expirationTtl: 180 * 24 * 3600 });
  }
  return wantText ? { ...a, text } : a;
}
async function docMarkApplied(env, id, idx) {
  const a = await env.KV.get('doc_' + id, 'json');
  if (!a || !Number.isInteger(idx) || idx < 0 || idx >= (a.findings || []).length) return;
  a.applied = [...new Set([...(a.applied || []), idx])];
  await env.KV.put('doc_' + id, JSON.stringify(a), { expirationTtl: 180 * 24 * 3600 });
}

async function handleApi(request, env, url) {
  const path = url.pathname.slice(5);
  const post = request.method === 'POST';
  if (!env.APP_PASSWORD || String(env.APP_PASSWORD).length < 10) {
    return APP_JSON({ error: 'Застосунок не налаштовано: додайте у воркер секрет APP_PASSWORD (не менше 10 символів).' }, 503);
  }
  const body = post ? await request.json().catch(() => ({})) : {};
  if (path === 'login' && post) {
    const fk = 'app_fail_' + (request.headers.get('CF-Connecting-IP') || 'x');
    const fails = parseInt((await env.KV.get(fk)) || '0', 10);
    if (fails >= 5) return APP_JSON({ error: 'Забагато спроб. Спробуйте за 15 хвилин.' }, 429);
    const [a, b] = await Promise.all([appSha('p|' + String(body.password || '')), appSha('p|' + env.APP_PASSWORD)]);
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    if (diff) {
      await env.KV.put(fk, String(fails + 1), { expirationTtl: 900 });
      return APP_JSON({ error: 'Невірний пароль.' }, 401);
    }
    const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    await env.KV.put('app_sess_' + (await appSha(token)), '1', { expirationTtl: 30 * 24 * 3600 });
    return APP_JSON({ token });
  }
  const tok = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const sessKey = tok ? 'app_sess_' + (await appSha(tok)) : '';
  if (!tok || !(await env.KV.get(sessKey))) return APP_JSON({ error: 'Потрібен вхід.' }, 401);

  if (path === 'logout' && post) { await env.KV.delete(sessKey); return APP_JSON({ ok: true }); }

  if (path === 'state') {
    const a = await visibleReport(env, 'advocate');
    const c = await visibleReport(env, 'clients');
    const manual = ((await env.KV.get('court_manual', 'json')) || []).filter((it) => { const d = daysUntil(it.date); return d === null || d >= 0; });
    return APP_JSON({ updated: a.updated || c.updated || '', advocate: a.visible, clients: c.visible, manual,
      tracked: await getCaseNums(env), names: await getNames(env), deadlines: await getDeadlines(env),
      newCases: (await getNewCases(env)).reverse(), calendar: !!env.GH_TOKEN });
  }
  if (path === 'newcase' && post) {
    if (body.dismiss) await env.KV.put('court_newcases', JSON.stringify((await getNewCases(env)).filter((x) => x.key !== body.dismiss)));
    return APP_JSON({ ok: true });
  }
  if (path === 'names' && post) {
    const arr = await getNames(env);
    if (body.add !== undefined) {
      const name = String(body.add).replace(/\s+/g, ' ').trim();
      if (name.length < 6 || name.split(' ').length < 2 || name.length > 80) {
        return APP_JSON({ error: "Вкажіть щонайменше прізвище та ім'я: одне слово дає забагато чужих справ." }, 400);
      }
      if (!arr.some((x) => x.toLowerCase() === name.toLowerCase())) { arr.push(name); await putNames(env, arr); }
    } else if (body.remove !== undefined) {
      await putNames(env, arr.filter((x) => x !== String(body.remove)));
    }
    return APP_JSON({ ok: true });
  }
  if (path === 'track' && post) {
    const nums = await getCaseNums(env);
    if (body.add !== undefined) {
      const n = normCaseNum(body.add);
      if (!n) return APP_JSON({ error: 'Це не схоже на номер справи: він має містити цифри та «/».' }, 400);
      if (!nums.some((x) => appCaseKey(x) === appCaseKey(n))) { nums.push(n); await putCaseNums(env, nums); }
    } else if (body.remove !== undefined) {
      const k = appCaseKey(body.remove);
      await putCaseNums(env, nums.filter((x) => appCaseKey(x) !== k));
    }
    return APP_JSON({ ok: true });
  }
  if (path === 'deadline' && post) {
    if (body.add) {
      const number = normCaseNum(body.add.number);
      const m = String(body.add.date || '').match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
      const title = String(body.add.title || '').trim().slice(0, 120);
      if (!number || !m || !utcDate(m[1], m[2], m[3]) || title.length < 2) return APP_JSON({ error: 'Перевірте номер справи, дату і назву строку.' }, 400);
      await saveDeadline(env, { number, date: m[0], title, note: String(body.add.note || '').slice(0, 200) }, null, null);
      if (body.doc) await docMarkApplied(env, String(body.doc).replace(/\D/g, ''), body.idx);
    } else if (body.remove) {
      await env.KV.put('court_deadlines', JSON.stringify((await getDeadlines(env)).filter((x) => x.key !== body.remove)));
    } else if (body.done) {
      const list = await getDeadlines(env);
      const x = list.find((it) => it.key === body.done);
      if (x) { x.done = !!body.value; await env.KV.put('court_deadlines', JSON.stringify(list)); }
    }
    return APP_JSON({ ok: true });
  }
  if (path === 'hearing' && post) {
    const number = normCaseNum(body.number);
    const m = String(body.date || '').match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    const time = /^\d{2}:\d{2}$/.test(body.time || '') ? body.time : '';
    if (!number || !m || !utcDate(m[1], m[2], m[3])) return APP_JSON({ error: 'Перевірте номер справи і дату.' }, 400);
    const cut = (s, n) => String(s || '').slice(0, n);
    const item = { court: cut(body.court, 160) || 'Суд не визначено', number, date: (m[0] + ' ' + time).trim(), judge: cut(body.judge, 120),
      involved: '', description: cut(body.note, 200), forma: cut(body.forma, 60), courtroom: cut(body.courtroom, 20), address: '',
      matched: 'справа № ' + number };
    const list = ((await env.KV.get('court_manual', 'json')) || []).filter((it) => { const d = daysUntil(it.date); return d === null || d >= 0; });
    if (!list.some((it) => appCaseKey(it.number) === appCaseKey(number) && it.date === item.date)) {
      list.push(item);
      await env.KV.put('court_manual', JSON.stringify(list.slice(-200)));
    }
    // справа стає на стеження, щоб бот і далі знаходив у ній засідання
    const nums = await getCaseNums(env);
    if (!nums.some((x) => appCaseKey(x) === appCaseKey(number))) { nums.push(number); await putCaseNums(env, nums); }
    await queueGcal(env, shortHash('man|' + itemKey(item)), item.court, { number, date: item.date, judge: item.judge, involved: '',
      description: item.description, forma: item.forma, courtroom: item.courtroom, add_address: '' }, null, null);
    if (body.doc) await docMarkApplied(env, String(body.doc).replace(/\D/g, ''), body.idx);
    return APP_JSON({ ok: true });
  }
  if (path === 'gcal' && post) {
    const it = body.item || {};
    if (!it.number || !it.date) return APP_JSON({ error: 'Немає даних засідання.' }, 400);
    await queueGcal(env, shortHash('app|' + itemKey(it)), it.court || '', { number: it.number, date: it.date, judge: it.judge || '',
      involved: it.involved || '', description: it.description || '', forma: it.forma || '', courtroom: it.courtroom || '',
      add_address: it.address || '' }, null, null);
    return APP_JSON({ ok: true });
  }
  if (path === 'scan' && post) {
    if (!env.GH_TOKEN) return APP_JSON({ error: 'Позачерговий прогін не налаштовано (немає GH_TOKEN). Планові прогони працюють.' }, 400);
    const last = parseInt((await env.KV.get('court_run_at')) || '0', 10);
    if (Date.now() - last < 90000) return APP_JSON({ ok: true });
    const st = await triggerScan(env);
    await env.KV.put('court_run_at', String(Date.now()));
    return st === 204 ? APP_JSON({ ok: true }) : APP_JSON({ error: 'GitHub не прийняв запуск прогону.' }, 502);
  }
  if (path === 'docs') {
    const number = url.searchParams.get('case') || '';
    const key = appCaseKey(number);
    if (!/\d/.test(key)) return APP_JSON({ error: 'Немає номера справи.' }, 400);
    const kvKey = 'docs_' + key.replace(/[^\d/a-zа-яіїєґ-]/gi, '_');
    let cached = await env.KV.get(kvKey, 'json');
    const fresh = cached && Date.now() - cached.checked < 6 * 3600 * 1000;
    if (!fresh || url.searchParams.get('force')) {
      try {
        const rows = (await reySearch(appCaseQuery(number))).filter((r) => appCaseKey(r.caseNo) === key);
        cached = { checked: Date.now(), rows };
        await env.KV.put(kvKey, JSON.stringify(cached), { expirationTtl: 90 * 24 * 3600 });
      } catch (e) {
        if (!cached) return APP_JSON({ error: 'Реєстр судових рішень не відповів серверу. Спробуйте пізніше.' }, 502);
      }
    }
    // розбираємо до трьох найновіших нерозібраних документів за один запит
    const rows = cached.rows.slice().reverse();
    let budget = 3;
    for (const r of rows) {
      let a = await env.KV.get('doc_' + r.id, 'json');
      if (!a && budget > 0) { budget--; try { a = await docAnalysis(env, r.id, false); } catch (e) { a = null; } }
      if (a) { r.labels = a.labels; r.findings = a.findings; r.applied = a.applied || []; }
    }
    return APP_JSON({ checked: cached.checked, rows });
  }
  if (path === 'doc') {
    const id = (url.searchParams.get('id') || '').replace(/\D/g, '');
    if (!id) return APP_JSON({ error: 'Немає номера документа.' }, 400);
    try {
      return APP_JSON(await docAnalysis(env, id, !!url.searchParams.get('text')));
    } catch (e) {
      return APP_JSON({ error: 'Текст документа не завантажився з реєстру.' }, 502);
    }
  }
  return APP_JSON({ error: 'Невідома адреса.' }, 404);
}

function appRoute(request, env, url) {
  if (url.pathname === '/app' || url.pathname === '/app/') return new Response(APP_HTML, { headers: APP_HEADERS });
  if (url.pathname === '/app/manifest.json') {
    return new Response(JSON.stringify({ name: 'Мої судові справи', short_name: 'Мої справи', start_url: '/app', scope: '/app',
      display: 'standalone', background_color: '#e9ecea', theme_color: '#1f5a4c', lang: 'uk',
      icons: [{ src: '/app/icon.png', sizes: '180x180', type: 'image/png' }] }),
      { headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=86400' } });
  }
  if (url.pathname === '/app/icon.png') {
    const bin = Uint8Array.from(atob(APP_ICON), (c) => c.charCodeAt(0));
    return new Response(bin, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' } });
  }
  if (url.pathname.startsWith('/api/')) {
    return handleApi(request, env, url).catch(() => APP_JSON({ error: 'Внутрішня помилка сервера.' }, 500));
  }
  return null;
}

// Сторінка застосунку (джерело: webapp/app.html, вбудовується скриптом tools/build_webapp.py).
/*APP_HTML_BEGIN*/const APP_HTML = "<!DOCTYPE html>\n<html lang=\"uk\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<meta name=\"apple-mobile-web-app-capable\" content=\"yes\">\n<meta name=\"mobile-web-app-capable\" content=\"yes\">\n<meta name=\"apple-mobile-web-app-title\" content=\"Мої справи\">\n<meta name=\"apple-mobile-web-app-status-bar-style\" content=\"default\">\n<meta name=\"theme-color\" content=\"#1f5a4c\">\n<meta name=\"robots\" content=\"noindex,nofollow\">\n<link rel=\"manifest\" href=\"/app/manifest.json\">\n<link rel=\"apple-touch-icon\" href=\"/app/icon.png\">\n<title>Мої судові справи</title>\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link href=\"https://fonts.googleapis.com/css2?family=Golos+Text:wght@400;500;600&family=JetBrains+Mono:wght@500&family=Unbounded:wght@500&display=swap\" rel=\"stylesheet\">\n<style>\n:root{\n  /* layout: one-column app, five tabs at the bottom, bottom sheets for input */\n  --bg:#e9ecea; --surface:#ffffff; --surface2:#f3f5f3; --ink:#16211d; --muted:#5b6964; --line:#d9dedb;\n  --accent:#1f5a4c; --accent-ink:#ffffff; --accent-soft:#deeee8;\n  --crit:#b3261e; --crit-soft:#fbe8e6; --warn:#855600; --warn-soft:#fbefd2; --ok:#1e6a39; --ok-soft:#e1f1e6;\n  --font-display:\"Unbounded\",\"Golos Text\",system-ui,sans-serif;\n  --font-body:\"Golos Text\",system-ui,-apple-system,\"Segoe UI\",sans-serif;\n  --font-mono:\"JetBrains Mono\",ui-monospace,Menlo,monospace;\n}\n@media (prefers-color-scheme: dark){\n  :root{\n    color-scheme:dark;\n    --bg:#0d1311; --surface:#161d1a; --surface2:#1c2521; --ink:#e6ece9; --muted:#97a59f; --line:#2a3530;\n    --accent:#62c4a8; --accent-ink:#0a1a15; --accent-soft:#17342c;\n    --crit:#ff8d83; --crit-soft:#3b1b18; --warn:#f0c463; --warn-soft:#382c10; --ok:#80d59b; --ok-soft:#15301e;\n  }\n}\n*{box-sizing:border-box}\nhtml,body{height:100%;margin:0}\nbody{background:var(--bg);color:var(--ink);font:400 15px/1.45 var(--font-body);-webkit-text-size-adjust:100%}\nbutton,input,select{font:inherit;color:inherit}\nbutton{cursor:pointer;background:none;border:0;padding:0;text-align:left}\na{color:var(--accent)}\n:focus-visible{outline:2px solid var(--accent);outline-offset:2px}\n.app{max-width:640px;height:100%;margin:0 auto;background:var(--surface2);display:flex;flex-direction:column;position:relative;overflow:hidden}\n.scr{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:calc(18px + env(safe-area-inset-top)) 16px 24px;display:flex;flex-direction:column;gap:12px}\n.top{display:flex;flex-direction:column;gap:2px}\n.eyebrow{margin:0;color:var(--muted);font-size:13px}\nh1{font:500 22px/1.2 var(--font-display);margin:0;text-wrap:balance;overflow-wrap:anywhere}\nh2{font:600 13px/1.2 var(--font-body);letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin:10px 0 0}\n.fresh{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;color:var(--muted);background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:8px 10px}\n.fresh i{flex:none;width:8px;height:8px;border-radius:50%;background:var(--ok);margin-top:5px}\n.fresh.bad i{background:var(--crit)}\n.fresh span{flex:1}\n.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}\n.tile{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:10px;display:flex;flex-direction:column;gap:2px}\n.tile b{font:500 22px/1 var(--font-display);font-variant-numeric:tabular-nums}\n.tile span{font-size:12px;color:var(--muted);line-height:1.25}\n.tile.hot b{color:var(--crit)}\n.alert{background:var(--crit-soft);color:var(--crit);border-radius:14px;padding:10px 12px;font-size:13.5px;border-left:4px solid var(--crit)}\n.alert b{display:block}\n.list{display:flex;flex-direction:column;gap:8px}\n.row{display:flex;gap:10px;align-items:center;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:10px 12px;width:100%}\n.row .main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}\n.row .main b{font-weight:600;overflow-wrap:anywhere}\n.row small{color:var(--muted);font-size:12.5px;overflow-wrap:anywhere}\n.row small.hl{color:var(--accent)}\n.row small.wr{color:var(--warn)}\n.date{flex:none;width:44px;text-align:center;background:var(--accent-soft);color:var(--accent);border-radius:10px;padding:6px 0;font-size:11.5px;line-height:1.1}\n.date b{display:block;font:500 17px/1.1 var(--font-display)}\n.num{font-family:var(--font-mono);font-size:13px;font-variant-numeric:tabular-nums}\n.chip{flex:none;font-size:12px;font-weight:600;border-radius:999px;padding:3px 9px;white-space:nowrap}\n.chip.crit{background:var(--crit-soft);color:var(--crit)}\n.chip.warn{background:var(--warn-soft);color:var(--warn)}\n.chip.ok{background:var(--ok-soft);color:var(--ok)}\n.chip.tag{background:var(--surface2);color:var(--muted);border:1px solid var(--line)}\n.chk{flex:none;width:22px;height:22px;border-radius:7px;border:2px solid var(--muted);display:grid;place-items:center;color:var(--accent-ink)}\n.chk.on{background:var(--accent);border-color:var(--accent)}\n.chk.on::after{content:\"\";width:10px;height:5px;border-left:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(-45deg) translateY(-1px)}\n.done b{text-decoration:line-through;color:var(--muted)}\n.filters{display:flex;gap:6px;overflow-x:auto;padding-bottom:2px}\n.filters button{flex:none;border:1px solid var(--line);background:var(--surface);border-radius:999px;padding:5px 12px;font-size:13px}\n.filters button.on{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}\n.field{width:100%;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:10px 12px;font-size:16px}\n.btn{background:var(--accent);color:var(--accent-ink);border-radius:12px;padding:10px 14px;font-weight:600;text-align:center;text-decoration:none;display:inline-block}\n.btn.ghost{background:var(--surface);color:var(--accent);border:1px solid var(--line)}\n.btn.danger{background:var(--surface);color:var(--crit);border:1px solid var(--line)}\n.btn.sm{padding:6px 10px;font-size:13px}\n.btn[disabled]{opacity:.5}\n.acts{display:flex;gap:8px;flex-wrap:wrap}\n.acts .btn{flex:1 1 auto}\n.back{color:var(--accent);font-weight:600;align-self:flex-start;padding:4px 0}\n.meta{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:4px 12px;margin:0}\n.meta div{display:flex;gap:10px;padding:7px 0;border-bottom:1px solid var(--line);font-size:13.5px}\n.meta div:last-child{border:0}\n.meta dt{flex:none;width:96px;color:var(--muted)}\n.meta dd{margin:0;overflow-wrap:anywhere}\n.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:12px;display:flex;flex-direction:column;gap:6px}\n.card p{margin:0;font-size:13px;color:var(--muted);overflow-wrap:anywhere}\n.text{font-size:13.5px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;margin:0;color:var(--ink)}\n.inline{display:flex;gap:8px}\n.inline .field{flex:1;min-width:0}\n.cal{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:10px}\n.calhead{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}\n.calhead b{font:500 15px var(--font-display)}\n.calhead button{width:34px;height:34px;border-radius:10px;border:1px solid var(--line);text-align:center}\n.grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;text-align:center}\n.grid span{font-size:11.5px;color:var(--muted);padding:4px 0}\n.grid button{aspect-ratio:1;border-radius:10px;text-align:center;font-variant-numeric:tabular-nums;position:relative;font-size:14px}\n.grid button.today{box-shadow:inset 0 0 0 1.5px var(--accent)}\n.grid button.sel{background:var(--accent);color:var(--accent-ink)}\n.grid button i{position:absolute;bottom:5px;left:50%;width:5px;height:5px;border-radius:50%;background:var(--accent);transform:translateX(-50%)}\n.grid button i.d{background:var(--crit)}\n.grid button i.both{box-shadow:7px 0 0 var(--crit);transform:translateX(-6px)}\n.grid button.sel i{background:var(--accent-ink)}\n.legend{display:flex;gap:14px;font-size:12px;color:var(--muted);margin-top:6px}\n.legend i{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--accent);margin-right:5px}\n.legend i.d{background:var(--crit)}\n.empty{color:var(--muted);font-size:13.5px;padding:6px 2px;margin:0}\n.err{color:var(--crit);font-size:13.5px;margin:0}\n.tabs{flex:none;display:flex;background:var(--surface);border-top:1px solid var(--line);padding-bottom:env(safe-area-inset-bottom)}\n.tabs button{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;padding:8px 0 10px;font-size:10.5px;color:var(--muted);position:relative}\n.tabs button.on{color:var(--accent);font-weight:600}\n.tabs svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}\n.tabs em{position:absolute;top:4px;left:calc(50% + 6px);background:var(--crit);color:#fff;border-radius:999px;font:600 10px/16px var(--font-body);min-width:16px;height:16px;padding:0 4px;text-align:center}\n.shade{position:absolute;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:flex-end;z-index:5}\n.sheet{background:var(--surface);width:100%;border-radius:22px 22px 0 0;padding:18px 16px calc(22px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:10px;max-height:90%;overflow-y:auto}\n.sheet h3{margin:0;font:500 16px var(--font-display)}\n.sheet label{font-size:12.5px;color:var(--muted);display:flex;flex-direction:column;gap:4px}\n.sheet p{margin:0;font-size:12.5px;color:var(--muted)}\n.login{flex:1;display:flex;flex-direction:column;justify-content:center;gap:14px;padding:24px}\n.login p{margin:0;color:var(--muted)}\n#toast{position:absolute;left:50%;bottom:calc(78px + env(safe-area-inset-bottom));transform:translateX(-50%);background:var(--ink);color:var(--surface);font-size:13px;border-radius:999px;padding:7px 14px;opacity:0;pointer-events:none;transition:opacity .2s;max-width:90%;text-align:center;z-index:9}\n#toast.show{opacity:1}\n.spin{width:16px;height:16px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:sp 1s linear infinite;flex:none}\n@keyframes sp{to{transform:rotate(360deg)}}\n@media (prefers-reduced-motion:reduce){#toast{transition:none}.spin{animation:none}}\n</style>\n</head>\n<body>\n<div class=\"app\"><div id=\"app\" style=\"display:contents\"></div><div id=\"toast\" role=\"status\"></div></div>\n<script>\nconst esc=s=>String(s==null?'':s).replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));\nconst T0=new Date();T0.setHours(0,0,0,0);\nconst we=d=>{const x=new Date(d);while(x.getDay()%6===0)x.setDate(x.getDate()+1);return x};\nconst plus=(d,n)=>we(new Date(d.getFullYear(),d.getMonth(),d.getDate()+n));\nconst left=d=>Math.round((d-T0)/864e5);\nconst MG=['січня','лютого','березня','квітня','травня','червня','липня','серпня','вересня','жовтня','листопада','грудня'];\nconst MN=['Січень','Лютий','Березень','Квітень','Травень','Червень','Липень','Серпень','Вересень','Жовтень','Листопад','Грудень'];\nconst MS=['січ','лют','бер','кві','тра','чер','лип','сер','вер','жов','лис','гру'];\nconst WD=['нд','пн','вт','ср','чт','пт','сб'];\nconst p2=n=>String(n).padStart(2,'0');\nconst fd=d=>`${p2(d.getDate())}.${p2(d.getMonth()+1)}.${d.getFullYear()}`;\nconst fh=d=>`${d.getDate()} ${MG[d.getMonth()]}, ${WD[d.getDay()]}`;\nconst iso=d=>`${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())}`;\nconst pd=v=>{const[y,m,d]=v.split('-').map(Number);return new Date(y,m-1,d)};\nconst TYPES={civ:'Цивільна',com:'Господарська',adm:'КУпАП',crim:'Кримінальна',admj:'Адміністративна',oth:'Інша'};\nconst TPL={\n civ:[['Відзив на позов',15,'ст. 178 ЦПК, не менше 15 днів з вручення ухвали'],['Апеляційна скарга на рішення',30,'ст. 354 ЦПК'],['Апеляційна скарга на ухвалу',15,'ст. 354 ЦПК'],['Касаційна скарга',30,'ст. 390 ЦПК']],\n com:[['Відзив на позов',15,'ст. 165 ГПК, не менше 15 днів з вручення ухвали'],['Апеляційна скарга на рішення',20,'ст. 256 ГПК'],['Апеляційна скарга на ухвалу',10,'ст. 256 ГПК'],['Касаційна скарга',20,'ст. 288 ГПК']],\n adm:[['Апеляційна скарга на постанову',10,'ст. 294 КУпАП']],\n crim:[['Апеляційна скарга на вирок',30,'ст. 395 КПК'],['Апеляційна скарга на ухвалу слідчого судді',5,'ст. 395 КПК']],\n admj:[['Відзив на позов',15,'ст. 162 КАС, строк встановлює суд'],['Апеляційна скарга на рішення',30,'ст. 295 КАС'],['Апеляційна скарга на ухвалу',15,'ст. 295 КАС'],['Касаційна скарга',30,'ст. 329 КАС']]\n};\nconst store={get(k){try{return localStorage.getItem(k)||''}catch(_){return ''}},set(k,v){try{v?localStorage.setItem(k,v):localStorage.removeItem(k)}catch(_){}}};\nconst S={token:store.get('cc_token'),ready:false,busy:false,err:'',updated:'',calendar:false,tab:'today',cid:null,doc:null,filter:'all',q:'',sheet:null,preset:null,\n calM:new Date(T0.getFullYear(),T0.getMonth(),1),calD:T0};\nlet C=[],W=[],TR=[],NC=[];const DOCS={},DOC={};\n\n// ── сервер ──\nasync function api(path,body){\n const r=await fetch('/api/'+path,{method:body?'POST':'GET',cache:'no-store',\n  headers:Object.assign({'Authorization':'Bearer '+S.token},body?{'Content-Type':'application/json'}:{}),body:body?JSON.stringify(body):undefined});\n const j=await r.json().catch(()=>({}));\n if(r.status===401&&path!=='login'){logout();throw new Error('Потрібен вхід.')}\n if(!r.ok)throw new Error(j.error||('Помилка сервера ('+r.status+')'));\n return j;\n}\nfunction logout(){S.token='';store.set('cc_token','');S.ready=false;render()}\nconst caseKey=n=>{const b=String(n||'').replace(/[‐-―−]/g,'-').toLowerCase().replace(/\\s+/g,'').replace(/^№+/,'').replace(/-[^\\d/]+$/,'');const m=b.match(/(\\d{2,4})\\/(\\d{1,7})\\/(\\d{2})(?!\\d)/);return m?`${m[1]}/${+m[2]}/${m[3]}`:b};\nconst typeOf=(f,num)=>{f=String(f||'').toLowerCase();if(/господар/.test(f))return 'com';if(/кримін/.test(f))return 'crim';if(/правопоруш|купап/.test(f))return 'adm';if(/адміністрат/.test(f))return 'admj';if(/цивіл/.test(f))return 'civ';\n const n=String(num||'').toLowerCase();if(/-ц$/.test(n))return 'civ';if(/-к$/.test(n))return 'crim';if(/-п$/.test(n))return 'adm';if(/-а$/.test(n))return 'admj';if(/^9\\d\\d\\//.test(n))return 'com';return 'oth'};\nfunction build(o){\n const map=new Map();\n const get=num=>{const k=caseKey(num);if(!map.has(k))map.set(k,{key:k,num:String(num),type:'oth',subj:'',parties:'',client:'',role:'',court:'',judge:'',ev:[],dl:[],tracked:false});return map.get(k)};\n const add=(it,src)=>{if(!it||!it.number)return;const c=get(it.number);\n  c.court=c.court||it.court||'';c.judge=c.judge||it.judge||'';c.parties=c.parties||it.involved||'';c.subj=c.subj||it.description||'';\n  if(c.type==='oth')c.type=typeOf(it.forma,it.number);\n  const m=String(it.matched||'');if(m&&!m.startsWith('справа №'))c.client=m;\n  if(src==='adv')c.role='ваша справа';\n  const d=/(\\d{2})\\.(\\d{2})\\.(\\d{4})(?:\\D+(\\d{1,2}):(\\d{2}))?/.exec(it.date||'');\n  if(d){const dt=new Date(+d[3],+d[2]-1,+d[1]),tm=d[4]?p2(+d[4])+':'+d[5]:'';\n   const sure=src!=='cli'||m.startsWith('справа №');\n   const ex=c.ev.find(e=>+e.d===+dt&&e.tm===tm);\n   if(ex){ex.sure=ex.sure||sure}else c.ev.push({d:dt,tm,rm:it.courtroom?'зал/каб. '+it.courtroom:'',court:it.court||'',src,sure,raw:it})}};\n (o.advocate||[]).forEach(it=>add(it,'adv'));(o.clients||[]).forEach(it=>add(it,'cli'));(o.manual||[]).forEach(it=>add(it,'man'));\n (o.tracked||[]).forEach(n=>{get(n).tracked=true});\n (o.deadlines||[]).forEach(x=>{const d=/(\\d{2})\\.(\\d{2})\\.(\\d{4})/.exec(x.date||'');if(!d||!x.number)return;get(x.number).dl.push({key:x.key,t:x.title||'Строк',due:new Date(+d[3],+d[2]-1,+d[1]),b:x.note||'',done:!!x.done})});\n const list=[...map.values()];\n list.forEach(c=>{c.ev.sort((a,b)=>a.d-b.d||a.tm.localeCompare(b.tm));if(c.type==='oth')c.type=typeOf('',c.num);\n  if(!c.client)c.client=c.parties?c.parties.slice(0,70):'Справа № '+c.num;if(!c.court)c.court='Суд не визначено';if(!c.judge)c.judge='не визначено'});\n list.sort((a,b)=>((a.ev[0]||{}).d||9e15)-((b.ev[0]||{}).d||9e15));\n C=list;W=o.names||[];TR=o.tracked||[];NC=o.newCases||[];S.updated=o.updated||'';S.calendar=!!o.calendar;\n}\nasync function load(quiet){\n if(!quiet){S.busy=true;render()}\n try{build(await api('state'));S.err='';S.ready=true}catch(e){S.err=e.message}\n S.busy=false;render();\n}\nasync function act(path,body,okMsg){\n try{await api(path,body);if(okMsg)toast(okMsg);await load(true);return true}catch(e){toast(e.message);return false}\n}\nasync function loadDocs(c,force){\n const k=c.key,cur=DOCS[k]||{};\n if(cur.loading||(cur.rows&&!force))return;\n DOCS[k]={loading:true,rows:cur.rows};render();\n try{const j=await api('docs?case='+encodeURIComponent(c.num)+(force?'&force=1':''));DOCS[k]={rows:j.rows||[],checked:j.checked}}\n catch(e){DOCS[k]={err:e.message,rows:cur.rows||[]}}\n render();\n}\nasync function loadDoc(id,text){\n const cur=DOC[id]||{};if(cur.loading)return;\n DOC[id]=Object.assign({},cur,{loading:true});render();\n try{const j=await api('doc?id='+encodeURIComponent(id)+(text?'&text=1':''));DOC[id]=Object.assign({},cur,j,{loading:false,err:''})}\n catch(e){DOC[id]=Object.assign({},cur,{loading:false,err:e.message})}\n render();\n}\n\n// ── похідні списки ──\nconst byKey=k=>C.find(c=>c.key===k);\nconst hearings=()=>C.flatMap(c=>c.ev.filter(e=>left(e.d)>=0).map(e=>({c,e}))).sort((a,b)=>a.e.d-b.e.d||a.e.tm.localeCompare(b.e.tm));\nconst dls=()=>C.flatMap(c=>c.dl.filter(d=>!d.done).map(d=>({c,d}))).sort((a,b)=>a.d.due-b.d.due);\nconst mins=t=>{const[h,m]=String(t||'0:0').split(':');return h*60+ +m};\nfunction conflicts(hs){const r=[];for(let i=0;i<hs.length;i++)for(let j=i+1;j<hs.length;j++){const a=hs[i],b=hs[j];if(a.e.tm&&b.e.tm&&+a.e.d===+b.e.d&&a.e.court!==b.e.court&&a.c.key!==b.c.key&&Math.abs(mins(a.e.tm)-mins(b.e.tm))<120)r.push([a,b])}return r}\nfunction chip(n){const c=n<=2?'crit':n<=7?'warn':'ok';const t=n<0?`прострочено ${-n} дн.`:n===0?'сьогодні':n===1?'завтра':`${n} дн.`;return `<span class=\"chip ${c}\">${t}</span>`}\nconst dateBox=d=>`<span class=\"date\"><b>${d.getDate()}</b>${MS[d.getMonth()]}</span>`;\nconst hRow=({c,e},link=true)=>`<${link?'button data-a=\"open\" data-v=\"'+esc(c.key)+'\"':'div'} class=\"row\">${dateBox(e.d)}<span class=\"main\"><b>${e.tm?e.tm+' · ':''}${esc(c.client)}</b><small><span class=\"num\">${esc(c.num)}</span></small><small>${esc(e.court||c.court)}${e.rm?', '+esc(e.rm):''}</small>${e.sure?'':'<small class=\"wr\">Збіг лише за ПІБ – перевірте</small>'}</span>${chip(left(e.d))}</${link?'button':'div'}>`;\nconst dRow=({c,d},showCase=true)=>`<div class=\"row${d.done?' done':''}\"><button class=\"chk${d.done?' on':''}\" data-a=\"dldone\" data-v=\"${esc(d.key)}\" aria-label=\"Позначити строк виконаним\"></button><button class=\"main\" data-a=\"open\" data-v=\"${esc(c.key)}\"><b>${esc(d.t)}</b><small>до ${fd(d.due)}${d.b?' · '+esc(d.b):''}</small>${showCase?`<small><span class=\"num\">${esc(c.num)}</span> · ${esc(c.client)}</small>`:''}</button>${d.done?'':chip(left(d.due))}</div>`;\nconst cRow=c=>{const h=c.ev.find(e=>left(e.d)>=0);return `<button class=\"row\" data-a=\"open\" data-v=\"${esc(c.key)}\"><span class=\"main\"><b>${esc(c.client)}${c.role?` <span class=\"chip tag\">${esc(c.role)}</span>`:''}</b><small><span class=\"num\">${esc(c.num)}</span> · ${TYPES[c.type]}</small>${c.subj?`<small>${esc(c.subj)}</small>`:''}<small class=\"${h?'hl':''}\">${h?`Засідання ${fd(h.d)}${h.tm?' о '+h.tm:''}`:'Засідання не призначено'}</small></span></button>`};\nconst fresh=()=>`<div class=\"fresh${S.err?' bad':''}\"><i></i><span>${S.err?esc(S.err):`Бот оновив перелік ${S.updated?esc(S.updated):'(час невідомий)'}. Дату й час засідання звіряйте з ЄСІТС.`}</span><button class=\"btn ghost sm\" data-a=\"reload\"${S.busy?' disabled':''}>Оновити</button></div>`;\n\n// ── екрани ──\nfunction vLogin(){\n return `<div class=\"login\"><h1>Мої судові справи</h1><p>Введіть пароль застосунку. Він зберігається у воркері бота, а на цьому пристрої лишається тільки ключ сеансу.</p>\n <form data-f=\"login\" class=\"list\"><input class=\"field\" id=\"pw\" type=\"password\" autocomplete=\"current-password\" placeholder=\"Пароль\" aria-label=\"Пароль\" required><button class=\"btn\"${S.busy?' disabled':''}>Увійти</button></form>\n ${S.err?`<p class=\"err\">${esc(S.err)}</p>`:''}</div>`;\n}\nfunction vToday(){\n const hs=hearings(),ds=dls(),hot=ds.filter(x=>left(x.d.due)<=7),cf=conflicts(hs);\n return `<header class=\"top\"><p class=\"eyebrow\">${fh(T0)}</p><h1>Сьогодні</h1></header>${fresh()}\n <div class=\"tiles\"><div class=\"tile\"><b>${hs.filter(h=>left(h.e.d)<=7).length}</b><span>засідань за 7 днів</span></div><div class=\"tile${hot.length?' hot':''}\"><b>${hot.length}</b><span>строків за 7 днів</span></div><div class=\"tile${NC.length?' hot':''}\"><b>${NC.length}</b><span>нових справ</span></div></div>\n ${cf.map(([a,b])=>`<div class=\"alert\"><b>Накладка засідань ${fd(a.e.d)}</b>${a.e.tm} ${esc(a.e.court||a.c.court)} та ${b.e.tm} ${esc(b.e.court||b.c.court)}. Подайте клопотання про відкладення або участь у режимі відеоконференції.</div>`).join('')}\n ${NC.length?`<h2>Нові справи</h2><div class=\"list\">${NC.map(n=>`<div class=\"card\"><b><span class=\"num\">${esc(n.number)}</span></b><p>${esc(n.court)}${n.judge?' · '+esc(n.judge):''}</p>${n.involved?`<p>${esc(n.involved)}</p>`:''}${n.description?`<p>${esc(n.description)}</p>`:''}<p>Бот знайшов ${esc(n.found)}${n.date?'. Найближче засідання '+esc(n.date):''}</p>${n.reliable?'':'<p style=\"color:var(--warn)\">Збіг лише за ПІБ – перевірте, чи це ваш клієнт.</p>'}<div class=\"acts\">${byKey(caseKey(n.number))?`<button class=\"btn ghost sm\" data-a=\"open\" data-v=\"${esc(caseKey(n.number))}\">Відкрити справу</button>`:''}<button class=\"btn ghost sm\" data-a=\"ncdone\" data-v=\"${esc(n.key)}\">Переглянуто</button></div></div>`).join('')}</div>`:''}\n <h2>Найближчі засідання</h2><div class=\"list\">${hs.slice(0,6).map(x=>hRow(x)).join('')||'<p class=\"empty\">Засідань не знайдено.</p>'}</div>\n <h2>Строки на цьому тижні</h2><div class=\"list\">${hot.map(x=>dRow(x)).join('')||'<p class=\"empty\">Найближчі 7 днів без строків.</p>'}</div>`;\n}\nfunction caseList(){\n const q=S.q.trim().toLowerCase();\n const r=C.filter(c=>(S.filter==='all'||c.type===S.filter)&&(!q||[c.num,c.client,c.parties,c.subj,c.court].join(' ').toLowerCase().includes(q)));\n return r.map(cRow).join('')||`<p class=\"empty\">${C.length?'Нічого не знайдено. Перевірте номер або прізвище.':'Справ поки немає. Додайте клієнтів чи номери справ у «Моніторингу».'}</p>`;\n}\nfunction vCases(){\n return `<header class=\"top\"><p class=\"eyebrow\">${C.length} у роботі</p><h1>Справи</h1></header>\n <input class=\"field\" id=\"q\" type=\"search\" placeholder=\"Номер, клієнт, сторона або суд\" value=\"${esc(S.q)}\" aria-label=\"Пошук у справах\">\n <div class=\"filters\">${[['all','Усі'],['civ','Цивільні'],['com','Господарські'],['crim','Кримінальні'],['adm','КУпАП'],['admj','Адміністративні']].map(([k,t])=>`<button class=\"${S.filter===k?'on':''}\" data-a=\"filter\" data-v=\"${k}\">${t}</button>`).join('')}</div>\n <div class=\"list\" id=\"caselist\">${caseList()}</div>\n <button class=\"btn\" data-a=\"sheet\" data-v=\"case\">Стежити за справою за номером</button>`;\n}\nfunction docRow(c,d){\n const pend=(d.findings||[]).filter((f,i)=>!(d.applied||[]).includes(i));\n return `<button class=\"row\" data-a=\"doc\" data-v=\"${esc(d.id)}\"><span class=\"main\"><b>${esc(d.form)} від ${esc(d.date)}</b>${(d.labels||[]).length?`<small class=\"hl\">${esc(d.labels.join(' · '))}</small>`:''}<small>${esc(d.court)}${d.judge?' · '+esc(d.judge):''}</small>${pend.length?`<small class=\"wr\">Є дані для внесення: ${esc(pend.map(f=>f.title).join(', '))}</small>`:''}</span></button>`;\n}\nfunction vCase(c){\n const up=c.ev.filter(e=>left(e.d)>=0),D=DOCS[c.key]||{};\n return `<button class=\"back\" data-a=\"back\">‹ Назад</button>\n <header class=\"top\"><p class=\"eyebrow\"><span class=\"num\">№ ${esc(c.num)}</span> · ${TYPES[c.type]}</p><h1>${esc(c.client)}</h1>${c.subj?`<p class=\"eyebrow\">${esc(c.subj)}</p>`:''}</header>\n <dl class=\"meta\"><div><dt>Суд</dt><dd>${esc(c.court)}</dd></div><div><dt>Суддя</dt><dd>${esc(c.judge)}</dd></div>${c.parties?`<div><dt>Сторони</dt><dd>${esc(c.parties)}</dd></div>`:''}</dl>\n <div class=\"acts\"><button class=\"btn ghost sm\" data-a=\"copy\" data-v=\"${esc(c.key)}\">Скопіювати реквізити</button><button class=\"btn ghost sm\" data-a=\"sheet\" data-v=\"hear\">Додати засідання</button></div>\n <h2>Засідання</h2><div class=\"list\">${up.map(e=>hRow({c,e},false)+(e.src==='cli'&&!e.sure?`<button class=\"btn ghost sm\" data-a=\"gcal\" data-v=\"${c.ev.indexOf(e)}\">Це мій клієнт – додати в календар</button>`:'')).join('')||'<p class=\"empty\">Не призначено. Щойно дата з\\'явиться на сайті суду, бот її знайде.</p>'}</div>\n <h2>Документи суду${D.rows?` (${D.rows.length})`:''}</h2><div class=\"list\">${(D.rows||[]).map(d=>docRow(c,d)).join('')}\n ${D.loading?'<div class=\"row\"><span class=\"spin\"></span><span class=\"main\"><small>Шукаю в реєстрі судових рішень</small></span></div>':''}\n ${D.err?`<p class=\"err\">${esc(D.err)}</p><a class=\"btn ghost sm\" href=\"https://reyestr.court.gov.ua/\" target=\"_blank\" rel=\"noopener\">Відкрити пошук у реєстрі</a>`:''}\n ${D.rows&&!D.rows.length&&!D.loading&&!D.err?'<p class=\"empty\">У реєстрі рішень у цій справі поки нічого немає.</p>':''}\n ${D.loading?'':'<button class=\"btn ghost sm\" data-a=\"docs\">Оновити з реєстру</button>'}</div>\n <h2>Процесуальні строки</h2><div class=\"list\">${c.dl.map(d=>dRow({c,d},false)+`<button class=\"btn danger sm\" data-a=\"dldel\" data-v=\"${esc(d.key)}\">Видалити строк «${esc(d.t)}»</button>`).join('')||'<p class=\"empty\">Строків немає.</p>'}</div>\n <button class=\"btn ghost sm\" data-a=\"sheet\" data-v=\"dl\">Розрахувати новий строк</button>\n <h2>Стеження</h2>${c.tracked?`<button class=\"btn danger sm\" data-a=\"untrack\" data-v=\"${esc(c.num)}\">Припинити стеження за номером</button>`:`<button class=\"btn ghost sm\" data-a=\"track\" data-v=\"${esc(c.num)}\">Стежити за цією справою за номером</button>`}\n <p class=\"empty\">Засідання у справах під наглядом за номером бот додає в календар сам.</p>`;\n}\nfunction vDoc(c,id){\n const row=((DOCS[c.key]||{}).rows||[]).find(d=>d.id===id)||{id},X=DOC[id]||{},labels=X.labels||row.labels||[],fnd=X.findings||row.findings||[],applied=X.applied||row.applied||[];\n const url='https://reyestr.court.gov.ua/Review/'+encodeURIComponent(id);\n return `<button class=\"back\" data-a=\"docback\">‹ ${esc(c.num)}</button>\n <header class=\"top\"><p class=\"eyebrow\">Документ суду</p><h1>${esc(row.form||'Документ')}${row.date?' від '+esc(row.date):''}</h1></header>\n <dl class=\"meta\"><div><dt>Справа</dt><dd class=\"num\">${esc(row.caseNo||c.num)}</dd></div>${row.court?`<div><dt>Суд</dt><dd>${esc(row.court)}</dd></div>`:''}${row.judge?`<div><dt>Суддя</dt><dd>${esc(row.judge)}</dd></div>`:''}${row.inForce?`<div><dt>Набрання сили</dt><dd>${esc(row.inForce)}</dd></div>`:''}\n <div><dt>Реєстр</dt><dd><a href=\"${url}\" target=\"_blank\" rel=\"noopener\">${url}</a></dd></div></dl>\n ${labels.length?`<h2>Суть</h2><div class=\"list\">${labels.map(l=>`<div class=\"row\"><span class=\"main\"><b>${esc(l)}</b></span></div>`).join('')}</div>`:''}\n ${fnd.length?`<h2>Знайдено в документі</h2><div class=\"list\">${fnd.map((f,i)=>`<div class=\"card\"><b>${esc(f.kind==='deadline'?f.title+': '+f.days+' дн.':f.title)}</b><p>${esc(f.detail)}</p>${applied.includes(i)?'<span class=\"chip ok\" style=\"align-self:flex-start\">внесено</span>':`<button class=\"btn ghost sm\" data-a=\"apply\" data-v=\"${i}\">${f.kind==='hearing'?'Додати засідання в справу й календар':'Розрахувати й додати строк'}</button>`}</div>`).join('')}</div><p class=\"empty\">Розпізнано автоматично з резолютивної частини. Перевірте за текстом, перш ніж вносити.</p>`:''}\n <h2>Резолютивна частина</h2>${X.loading&&!X.excerpt?'<div class=\"row\"><span class=\"spin\"></span><span class=\"main\"><small>Завантажую текст із реєстру</small></span></div>':X.excerpt?`<div class=\"card\"><p class=\"text\">${esc(X.excerpt)}</p></div>`:X.err?`<p class=\"err\">${esc(X.err)} Відкрийте документ у реєстрі за посиланням вище.</p>`:'<p class=\"empty\">Не вдалося виділити резолютивну частину.</p>'}\n <h2>Повний текст</h2>${X.text?`<div class=\"card\"><p class=\"text\">${esc(X.text)}</p></div>`:X.loading?'<p class=\"empty\">Завантажую.</p>':'<button class=\"btn ghost sm\" data-a=\"doctext\">Показати повний текст</button>'}`;\n}\nfunction vCal(){\n const y=S.calM.getFullYear(),m=S.calM.getMonth(),off=(new Date(y,m,1).getDay()+6)%7,n=new Date(y,m+1,0).getDate();\n const hs=hearings(),ds=dls();let cells='';\n for(let i=0;i<off;i++)cells+='<span></span>';\n for(let i=1;i<=n;i++){const d=new Date(y,m,i),hh=hs.some(x=>+x.e.d===+d),dd=ds.some(x=>+x.d.due===+d);\n  cells+=`<button class=\"${+d===+T0?'today ':''}${+d===+S.calD?'sel':''}\" data-a=\"calday\" data-v=\"${+d}\" aria-label=\"${fh(d)}\">${i}${hh||dd?`<i class=\"${hh&&dd?'both':dd?'d':''}\"></i>`:''}</button>`}\n const sh=hs.filter(x=>+x.e.d===+S.calD),sd=ds.filter(x=>+x.d.due===+S.calD);\n return `<header class=\"top\"><p class=\"eyebrow\">Засідання та строки</p><h1>Календар</h1></header>\n <div class=\"cal\"><div class=\"calhead\"><button data-a=\"calnav\" data-v=\"-1\" aria-label=\"Попередній місяць\">‹</button><b>${MN[m]} ${y}</b><button data-a=\"calnav\" data-v=\"1\" aria-label=\"Наступний місяць\">›</button></div>\n <div class=\"grid\">${['пн','вт','ср','чт','пт','сб','нд'].map(w=>`<span>${w}</span>`).join('')}${cells}</div>\n <div class=\"legend\"><span><i></i>засідання</span><span><i class=\"d\"></i>строк</span></div></div>\n <h2>${fh(S.calD)}</h2><div class=\"list\">${sh.map(x=>hRow(x)).join('')}${sd.map(x=>dRow(x)).join('')||(sh.length?'':'<p class=\"empty\">На цей день нічого не заплановано.</p>')}</div>`;\n}\nfunction vDl(){\n const ds=dls(),done=C.flatMap(c=>c.dl.filter(d=>d.done).map(d=>({c,d})));\n return `<header class=\"top\"><p class=\"eyebrow\">${ds.length} активних</p><h1>Строки</h1></header>\n <div class=\"list\">${ds.map(x=>dRow(x)).join('')||'<p class=\"empty\">Активних строків немає. Строк додається з картки справи або з документа суду.</p>'}</div>\n ${done.length?`<h2>Виконано</h2><div class=\"list\">${done.map(x=>dRow(x)).join('')}</div>`:''}\n <p class=\"empty\">Рахуються календарні дні. Якщо останній день випав на суботу чи неділю, строк перенесено на понеділок. Святкові дні не враховано.</p>`;\n}\nfunction vMon(){\n return `<header class=\"top\"><p class=\"eyebrow\">Кого й що шукає бот</p><h1>Моніторинг</h1></header>\n <h2>Клієнти (${W.length})</h2><div class=\"list\">${W.map(w=>`<div class=\"row\"><span class=\"main\"><b>${esc(w)}</b></span><button class=\"btn danger sm\" data-a=\"unname\" data-v=\"${esc(w)}\">Прибрати</button></div>`).join('')||'<p class=\"empty\">Список порожній.</p>'}</div>\n <form class=\"inline\" data-f=\"name\"><input class=\"field\" id=\"newname\" placeholder=\"Прізвище Ім'я По батькові\" aria-label=\"ПІБ клієнта\" required><button class=\"btn sm\">Додати</button></form>\n <h2>Справи за номером (${TR.length})</h2><div class=\"list\">${TR.map(n=>`<div class=\"row\"><span class=\"main\"><b class=\"num\">${esc(n)}</b></span><button class=\"btn danger sm\" data-a=\"untrack\" data-v=\"${esc(n)}\">Прибрати</button></div>`).join('')||'<p class=\"empty\">Список порожній.</p>'}</div>\n <form class=\"inline\" data-f=\"track\"><input class=\"field num\" id=\"newnum\" placeholder=\"757/12345/26-ц\" aria-label=\"Номер справи\" required><button class=\"btn sm\">Стежити</button></form>\n <h2>Перевірка судів</h2><p class=\"empty\">Бот перевіряє суди за розкладом кілька разів на добу. Позачерговий прогін триває кілька хвилин, після нього натисніть «Оновити» на екрані «Сьогодні».</p>\n <div class=\"acts\"><button class=\"btn ghost sm\" data-a=\"scan\">Запустити прогін зараз</button><button class=\"btn danger sm\" data-a=\"logout\">Вийти</button></div>`;\n}\nfunction sheet(){\n if(!S.sheet)return '';const c=byKey(S.cid);let b='';\n if(S.sheet==='case')b=`<h3>Стежити за справою</h3><form data-f=\"track\" style=\"display:contents\"><label>Номер справи<input class=\"field num\" id=\"newnum\" placeholder=\"757/12345/26-ц\" required></label><p>Бот шукатиме засідання в цій справі в усіх судах незалежно від ПІБ у сторонах і додаватиме їх у календар.</p><button class=\"btn\">Стежити</button></form>`;\n if(S.sheet==='dl'&&c){const list=(S.preset?[[S.preset.title,S.preset.days,S.preset.basis]]:[]).concat(TPL[c.type]||TPL.civ);\n  b=`<h3>Новий строк</h3><form data-f=\"dl\" style=\"display:contents\"><label>Що подаємо<select class=\"field\" id=\"dltpl\">${list.map((t,i)=>`<option value=\"${i}\">${esc(t[0])} · ${t[1]} днів</option>`).join('')}</select></label><label>Від якої дати рахуємо<input class=\"field\" id=\"dlfrom\" type=\"date\" value=\"${iso(T0)}\" required></label><p>Останній день, що припав на суботу чи неділю, переноситься на понеділок. Шаблони звірте з чинною редакцією кодексу. Строк потрапить у Google Календар з нагадуваннями за 3 дні та напередодні.</p><button class=\"btn\">Розрахувати й додати</button></form>`}\n if(S.sheet==='hear'&&c)b=`<h3>Нове засідання</h3><form data-f=\"hear\" style=\"display:contents\"><label>Дата<input class=\"field\" id=\"hdate\" type=\"date\" value=\"${iso(we(new Date(T0.getFullYear(),T0.getMonth(),T0.getDate()+7)))}\" required></label><label>Час<input class=\"field\" id=\"htime\" type=\"time\" value=\"10:00\" required></label><label>Зал<input class=\"field\" id=\"hroom\" placeholder=\"5\"></label><p>Засідання з'явиться в справі й потрапить у Google Календар.</p><button class=\"btn\">Додати</button></form>`;\n return `<div class=\"shade\" data-a=\"close\"><div class=\"sheet\" role=\"dialog\" aria-modal=\"true\">${b}<button class=\"btn ghost\" data-a=\"close\" type=\"button\">Скасувати</button></div></div>`;\n}\nconst ICON={today:'<circle cx=\"12\" cy=\"12\" r=\"4\"/><path d=\"M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4\"/>',cases:'<path d=\"M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z\"/>',cal:'<rect x=\"3\" y=\"5\" width=\"18\" height=\"16\" rx=\"2\"/><path d=\"M3 10h18M8 3v4M16 3v4\"/>',dl:'<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M12 7v5l3 2\"/>',mon:'<path d=\"M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/>'};\nlet lastKey='';\nfunction render(){\n const app=document.getElementById('app');\n if(!S.token||(!S.ready&&S.err&&!S.busy&&!S.token)){app.innerHTML=vLogin();return}\n if(!S.ready){app.innerHTML=S.token&&!S.err?'<div class=\"login\"><div class=\"row\"><span class=\"spin\"></span><span class=\"main\"><small>Завантажую справи</small></span></div></div>':`<div class=\"login\"><p class=\"err\">${esc(S.err)}</p><button class=\"btn\" data-a=\"reload\">Спробувати ще раз</button><button class=\"btn ghost\" data-a=\"logout\">Вийти</button></div>`;return}\n const old=app.querySelector('.scr'),key=S.tab+'|'+S.cid+'|'+S.doc,top=old&&key===lastKey?old.scrollTop:0;lastKey=key;\n const c=byKey(S.cid);\n const v=c?(S.doc?vDoc(c,S.doc):vCase(c)):({today:vToday,cases:vCases,cal:vCal,dl:vDl,mon:vMon})[S.tab]();\n const badge={dl:dls().filter(x=>left(x.d.due)<=2).length};\n app.innerHTML=`<main class=\"scr\">${v}</main><nav class=\"tabs\">${[['today','Сьогодні'],['cases','Справи'],['cal','Календар'],['dl','Строки'],['mon','Моніторинг']].map(([k,t])=>`<button class=\"${(S.tab===k&&!c)||(c&&k==='cases')?'on':''}\" data-a=\"tab\" data-v=\"${k}\"><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\">${ICON[k]}</svg>${t}${badge[k]?`<em>${badge[k]}</em>`:''}</button>`).join('')}</nav>${sheet()}`;\n app.querySelector('.scr').scrollTop=top;\n}\nlet tt;function toast(m){const t=document.getElementById('toast');t.textContent=m;t.classList.add('show');clearTimeout(tt);tt=setTimeout(()=>t.classList.remove('show'),2600)}\n\n// ── дії ──\ndocument.addEventListener('click',async e=>{\n const b=e.target.closest('[data-a]');if(!b)return;const a=b.dataset.a,v=b.dataset.v,c=byKey(S.cid);\n if(a==='close'){if(e.target!==b)return;S.sheet=null;S.preset=null}\n else if(a==='tab'){S.tab=v;S.cid=null;S.doc=null}\n else if(a==='open'){S.cid=v;S.doc=null;const x=byKey(v);if(x)loadDocs(x,false);return}\n else if(a==='back'){S.cid=null;S.doc=null}\n else if(a==='docback')S.doc=null;\n else if(a==='doc'){S.doc=v;render();loadDoc(v,false);return}\n else if(a==='doctext'){loadDoc(S.doc,true);return}\n else if(a==='docs'){if(c)loadDocs(c,true);return}\n else if(a==='filter')S.filter=v;\n else if(a==='sheet')S.sheet=v;\n else if(a==='calnav')S.calM=new Date(S.calM.getFullYear(),S.calM.getMonth()+ +v,1);\n else if(a==='calday')S.calD=new Date(+v);\n else if(a==='reload'){load(false);return}\n else if(a==='logout'){api('logout',{}).catch(()=>{});logout();return}\n else if(a==='scan'){try{await api('scan',{});toast('Прогін запущено. Результат буде за кілька хвилин.')}catch(err){toast(err.message)}return}\n else if(a==='track'){await act('track',{add:v},'Справу поставлено на стеження');return}\n else if(a==='untrack'){await act('track',{remove:v},'Стеження припинено');return}\n else if(a==='ncdone'){await act('newcase',{dismiss:v});return}\n else if(a==='unname'){await act('names',{remove:v},'Клієнта прибрано');return}\n else if(a==='dldone'){const d=C.flatMap(x=>x.dl).find(x=>x.key===v);if(d)await act('deadline',{done:v,value:!d.done});return}\n else if(a==='dldel'){await act('deadline',{remove:v},'Строк видалено. Подію в календарі приберіть вручну.');return}\n else if(a==='gcal'){const ev=c&&c.ev[+v];if(ev){try{await api('gcal',{item:ev.raw});toast('Засідання поставлено в чергу календаря')}catch(err){toast(err.message)}}return}\n else if(a==='apply'){\n  const row=((DOCS[c.key]||{}).rows||[]).find(d=>d.id===S.doc)||{},X=DOC[S.doc]||{},f=(X.findings||row.findings||[])[+v];if(!f)return;\n  if(f.kind==='deadline'){S.preset={title:f.title,days:f.days,basis:`${(row.form||'документ').toLowerCase()} від ${row.date||''}`,doc:S.doc,idx:+v};S.sheet='dl'}\n  else{const ok=await act('hearing',{number:c.num,date:f.date,time:f.time||'',court:row.court||c.court,judge:row.judge||'',forma:row.kind||'',note:`За документом суду: ${(row.form||'').toLowerCase()} від ${row.date||''}`,doc:S.doc,idx:+v},'Засідання додано');if(ok)loadDoc(S.doc,false);return}\n }\n else if(a==='copy'){const x=byKey(v),txt=`Справа № ${x.num}\\n${x.court}\\nСуддя: ${x.judge}`;\n  try{navigator.clipboard.writeText(txt).then(()=>toast('Реквізити скопійовано'),()=>toast('Не вдалося скопіювати'))}catch(_){toast('Не вдалося скопіювати')}return}\n render();\n});\ndocument.addEventListener('input',e=>{if(e.target.id==='q'){S.q=e.target.value;document.getElementById('caselist').innerHTML=caseList()}});\ndocument.addEventListener('submit',async e=>{\n e.preventDefault();const f=e.target.dataset.f,c=byKey(S.cid),val=id=>{const el=document.getElementById(id);return el?el.value.trim():''};\n if(f==='login'){S.busy=true;S.err='';const pw=val('pw');render();\n  try{const j=await api('login',{password:pw});S.token=j.token;store.set('cc_token',j.token);S.busy=false;await load(false)}catch(err){S.busy=false;S.err=err.message;S.token='';render()}return}\n if(f==='name'){await act('names',{add:val('newname')},'Клієнта додано');return}\n if(f==='track'){const ok=await act('track',{add:val('newnum')},'Справу поставлено на стеження');if(ok){S.sheet=null;render()}return}\n if(f==='dl'&&c){const list=(S.preset?[[S.preset.title,S.preset.days,S.preset.basis]]:[]).concat(TPL[c.type]||TPL.civ),t=list[+val('dltpl')]||list[0],from=pd(val('dlfrom')),due=plus(from,t[1]);\n  const p=S.preset&&+val('dltpl')===0?S.preset:null;\n  const ok=await act('deadline',{add:{number:c.num,date:fd(due),title:t[0],note:`${t[1]} дн. від ${fd(from)}, ${t[2]}`},doc:p?p.doc:undefined,idx:p?p.idx:undefined},'Строк до '+fd(due));\n  if(ok){S.sheet=null;S.preset=null;render();if(p)loadDoc(p.doc,false)}return}\n if(f==='hear'&&c){const d=pd(val('hdate'));const ok=await act('hearing',{number:c.num,date:fd(d),time:val('htime'),court:c.court,judge:c.judge==='не визначено'?'':c.judge,courtroom:val('hroom'),note:'Додано вручну'},'Засідання додано');if(ok){S.sheet=null;render()}return}\n});\nif(S.token)load(false);else render();\n</script>\n</body>\n</html>\n";/*APP_HTML_END*/
const APP_ICON = 'iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAIAAACyr5FlAAALPElEQVR42u2dbWwcxRnH55nZu927s01IGojThAQTMA44JMWQlyaQkKaBJqqAkpeGN9E2iBRCy1uUViD1hUptJVSpKVRqQaIqUiXUL1X7haoqrfhQqYWa0CZg13GSKhAgcbDPd3u7dzsz/bAoRYnP3jt717vr/+9DvvjOuZ35eZ6Z55mboUW7tjIAxoKjCQDkAJADQA4AOQDkAJADQA4AOQDkAJADAMgBIAeAHAByAMgBIAeAHAByAMgBIAcAkANADgA5AOQAkANADgA5AOQAkCPFbUEkOBoEcpyHIYTtukW7LLggIjQI5GCMMcEFY+z9j4au6bh8c8/qoeJw1asZQqBlxKzuK2bswxORIcRweTRrGI9vu/uZPY/s3PD5xfPmHzzSf+L0qYJpcc611pBjJsYRt1YtlssbV1z37MP777hhY9bIKKW6O5bctnaD7Tq9A/1OrZozTQ05ZlIc4Vrrj0qjC+Ze/MOvPfTdex9on/0pKSVx4sSlkq25wuae1au7ugdPvtt34rjBRTaTUTNvCJlZcvhxZLRic853b7ntuYf3X9d5ldZaMy24IEaMMU5ca62UWjSvfef6TfNmz+kd6Ptw+KOcaRHRjIoyM0gOQ4hqrTZSLq288urnH3vyzo03501LKsk5P2d5QkScc6WUEGLFks4vrds4VBz+50CflMrKZjXkSFkcIcbOjBYvmjX7O/fc/6Pde+fPmSuVJEa8fmLDN0Yq2ZovbFm5tqez6+3/Hh08+W5GGBnDmAlRJuVynI0jUum7N235xSPfXte9ghNXSgXMZ/hRRmvd0b5g1003F6zcm0f6T48MFyyLGGmmIUdS44jneWdGi6uXLjvw0BO7v3BrSy4vleJEDaW5iIiIpFKGEKu6uresXFu0S2/85x2tlZXNpngISaccnHNOdGa0OKuldd+Oe36y59FF89qllP5kounkOmPMk3JO2wVbV627cuHiw8ePHnv/vZxpipSmQ9ImBzEyhCg7jlN1t6/f9Nw39t9y/RrOuVRKiCnIi3POldZK665LLt2xfpNlmq/3HR61yznTJJa2GJMqOQQXUsnh0uiyjiUH9j6x99YdF7a2eVL6A8kUzmM4kVTKymbXXr38lpWffW/o9KFjg4wxM13pkJTIwYlzTiPlctYw9u2498DefUvmL1RKacZCKrRyIq210mruBRfevnZD58JF/+g/fHLotJXNpibKpEEOQwjbdWzXveX6Nc8/9uTWVeuEH0fOS2BM+VKIE1daa8a6Llm87YbPSaV6B/pKFTtvWRpyTHsc0VoPFUc6Fy7+8f0Pf+vL981pm+WvR3hUZfeza5mClbtpxXUblvecOPXBoWODgvOkJ92TKscnC6qPbrvrpw8+vqzj8lDjSLAoo+fPmbv9xk2Xzvv0mwP9J05/mOjSbiLlGKOgmslEEEeCTFSVVpqx7ksvu23t+qSXdhMmR92C6iQSGOFEmTSUdhMjxwQF1Zht7EtHaTcZcgQvqMbK5qSXduMuR3MF1VgpwhJb2o2vHJMvqMYtyiSutBtTOaaqoBor1xNX2o2dHGEUVGP1vSmWnNJujOQIu6Aaqz+ARJR24yJHNAXVeK1lYl/anX45oi+oxirKxLm0O81yTFdBNWZDSExLu9MmRxwKqjFcy8SqtDsNcsStoBq/KBOX0m7UcsSzoBq3iWpMSrvRyRH/gmr8osw0l3ajkCNZBVWUdv/fcYt2bQ3bDLdaLTmVNUuX/eArX7/2ii7GWNWr+UemgCAopTjngvP3hk5979e/fPmvfxJctORyYfsRrhxEVPO8BXMvevSOO7ffuAndPCX8ve/Q0y+90DvQF/b8PUQ5fDMWz2t/fNvdHe0LShVba4XpxaSGEK211i25/Khd/tnvXn7tX71mJhve+BHuyKEZywhRcV2nWk1pHjxyNJNaGVy05vOelOEuLUOupbGa52UzGTObRbdOpSFa1zwv7Lm8wcJfqvj7XD5ZSUHvNieEVOqcPWbJluMcUWy3UqlW0dPN5Q/b8oUo86RGlJsYbMdZv7xnVVe3vzZDfwcfM4joxKkPfvPqK1kjE5kfRpSFA9t11l/T88DW29HfTfDvowO/+uMfQl2eTH9Y8aT0pMQRwcHxa0/D5VLE2WSDRZ4S9rWAHA39UQnOoy9ZI/ADyAEgB0jwnENp5U9I0fQNTUjPyYClUA6tdd7MGUJgNtpo+osxNqvQEvFOQSPKimLetP5y8HWn6iIJ1lwSLJvJROlH6Jt9zlmSVVwH6XOkz+uGlZZcHj09+cJbOiekStb/kvGEGUDNlFaNpt0YTdzwDe3aJcYoQFj8ZDk6sudNsBzjYLvuhA1BjFmmSRP39tm21WXH1gEEsgLvOCHGPKVc15nwlRlhjDNLCON5UygHETlV9+n79ly1uEMqLcba8OFPykpO5ZvPPlO0y4YQ40dfIvKkbMsXnn/sqRYr5799rFWiFpwOHRt86sWfW1lzwojOicqOc+0VXU/d9VWldL29KVIqIfhvX/vzi6/8flah5ZxwEMbzplkOT6mezq7ll3WO/0pPyoxhBGwmrXXGMDZc0zPhyjlnmp5SQfb7E5GnvNmtbauXLpvwA/QO9I+5Xyuk501tWCHGyk5FKuVXIOv9JRXtckMtpbUu2uULCi31Rw4lOC87FWrkHBFPSqnUOAtyv+zs1qr16qghPW9q5xycPi48jtNYTVQm/XpmPTn8F3DiTZRJibF6cmitJ/yCZ0jPi9oKgBwAcgDIASAHgBwAcgDIAQDkAJADQA4AOQDkAJADQA4AOQDkAJADAMgBIAeAHAByAMgBIAeAHAByAMgBIAcAkANADgA5AOQAkANADgA5AOQADFdqsBCObz7LmD89+29zv7aJn07y107L86ZTDkMIIqp3Zqh/Ml/GaPgDZwyDiOod7NfchXP+LxT13+V/zvEPKQzpeVN5DikV7fJIuVT3WGCtWVPnkJ4ZLXpS+m8//wX+f1e0y8GPkCaimueNlEtaaap3grFSgvNK1al/Dmkoz5vgKzXGP6S8xcobQmimx+wnzRgxprUerdjB24uIWnN5IvLfPub/6x86W3LsgH74ByMXrFy9j3r2FFGnWnWq7ph+hPS8aR45grRCQyHAHzkCHjrb0MgxVBwJcAk31YssIT1vsuUgIl7vJGEhKFh/N3EH1kTjFmMN/togswF/Tlnvp40+r478eo2ob6R2a9VqreYPmVgrssbO6RZ509SplMMfjS9rX7Bg7sXjRGtQZ2ijol16a3Agyrs1jAjF50N2eedNmx/84jb0dhP0Dryzef/ejJFPoRz+4FGt1ZRS/o0T6G8W+F5ZwbntujNgQso51xpXhzYUVDjnnAi1FcBQeAOQAzBUZRu5OVcqRYSlbAMTUsam4YLZqG+kNjNZ/9I1dHlDWQDGWMHK6bTK4derjpw88bfDb/nXrqLXA48cH19+a3AeZREu0qqsn+eoSQ/93dz4YWWyKUmfj3GJvGZW1syRiZ5uDqX0+VM1rZROlhwBL5EHk8fMZA3OdSLkCHiJPJiSgYRz+v5LL7zR/3bBstRUT0eM8OaeQS6RB5NndmubpzwiYomQI8gl8mAqRg7FOfekDGn/gxHq7Hr8S+TBpPdWMs55eM2LZAOAHABygGTMOZRWSinMOUKdkLIwN2ob4X0PpWDlsd0r3GGfc8ZYSBmwsGorfp7jM0uuFMhzsNB3pR8+PnhmdMQQhk5EnsP/FsKrB1+f3i+JzxBypmVwI4ymNsIrwLblC+i5KGYeTR0hMc0TUn//EsBSFkAOADkAgBwAcgDIASAHgBwAcgDIASAHgBwAcgDIAQDkAJADQA4AOQDkAJADQA6QAv4HVAC/jBpgd+sAAAAASUVORK5CYII=';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Вебзастосунок «Мої судові справи»: сторінка /app і адреси /api/*.
    {
      const appRes = appRoute(request, env, url);
      if (appRes) return appRes;
    }
    // Список ПІБ для бота відстеження судових справ (за спільним секретом).
    if (request.method === 'GET' && url.pathname === '/court_names') {
      if ((request.headers.get('X-Auth-Token') || '') !== env.AUTH_TOKEN) {
        return new Response('forbidden', { status: 403 });
      }
      const arr = (await env.KV.get('court_names', 'json')) || [];
      const cases = (await env.KV.get('court_cases', 'json')) || [];
      return Response.json({ names: arr, cases });
    }
    // Завдання AI-агента для воркфлоу agent.yml: віддаємо один раз і видаляємо.
    if (request.method === 'GET' && url.pathname === '/agent_job') {
      if ((request.headers.get('X-Auth-Token') || '') !== env.AUTH_TOKEN) {
        return new Response('forbidden', { status: 403 });
      }
      const id = (url.searchParams.get('id') || '').replace(/[^a-f0-9]/g, '');
      const job = id ? await env.KV.get('agent_job_' + id, 'json') : null;
      if (!job) return new Response('not found', { status: 404 });
      await env.KV.delete('agent_job_' + id);
      return Response.json(job);
    }
    // Видалені (назавжди) справи — щоб бот не надсилав по них нагадувань.
    if (request.method === 'GET' && url.pathname === '/court_blocked') {
      if ((request.headers.get('X-Auth-Token') || '') !== env.AUTH_TOKEN) {
        return new Response('forbidden', { status: 403 });
      }
      return Response.json({
        clients: (await env.KV.get('court_deleted_clients', 'json')) || [],
        advocate: (await env.KV.get('court_deleted_advocate', 'json')) || [],
      });
    }
    // Звіт «справи адвоката/клієнтів» від бота (зберігається приватно для меню).
    // Режим злиття (шардинг): якщо передано scanned[] — оновлюємо лише справи
    // просканованих цього разу судів, решту зберігаємо (повне покриття за кілька
    // прогонів). Без scanned — повна заміна (легасі).
    if (request.method === 'POST' && url.pathname === '/court_report') {
      if ((request.headers.get('X-Auth-Token') || '') !== env.AUTH_TOKEN) {
        return new Response('forbidden', { status: 403 });
      }
      let o; try { o = await request.json(); } catch { return new Response('bad', { status: 400 }); }
      const kind = (o.kind === 'clients') ? 'clients' : 'advocate';
      let items = Array.isArray(o.items) ? o.items : [];
      if (Array.isArray(o.scanned) && o.scanned.length) {
        const prev = (await env.KV.get('court_report_' + kind, 'json')) || { items: [] };
        const scanned = new Set(o.scanned);
        const kept = (prev.items || []).filter((it) => !scanned.has(it.court));
        items = kept.concat(items);
        // прибрати минулі засідання, щоб сховище не роздувалось
        items = items.filter((it) => { const d = daysUntil(it.date); return d === null || d >= 0; });
      }
      await env.KV.put('court_report_' + kind, JSON.stringify({
        kind, updated: o.updated || '', count: items.length, items: items.slice(0, 500),
      }));
      return Response.json({ ok: true, count: items.length });
    }
    // Нова справа від бота – для списку «Нові справи» у вебзастосунку.
    if (request.method === 'POST' && url.pathname === '/court_newcase') {
      if ((request.headers.get('X-Auth-Token') || '') !== env.AUTH_TOKEN) {
        return new Response('forbidden', { status: 403 });
      }
      let o; try { o = await request.json(); } catch { return new Response('bad', { status: 400 }); }
      if (!o.number) return new Response('bad', { status: 400 });
      const key = shortHash('nc|' + appCaseKey(o.number) + '|' + (o.court || ''));
      const list = (await getNewCases(env)).filter((x) => x.key !== key);
      list.push({ key, number: String(o.number), court: String(o.court || ''), found: String(o.found || ''),
        reliable: !!o.reliable, date: String(o.date || ''), judge: String(o.judge || ''),
        involved: String(o.involved || '').slice(0, 400), description: String(o.description || '').slice(0, 300) });
      await env.KV.put('court_newcases', JSON.stringify(list.slice(-100)));
      return Response.json({ ok: true });
    }
    // Накопичені справи (для розсилки нагадувань ботом під час шардингу).
    if (request.method === 'GET' && url.pathname === '/court_cases') {
      if ((request.headers.get('X-Auth-Token') || '') !== env.AUTH_TOKEN) {
        return new Response('forbidden', { status: 403 });
      }
      const kind = (url.searchParams.get('kind') === 'clients') ? 'clients' : 'advocate';
      const rep = (await env.KV.get('court_report_' + kind, 'json')) || { items: [] };
      return Response.json({ items: rep.items || [] });
    }
    // ── Календар: черга клієнтських справ, що чекають підтвердження ──
    // Python відкладає клієнтську справу (stash); адвокат тисне «Додати» →
    // ключ потрапляє в gcal_approved; наступний прогін забирає підтверджені
    // (/gcal_approved), додає у Google Calendar і підтверджує (/gcal_ack).
    if (request.method === 'POST' && url.pathname === '/gcal_stash') {
      if ((request.headers.get('X-Auth-Token') || '') !== env.AUTH_TOKEN) {
        return new Response('forbidden', { status: 403 });
      }
      let o; try { o = await request.json(); } catch { return new Response('bad', { status: 400 }); }
      if (!o.key) return new Response('bad', { status: 400 });
      // чекає натискання кнопки; тримаємо до 60 днів, потім само зникне
      await env.KV.put('gcal_pending_' + o.key, JSON.stringify(o), { expirationTtl: 60 * 24 * 3600 });
      return Response.json({ ok: true });
    }
    if (request.method === 'GET' && url.pathname === '/gcal_approved') {
      if ((request.headers.get('X-Auth-Token') || '') !== env.AUTH_TOKEN) {
        return new Response('forbidden', { status: 403 });
      }
      const keys = (await env.KV.get('gcal_approved', 'json')) || [];
      const items = [];
      for (const k of keys) {
        const it = await env.KV.get('gcal_pending_' + k, 'json');
        if (it) items.push(it);
      }
      return Response.json({ items });
    }
    if (request.method === 'POST' && url.pathname === '/gcal_ack') {
      if ((request.headers.get('X-Auth-Token') || '') !== env.AUTH_TOKEN) {
        return new Response('forbidden', { status: 403 });
      }
      let o; try { o = await request.json(); } catch { return new Response('bad', { status: 400 }); }
      if (o.key) {
        await env.KV.delete('gcal_pending_' + o.key);
        const keys = (await env.KV.get('gcal_approved', 'json')) || [];
        await env.KV.put('gcal_approved', JSON.stringify(keys.filter((k) => k !== o.key)));
      }
      return Response.json({ ok: true });
    }
    if (request.method === 'POST') {
      // вебхук Telegram (за бажанням — з перевіркою secret_token)
      if (env.WEBHOOK_SECRET &&
          request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
        return new Response('forbidden: webhook secret mismatch (path=' + url.pathname + ')', { status: 403 });
      }
      let update;
      try { update = await request.json(); } catch { return new Response('bad', { status: 400 }); }
      ctx.waitUntil(handleUpdate(update, env));
      return new Response('ok');
    }
    return new Response('Osadko Telegram bot worker is running.');
  },
};
