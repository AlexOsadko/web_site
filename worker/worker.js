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

// Хто запустив прогін (розклад, застосунок, Telegram): потрібно для журналу прогонів.
async function noteRunSrc(env, src) {
  await env.KV.put('court_run_src', JSON.stringify({ ts: Date.now(), src }));
}

// Плановий прогін за розкладом Cloudflare (Cron Trigger «17 * * * *»).
// GitHub свої розклади відкладає або пропускає, тому прогін щогодини запускає
// воркер: тим самим запитом, що й кнопка «Запустити прогін». Години рахуються
// за київським часом, тож перехід на літній час нічого не зсуває.
const CRON_FROM_HOUR = 7;   // перший прогін о 07:17 за Києвом
const CRON_TO_HOUR = 20;    // останній о 20:17
async function cronScan(env) {
  if (!env.GH_TOKEN) return 'no-token';
  const hour = parseInt(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Kyiv', hour: '2-digit', hourCycle: 'h23' }).format(new Date()), 10);
  if (!(hour >= CRON_FROM_HOUR && hour <= CRON_TO_HOUR)) return 'night';
  // Не дублюємо: щойно запущений вручну або щойно завершений прогін.
  const now = Date.now();
  const last = parseInt((await env.KV.get('court_run_at')) || '0', 10);
  const stats = (await env.KV.get('court_stats', 'json')) || {};
  const done = (Number(stats.ts) || 0) * 1000;
  if (now - last < 25 * 60000 || now - done < 25 * 60000) return 'recent';
  let code = 0;
  try { code = await triggerScan(env); } catch (e) { code = 0; }
  if (code === 204) {
    await env.KV.put('court_run_at', String(now));
    await noteRunSrc(env, 'cron');
    return 'started';
  }
  // GitHub не прийняв запуск: попереджаємо адвоката, але не частіше ніж раз на 12 год.
  const warned = parseInt((await env.KV.get('court_cron_warn')) || '0', 10);
  if (env.REVIEW_CHAT && now - warned > 12 * 3600000) {
    await env.KV.put('court_cron_warn', String(now));
    await tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT,
      text: `⚠️ Плановий прогін судів не запустився (код GitHub: ${code || 'немає відповіді'}). ` +
        'Перевірте секрет GH_TOKEN у воркері: можливо, сплив його строк дії.' });
  }
  return 'failed:' + code;
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
    await noteRunSrc(env, 'tg');
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
// Групи судів для обходу: режим always (щоразу) | rotate (по черзі) | off (не перевіряти).
const COURT_GROUP_IDS = ['kyiv', 'gen_n', 'gen_w', 'gen_s', 'gen_e', 'gen_c', 'app', 'adm', 'gos', 'other'];
async function getCourtGroups(env) {
  const o = (await env.KV.get('court_groups', 'json')) || {};
  const out = {};
  for (const id of COURT_GROUP_IDS) if (['always', 'rotate', 'off'].includes(o[id])) out[id] = o[id];
  return out;
}
// «Суди ваших справ»: де є майбутні засідання (звіти без прихованих + додані вручну).
async function ownCourts(env) {
  const a = await visibleReport(env, 'advocate');
  const c = await visibleReport(env, 'clients');
  const manual = (await env.KV.get('court_manual', 'json')) || [];
  const set = new Set();
  for (const it of [...a.visible, ...c.visible, ...manual]) {
    const d = daysUntil(it.date);
    if (it.court && it.court !== 'Суд не визначено' && (d === null || d >= 0)) set.add(it.court);
  }
  return [...set].slice(0, 80);
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
// Що саме суд задовольнив чи відхилив: позов, скаргу, заяву або клопотання (і про що вони).
// Дивимось на додаток до дієслова в тому самому реченні, а не на слово «позов» десь поруч:
// «Заяву ... у справі за позовом ... задовольнити» – це заява, а не позов.
const DOC_V = 2; // версія правил розбору: збережені підписи перераховуються з уривка без запиту до реєстру
const DOC_TOPICS = [
  ['відеоконференц', 'про участь у ВКЗ'],
  ['забезпечення позову', 'про забезпечення позову'],
  ['забезпечення доказів', 'про забезпечення доказів'],
  [`поновленн[${L}] [^.]{0,40}строк`, 'про поновлення строку'],
  [`продовженн[${L}] [^.]{0,40}строк`, 'про продовження строку'],
  ['відвід', 'про відвід'],
  ['витребуванн', 'про витребування доказів'],
  ['експертиз', 'про призначення експертизи'],
  ['розстроч', 'про розстрочення'],
  ['відстроч', 'про відстрочення'],
  ['зупиненн', 'про зупинення провадження'],
  ["об'єднанн", "про об'єднання справ"],
  ['перегляд заочного', 'про перегляд заочного рішення'],
  ['скасування судового наказу', 'про скасування судового наказу'],
  ['відкладенн', 'про відкладення розгляду'],
  ['залученн', 'про залучення до участі у справі'],
  ['ознайомленн', 'про ознайомлення з матеріалами'],
  ['судового збору', 'щодо судового збору'],
  ['описк', 'про виправлення описки'],
];
function docSentences(op) {
  const t = String(op).replace(/[’ʼ`]/g, "'").replace(/\s+/g, ' ').trim();
  // межа речення – крапка або «;» після повного слова; після ініціалів і скорочень (м., вул., ст.) не ріжемо
  return t.split(new RegExp(`(?<=[А-ЯІЇЄҐ${L}_\\d»")]{4}[.;])\\s+(?=[А-ЯІЇЄҐ«"\\d])`)).map((x) => x.toLowerCase());
}
function docObject(seg, genitive) {
  const b = `(?<![${L}'])`; const e = `(?![${L}'])`;
  const forms = genitive
    ? [['claim', `${b}позову${e}|позовн(?:ої заяви|их вимог)`], ['appl', `${b}заяви${e}`], ['motion', `${b}клопотання${e}`], ['compl', `${b}скарги${e}`]]
    : [['claim', `${b}позов${e}|позовн(?:у заяву|і вимоги)`], ['appl', `${b}заяву${e}`], ['motion', `${b}клопотання${e}`], ['compl', `${b}скаргу${e}`]];
  let best = null;
  for (const [kind, re] of forms) {
    const m = new RegExp(re).exec(seg);
    if (m && (!best || m.index < best.at)) best = { kind, at: m.index };
  }
  return best;
}
function docTopic(seg) {
  let best = null;
  for (const [re, phrase] of DOC_TOPICS) {
    const m = new RegExp(re).exec(seg);
    if (m && (!best || m.index < best.at)) best = { phrase, at: m.index };
  }
  return best ? best.phrase : '';
}
function docOutcomes(op) {
  const out = [];
  for (const s of docSentences(op)) {
    let obj = null; let res = ''; let scope = '';
    let m = /(?<![а-яіїєґ'])[ув] задоволенні /.exec(s);
    if (m) {
      const tail = s.slice(m.index + m[0].length);
      obj = docObject(tail, true); res = 'no';
      if (obj) scope = tail.slice(obj.at);
    } else if ((m = /без задоволення|(?<!не )задовольнити|(?<!не )задоволити/.exec(s))) {
      res = m[0] === 'без задоволення' ? 'no' : (/частково/.test(s.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30)) ? 'part' : 'yes');
      const head = s.slice(0, m.index);
      obj = docObject(head, false);
      if (obj) scope = head.slice(obj.at);
      else {
        const tail = s.slice(m.index + m[0].length);
        obj = docObject(tail, false);
        if (obj) scope = tail.slice(obj.at);
      }
    }
    if (!obj) continue;
    let label;
    if (obj.kind === 'claim') label = { yes: 'Позов задоволено', part: 'Позов задоволено частково', no: 'У позові відмовлено' }[res];
    else if (obj.kind === 'compl') label = { yes: 'Скаргу задоволено', part: 'Скаргу задоволено частково', no: 'Скаргу залишено без задоволення' }[res];
    else {
      const topic = docTopic(scope);
      const acc = (obj.kind === 'appl' ? 'Заяву' : 'Клопотання') + (topic ? ' ' + topic : '');
      const gen = (obj.kind === 'appl' ? 'заяви' : 'клопотання') + (topic ? ' ' + topic : '');
      label = { yes: acc + ' задоволено', part: acc + ' задоволено частково', no: 'У задоволенні ' + gen + ' відмовлено' }[res];
    }
    if (!out.includes(label)) out.push(label);
  }
  return out;
}
function docLabels(op) {
  const t = docNorm(op);
  const before = [
    ['відмовити у відкритті', 'Відмовлено у відкритті провадження'],
    ['відкрити (апеляційне |касаційне |спрощене |загальне )?(позовне )?провадження', 'Відкрито провадження'],
    ['залишити без руху', 'Залишено без руху'],
    ['повернути (позовну заяву|заяву|апеляційну скаргу|касаційну скаргу|скаргу)', 'Повернуто заявнику'],
    ['закрити підготовче провадження', 'Підготовче закрито, справу призначено до розгляду по суті'],
    ['відкласти', 'Розгляд відкладено'],
    ['зупинити провадження', 'Провадження зупинено'],
    ['закрити провадження', 'Провадження закрито'],
    ['залишити без розгляду', 'Залишено без розгляду'],
  ];
  const after = [
    [`забезпеч[${L}]+ позов`, 'Вирішено питання забезпечення позову'],
    ['витребувати', 'Витребувано докази'],
    ['призначити[^.]{0,60}експертиз', 'Призначено експертизу'],
  ];
  const hit = (rules) => rules.filter(([p]) => new RegExp(p).test(t)).map(([, label]) => label);
  const outcomes = docOutcomes(op);
  let tail = hit(after);
  if (outcomes.some((x) => x.includes('забезпечення позову'))) tail = tail.filter((x) => x !== 'Вирішено питання забезпечення позову');
  if (outcomes.some((x) => x.includes('витребування доказів'))) tail = tail.filter((x) => x !== 'Витребувано докази');
  if (outcomes.some((x) => x.includes('експертизи'))) tail = tail.filter((x) => x !== 'Призначено експертизу');
  return [...new Set([...hit(before), ...outcomes, ...tail])].slice(0, 4);
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
// Збережений розбір, зроблений за старими правилами, перераховуємо зі збереженого уривка резолютивної частини.
async function docCached(env, id) {
  const a = await env.KV.get('doc_' + id, 'json');
  if (a && a.v !== DOC_V && a.excerpt) {
    a.labels = docLabels(a.excerpt); a.v = DOC_V;
    await env.KV.put('doc_' + id, JSON.stringify(a), { expirationTtl: 180 * 24 * 3600 });
  }
  return a;
}
async function docAnalysis(env, id, wantText) {
  let a = await docCached(env, id);
  let text = '';
  if (!a || wantText) {
    text = await reyText(id);
    const op = docOperative(text);
    const applied = (a && a.applied) || [];
    const titles = (a && a.findings) ? a.findings.map((f) => f.kind + '|' + f.title) : [];
    const findings = docFindings(op);
    // позначки «внесено» переносимо за змістом підказки, а не за її місцем у списку
    const keep = findings.map((f, i) => (applied.some((j) => titles[j] === f.kind + '|' + f.title) ? i : -1)).filter((i) => i >= 0);
    a = { v: DOC_V, labels: docLabels(op), findings, excerpt: op.slice(0, 2500), applied: keep };
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
    const scan = (await env.KV.get('court_stats', 'json')) || null;
    const lastAll = (await env.KV.get('court_last', 'json')) || {};
    const lastScan = {};
    const want = new Set([...a.visible, ...c.visible, ...manual].map((it) => it.court));
    for (const n of Object.values((scan && scan.tracked_courts) || {})) if (n) want.add(n);
    for (const n of want) if (n && lastAll[n]) lastScan[n] = lastAll[n];
    return APP_JSON({ updated: a.updated || c.updated || '', advocate: a.visible, clients: c.visible, manual,
      tracked: await getCaseNums(env), names: await getNames(env), deadlines: await getDeadlines(env),
      newCases: (await getNewCases(env)).reverse(), calendar: !!env.GH_TOKEN,
      scan, lastScan, groups: await getCourtGroups(env),
      log: ((await env.KV.get('court_log', 'json')) || []).slice(-150) });
  }
  if (path === 'groups' && post) {
    const id = String(body.id || ''), mode = String(body.mode || '');
    if (!COURT_GROUP_IDS.includes(id) || !['always', 'rotate', 'off'].includes(mode)) {
      return APP_JSON({ error: 'Невідома група або режим.' }, 400);
    }
    const g = await getCourtGroups(env);
    g[id] = mode;
    await env.KV.put('court_groups', JSON.stringify(g));
    return APP_JSON({ ok: true });
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
    if (st === 204) await noteRunSrc(env, 'app');
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
      let a = await docCached(env, r.id);
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
      display: 'standalone', background_color: '#ffffff', theme_color: '#1b2a6b', lang: 'uk',
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
/*APP_HTML_BEGIN*/const APP_HTML = "<!DOCTYPE html>\n<html lang=\"uk\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<meta name=\"apple-mobile-web-app-capable\" content=\"yes\">\n<meta name=\"mobile-web-app-capable\" content=\"yes\">\n<meta name=\"apple-mobile-web-app-title\" content=\"Мої справи\">\n<meta name=\"apple-mobile-web-app-status-bar-style\" content=\"default\">\n<meta name=\"theme-color\" content=\"#10142a\">\n<meta name=\"robots\" content=\"noindex,nofollow\">\n<link rel=\"manifest\" href=\"/app/manifest.json\">\n<link rel=\"apple-touch-icon\" href=\"/app/icon.png\">\n<title>Мої судові справи</title>\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link href=\"https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap\" rel=\"stylesheet\">\n<style>\n:root{\n  /* стриманий синій у кольорах сайту osadko.online: темно-синій фон, приглушений блакитний акцент, IBM Plex */\n  --bg:#10142a; --grey:#171c36; --text:#dfe3ef; --muted:#a3aac2; --soft:#c5cbe0; --line:#272d4a;\n  --head:#ffffff; --fill:#34437f; --fill-h:#40509a; --on-fill:#ffffff; --on-fill-muted:#c9d0ea; --rule:#363d60; --link:#a9b7ea; --acc:#93a4dc;\n  --side:#0c1022; --side-on:#1b2140;\n  --t-civ:#7fb2ff; --t-com:#5fd0b8; --t-crim:#f0a898; --t-adm:#e3c07a; --t-admj:#b8a4f0; --t-oth:#a3aac2;\n  --crit:#f0a898; --crit-soft:#2a1a1e; --crit-line:#57303a; --warn:#e3c07a; --warn-soft:#2a2619; --ok:#7cc79a; --ok-soft:#14281f;\n  --font-display:\"IBM Plex Sans\",system-ui,-apple-system,sans-serif;\n  --font-body:\"IBM Plex Sans\",system-ui,-apple-system,sans-serif;\n  --font-mono:\"IBM Plex Mono\",ui-monospace,Menlo,monospace;\n  --pad:18px;\n  color-scheme:dark;\n  /* сумісність зі старими назвами */\n  --surface:var(--bg); --surface2:var(--grey); --ink:var(--text); --accent:var(--head); --accent-ink:var(--on-fill); --accent-soft:var(--grey);\n}\n:root[data-theme=\"light\"]{\n  color-scheme:light;\n  --bg:#ffffff; --grey:#f3f4f7; --text:#222736; --muted:#606779; --soft:#3d4458; --line:#e1e3ea;\n  --head:#1b2a6b; --fill:#1b2a6b; --fill-h:#13205a; --on-fill:#ffffff; --on-fill-muted:#c9d0ea; --rule:#c5cad8; --link:#1b2a6b; --acc:#1b2a6b;\n  --side:#f3f4f7; --side-on:#e3e6f0;\n  --t-civ:#1f5fbf; --t-com:#0f7a68; --t-crim:#b3402f; --t-adm:#8a5a00; --t-admj:#5b3fb0; --t-oth:#606779;\n  --crit:#a1221b; --crit-soft:#fbe9e7; --crit-line:#e9b9b4; --warn:#8a5a00; --warn-soft:#fbf0d6; --ok:#1e6a39; --ok-soft:#e3f2e7;\n}\n*{box-sizing:border-box}\nhtml,body{height:100%;margin:0}\nbody{background:var(--grey);color:var(--text);font:400 16px/1.4 var(--font-body);-webkit-text-size-adjust:100%}\nbutton,input,select{font:inherit;color:inherit;border-radius:0}\nbutton{cursor:pointer;background:none;border:0;padding:0;text-align:left}\na{color:var(--head)}\n:focus-visible{outline:2px solid var(--head);outline-offset:2px}\n.app{max-width:640px;height:100%;margin:0 auto;background:var(--bg);display:flex;flex-direction:column;position:relative;overflow:hidden}\n.scr{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:0 var(--pad) 28px;display:flex;flex-direction:column}\n\n/* шапка екрана: синя смуга на всю ширину */\n.top{margin:0 calc(-1*var(--pad));padding:calc(20px + env(safe-area-inset-top)) var(--pad) 18px;background:var(--fill);color:var(--on-fill);display:flex;flex-direction:column;gap:6px}\n.back{margin:0 calc(-1*var(--pad));padding:calc(14px + env(safe-area-inset-top)) var(--pad) 0;background:var(--fill);color:var(--on-fill-muted);font:500 14px/1 var(--font-display);text-transform:uppercase;letter-spacing:.06em}\n.back + .top{padding-top:12px}\n.top .eyebrow{color:var(--on-fill-muted)}\n.eyebrow{margin:0;color:var(--muted);font-size:14px}\nh1{font:600 32px/1 var(--font-display);text-transform:uppercase;letter-spacing:-.005em;margin:0;text-wrap:balance;overflow-wrap:anywhere}\n.back + .top h1{font-size:24px;line-height:1.08}\nh2{font:500 19px/1.1 var(--font-display);text-transform:uppercase;color:var(--head);margin:26px 0 0;padding-top:12px;border-top:5px solid var(--rule)}\n\n.fresh{display:flex;gap:10px;align-items:center;font-size:13.5px;color:var(--muted);background:var(--grey);margin:0 calc(-1*var(--pad));padding:10px var(--pad)}\n.fresh i{flex:none;width:8px;height:8px;border-radius:50%;background:var(--ok)}\n.fresh.bad i{background:var(--crit)}\n.fresh span{flex:1}\n.tiles{display:grid;grid-template-columns:repeat(3,1fr);margin:0 calc(-1*var(--pad));border-bottom:1px solid var(--line)}\n.tile{padding:16px 10px 14px var(--pad);display:flex;flex-direction:column;gap:4px;border-left:1px solid var(--line)}\n.tile:first-child{border-left:0}\n.tile b{font:600 40px/1 var(--font-display);color:var(--head);font-variant-numeric:tabular-nums}\n.tile span{font-size:13px;color:var(--muted);line-height:1.2}\n.tile.hot b{color:var(--crit)}\n.alert{background:var(--crit-soft);color:var(--crit);padding:12px 14px;font-size:14.5px;border-left:5px solid var(--crit);margin-top:18px}\n.alert b{display:block;font:500 16px/1.2 var(--font-display);text-transform:uppercase;margin-bottom:3px}\n\n/* списки: суцільні рядки з лініями замість окремих карток */\n.list{display:flex;flex-direction:column}\n.row{display:flex;gap:14px;align-items:center;padding:13px 0;width:100%;border-bottom:1px solid var(--line)}\n.row .main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}\n.row .main b{font-weight:700;font-size:16px;line-height:1.25;overflow-wrap:anywhere}\n.row small{color:var(--muted);font-size:13.5px;line-height:1.3;overflow-wrap:anywhere}\n.row small.hl{color:var(--head);font-weight:700}\n.clamp{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}\n.own{font:500 12px/1 var(--font-display);text-transform:uppercase;letter-spacing:.05em;color:var(--head)}\n.row small.wr{color:var(--warn)}\nbutton.row:active,.row button.main:active{background:var(--grey)}\n.date{flex:none;width:54px;text-align:center;background:var(--fill);color:var(--on-fill);padding:7px 0 6px;font:400 11px/1.15 var(--font-display);text-transform:uppercase;letter-spacing:.05em;align-self:flex-start}\n.date b{display:block;font:600 24px/1 var(--font-display);letter-spacing:0}\n.date u{display:block;text-decoration:none;margin-top:4px;padding-top:4px;border-top:1px solid rgba(255,255,255,.3);font-size:13px;letter-spacing:0;font-variant-numeric:tabular-nums}\n.num{font-family:var(--font-mono);font-size:13.5px;font-variant-numeric:tabular-nums}\n.chip{flex:none;font:500 12px/1 var(--font-display);text-transform:uppercase;letter-spacing:.04em;padding:5px 8px;white-space:nowrap}\n.chip.crit{background:var(--crit-soft);color:var(--crit)}\n.chip.warn{background:var(--warn-soft);color:var(--warn)}\n.chip.ok{background:var(--ok-soft);color:var(--ok)}\n.chip.tag{background:var(--grey);color:var(--muted);vertical-align:2px;margin-left:4px}\n.chk{flex:none;width:24px;height:24px;border:2px solid var(--muted);display:grid;place-items:center;color:var(--on-fill)}\n.chk.on{background:var(--fill);border-color:var(--fill)}\n.chk.on::after{content:\"\";width:11px;height:6px;border-left:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(-45deg) translateY(-1px)}\n.done b{text-decoration:line-through;color:var(--muted)}\n\n.filters{display:flex;gap:0;overflow-x:auto;margin:14px calc(-1*var(--pad)) 0;padding:0 var(--pad);border-bottom:1px solid var(--line)}\n.filters button{flex:none;padding:10px 12px;font:500 14px/1 var(--font-display);text-transform:uppercase;letter-spacing:.04em;color:var(--muted);border-bottom:3px solid transparent;margin-bottom:-1px}\n.filters button.on{color:var(--head);border-bottom-color:var(--rule)}\n.field{width:100%;background:var(--bg);border:1px solid var(--line);padding:12px 14px;font-size:16px;-webkit-appearance:none;appearance:none}\n.field:focus{border-color:var(--head);outline:0}\n#q{margin-top:16px}\n.btn{background:var(--fill);color:var(--on-fill);padding:14px 18px;font:500 15px/1.1 var(--font-display);text-transform:uppercase;letter-spacing:.05em;text-align:center;text-decoration:none;display:inline-block;margin-top:14px}\n.btn:active{background:var(--fill-h)}\n.btn.ghost{background:none;color:var(--head);box-shadow:inset 0 0 0 1.5px var(--head)}\n.btn.danger{background:none;color:var(--crit);box-shadow:inset 0 0 0 1.5px var(--crit)}\n.btn.sm{padding:10px 12px;font-size:13px}\n.btn[disabled]{opacity:.5}\n.fresh .btn,.row .btn,.inline .btn,.card .btn{margin-top:0}\n.acts{display:flex;gap:10px;flex-wrap:wrap}\n.acts .btn{flex:1 1 auto}\n.list > .btn{align-self:flex-start;margin:0 0 14px}\n.meta{margin:8px 0 0;padding:0}\n.meta div{display:flex;gap:12px;padding:11px 0;border-bottom:1px solid var(--line);font-size:15px}\n.meta dt{flex:none;width:92px;color:var(--muted);font:400 12.5px/1.6 var(--font-display);text-transform:uppercase;letter-spacing:.05em}\n.meta dd{margin:0;overflow-wrap:anywhere}\n.card{background:var(--grey);border-left:5px solid var(--rule);padding:14px;display:flex;flex-direction:column;gap:7px;margin-top:12px}\n.card > b{font:500 18px/1.2 var(--font-display);text-transform:uppercase;color:var(--head)}\n.card p{margin:0;font-size:14px;color:var(--muted);overflow-wrap:anywhere}\n.card .acts{margin-top:4px}\n.text{font-size:15px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;margin:0;color:var(--text)!important}\n.inline{display:flex;gap:0;margin-top:14px}\n.inline .field{flex:1;min-width:0;border-right:0}\n.cal{margin-top:16px}\n.calhead{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}\n.calhead b{font:500 20px/1 var(--font-display);text-transform:uppercase;color:var(--head)}\n.calhead button{width:40px;height:40px;box-shadow:inset 0 0 0 1.5px var(--head);color:var(--head);text-align:center;font-size:20px}\n.grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:0;text-align:center;border-top:5px solid var(--rule)}\n.grid > span{font:400 12px/1 var(--font-display);text-transform:uppercase;letter-spacing:.05em;color:var(--muted);padding:9px 0 5px}\n.grid button{aspect-ratio:1;text-align:center;font-variant-numeric:tabular-nums;position:relative;font-size:16px}\n.grid button.today{box-shadow:inset 0 0 0 2px var(--head)}\n.grid button.sel{background:var(--fill);color:var(--on-fill)}\n.grid button i{position:absolute;bottom:6px;left:50%;width:6px;height:6px;background:var(--head);transform:translateX(-50%)}\n.grid button i.d{background:var(--crit)}\n.grid button i.both{box-shadow:9px 0 0 var(--crit);transform:translateX(-7px)}\n.grid button.sel i{background:var(--on-fill)}\n.legend{display:flex;gap:16px;font-size:13px;color:var(--muted);margin-top:8px}\n.legend i{display:inline-block;width:8px;height:8px;background:var(--head);margin-right:6px}\n.legend i.d{background:var(--crit)}\n.lnk{margin-left:auto;color:var(--head);font:500 13px/1 var(--font-display);text-transform:uppercase;letter-spacing:.05em;text-decoration:underline;text-underline-offset:3px}\n.lnk + .lnk{margin-left:0}\n.day{margin:22px 0 0;padding:0 0 8px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:baseline;gap:10px;font:500 17px/1.1 var(--font-display);text-transform:uppercase;color:var(--head)}\n.day span{font:400 13.5px/1 var(--font-body);text-transform:none;color:var(--muted)}\n.day.now{border-bottom:3px solid var(--rule)}\n.day b{font-weight:500}\n.legend{align-items:center}\n.empty{color:var(--muted);font-size:14.5px;padding:12px 0 0;margin:0}\n.err{color:var(--crit);font-size:14.5px;margin:10px 0 0}\n\n.tabs{flex:none;display:flex;background:var(--bg);border-top:1px solid var(--line);padding-bottom:env(safe-area-inset-bottom)}\n.tabs button{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;padding:9px 0 9px;font:400 11px/1 var(--font-display);text-transform:uppercase;letter-spacing:.04em;color:var(--muted);position:relative;border-top:3px solid transparent;margin-top:-1px}\n.tabs button.on{color:var(--head);border-top-color:var(--rule);font-weight:500}\n.tabs svg{width:23px;height:23px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:square;stroke-linejoin:miter}\n.tabs em{position:absolute;top:5px;left:calc(50% + 7px);background:var(--crit);color:#fff;font:500 11px/16px var(--font-display);font-style:normal;min-width:16px;height:16px;padding:0 4px;text-align:center}\n.shade{position:absolute;inset:0;background:rgba(8,12,34,.6);display:flex;align-items:flex-end;z-index:5}\n.sheet{background:var(--bg);width:100%;border-top:6px solid var(--rule);padding:20px 18px calc(22px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:12px;max-height:90%;overflow-y:auto}\n.sheet h3{margin:0;font:500 24px/1.1 var(--font-display);text-transform:uppercase;color:var(--head)}\n.sheet label{font:400 12.5px/1 var(--font-display);text-transform:uppercase;letter-spacing:.05em;color:var(--muted);display:flex;flex-direction:column;gap:6px}\n.sheet label .field{font-family:var(--font-body);text-transform:none;letter-spacing:0;color:var(--text)}\n.sheet p{margin:0;font-size:13.5px;color:var(--muted)}\n.sheet .btn{margin-top:2px}\n.login{flex:1;display:flex;flex-direction:column;justify-content:center;gap:14px;padding:28px 22px}\n.login h1{color:var(--head);font-size:40px;padding-top:16px;border-top:6px solid var(--rule)}\n.login p{margin:0;color:var(--muted)}\n.login .list{gap:0}\n#toast{position:absolute;left:18px;right:18px;bottom:calc(84px + env(safe-area-inset-bottom));background:var(--fill);color:var(--on-fill);font-size:14.5px;padding:12px 14px;opacity:0;pointer-events:none;transition:opacity .2s;text-align:center;z-index:9}\n#toast.show{opacity:1}\n.spin{width:18px;height:18px;border:2px solid var(--line);border-top-color:var(--head);border-radius:50%;animation:sp 1s linear infinite;flex:none}\n@keyframes sp{to{transform:rotate(360deg)}}\n@media (prefers-reduced-motion:reduce){#toast{transition:none}.spin{animation:none}}\n\n/* таблиці (комп'ютер): один рядок на запис, без переносів, довге обрізається з підказкою */\n.tw{overflow-x:auto;margin-top:4px}\n.tb{width:100%;border-collapse:collapse;table-layout:fixed;font-size:14.5px}\n.tb th{font:500 12.5px/1 var(--font-display);text-transform:uppercase;letter-spacing:.05em;color:var(--muted);text-align:left;padding:12px 12px 9px 0;border-bottom:2px solid var(--rule);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.tb th.s{cursor:pointer;color:var(--head)}\n.tb th.up::after{content:\" ↑\"}\n.tb th.dn::after{content:\" ↓\"}\n.tb td{padding:10px 12px 10px 0;border-bottom:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;vertical-align:middle}\n.tb tbody tr[data-a]{cursor:pointer}\n.tb tbody tr:hover{background:var(--grey)}\n.tb td.num{font-family:var(--font-mono);font-size:13.5px}\n.tb td.b{font-weight:700}\n.tb td.m{color:var(--muted)}\n.tb td.act{overflow:visible;text-overflow:clip}\n.tb tr.done td{color:var(--muted)}\n.tb tr.done td.b{text-decoration:line-through}\n.tb .chip{display:inline-block}\n.tb .btn{margin:0;padding:6px 9px;font-size:12px}\n.x{color:var(--crit);font-size:15px;padding:4px 8px}\n.wr{color:var(--warn)}\n.navbar{flex:none;display:flex;gap:22px;align-items:center;margin:0 calc(-1*var(--pad));padding:16px var(--pad) 8px;font:500 13px/1.6 var(--font-display);text-transform:uppercase;letter-spacing:.05em}\n.navbar button{color:var(--head);text-decoration:underline;text-underline-offset:4px}\n.navbar button[disabled]{opacity:.35;text-decoration:none;cursor:default}\n.navbar span{margin-left:auto;color:var(--muted);text-transform:none;letter-spacing:0;font:400 13px/1.6 var(--font-body)}\n.navbar + .top{padding-top:4px}\n.toolbar{display:flex;gap:14px;align-items:center;margin-top:16px}\n.toolbar #q{margin-top:0;max-width:420px}\n.toolbar .filters{margin:0;padding:0;border-bottom:0;flex:1}\n.toolbar .btn{margin-top:0;white-space:nowrap}\n\n/* вузький екран: блоки йдуть один за одним у порядку важливості */\n.side{display:none}\n.evs{display:none}\n.cols,.cols2{display:flex;flex-direction:column}\n.c-alerts,.k-a{order:1}.c-hear,.k-b{order:2}.c-dl,.k-c{order:3}\n.row.cur{background:var(--grey);box-shadow:inset 4px 0 0 var(--rule);padding-left:14px;padding-right:10px}\n.hint{flex:1;display:flex;align-items:center;justify-content:center;color:var(--muted);text-align:center;padding:40px}\n\n/* комп'ютер: бічне меню, кілька колонок, вікна по центру */\n@media (min-width:960px){\n  :root{--pad:30px}\n  .app{max-width:none;flex-direction:row}\n  .tabs{display:none}\n  .side{display:flex;flex:none;width:236px;background:var(--fill);color:var(--on-fill);flex-direction:column;padding:26px 0 20px}\n  .brand{padding:0 24px 22px;border-bottom:1px solid rgba(255,255,255,.2)}\n  .brand b{display:block;font:600 19px/1.05 var(--font-display);text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n  .brand small{display:block;margin-top:8px;color:var(--on-fill-muted);font-size:13.5px}\n  .side nav{display:flex;flex-direction:column;padding:14px 0;flex:1}\n  .side nav button{display:flex;align-items:center;gap:12px;padding:13px 20px;font:500 15px/1 var(--font-display);text-transform:uppercase;letter-spacing:.05em;color:var(--on-fill-muted);border-left:4px solid transparent}\n  .side nav button:hover{color:var(--on-fill)}\n  .side nav button.on{color:var(--on-fill);background:rgba(255,255,255,.12);border-left-color:var(--on-fill)}\n  .side nav svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:square;flex:none}\n  .side nav em{margin-left:auto;background:var(--crit);color:#fff;font:500 12px/1 var(--font-display);font-style:normal;padding:3px 6px}\n  .sidefoot{padding:16px 24px 0;border-top:1px solid rgba(255,255,255,.2);display:flex;flex-direction:column;gap:11px;align-items:flex-start}\n  .sidefoot small{color:var(--on-fill-muted);font-size:12.5px;line-height:1.35}\n  .sidefoot button{color:var(--on-fill);font:500 13px/1 var(--font-display);text-transform:uppercase;letter-spacing:.05em;text-decoration:underline;text-underline-offset:4px}\n  .sidefoot button[disabled]{opacity:.5}\n  .mainarea{flex:1;min-width:0;display:flex;background:var(--bg)}\n  .split{display:flex;flex:1;min-width:0}\n  .pane{flex:1;min-width:0;height:100%}\n  .pl{flex:0 0 400px;border-right:1px solid var(--line)}\n  .top{background:var(--bg);color:var(--head);border-bottom:5px solid var(--rule);padding-top:26px}\n  .top .eyebrow{color:var(--muted)}\n  .back{background:var(--bg);color:var(--head);padding-top:22px}\n  .back + .top{padding-top:10px}\n  .pd > .back[data-a=\"back\"]{display:none}\n  .pd > .back[data-a=\"back\"] + .top{padding-top:26px}\n  h1{font-size:34px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-bottom:2px}\n  .back + .top h1,.navbar + .top h1{font-size:28px}\n  .top .eyebrow{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n  h2{white-space:nowrap}\n  .tile b{font-size:52px}\n  .cols{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);grid-template-areas:\"hear alerts\" \"hear dl\";grid-template-rows:auto 1fr;column-gap:40px}\n  .c-hear{grid-area:hear}.c-alerts{grid-area:alerts}.c-dl{grid-area:dl}\n  .cols2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);grid-template-areas:\"a b\" \"c b\";grid-template-rows:auto 1fr;column-gap:40px}\n  .k-a{grid-area:a}.k-b{grid-area:b}.k-c{grid-area:c}\n  .duo{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);column-gap:40px;align-items:start}\n  .calwrap{display:grid;grid-template-columns:minmax(0,1.8fr) minmax(0,1fr);column-gap:40px;align-items:start}\n  .grid button{min-width:0;overflow:hidden;aspect-ratio:auto;min-height:108px;text-align:left;padding:6px 7px 8px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:4px;font:500 15px/1 var(--font-display)}\n  .grid button:hover{background:var(--grey)}\n  .grid button.sel:hover{background:var(--fill)}\n  .grid button i{display:none}\n  .evs{display:flex;flex-direction:column;gap:3px;width:100%;min-width:0}\n  .evs em{display:block;font:400 12.5px/1.25 var(--font-body);font-style:normal;background:var(--grey);border-left:3px solid var(--rule);padding:2px 5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text)}\n  .evs em.d{border-left-color:var(--crit)}\n  .grid button.sel .evs em{background:rgba(255,255,255,.16);color:var(--on-fill);border-left-color:var(--on-fill)}\n  .row:hover{background:var(--grey)}\n  button.row,.row button.main{cursor:pointer}\n  .pane{overflow:hidden;display:flex;flex-direction:column;padding-bottom:0}\n  .pane.free{overflow-y:auto;padding-bottom:28px}\n  .fill{flex:1;min-height:0;overflow:auto;padding-bottom:22px}\n  .stack{display:flex;flex-direction:column;min-height:0;height:100%}\n  .stack > h2,.stack > .hrow{flex:none}\n  .hrow{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-top:22px;padding-top:12px;border-top:5px solid var(--rule)}\n  .hrow h2{margin:0;padding:0;border:0}\n  .hrow .btn{margin:0}\n  .two{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);column-gap:40px}\n  .today2{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) 430px;column-gap:40px}\n  .two > *,.today2 > *{min-height:0}\n  .fill .tb th{position:sticky;top:0;z-index:1;background:var(--bg);border-bottom:0;box-shadow:inset 0 -2px 0 var(--rule)}\n  .fill > h2:first-child,.fill > .alert:first-child{margin-top:22px}\n  .calwrap{flex:1;min-height:0;align-items:stretch}\n  .calwrap > .cal,.calwrap > .agenda{overflow:auto;min-height:0;padding-bottom:22px}\n  .agenda > .day:first-child{margin-top:16px}\n  .shade{align-items:center;justify-content:center}\n  .sheet{width:520px;max-width:92%}\n  .login{max-width:460px;margin:0 auto}\n  #toast{left:auto;right:30px;bottom:30px;max-width:440px}\n  .btn{cursor:pointer}\n  .btn:hover{background:var(--fill-h)}\n  .btn.ghost:hover,.btn.danger:hover{background:var(--grey)}\n}\n.gsel{flex:none;width:auto;max-width:46%;border-right:1px solid var(--line);padding:9px 10px;font-size:14px;-webkit-appearance:menulist;appearance:auto}\ndetails.dead{margin-top:16px}\ndetails.dead summary{cursor:pointer;color:var(--muted);font-size:14.5px}\n\n/* ── новий вигляд: уточнення компонентів ── */\nbody{background:var(--bg)}\na{color:var(--link)}\n:focus-visible{outline-color:var(--acc)}\nh1,h2,.btn,.brand b,.calhead b,.day,.card > b,.sheet h3,.alert b,.filters button,.tabs button,.lnk,.navbar,.sidefoot button,.side nav button,.back,.own,.chip,.date{text-transform:none;letter-spacing:0}\nh1{font-weight:600}\nh2{font:600 17px/1.2 var(--font-display);color:var(--head);border-top:0;padding:0 0 8px;margin-top:22px}\n.top,.back{background:var(--bg);color:var(--head)}\n.top{border-bottom:1px solid var(--line)}\n.top .eyebrow{color:var(--muted)}\n.back{color:var(--soft)}\n.fresh{background:var(--grey)}\n.tile b{color:var(--head)}\n.alert{border-left:0;border:1px solid var(--crit-line);border-radius:8px}\n.alert b{font:600 15px/1.3 var(--font-display)}\n.card{border-left:0;border:1px solid var(--line);border-radius:8px}\n.card > b{font:600 16px/1.3 var(--font-display)}\n.date{background:var(--grey);color:var(--head);box-shadow:inset 0 0 0 1px var(--line);border-radius:6px;font-size:12px}\n.date u{border-top-color:var(--line)}\n.own,.row small.hl{color:var(--link)}\n.own.chk1{color:var(--warn)}\n.chip{font:600 12.5px/1 var(--font-display);border-radius:4px}\n.chip.ok{background:transparent;color:var(--soft);box-shadow:inset 0 0 0 1px var(--rule)}\n.chk{border-radius:4px}\n.filters button{font:500 14.5px/1 var(--font-display)}\n.filters button.on{color:var(--head);border-bottom-color:var(--acc)}\n.field{background:var(--grey);border-color:var(--rule);border-radius:6px;color:var(--text)}\n.field:focus{border-color:var(--acc)}\n.inline .field{border-radius:6px 0 0 6px}\n.inline .btn{border-radius:0 6px 6px 0}\n.btn{border-radius:6px;font:600 15px/1.1 var(--font-display);padding:12px 16px}\n.btn.ghost{color:var(--text);box-shadow:inset 0 0 0 1px var(--rule)}\n.btn.danger{color:var(--crit);box-shadow:inset 0 0 0 1px var(--crit-line)}\n.btn.sm{padding:9px 12px;font-size:13.5px}\n.meta dt{font:400 12.5px/1.6 var(--font-body);letter-spacing:.05em}\n.calhead button{border-radius:6px;box-shadow:inset 0 0 0 1px var(--rule);color:var(--text)}\n.grid{border-top:1px solid var(--rule)}\n.grid button.today{box-shadow:inset 0 0 0 2px var(--acc)}\n.grid button i{background:var(--acc);border-radius:50%}\n.legend i{background:var(--acc);border-radius:50%}\n.lnk{color:var(--link);font:500 13.5px/1 var(--font-display)}\n.day{font:600 16px/1.2 var(--font-display);border-bottom-color:var(--rule)}\n.day.now{border-bottom:2px solid var(--acc)}\n.day b{font-weight:600}\n.tabs button.on{color:var(--head);border-top-color:var(--acc)}\n.tabs em,.side nav em{background:var(--fill)!important;color:var(--on-fill)!important;border-radius:4px}\n.shade{background:rgba(0,0,0,.6)}\n.sheet{border-top:0;border:1px solid var(--line);border-radius:10px}\n.sheet h3{font:600 20px/1.2 var(--font-display)}\n.sheet label{font:400 12.5px/1 var(--font-body)}\n.login h1{border-top:0;font-size:30px;padding-top:0}\n#toast{border-radius:6px;font-weight:600}\n.spin{border-top-color:var(--acc)}\n.tb th{font:500 12px/1 var(--font-body);border-bottom:1px solid var(--rule)}\n.tb th.s{color:var(--soft)}\n.navbar{font:500 13.5px/1.6 var(--font-display)}\n.navbar button{color:var(--link);text-decoration:none}\n.row.cur{box-shadow:inset 3px 0 0 var(--acc)}\n\n/* екран «Сьогодні» на комп'ютері: наступне засідання, тиждень, порядок денний за днями */\n.tg-top{flex:none;display:flex;gap:16px;margin-top:18px}\n.nx{flex:2 1 0;min-width:0;background:var(--grey);border:1px solid var(--line);border-radius:8px;padding:16px 20px;display:flex;flex-direction:column;gap:8px;cursor:pointer}\n.nx .lb{font-size:12.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--link)}\n.nx .big{font:600 30px/1 var(--font-display);color:var(--head);font-variant-numeric:tabular-nums}\n.nx b{font-weight:600;color:var(--head);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.nx small{color:var(--soft);font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.wk{flex:3 1 0;min-width:0;display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px}\n.wk div{background:var(--grey);border:1px solid var(--line);border-radius:8px;padding:11px 12px;display:flex;flex-direction:column;gap:6px;min-width:0}\n.wk div.now{box-shadow:inset 0 2px 0 var(--acc)}\n.wk small{font-size:13px;color:var(--muted)}\n.wk b{font:600 24px/1 var(--font-display);color:var(--head)}\n.wk span{font-size:13px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.wk .on span{color:var(--link);font-weight:600}\n.today3{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) 340px;column-gap:28px}\n.today3 > *{min-height:0}\n.dayh{display:flex;justify-content:space-between;align-items:baseline;gap:16px;margin:18px 0 8px;padding-bottom:6px;border-bottom:1px solid var(--rule);font:600 17px/1.2 var(--font-display);color:var(--head)}\n.dayh b{font-weight:600}\n.dayh span{font:400 13.5px/1 var(--font-body);color:var(--muted)}\n.cf{display:flex;gap:12px;align-items:flex-start;padding:10px 14px;margin-bottom:8px;border-radius:8px;border:1px solid var(--crit-line);background:var(--crit-soft);color:var(--crit);font-size:14.5px}\n.cf svg{flex:none;width:18px;height:18px;margin-top:2px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}\n.cf b{font-weight:600}\n.hc{display:flex;align-items:center;gap:18px;width:100%;background:var(--grey);border:1px solid var(--line);border-radius:8px;padding:11px 16px;margin-bottom:8px;cursor:pointer}\n.hc:hover,.nx:hover{border-color:var(--rule)}\n.hc .tm{flex:0 0 62px;font:600 21px/1 var(--font-display);color:var(--head);font-variant-numeric:tabular-nums}\n.hc .main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}\n.hc .main b{font-weight:600;font-size:15.5px;color:var(--head);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.hc .main small{color:var(--muted);font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.hc .rt{flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:3px}\n.hc .rt small{font-size:13.5px;color:var(--muted)}\n.box{background:var(--grey);border:1px solid var(--line);border-radius:8px;padding:14px 18px;margin-top:18px;display:flex;flex-direction:column;gap:9px}\n.box h2{margin:0;padding:0}\n.box .empty{padding:0}\n.box small{font-size:13px;color:var(--muted)}\n.kv{display:flex;justify-content:space-between;align-items:baseline;gap:12px;font-size:14.5px;color:var(--soft)}\n.kv + .kv{padding-top:8px;border-top:1px solid var(--line)}\n.kv b{color:var(--head);font-weight:600}\n.kv b.w{color:var(--crit)}\n.kv .num{color:var(--text)}\n.bar{height:6px;border-radius:3px;background:var(--line)}\n.bar i{display:block;height:6px;border-radius:3px;background:var(--ok)}\n.bar i.a{background:var(--acc)}\n@media (min-width:960px){\n  .side{background:var(--side);color:var(--text);border-right:1px solid var(--line);padding:24px 0 18px}\n  .brand{padding:0 24px 20px;border-bottom-color:var(--line)}\n  .brand b{font:600 17px/1.2 var(--font-display);color:var(--head)}\n  .brand small{color:var(--muted);margin-top:4px}\n  .side nav{padding:14px 12px;gap:2px}\n  .side nav button{padding:12px 12px;border-left:0;border-radius:6px;font:500 15px/1 var(--font-display);color:var(--soft)}\n  .side nav button:hover{color:var(--head)}\n  .side nav button.on{color:var(--head);font-weight:600;background:var(--side-on);box-shadow:inset 3px 0 0 var(--acc)}\n  .side nav svg{stroke-linecap:round;stroke-linejoin:round;stroke-width:1.8}\n  .sidefoot{border-top-color:var(--line)}\n  .sidefoot small{color:var(--muted)}\n  .sidefoot button{color:var(--soft);font:500 13.5px/1 var(--font-display);text-decoration:none}\n  .sidefoot button:hover{color:var(--head)}\n  .top{border-bottom:0;padding-bottom:4px}\n  h1{font-size:28px}\n  .back + .top h1,.navbar + .top h1{font-size:24px}\n  .hrow{border-top:0;padding-top:0}\n  .fill .tb th{box-shadow:inset 0 -1px 0 var(--rule)}\n  .grid button{font:500 14.5px/1 var(--font-display)}\n  .grid button.sel,.grid button.sel:hover{background:var(--side-on);color:var(--head);box-shadow:inset 0 0 0 2px var(--acc)}\n  .evs em{border-left-color:var(--acc);border-radius:3px}\n  .evs em.d{border-left-color:var(--crit)}\n  .grid button.sel .evs em{background:var(--grey);color:var(--text);border-left-color:var(--acc)}\n  .btn.ghost:hover,.btn.danger:hover{background:var(--side-on)}\n}\n\n/* ── кольори видів справ, більші картки, переходи ── */\n.ty{color:var(--tc,var(--muted));font-weight:600;white-space:nowrap}\n.ty::before{content:\"\";display:inline-block;width:8px;height:8px;border-radius:50%;background:currentColor;margin-right:6px;vertical-align:1px}\n.hc{box-shadow:inset 4px 0 0 var(--tc,var(--rule));padding:15px 20px 15px 22px;gap:22px;margin-bottom:10px}\n.hc .tm{flex:0 0 72px;font-size:25px}\n.hc .main{gap:5px}\n.hc .main b{font-size:17px}\n.hc .main small{font-size:14.5px}\n.hc .rt{gap:6px}\n.hc .rt .num{font-size:14.5px}\n.hc .rt small{font-size:14px}\n.nx{box-shadow:inset 4px 0 0 var(--tc,var(--acc));padding:18px 22px 18px 24px}\n.nx .big{font-size:34px}\n.nx b{font-size:17px}\n.wk .on{background:color-mix(in srgb,var(--acc) 13%,var(--grey));border-color:color-mix(in srgb,var(--acc) 38%,var(--line))}\n.wk .dots{display:flex;gap:4px;min-height:7px}\n.wk .dots i{width:7px;height:7px;border-radius:50%;background:var(--tc,var(--acc))}\n.dayh span.r1{color:var(--crit);font-weight:600}\n.dayh span.r7{color:var(--warn);font-weight:600}\n.kv b.a{color:var(--acc)}\n.kv b.y{color:var(--warn)}\n.kv b.g{color:var(--ok)}\n.side nav button.on svg{color:var(--acc)}\n#caselist .tb{font-size:15.5px}\n#caselist .tb td{padding:15px 12px 15px 0}\n#caselist .tb td.num{font-size:14.5px}\n#caselist .tb tr td:first-child{box-shadow:inset 3px 0 0 var(--tc,transparent);padding-left:12px}\n#caselist .tb th:first-child{padding-left:12px}\n.row .main b{font-size:16.5px}\n.row{padding:15px 0}\n\nbody,.side,.field,.card,.box{transition:background-color .2s ease,border-color .2s ease,color .2s ease}\n.btn,.side nav button,.sidefoot button,.filters button,.tabs button,.calhead button,.grid button,.row,.tb tbody tr,.hc,.nx,.wk div,.chk,.lnk,.navbar button{transition:background-color .15s ease,border-color .15s ease,color .15s ease,box-shadow .15s ease,transform .15s ease,opacity .15s ease}\n.hc:hover,.nx:hover{border-color:var(--acc);transform:translateY(-1px)}\n.hc:active,.nx:active,.btn:active{transform:scale(.985)}\n.wk div:hover{border-color:var(--rule)}\n@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}\n@keyframes fade{from{opacity:0}to{opacity:1}}\n@keyframes pop{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}\n@keyframes grow{from{transform:scaleX(0)}to{transform:none}}\n#app.enter .scr > *{animation:rise .24s cubic-bezier(.2,.7,.2,1) both}\n#app.enter .scr > *:nth-child(2){animation-delay:.03s}\n#app.enter .scr > *:nth-child(3){animation-delay:.06s}\n#app.enter .scr > *:nth-child(n+4){animation-delay:.09s}\n#app.enter .hc,#app.enter .dayh,#app.enter .cf,#app.enter .box,#app.enter .wk div{animation:rise .28s cubic-bezier(.2,.7,.2,1) both;animation-delay:calc(.08s + var(--i,0)*.028s)}\n#app.enter .bar i{animation:grow .7s cubic-bezier(.2,.7,.2,1) .25s both;transform-origin:left center}\n#app.sheet-in .shade{animation:fade .16s ease both}\n#app.sheet-in .sheet{animation:pop .2s cubic-bezier(.2,.7,.2,1) both}\n\n/* ── «Моніторинг»: рядок стану, розкривні секції, журнал прогонів ── */\n.strip{display:flex;flex-wrap:wrap;align-items:center;gap:8px 24px;background:var(--grey);border:1px solid var(--line);border-radius:8px;padding:10px 16px;margin-top:16px;font-size:14.5px;color:var(--soft)}\n.strip > i{flex:none;width:10px;height:10px;border-radius:50%;background:var(--ok)}\n.strip.bad > i{background:var(--crit)}\n.strip b{color:var(--head);font-weight:600}\n.strip .btn{margin:0 0 0 auto}\n.folds{display:flex;flex-direction:column;gap:10px;margin-top:14px}\n.fold{background:var(--grey);border:1px solid var(--line);border-radius:8px;overflow:hidden;transition:border-color .15s ease}\n.fold.on{border-color:var(--rule)}\n.fh{width:100%;min-height:54px;padding:10px 18px;display:flex;flex-wrap:wrap;align-items:center;gap:4px 16px;cursor:pointer;transition:background-color .15s ease}\n.fh:hover{background:var(--side-on)}\n.fh > b{flex:0 0 200px;font:600 17px/1.2 var(--font-display);color:var(--head)}\n.fh > span{flex:1 1 200px;min-width:0;color:var(--muted);font-size:14.5px}\n.fh > span .ty{margin-right:14px}\n.fh > i{flex:none;font-style:normal;font-size:13.5px;color:var(--link)}\n.fh > i::after{content:\" ▾\"}\n.fold.on .fh > i::after{content:\" ▴\"}\n.fb{padding:2px 18px 16px;border-top:1px solid var(--line)}\n.fb .day{margin-top:14px}\n.fb .inline{max-width:560px}\n.grow,.lrow{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;padding:10px 0;border-bottom:1px solid var(--line)}\n.grow .main,.lrow .main{flex:1 1 220px;min-width:0;display:flex;flex-direction:column;gap:1px}\n.grow .main b{font-weight:600;color:var(--head)}\n.grow small,.lrow small{color:var(--muted);font-size:13px}\n.gl{flex:0 0 180px;display:flex;align-items:center;gap:10px}\n.gl.wide{flex:2 1 220px}\n.gl .bar{flex:1}\n.lrow .tm{flex:0 0 60px;font:600 19px/1 var(--font-display);color:var(--head);font-variant-numeric:tabular-nums}\n.seg{flex:none;display:inline-flex;border:1px solid var(--rule);border-radius:6px;overflow:hidden}\n.seg button{min-height:36px;padding:0 12px;font-size:13.5px;color:var(--muted);text-align:center;transition:background-color .15s ease,color .15s ease}\n.seg button + button{border-left:1px solid var(--rule)}\n.seg button:hover{color:var(--head)}\n.seg button.on{font-weight:600}\n.seg button.on.always{background:var(--ok-soft);color:var(--ok);box-shadow:inset 0 -2px 0 var(--ok)}\n.seg button.on.rotate{background:var(--side-on);color:var(--link);box-shadow:inset 0 -2px 0 var(--acc)}\n.seg button.on.off{background:var(--bg);color:var(--head);box-shadow:inset 0 -2px 0 var(--muted)}\n.tags{display:flex;flex-wrap:wrap;gap:8px;padding-top:12px}\n.tag{display:inline-flex;align-items:center;gap:2px;padding:0 2px 0 12px;border-radius:16px;background:var(--side-on);border:1px solid var(--rule);font-size:14.5px}\n.tag button{width:30px;height:30px;text-align:center;color:var(--muted);border-radius:50%;font-size:13px}\n.tag button:hover{color:var(--crit)}\n#app.fold-in .fb{animation:rise .22s cubic-bezier(.2,.7,.2,1) both}\n@media (min-width:960px){.mobonly{display:none}}\n@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}\n</style>\n</head>\n<body>\n<div class=\"app\"><div id=\"app\" style=\"display:contents\"></div><div id=\"toast\" role=\"status\"></div></div>\n<script>\nconst esc=s=>String(s==null?'':s).replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));\nconst T0=new Date();T0.setHours(0,0,0,0);\nconst we=d=>{const x=new Date(d);while(x.getDay()%6===0)x.setDate(x.getDate()+1);return x};\nconst plus=(d,n)=>we(new Date(d.getFullYear(),d.getMonth(),d.getDate()+n));\nconst left=d=>Math.round((d-T0)/864e5);\nconst MG=['січня','лютого','березня','квітня','травня','червня','липня','серпня','вересня','жовтня','листопада','грудня'];\nconst MN=['Січень','Лютий','Березень','Квітень','Травень','Червень','Липень','Серпень','Вересень','Жовтень','Листопад','Грудень'];\nconst MS=['січ','лют','бер','кві','тра','чер','лип','сер','вер','жов','лис','гру'];\nconst WD=['нд','пн','вт','ср','чт','пт','сб'];\nconst p2=n=>String(n).padStart(2,'0');\nconst fd=d=>`${p2(d.getDate())}.${p2(d.getMonth()+1)}.${d.getFullYear()}`;\nconst fh=d=>`${d.getDate()} ${MG[d.getMonth()]}, ${WD[d.getDay()]}`;\nconst iso=d=>`${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())}`;\nconst pd=v=>{const[y,m,d]=v.split('-').map(Number);return new Date(y,m-1,d)};\nconst TYPES={civ:'Цивільна',com:'Господарська',adm:'КУпАП',crim:'Кримінальна',admj:'Адміністративна',oth:'Інша'};\nconst TPL={\n civ:[['Відзив на позов',15,'ст. 178 ЦПК, не менше 15 днів з вручення ухвали'],['Апеляційна скарга на рішення',30,'ст. 354 ЦПК'],['Апеляційна скарга на ухвалу',15,'ст. 354 ЦПК'],['Касаційна скарга',30,'ст. 390 ЦПК']],\n com:[['Відзив на позов',15,'ст. 165 ГПК, не менше 15 днів з вручення ухвали'],['Апеляційна скарга на рішення',20,'ст. 256 ГПК'],['Апеляційна скарга на ухвалу',10,'ст. 256 ГПК'],['Касаційна скарга',20,'ст. 288 ГПК']],\n adm:[['Апеляційна скарга на постанову',10,'ст. 294 КУпАП']],\n crim:[['Апеляційна скарга на вирок',30,'ст. 395 КПК'],['Апеляційна скарга на ухвалу слідчого судді',5,'ст. 395 КПК']],\n admj:[['Відзив на позов',15,'ст. 162 КАС, строк встановлює суд'],['Апеляційна скарга на рішення',30,'ст. 295 КАС'],['Апеляційна скарга на ухвалу',15,'ст. 295 КАС'],['Касаційна скарга',30,'ст. 329 КАС']]\n};\nconst store={get(k){try{return localStorage.getItem(k)||''}catch(_){return ''}},set(k,v){try{v?localStorage.setItem(k,v):localStorage.removeItem(k)}catch(_){}}};\nconst theme={get(){return store.get('cc_theme')},eff(){return this.get()||'dark'},apply(){const t=this.get();if(t)document.documentElement.dataset.theme=t},toggle(){store.set('cc_theme',this.eff()==='dark'?'light':'dark');this.apply()}};theme.apply();\nconst S={scan:null,groups:{},lastScan:{},token:store.get('cc_token'),ready:false,busy:false,err:'',updated:'',calendar:false,tab:'today',cid:null,doc:null,filter:'all',q:'',sort:{k:'next',d:1},sheet:null,preset:null,log:[],mon:(m=>m==='none'?'':(m||'log'))(store.get('cc_mon')),\n calM:new Date(T0.getFullYear(),T0.getMonth(),1),calD:null};\nlet C=[],W=[],TR=[],NC=[];const DOCS={},DOC={};\n\n// ── сервер ──\nasync function api(path,body){\n const r=await fetch('/api/'+path,{method:body?'POST':'GET',cache:'no-store',\n  headers:Object.assign({'Authorization':'Bearer '+S.token},body?{'Content-Type':'application/json'}:{}),body:body?JSON.stringify(body):undefined});\n const j=await r.json().catch(()=>({}));\n if(r.status===401&&path!=='login'){logout();throw new Error('Потрібен вхід.')}\n if(!r.ok)throw new Error(j.error||('Помилка сервера ('+r.status+')'));\n return j;\n}\nfunction logout(){S.token='';store.set('cc_token','');S.ready=false;render()}\nconst caseKey=n=>{const b=String(n||'').replace(/[‐-―−]/g,'-').toLowerCase().replace(/\\s+/g,'').replace(/^№+/,'').replace(/-[^\\d/]+$/,'');const m=b.match(/(\\d{2,4})\\/(\\d{1,7})\\/(\\d{2})(?!\\d)/);return m?`${m[1]}/${+m[2]}/${m[3]}`:b};\nconst typeOf=(f,num,desc,court,inv)=>{f=String(f||'').toLowerCase();if(/господар/.test(f))return 'com';if(/кримін/.test(f))return 'crim';if(/правопоруш|купап/.test(f))return 'adm';if(/адміністрат/.test(f))return 'admj';if(/цивіл/.test(f))return 'civ';\n const n=String(num||'').toLowerCase();if(/-ц$/.test(n))return 'civ';if(/-к$/.test(n))return 'crim';if(/-п$/.test(n))return 'adm';if(/-а$/.test(n))return 'admj';if(/^9\\d\\d\\//.test(n))return 'com';\n const d=String(desc||'').toLowerCase(),c=String(court||'').toLowerCase(),p=String(inv||'').toLowerCase();\n if(/купап|адміністративн\\S* правопоруш/.test(d))return 'adm';\n if(/господарськ/.test(c))return 'com';\n if(/адміністративн/.test(c))return 'admj';\n if(/обвинувач|підозрюван|потерпіл/.test(p)||/кримінальн|\\bкк\\b|вирок/.test(d))return 'crim';\n if(/сімейн|шлюб|алімент|спадщ|спадк|позик|борг|стягнення|власност|відшкодуван|договор|купівлі|виселен|усиновлен|батьківськ/.test(d))return 'civ';\n return 'oth'};\nfunction build(o){\n const map=new Map();\n const get=num=>{const k=caseKey(num);if(!map.has(k))map.set(k,{key:k,num:String(num),type:'oth',subj:'',parties:'',client:'',role:'',court:'',judge:'',ev:[],dl:[],tracked:false});return map.get(k)};\n const add=(it,src)=>{if(!it||!it.number)return;const c=get(it.number);\n  c.court=c.court||it.court||'';c.judge=c.judge||it.judge||'';c.parties=c.parties||it.involved||'';c.subj=c.subj||it.description||'';\n  if(c.type==='oth')c.type=typeOf(it.forma,it.number,it.description,it.court,it.involved);\n  const m=String(it.matched||'');if(m&&!m.startsWith('справа №'))c.client=m;\n  if(src==='adv')c.role='я у справі';\n  const d=/(\\d{2})\\.(\\d{2})\\.(\\d{4})(?:\\D+(\\d{1,2}):(\\d{2}))?/.exec(it.date||'');\n  if(d){const dt=new Date(+d[3],+d[2]-1,+d[1]),tm=d[4]?p2(+d[4])+':'+d[5]:'';\n   const sure=src!=='cli'||m.startsWith('справа №');\n   const ex=c.ev.find(e=>+e.d===+dt&&e.tm===tm);\n   if(ex){ex.sure=ex.sure||sure}else c.ev.push({d:dt,tm,rm:it.courtroom?'зал/каб. '+it.courtroom:'',court:it.court||'',src,sure,raw:it})}};\n (o.advocate||[]).forEach(it=>add(it,'adv'));(o.clients||[]).forEach(it=>add(it,'cli'));(o.manual||[]).forEach(it=>add(it,'man'));\n (o.tracked||[]).forEach(n=>{get(n).tracked=true});\n (o.deadlines||[]).forEach(x=>{const d=/(\\d{2})\\.(\\d{2})\\.(\\d{4})/.exec(x.date||'');if(!d||!x.number)return;get(x.number).dl.push({key:x.key,t:x.title||'Строк',due:new Date(+d[3],+d[2]-1,+d[1]),b:x.note||'',done:!!x.done})});\n const list=[...map.values()];\n list.forEach(c=>{c.ev.sort((a,b)=>a.d-b.d||a.tm.localeCompare(b.tm));if(c.type==='oth')c.type=typeOf('',c.num,c.subj,c.court,c.parties);\n  if(!c.client){const t=c.parties.split(/[,;]/).filter(x=>!/осадьк/i.test(x)).join(',').replace(/\\s+/g,' ').replace(/^[\\s,]+|[\\s,]+$/g,'').trim();c.client=!t?'Справа № '+c.num:t.length<=90?t:t.slice(0,90).replace(/[\\s,;:]+\\S*$/,'')+'…'}if(!c.court)c.court='Суд не визначено';if(!c.judge)c.judge='не визначено'});\n list.sort((a,b)=>((a.ev[0]||{}).d||9e15)-((b.ev[0]||{}).d||9e15));\n C=list;W=o.names||[];TR=o.tracked||[];NC=o.newCases||[];S.updated=o.updated||'';S.calendar=!!o.calendar;\n S.scan=o.scan||null;S.groups=o.groups||{};S.lastScan=o.lastScan||{};S.log=o.log||[];\n}\nasync function load(quiet){\n if(!quiet){S.busy=true;render()}\n try{build(await api('state'));S.err='';S.ready=true}catch(e){S.err=e.message}\n S.busy=false;render();\n}\nasync function act(path,body,okMsg){\n try{await api(path,body);if(okMsg)toast(okMsg);await load(true);return true}catch(e){toast(e.message);return false}\n}\nasync function loadDocs(c,force){\n const k=c.key,cur=DOCS[k]||{};\n if(cur.loading||(cur.rows&&!force))return;\n DOCS[k]={loading:true,rows:cur.rows};render();\n try{const j=await api('docs?case='+encodeURIComponent(c.num)+(force?'&force=1':''));DOCS[k]={rows:j.rows||[],checked:j.checked}}\n catch(e){DOCS[k]={err:e.message,rows:cur.rows||[]}}\n render();\n}\nasync function loadDoc(id,text){\n const cur=DOC[id]||{};if(cur.loading)return;\n DOC[id]=Object.assign({},cur,{loading:true});render();\n try{const j=await api('doc?id='+encodeURIComponent(id)+(text?'&text=1':''));DOC[id]=Object.assign({},cur,j,{loading:false,err:''})}\n catch(e){DOC[id]=Object.assign({},cur,{loading:false,err:e.message})}\n render();\n}\n\n// ── скорочення для таблиць ──\nconst ORG=[[/товариство з обмеженою відповідальністю/gi,'ТОВ'],[/фізична особа[\\s-]*підприємець/gi,'ФОП'],[/приватне акціонерне товариство/gi,'ПрАТ'],[/публічне акціонерне товариство/gi,'ПАТ'],[/акціонерне товариство/gi,'АТ'],[/приватне підприємство/gi,'ПП'],[/комунальне підприємство/gi,'КП'],[/державне підприємство/gi,'ДП'],[/об'єднання співвласників багатоквартирного будинку/gi,'ОСББ']];\nconst fdS=d=>`${p2(d.getDate())}.${p2(d.getMonth()+1)}${d.getFullYear()===T0.getFullYear()?'':'.'+String(d.getFullYear()).slice(2)}, ${WD[d.getDay()]}`;\nconst sn=t=>ORG.reduce((x,[re,v])=>x.replace(re,v),String(t||'')).replace(/([А-ЯІЇЄҐ][а-яіїєґ'’ʼ-]+)\\s+([А-ЯІЇЄҐ])[а-яіїєґ'’ʼ-]+\\s+([А-ЯІЇЄҐ])[а-яіїєґ'’ʼ-]+/g,'$1 $2.$3.');\nconst sc=t=>String(t||'').replace(/міськрайонний суд/i,'міськрайсуд').replace(/районний суд/i,'райсуд').replace(/міський суд/i,'міськсуд').replace(/\\sміста\\s/,' м. ').replace(/області/,'обл.');\nconst cell=(v,cls)=>`<td${cls?` class=\"${cls}\"`:''} title=\"${esc(v)}\">${esc(v)}</td>`;\nconst tbl=(cols,rows)=>`<div class=\"tw\"><table class=\"tb\"><colgroup>${cols.map(c=>`<col style=\"width:${c[1]}\">`).join('')}</colgroup><thead><tr>${cols.map(c=>c[2]?`<th class=\"s${S.sort.k===c[2]?(S.sort.d>0?' up':' dn'):''}\" data-a=\"sort\" data-v=\"${c[2]}\" title=\"Сортувати\">${c[0]}</th>`:`<th>${c[0]}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;\nconst nextH=c=>c.ev.find(e=>left(e.d)>=0);\nconst nextD=c=>c.dl.filter(d=>!d.done).sort((a,b)=>a.due-b.due)[0];\nfunction listCases(){\n const q=S.q.trim().toLowerCase();\n let r=C.filter(c=>(S.filter==='all'||c.type===S.filter)&&(!q||[c.num,c.client,c.parties,c.subj,c.court,c.judge].join(' ').toLowerCase().includes(q)));\n if(WIDE.matches){const k=S.sort.k,d=S.sort.d,far=9e15;\n  const val=c=>k==='num'?c.num:k==='client'?c.client:k==='type'?TYPES[c.type]:k==='court'?c.court:k==='judge'?c.judge:k==='dl'?+((nextD(c)||{}).due||far):+((nextH(c)||{}).d||far);\n  r=r.slice().sort((a,b)=>{const x=val(a),y=val(b);return (typeof x==='string'?x.localeCompare(y,'uk'):x-y)*d})}\n return r;\n}\n\n// ── похідні списки ──\nconst byKey=k=>C.find(c=>c.key===k);\nconst hearings=()=>C.flatMap(c=>c.ev.filter(e=>left(e.d)>=0).map(e=>({c,e}))).sort((a,b)=>a.e.d-b.e.d||a.e.tm.localeCompare(b.e.tm));\nconst dls=()=>C.flatMap(c=>c.dl.filter(d=>!d.done).map(d=>({c,d}))).sort((a,b)=>a.d.due-b.d.due);\nconst mins=t=>{const[h,m]=String(t||'0:0').split(':');return h*60+ +m};\nfunction conflicts(hs){const r=[];for(let i=0;i<hs.length;i++)for(let j=i+1;j<hs.length;j++){const a=hs[i],b=hs[j];if(a.e.tm&&b.e.tm&&+a.e.d===+b.e.d&&a.e.court!==b.e.court&&a.c.key!==b.c.key&&Math.abs(mins(a.e.tm)-mins(b.e.tm))<120)r.push([a,b])}return r}\nfunction chip(n){const c=n<=2?'crit':n<=7?'warn':'ok';const t=n<0?`прострочено ${-n} дн.`:n===0?'сьогодні':n===1?'завтра':`${n} дн.`;return `<span class=\"chip ${c}\">${t}</span>`}\nconst dateBox=(d,tm)=>`<span class=\"date\"><b>${d.getDate()}</b>${MS[d.getMonth()]}${tm?`<u>${tm}</u>`:''}</span>`;\nconst hRow=({c,e},link=true)=>`<${link?'button data-a=\"open\" data-v=\"'+esc(c.key)+'\"':'div'} class=\"row\">${dateBox(e.d,e.tm)}<span class=\"main\">${link?`<b class=\"clamp\">${esc(c.client)}</b><small><span class=\"num\">${esc(c.num)}</span></small><small>${esc(e.court||c.court)}${e.rm?', '+esc(e.rm):''}</small>`:`<b>${esc(e.court||c.court)}</b>${e.rm?`<small>${esc(e.rm)}</small>`:''}<small>${fh(e.d)}${e.src==='man'?' · додано вручну або з документа':''}</small>`}${e.sure?'':'<small class=\"wr\">Збіг лише за ПІБ – перевірте</small>'}</span>${chip(left(e.d))}</${link?'button':'div'}>`;\nconst dRow=({c,d},showCase=true)=>`<div class=\"row${d.done?' done':''}\"><button class=\"chk${d.done?' on':''}\" data-a=\"dldone\" data-v=\"${esc(d.key)}\" aria-label=\"Позначити строк виконаним\"></button><button class=\"main\" data-a=\"open\" data-v=\"${esc(c.key)}\"><b>${esc(d.t)}</b><small>до ${fd(d.due)}${d.b?' · '+esc(d.b):''}</small>${showCase?`<small><span class=\"num\">${esc(c.num)}</span> · ${esc(c.client)}</small>`:''}</button>${d.done?'':chip(left(d.due))}</div>`;\nconst cRow=c=>{const h=c.ev.find(e=>left(e.d)>=0);return `<button class=\"row${S.cid===c.key?' cur':''}\" data-a=\"open\" data-v=\"${esc(c.key)}\"><span class=\"main\"><b class=\"clamp\">${esc(c.client)}</b><small><span class=\"num\">${esc(c.num)}</span> · ${TYPES[c.type]}${c.role?` · <span class=\"own\">${esc(c.role)}</span>`:''}</small>${c.subj?`<small class=\"clamp\">${esc(c.subj)}</small>`:''}<small class=\"${h?'hl':''}\">${h?`Засідання ${fd(h.d)}${h.tm?' о '+h.tm:''}`:'Засідання не призначено'}</small></span></button>`};\nconst GROUPS=[['kyiv','Київ і Київська область','районні та міськрайонні суди'],['gen_n','Загальні суди: Північ','Житомирська, Сумська, Чернігівська області'],['gen_w','Загальні суди: Захід','Волинська, Закарпатська, Івано-Франківська, Львівська, Рівненська, Тернопільська, Хмельницька, Чернівецька області'],['gen_s','Загальні суди: Південь','Запорізька, Миколаївська, Одеська, Херсонська області'],['gen_e','Загальні суди: Схід','Дніпропетровська, Донецька, Луганська, Харківська області'],['gen_c','Загальні суди: Центр','Вінницька, Кіровоградська, Полтавська, Черкаська області'],['app','Апеляційні суди','загальні апеляційні суди всіх областей'],['adm','Адміністративні суди','окружні та апеляційні'],['gos','Господарські суди','місцеві та апеляційні'],['other','Інші суди','поза переліком груп']];\nconst GMODES=[['always','Щоразу'],['rotate','По черзі'],['off','Не перевіряти']];\nconst gmode=id=>S.groups[id]||(id==='kyiv'?'always':'rotate');\nconst fts=ts=>{if(!ts)return '';const d=new Date(ts*1000);return `${p2(d.getDate())}.${p2(d.getMonth()+1)} ${p2(d.getHours())}:${p2(d.getMinutes())}`};\nconst nruns=n=>n+' '+(n%10===1&&n%100!==11?'прогін':(n%10>=2&&n%10<=4&&(n%100<12||n%100>14)?'прогони':'прогонів'));\nfunction etaRuns(n){const t=new Date();t.setMinutes(17,0,0);if(t<=new Date())t.setHours(t.getHours()+1);for(let g=0;g<400;g++){const h=t.getHours();if(h>=7&&h<=20){n--;if(n<=0)break}t.setHours(t.getHours()+1)}return t}\nconst scanShort=()=>S.scan?`Прогін ${fts(S.scan.ts)}: перевірено ${S.scan.ok} з ${S.scan.planned} судів`:'';\nconst cycleShort=()=>S.scan&&!S.scan.full&&S.scan.rotation?`Коло: ${S.scan.cursor} з ${S.scan.rotation}`:'';\nfunction scanLine(){const s=S.scan;if(!s)return '';return `Останній прогін ${fts(s.ts)}: перевірено ${s.ok} з ${s.planned} судів`+(s.failed?`, не відповіли ${s.failed}`:'')+(s.dead?`, пропущено як недоступні ${s.dead}`:'')+(s.cut?`, не встиг ${s.cut}`:'')+'.'}\nfunction cycleLine(){const s=S.scan;if(!s)return '';if(s.full)return 'Це був повний прогін: усі суди за раз.';if(!s.rotation)return '';const n=Math.ceil(Math.max(0,s.rotation-s.cursor)/(s.shard||70));return `Коло: пройдено ${s.cursor} з ${s.rotation} судів, що йдуть по черзі. До кінця кола ${nruns(n)}, приблизно до ${fts(etaRuns(n)/1000)}.`}\nfunction scanInfo(c){if(!S.scan)return '';const tc=S.scan.tracked_courts||{};let n=c.court&&c.court!=='Суд не визначено'?c.court:'';if(!n){const k=Object.keys(tc).find(x=>caseKey(x)===c.key);n=k?tc[k]:''}\n const ts=n&&S.lastScan[n];\n return `<div><dt>Перевірка</dt><dd>${ts?'Суд перевірено '+fts(ts):(n?esc(n)+': час перевірки ще не записано':'Суд цієї справи бот ще не визначив. Це станеться, коли до суду дійде черга.')}</dd></div>`}\nfunction vScan(){\n const s=S.scan,gs=(s&&s.groups)||[],own=(s&&s.own)||[],dead=(s&&s.dead_names)||[];\n return `<h2>Перевірка судів</h2><p class=\"empty\">${s?esc(scanLine()+' '+cycleLine()):'Лічильники з\\'являться після першого прогону оновленого бота.'}</p>\n <div class=\"duo\"><div><h2>Групи судів</h2><div class=\"list\">${GROUPS.map(([id,name,hint])=>{const g=gs.find(x=>x.id===id);if(id==='other'&&!(g&&g.total))return '';const m=gmode(id);\n  return `<div class=\"row\"><span class=\"main\"><b>${name}</b><small>${hint}${g?` · судів: ${g.total}`:''}${g&&g.planned?` · останній прогін: ${g.ok} з ${g.planned}`:''}</small></span><select class=\"field gsel\" data-g=\"${id}\" aria-label=\"Режим групи: ${name}\">${GMODES.map(([v,t])=>`<option value=\"${v}\"${v===m?' selected':''}>${t}</option>`).join('')}</select></div>`}).join('')}</div>\n <p class=\"empty\">Щоразу: у кожному прогоні. По черзі: частинами, повне коло за кілька прогонів. Не перевіряти: нових справ у цих судах бот не шукатиме. Зміна діє з наступного прогону.</p></div>\n <div><h2>Суди ваших справ (${own.length})</h2><div class=\"list\">${own.map(n=>`<div class=\"row\"><span class=\"main\"><b>${esc(n)}</b><small>${S.lastScan[n]?'перевірено '+fts(S.lastScan[n]):'час перевірки ще не записано'}</small></span></div>`).join('')||'<p class=\"empty\">Поки порожньо.</p>'}</div>\n <p class=\"empty\">Суди, де є ваші засідання або справа на стеженні за номером. Перевіряються щоразу, навіть якщо їхню групу вимкнено.</p>\n ${dead.length?`<details class=\"dead\"><summary>Не відповідають кілька прогонів поспіль (${dead.length})</summary><p class=\"empty\">${dead.map(esc).join(', ')}</p></details>`:''}</div></div>`;\n}\nconst fresh=()=>`<div class=\"fresh${S.err?' bad':''}\"><i></i><span>${S.err?esc(S.err):`Бот оновив перелік ${S.updated?esc(S.updated):'(час невідомий)'}. ${scanShort()?esc(scanShort())+'. ':''}Дату й час засідання звіряйте з ЄСІТС.`}</span><button class=\"btn ghost sm\" data-a=\"reload\"${S.busy?' disabled':''}>Оновити</button></div>`;\n\n// ── екрани ──\nfunction vLogin(){\n return `<div class=\"login\"><p class=\"eyebrow\">Адвокат Осадько О.О.</p><h1>Мої судові справи</h1><p>Введіть пароль застосунку. Він зберігається у воркері бота, а на цьому пристрої лишається тільки ключ сеансу.</p>\n <form data-f=\"login\" class=\"list\"><input class=\"field\" id=\"pw\" type=\"password\" autocomplete=\"current-password\" placeholder=\"Пароль\" aria-label=\"Пароль\" required><button class=\"btn\"${S.busy?' disabled':''}>Увійти</button></form>\n ${S.err?`<p class=\"err\">${esc(S.err)}</p>`:''}</div>`;\n}\nfunction vToday(){\n const hs=hearings(),ds=dls(),hot=ds.filter(x=>left(x.d.due)<=7),cf=conflicts(hs);\n return `<header class=\"top\"><p class=\"eyebrow\">${fh(T0)}</p><h1>Сьогодні</h1></header>${fresh()}\n <div class=\"tiles\"><div class=\"tile\"><b>${hs.filter(h=>left(h.e.d)<=7).length}</b><span>засідань за 7 днів</span></div><div class=\"tile${hot.length?' hot':''}\"><b>${hot.length}</b><span>строків за 7 днів</span></div><div class=\"tile${NC.length?' hot':''}\"><b>${NC.length}</b><span>нових справ</span></div></div>\n <div class=\"cols\"><div class=\"c-alerts\">${cf.map(([a,b])=>`<div class=\"alert\"><b>Накладка засідань ${fd(a.e.d)}</b>${a.e.tm} ${esc(a.e.court||a.c.court)} та ${b.e.tm} ${esc(b.e.court||b.c.court)}. Подайте клопотання про відкладення або участь у режимі відеоконференції.</div>`).join('')}\n ${NC.length?`<h2>Нові справи</h2><div class=\"list\">${NC.map(n=>`<div class=\"card\"><b><span class=\"num\">${esc(n.number)}</span></b><p>${esc(n.court)}${n.judge?' · '+esc(n.judge):''}</p>${n.involved?`<p>${esc(n.involved)}</p>`:''}${n.description?`<p>${esc(n.description)}</p>`:''}<p>Бот знайшов ${esc(n.found)}${n.date?'. Найближче засідання '+esc(n.date):''}</p>${n.reliable?'':'<p style=\"color:var(--warn)\">Збіг лише за ПІБ – перевірте, чи це ваш клієнт.</p>'}<div class=\"acts\">${byKey(caseKey(n.number))?`<button class=\"btn ghost sm\" data-a=\"open\" data-v=\"${esc(caseKey(n.number))}\">Відкрити справу</button>`:''}<button class=\"btn ghost sm\" data-a=\"ncdone\" data-v=\"${esc(n.key)}\">Переглянуто</button></div></div>`).join('')}</div>`:''}</div>\n <div class=\"c-hear\"><h2>Найближчі засідання</h2><div class=\"list\">${hs.slice(0,WIDE.matches?40:6).map(x=>hRow(x)).join('')||'<p class=\"empty\">Засідань не знайдено.</p>'}</div></div>\n <div class=\"c-dl\"><h2>Строки на цьому тижні</h2><div class=\"list\">${hot.map(x=>dRow(x)).join('')||'<p class=\"empty\">Найближчі 7 днів без строків.</p>'}</div></div></div>`;\n}\nfunction caseList(){\n const r=listCases();\n if(!r.length)return `<p class=\"empty\">${C.length?'Нічого не знайдено. Перевірте номер або прізвище.':'Справ поки немає. Додайте клієнтів чи номери справ у «Моніторингу».'}</p>`;\n if(!WIDE.matches)return r.map(cRow).join('');\n return tbl([['№ справи','12%','num'],['Клієнт / сторони','23%','client'],['Вид','13%','type'],['Суд','20%','court'],['Суддя','11%','judge'],['Засідання','12%','next'],['Строк','9%','dl']],\n  r.map(c=>{const h=nextH(c),d=nextD(c);return `<tr style=\"--tc:var(--t-${c.type})\" data-a=\"open\" data-v=\"${esc(c.key)}\">${cell(c.num,'num')}<td class=\"b\" title=\"${esc(c.parties||c.client)}\">${c.role?'':`<span class=\"own${c.tracked?'':' chk1'}\" title=\"${c.tracked?'Ви стежите за цією справою за номером':'Бот знайшов справу за ПІБ клієнта, а не за вашим прізвищем. Можливий збіг імен: перевірте, чи це ваш клієнт'}\">${c.tracked?'стежу':'перевірити'}</span> `}${esc(sn(c.client))}</td><td><span class=\"ty\">${TYPES[c.type]}</span></td>${cell(sc(c.court))}${cell(sn(c.judge),'m')}<td>${h?`${fdS(h.d)}${h.tm?' · '+h.tm:''}`:'<span class=\"m\" style=\"color:var(--muted)\">не призначено</span>'}</td><td>${d?`<span style=\"color:var(--${left(d.due)<=2?'crit':left(d.due)<=7?'warn':'text'})\" title=\"${esc(d.t)}\">${fd(d.due)}</span>`:''}</td></tr>`}));\n}\nfunction vCases(){\n return `<header class=\"top\"><p class=\"eyebrow\">${C.length} у роботі</p><h1>Справи</h1></header>\n <input class=\"field\" id=\"q\" type=\"search\" placeholder=\"Номер, клієнт, сторона або суд\" value=\"${esc(S.q)}\" aria-label=\"Пошук у справах\">\n <div class=\"filters\">${[['all','Усі'],['civ','Цивільні'],['com','Господарські'],['crim','Кримінальні'],['adm','КУпАП'],['admj','Адміністративні']].map(([k,t])=>`<button class=\"${S.filter===k?'on':''}\" data-a=\"filter\" data-v=\"${k}\">${t}</button>`).join('')}</div>\n <div class=\"list\" id=\"caselist\">${caseList()}</div>\n <button class=\"btn\" data-a=\"sheet\" data-v=\"case\">Стежити за справою за номером</button>`;\n}\nfunction docRow(c,d){\n const pend=(d.findings||[]).filter((f,i)=>!(d.applied||[]).includes(i));\n return `<button class=\"row\" data-a=\"doc\" data-v=\"${esc(d.id)}\"><span class=\"main\"><b>${esc(d.form)} від ${esc(d.date)}</b>${(d.labels||[]).length?`<small class=\"hl\">${esc(d.labels.join(' · '))}</small>`:''}<small>${esc(d.court)}${d.judge?' · '+esc(d.judge):''}</small>${pend.length?`<small class=\"wr\">Є дані для внесення: ${esc(pend.map(f=>f.title).join(', '))}</small>`:''}</span></button>`;\n}\nfunction vCase(c){\n const up=c.ev.filter(e=>left(e.d)>=0),D=DOCS[c.key]||{};\n return `<button class=\"back\" data-a=\"back\">‹ Назад</button>\n <header class=\"top\"><p class=\"eyebrow\"><span class=\"num\">№ ${esc(c.num)}</span> · ${TYPES[c.type]}</p><h1>${esc(c.client)}</h1>${c.subj?`<p class=\"eyebrow\">${esc(c.subj)}</p>`:''}</header>\n <div class=\"cols2\"><div class=\"k-a\"><dl class=\"meta\"><div><dt>Суд</dt><dd>${esc(c.court)}</dd></div><div><dt>Суддя</dt><dd>${esc(c.judge)}</dd></div>${scanInfo(c)}${c.parties?`<div><dt>Сторони</dt><dd>${esc(c.parties)}</dd></div>`:''}</dl>\n <div class=\"acts\"><button class=\"btn ghost sm\" data-a=\"copy\" data-v=\"${esc(c.key)}\">Скопіювати реквізити</button><button class=\"btn ghost sm\" data-a=\"sheet\" data-v=\"hear\">Додати засідання</button></div>\n <h2>Засідання</h2><div class=\"list\">${up.map(e=>hRow({c,e},false)+(e.src==='cli'&&!e.sure?`<button class=\"btn ghost sm\" data-a=\"gcal\" data-v=\"${c.ev.indexOf(e)}\">Це мій клієнт – додати в календар</button>`:'')).join('')||'<p class=\"empty\">Не призначено. Щойно дата з\\'явиться на сайті суду, бот її знайде.</p>'}</div></div>\n <div class=\"k-b\"><h2>Документи суду${D.rows?` (${D.rows.length})`:''}</h2><div class=\"list\">${(D.rows||[]).map(d=>docRow(c,d)).join('')}\n ${D.loading?'<div class=\"row\"><span class=\"spin\"></span><span class=\"main\"><small>Шукаю в реєстрі судових рішень</small></span></div>':''}\n ${D.err?`<p class=\"err\">${esc(D.err)}</p><a class=\"btn ghost sm\" href=\"https://reyestr.court.gov.ua/\" target=\"_blank\" rel=\"noopener\">Відкрити пошук у реєстрі</a>`:''}\n ${D.rows&&!D.rows.length&&!D.loading&&!D.err?'<p class=\"empty\">У реєстрі рішень у цій справі поки нічого немає.</p>':''}\n ${D.loading?'':'<button class=\"btn ghost sm\" data-a=\"docs\">Оновити з реєстру</button>'}</div></div>\n <div class=\"k-c\"><h2>Процесуальні строки</h2><div class=\"list\">${c.dl.map(d=>dRow({c,d},false)+`<button class=\"btn danger sm\" data-a=\"dldel\" data-v=\"${esc(d.key)}\">Видалити строк «${esc(d.t)}»</button>`).join('')||'<p class=\"empty\">Строків немає.</p>'}</div>\n <button class=\"btn ghost sm\" data-a=\"sheet\" data-v=\"dl\">Розрахувати новий строк</button>\n <h2>Стеження</h2>${c.tracked?`<button class=\"btn danger sm\" data-a=\"untrack\" data-v=\"${esc(c.num)}\">Припинити стеження за номером</button>`:`<button class=\"btn ghost sm\" data-a=\"track\" data-v=\"${esc(c.num)}\">Стежити за цією справою за номером</button>`}\n <p class=\"empty\">Засідання у справах під наглядом за номером бот додає в календар сам.</p></div></div>`;\n}\nfunction vDoc(c,id){\n const row=((DOCS[c.key]||{}).rows||[]).find(d=>d.id===id)||{id},X=DOC[id]||{},labels=X.labels||row.labels||[],fnd=X.findings||row.findings||[],applied=X.applied||row.applied||[];\n const url='https://reyestr.court.gov.ua/Review/'+encodeURIComponent(id);\n return `${WIDE.matches?navBar(c,true):`<button class=\"back\" data-a=\"docback\">‹ ${esc(c.num)}</button>`}\n <header class=\"top\"><p class=\"eyebrow\">Документ суду</p><h1>${esc(row.form||'Документ')}${row.date?' від '+esc(row.date):''}</h1></header>\n <dl class=\"meta\"><div><dt>Справа</dt><dd class=\"num\">${esc(row.caseNo||c.num)}</dd></div>${row.court?`<div><dt>Суд</dt><dd>${esc(row.court)}</dd></div>`:''}${row.judge?`<div><dt>Суддя</dt><dd>${esc(row.judge)}</dd></div>`:''}${row.inForce?`<div><dt>Набрання сили</dt><dd>${esc(row.inForce)}</dd></div>`:''}\n <div><dt>Реєстр</dt><dd><a href=\"${url}\" target=\"_blank\" rel=\"noopener\">${url}</a></dd></div></dl>\n ${labels.length?`<h2>Суть</h2><div class=\"list\">${labels.map(l=>`<div class=\"row\"><span class=\"main\"><b>${esc(l)}</b></span></div>`).join('')}</div>`:''}\n ${fnd.length?`<h2>Знайдено в документі</h2><div class=\"list\">${fnd.map((f,i)=>`<div class=\"card\"><b>${esc(f.kind==='deadline'?f.title+': '+f.days+' дн.':f.title)}</b><p>${esc(f.detail)}</p>${applied.includes(i)?'<span class=\"chip ok\" style=\"align-self:flex-start\">внесено</span>':`<button class=\"btn ghost sm\" data-a=\"apply\" data-v=\"${i}\">${f.kind==='hearing'?'Додати засідання в справу й календар':'Розрахувати й додати строк'}</button>`}</div>`).join('')}</div><p class=\"empty\">Розпізнано автоматично з резолютивної частини. Перевірте за текстом, перш ніж вносити.</p>`:''}\n <h2>Резолютивна частина</h2>${X.loading&&!X.excerpt?'<div class=\"row\"><span class=\"spin\"></span><span class=\"main\"><small>Завантажую текст із реєстру</small></span></div>':X.excerpt?`<div class=\"card\"><p class=\"text\">${esc(X.excerpt)}</p></div>`:X.err?`<p class=\"err\">${esc(X.err)} Відкрийте документ у реєстрі за посиланням вище.</p>`:'<p class=\"empty\">Не вдалося виділити резолютивну частину.</p>'}\n <h2>Повний текст</h2>${X.text?`<div class=\"card\"><p class=\"text\">${esc(X.text)}</p></div>`:X.loading?'<p class=\"empty\">Завантажую.</p>':'<button class=\"btn ghost sm\" data-a=\"doctext\">Показати повний текст</button>'}`;\n}\nfunction vCal(){\n const y=S.calM.getFullYear(),m=S.calM.getMonth(),off=(new Date(y,m,1).getDay()+6)%7,n=new Date(y,m+1,0).getDate();\n const hs=hearings().filter(x=>x.e.d.getFullYear()===y&&x.e.d.getMonth()===m),ds=dls().filter(x=>x.d.due.getFullYear()===y&&x.d.due.getMonth()===m);\n const days=new Map();\n const day=d=>{const k=+d;if(!days.has(k))days.set(k,{d,hs:[],ds:[]});return days.get(k)};\n hs.forEach(x=>day(x.e.d).hs.push(x));ds.forEach(x=>day(x.d.due).ds.push(x));\n let cells='';\n for(let i=0;i<off;i++)cells+='<span></span>';\n for(let i=1;i<=n;i++){const d=new Date(y,m,i),g=days.get(+d),hh=g&&g.hs.length,dd=g&&g.ds.length;\n  cells+=`<button class=\"${+d===+T0?'today ':''}${S.calD&&+d===+S.calD?'sel':''}\" data-a=\"calday\" data-v=\"${+d}\" aria-label=\"${fh(d)}${hh?', засідань: '+hh:''}${dd?', строків: '+dd:''}\">${i}${hh||dd?`<i class=\"${hh&&dd?'both':dd?'d':''}\"></i><span class=\"evs\">${g.hs.slice(0,3).map(x=>`<em style=\"border-left-color:var(--t-${x.c.type})\">${x.e.tm?x.e.tm+' ':''}${esc(x.c.client)}</em>`).join('')}${g.ds.slice(0,2).map(x=>`<em class=\"d\">${esc(x.d.t)}</em>`).join('')}${g.hs.length+g.ds.length>5?`<em>ще ${g.hs.length+g.ds.length-5}</em>`:''}</span>`:''}</button>`}\n const cur=y===T0.getFullYear()&&m===T0.getMonth();\n const list=[...days.values()].sort((a,b)=>a.d-b.d).filter(g=>!S.calD||+g.d===+S.calD);\n const rel=d=>{const k=left(d);return k===0?'сьогодні':k===1?'завтра':k>0?`через ${k} дн.`:`${-k} дн. тому`};\n return `<header class=\"top\"><p class=\"eyebrow\">Засідань у місяці: ${hs.length} · строків: ${ds.length}</p><h1>Календар</h1></header>\n <div class=\"calwrap\"><div class=\"cal\"><div class=\"calhead\"><button data-a=\"calnav\" data-v=\"-1\" aria-label=\"Попередній місяць\">‹</button><b>${MN[m]} ${y}</b><button data-a=\"calnav\" data-v=\"1\" aria-label=\"Наступний місяць\">›</button></div>\n <div class=\"grid\">${['пн','вт','ср','чт','пт','сб','нд'].map(w=>`<span>${w}</span>`).join('')}${cells}</div>\n <div class=\"legend\"><span><i></i>засідання</span><span><i class=\"d\"></i>строк</span>${cur?'':'<button class=\"lnk\" data-a=\"caltoday\">До поточного місяця</button>'}${S.calD?'<button class=\"lnk\" data-a=\"calall\">Увесь місяць</button>':''}</div></div>\n <div class=\"agenda\">${list.map(g=>`<h3 class=\"day${+g.d===+T0?' now':''}\"><b>${fh(g.d)}</b><span>${rel(g.d)}</span></h3><div class=\"list\">${g.hs.map(x=>hRow(x)).join('')}${g.ds.map(x=>dRow(x)).join('')}</div>`).join('')\n  ||`<p class=\"empty\">${S.calD?'На '+fh(S.calD)+' нічого не заплановано.':'У цьому місяці засідань і строків немає.'}</p>`}</div></div>`;\n}\nfunction vDl(){\n const ds=dls(),done=C.flatMap(c=>c.dl.filter(d=>d.done).map(d=>({c,d})));\n return `<header class=\"top\"><p class=\"eyebrow\">${ds.length} активних</p><h1>Строки</h1></header>\n <button class=\"btn\" data-a=\"sheet\" data-v=\"dlnew\" style=\"align-self:flex-start\">Додати строк</button>\n <div class=\"duo\"><div><h2>Активні</h2><div class=\"list\">${ds.map(x=>dRow(x)).join('')||'<p class=\"empty\">Активних строків немає. Додайте строк кнопкою вище, з картки справи або з документа суду.</p>'}</div></div>\n <div><h2>Виконано</h2><div class=\"list\">${done.map(x=>dRow(x)).join('')||'<p class=\"empty\">Поки нічого.</p>'}</div></div></div>\n <p class=\"empty\">Рахуються календарні дні. Якщо останній день випав на суботу чи неділю, строк перенесено на понеділок. Святкові дні не враховано.</p>`;\n}\nconst SRC={cron:'за розкладом',app:'вручну із застосунку',tg:'вручну з Telegram'};\nconst durS=n=>n?`${Math.floor(n/60)} хв ${p2(Math.round(n%60))} с`:'';\nfunction fold(k,title,sum,body){const on=S.mon===k;return `<section class=\"fold${on?' on':''}\"><button class=\"fh\" data-a=\"fold\" data-v=\"${k}\" aria-expanded=\"${on}\"><b>${title}</b><span>${sum}</span><i>${on?'згорнути':'розгорнути'}</i></button>${on?`<div class=\"fb\">${body}</div>`:''}</section>`}\nfunction vMon(){\n const s=S.scan,gs=(s&&s.groups)||[],own=(s&&s.own)||[],dead=(s&&s.dead_names)||[],L=(S.log||[]).slice().reverse();\n const rows=GROUPS.filter(([id])=>id!=='other'||gs.some(x=>x.id==='other'&&x.total)).map(g=>({g,m:gmode(g[0]),st:gs.find(x=>x.id===g[0])}));\n const cntM=m=>rows.filter(x=>x.m===m).length,SEG=[['always','Щоразу'],['rotate','По черзі'],['off','Ні']];\n const bGroups=`<div>${rows.map(({g:[id,name,hint],m,st})=>`<div class=\"grow\"><span class=\"main\"><b>${name}</b><small>${hint}${st?` · судів: ${st.total}`:''}</small></span><span class=\"gl\">${m==='off'?'<small>вимкнено</small>':st&&st.planned?`<span class=\"bar\" aria-hidden=\"true\"><i style=\"width:${Math.round(st.ok/st.planned*100)}%\"></i></span><span class=\"num\">${st.ok} з ${st.planned}</span>`:'<small>в останньому прогоні не перевірялась</small>'}</span><span class=\"seg\" role=\"group\" aria-label=\"Режим групи: ${name}\">${SEG.map(([v,t])=>`<button class=\"${v===m?'on '+v:''}\" data-a=\"gmode\" data-g=\"${id}\" data-v=\"${v}\" aria-pressed=\"${v===m}\">${t}</button>`).join('')}</span></div>`).join('')}</div>\n <p class=\"empty\">Щоразу: у кожному прогоні. По черзі: частинами, повне коло за кілька прогонів. Ні: нових справ у цих судах бот не шукатиме. Зміна діє з наступного прогону.</p>`;\n const dayK=ts=>{const d=new Date(ts*1000);d.setHours(0,0,0,0);return +d},dayL=k=>{const n=Math.round((+T0-k)/864e5);return n===0?'сьогодні':n===1?'вчора':fh(new Date(k))};\n let prev=null;\n const bLog=L.length?L.map(e=>{const k=dayK(e.ts),d=new Date(e.ts*1000),h=k!==prev?`<h3 class=\"day\"><b>${dayL(k)}</b></h3>`:'';prev=k;\n  return `${h}<div class=\"lrow\"><b class=\"tm\">${p2(d.getHours())}:${p2(d.getMinutes())}</b><span class=\"main\"><span>${SRC[e.src]||'запуск із GitHub'}${e.full?' · повний прогін':''}</span><small>${durS(e.dur)}</small></span><span class=\"gl wide\"><span class=\"bar\" aria-hidden=\"true\"><i style=\"width:${e.planned?Math.round(e.ok/e.planned*100):0}%\"></i></span><span class=\"num\">${e.ok} з ${e.planned}</span></span>${e.failed?`<small class=\"wr\">не відповіли: ${e.failed}</small>`:''}</div>`}).join('')+'<p class=\"empty\">Час у журналі показує завершення прогону. Зберігаються прогони за останні 7 днів.</p>'\n  :'<p class=\"empty\">Журнал почне наповнюватися з наступного прогону. Попередні прогони в нього не потрапляють.</p>';\n const today=L.filter(e=>dayK(e.ts)===+T0).length;\n const few=(a,f)=>a.length?`${a.length}: ${a.slice(0,3).map(f).join(', ')}${a.length>3?` та ще ${a.length-3}`:''}`:'список порожній';\n const bNames=`<div class=\"tags\">${W.map(w=>`<span class=\"tag\">${esc(w)}<button data-a=\"unname\" data-v=\"${esc(w)}\" aria-label=\"Прибрати: ${esc(w)}\" title=\"Прибрати\">✕</button></span>`).join('')||'<p class=\"empty\">Список порожній.</p>'}</div>\n <form class=\"inline\" data-f=\"name\"><input class=\"field\" id=\"newname\" placeholder=\"Прізвище Ім'я По батькові\" aria-label=\"ПІБ клієнта\" required><button class=\"btn sm\">Додати</button></form>`;\n const bNums=`<div class=\"tags\">${TR.map(n=>`<span class=\"tag num\">${esc(n)}<button data-a=\"untrack\" data-v=\"${esc(n)}\" aria-label=\"Не стежити: ${esc(n)}\" title=\"Прибрати\">✕</button></span>`).join('')||'<p class=\"empty\">Список порожній.</p>'}</div>\n <form class=\"inline\" data-f=\"track\"><input class=\"field num\" id=\"newnum\" placeholder=\"757/12345/26-ц\" aria-label=\"Номер справи\" required><button class=\"btn sm\">Стежити</button></form>`;\n const bOwn=`<div>${own.map(n=>`<div class=\"grow\"><span class=\"main\"><b>${esc(n)}</b></span><small>${S.lastScan[n]?'перевірено '+fts(S.lastScan[n]):'час перевірки ще не записано'}</small></div>`).join('')||'<p class=\"empty\">Поки порожньо.</p>'}</div>\n <p class=\"empty\">Суди, де є ваші засідання або справа на стеженні за номером. Перевіряються щоразу, навіть якщо їхню групу вимкнено.</p>`;\n return `<header class=\"top\"><p class=\"eyebrow\">Кого й де шукає бот</p><h1>Моніторинг</h1></header>\n <div class=\"strip${S.err?' bad':''}\"><i></i>${S.err?`<span>${esc(S.err)}</span>`:s?`<b>Останній прогін ${fts(s.ts)}</b><span>перевірено ${s.ok} із ${s.planned} судів${s.failed?`, не відповіли ${s.failed}`:''}</span>${!s.full&&s.rotation?`<span>коло ${s.cursor} із ${s.rotation}</span>`:''}<span>наступний ${fts(etaRuns(1)/1000)}</span>`:'<span>Лічильники зʼявляться після першого прогону.</span>'}<button class=\"btn sm\" data-a=\"scan\">Запустити прогін</button></div>\n <div class=\"folds\">\n ${fold('log','Журнал прогонів',L.length?`сьогодні: ${today} · останній ${fts(L[0].ts)}${SRC[L[0].src]?', '+SRC[L[0].src]:''}`:'ще порожній',bLog)}\n ${fold('groups','Групи судів',`<span class=\"ty\" style=\"--tc:var(--ok)\">щоразу: ${cntM('always')}</span><span class=\"ty\" style=\"--tc:var(--acc)\">по черзі: ${cntM('rotate')}</span><span class=\"ty\">вимкнено: ${cntM('off')}</span>`,bGroups)}\n ${fold('names','Клієнти',few(W,w=>esc(sn(w))),bNames)}\n ${fold('nums','Справи за номером',few(TR,esc),bNums)}\n ${fold('own','Суди моїх справ',own.length?`судів: ${own.length}, перевіряються щоразу`:'поки порожньо',bOwn)}\n ${dead.length?fold('dead','Не відповідають',`судів: ${dead.length}, недоступні кілька прогонів поспіль`,`<p class=\"empty\">${dead.map(esc).join(', ')}</p>`):''}\n </div>\n <p class=\"empty\">Після позачергового прогону натисніть «Оновити» на екрані «Сьогодні».</p>\n <div class=\"acts mobonly\"><button class=\"btn ghost sm\" data-a=\"theme\">${theme.eff()==='dark'?'Денна тема':'Нічна тема'}</button><button class=\"btn danger sm\" data-a=\"logout\">Вийти</button></div>`;\n}\nfunction sheet(){\n if(!S.sheet)return '';const c=byKey(S.cid);let b='';\n if(S.sheet==='case')b=`<h3>Стежити за справою</h3><form data-f=\"track\" style=\"display:contents\"><label>Номер справи<input class=\"field num\" id=\"newnum\" placeholder=\"757/12345/26-ц\" required></label><p>Бот шукатиме засідання в цій справі в усіх судах незалежно від ПІБ у сторонах і додаватиме їх у календар.</p><button class=\"btn\">Стежити</button></form>`;\n if(S.sheet==='dl'&&c){const list=(S.preset?[[S.preset.title,S.preset.days,S.preset.basis]]:[]).concat(TPL[c.type]||TPL.civ);\n  b=`<h3>Новий строк</h3><form data-f=\"dl\" style=\"display:contents\"><label>Що подаємо<select class=\"field\" id=\"dltpl\">${list.map((t,i)=>`<option value=\"${i}\">${esc(t[0])} · ${t[1]} днів</option>`).join('')}</select></label><label>Від якої дати рахуємо<input class=\"field\" id=\"dlfrom\" type=\"date\" value=\"${iso(T0)}\" required></label><p>Останній день, що припав на суботу чи неділю, переноситься на понеділок. Шаблони звірте з чинною редакцією кодексу. Строк потрапить у Google Календар з нагадуваннями за 3 дні та напередодні.</p><button class=\"btn\">Розрахувати й додати</button></form>`}\n if(S.sheet==='dlnew'){const names=[...new Set(Object.values(TPL).flat().map(t=>t[0]))],d15=plus(T0,15);\n  b=C.length?`<h3>Новий строк</h3><form data-f=\"dlnew\" style=\"display:contents\"><label>Справа<select class=\"field\" id=\"dncase\">${C.map(x=>`<option value=\"${esc(x.num)}\">${esc(x.num)} · ${esc(x.client.slice(0,60))}</option>`).join('')}</select></label><label>Що подаємо<input class=\"field\" id=\"dntitle\" list=\"dnlist\" placeholder=\"Відзив на позов\" required maxlength=\"120\"><datalist id=\"dnlist\">${names.map(n=>`<option value=\"${esc(n)}\">`).join('')}</datalist></label><label>Останній день строку<input class=\"field\" id=\"dndate\" type=\"date\" value=\"${iso(d15)}\" required></label><p>Якщо строк треба порахувати від дати за шаблоном, відкрийте картку справи й натисніть «Розрахувати новий строк». Строк потрапить у Google Календар з нагадуваннями за 3 дні та напередодні.</p><button class=\"btn\">Додати</button></form>`\n   :'<h3>Новий строк</h3><p>Спершу додайте справу: строк прив\\'язується до номера справи.</p>'}\n if(S.sheet==='hear'&&c)b=`<h3>Нове засідання</h3><form data-f=\"hear\" style=\"display:contents\"><label>Дата<input class=\"field\" id=\"hdate\" type=\"date\" value=\"${iso(we(new Date(T0.getFullYear(),T0.getMonth(),T0.getDate()+7)))}\" required></label><label>Час<input class=\"field\" id=\"htime\" type=\"time\" value=\"10:00\" required></label><label>Зал<input class=\"field\" id=\"hroom\" placeholder=\"5\"></label><p>Засідання з'явиться в справі й потрапить у Google Календар.</p><button class=\"btn\">Додати</button></form>`;\n return `<div class=\"shade\" data-a=\"close\"><div class=\"sheet\" role=\"dialog\" aria-modal=\"true\">${b}<button class=\"btn ghost\" data-a=\"close\" type=\"button\">Скасувати</button></div></div>`;\n}\nconst FILTERS=[['all','Усі'],['civ','Цивільні'],['com','Господарські'],['crim','Кримінальні'],['adm','КУпАП'],['admj','Адміністративні']];\nfunction wCases(){\n return `<header class=\"top\"><p class=\"eyebrow\">${C.length} у роботі · клацніть рядок, щоб відкрити справу; заголовок колонки сортує</p><h1>Справи</h1></header>\n <div class=\"toolbar\"><input class=\"field\" id=\"q\" type=\"search\" placeholder=\"Номер, клієнт, сторона, суд або суддя\" value=\"${esc(S.q)}\" aria-label=\"Пошук у справах\">\n <div class=\"filters\">${FILTERS.map(([k,t])=>`<button class=\"${S.filter===k?'on':''}\" data-a=\"filter\" data-v=\"${k}\">${t}</button>`).join('')}</div>\n <button class=\"btn\" data-a=\"sheet\" data-v=\"case\">Стежити за справою</button></div>\n <div id=\"caselist\" class=\"fill\">${caseList()}</div>`;\n}\nconst hearCols=[['Дата','11%'],['Час','6%'],['№ справи','12%'],['Клієнт / сторони','25%'],['Суд','24%'],['Зал','6%'],['Суддя','10%'],['Через','6%']];\nconst hearTr=({c,e})=>`<tr data-a=\"open\" data-v=\"${esc(c.key)}\"><td>${fdS(e.d)}</td><td class=\"b\">${e.tm||'–'}</td>${cell(c.num,'num')}<td class=\"b\" title=\"${esc(c.parties||c.client)}\">${esc(sn(c.client))}${e.sure?'':' <span class=\"wr\" style=\"font-weight:400\">· збіг за ПІБ</span>'}</td>${cell(sc(e.court||c.court))}${cell((e.rm||'').replace('зал/каб. ',''),'m')}${cell(sn(c.judge),'m')}<td class=\"act\">${chip(left(e.d))}</td></tr>`;\nconst dlCols=[['','4%'],['Останній день','12%'],['Через','9%'],['Що подаємо','24%'],['№ справи','12%'],['Клієнт / сторони','20%'],['Примітка','15%'],['','4%']];\nconst dlTr=({c,d})=>`<tr class=\"${d.done?'done':''}\" data-a=\"open\" data-v=\"${esc(c.key)}\"><td class=\"act\"><button class=\"chk${d.done?' on':''}\" data-a=\"dldone\" data-v=\"${esc(d.key)}\" aria-label=\"Позначити строк виконаним\"></button></td><td>${fdS(d.due)}</td><td class=\"act\">${d.done?'виконано':chip(left(d.due))}</td>${cell(d.t,'b')}${cell(c.num,'num')}${cell(sn(c.client))}${cell(d.b,'m')}<td class=\"act\"><button class=\"x\" data-a=\"dldel\" data-v=\"${esc(d.key)}\" aria-label=\"Видалити строк\" title=\"Видалити строк\">✕</button></td></tr>`;\nfunction wToday(){\n const hs=hearings(),ds=dls(),hot=ds.filter(x=>left(x.d.due)<=7),cf=conflicts(hs),nx=hs[0],s=S.scan;\n const WDF=['Неділя','Понеділок','Вівторок','Середа','Четвер','Пʼятниця','Субота'];\n const rel=d=>{const k=left(d);return k===0?'сьогодні':k===1?'завтра':`через ${k} дн.`};\n const cnt=n=>n===0?'вільно':n+' засід.';\n const pct=(a,b)=>b?Math.max(2,Math.min(100,Math.round(a/b*100))):0;\n const week=[...Array(7)].map((_,i)=>{const d=new Date(T0.getFullYear(),T0.getMonth(),T0.getDate()+i);const hh=hs.filter(h=>+h.e.d===+d);return {d,n:hh.length,hh}});\n const days=[];hs.forEach(h=>{const g=days[days.length-1];if(g&&+g.d===+h.e.d)g.hs.push(h);else days.push({d:h.e.d,hs:[h]})});\n const room=e=>(e.rm||'').replace('зал/каб. ','зал ');\n const warn='<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M12 3l9.5 17h-19z\"/><path d=\"M12 10v4M12 17.5v.5\"/></svg>';\n const cf7=cf.filter(([a])=>left(a.e.d)<=7).length;let ord=0;\n return `<header class=\"top\"><p class=\"eyebrow\">${fh(T0)}</p><h1>Сьогодні</h1></header>\n <div class=\"tg-top\">${nx?`<button class=\"nx\" style=\"--tc:var(--t-${nx.c.type})\" data-a=\"open\" data-v=\"${esc(nx.c.key)}\"><span class=\"lb\">Наступне засідання</span><span class=\"big\">${left(nx.e.d)<=1?rel(nx.e.d):fdS(nx.e.d)}${nx.e.tm?', '+nx.e.tm:''}</span><b title=\"${esc(nx.c.parties||nx.c.client)}\">${esc(sn(nx.c.client))}</b><small><span class=\"ty\">${TYPES[nx.c.type]}</span> · ${esc(sc(nx.e.court||nx.c.court))}${nx.e.rm?', '+esc(room(nx.e)):''}</small></button>`:`<div class=\"nx\"><span class=\"lb\">Наступне засідання</span><span class=\"big\">немає</span><small>Засідань не знайдено.</small></div>`}\n <div class=\"wk\">${week.map(({d,n,hh},i)=>`<div class=\"${i?'':'now '}${n?'on':''}\" style=\"--i:${i}\"><small>${i?WD[d.getDay()]:'сьогодні'}</small><b>${d.getDate()}</b><span title=\"Засідань: ${n}\">${cnt(n)}</span><span class=\"dots\" aria-hidden=\"true\">${hh.slice(0,6).map(h=>`<i style=\"--tc:var(--t-${h.c.type})\"></i>`).join('')}</span></div>`).join('')}</div></div>\n <div class=\"today3\"><div class=\"fill\">${days.map(g=>{const c2=cf.filter(([a])=>+a.e.d===+g.d),k=left(g.d);\n  return `<h2 class=\"dayh\"><b>${WDF[g.d.getDay()]}, ${g.d.getDate()} ${MG[g.d.getMonth()]}${g.d.getFullYear()===T0.getFullYear()?'':' '+g.d.getFullYear()}</b><span class=\"${k<=1?'r1':k<=7?'r7':''}\">${rel(g.d)}</span></h2>\n  ${c2.length?`<div class=\"cf\">${warn}<span><b>Накладка.</b> ${c2.map(([a,b])=>`${a.e.tm} ${esc(sc(a.e.court||a.c.court))} і ${b.e.tm} ${esc(sc(b.e.court||b.c.court))}`).join('; ').replace(/\\.$/,'')}. Подайте клопотання про відкладення або участь у режимі відеоконференції.</span></div>`:''}\n  ${g.hs.map(({c,e})=>`<button class=\"hc\" style=\"--tc:var(--t-${c.type});--i:${Math.min(ord++,14)}\" data-a=\"open\" data-v=\"${esc(c.key)}\"><span class=\"tm\">${e.tm||'–'}</span><span class=\"main\"><b title=\"${esc(c.parties||c.client)}\">${esc(sn(c.client))}</b><small><span class=\"ty\">${TYPES[c.type]}</span> · ${esc(sc(e.court||c.court))}${c.judge&&c.judge!=='не визначено'?' · суддя '+esc(sn(c.judge)):''}${e.sure?'':' <span class=\"wr\">· збіг за ПІБ, перевірте</span>'}</small></span><span class=\"rt\"><span class=\"num\">${esc(c.num)}</span><small>${esc(room(e))}</small></span></button>`).join('')}`}).join('')||'<p class=\"empty\">Засідань не знайдено.</p>'}</div>\n <div class=\"fill\">\n ${NC.length?`<h2>Нові справи</h2>${NC.map(n=>`<div class=\"card\"><b><span class=\"num\">${esc(n.number)}</span></b><p>${esc(sc(n.court))}</p>${n.involved?`<p>${esc(sn(n.involved))}</p>`:''}<p>Бот знайшов ${esc(n.found)}${n.date?'. Засідання '+esc(n.date):''}</p>${n.reliable?'':'<p class=\"wr\">Збіг лише за ПІБ – перевірте, чи це ваш клієнт.</p>'}<div class=\"acts\">${byKey(caseKey(n.number))?`<button class=\"btn ghost sm\" data-a=\"open\" data-v=\"${esc(caseKey(n.number))}\">Відкрити справу</button>`:''}<button class=\"btn ghost sm\" data-a=\"ncdone\" data-v=\"${esc(n.key)}\">Переглянуто</button></div></div>`).join('')}`:''}\n <div class=\"box\"><h2>Найближчі 7 днів</h2><div class=\"kv\"><span>Засідання</span><b class=\"a\">${hs.filter(h=>left(h.e.d)<=7).length}</b></div><div class=\"kv\"><span>Накладки</span><b class=\"${cf7?'w':''}\">${cf7}</b></div><div class=\"kv\"><span>Процесуальні строки</span><b class=\"${hot.length?'y':''}\">${hot.length}</b></div><div class=\"kv\"><span>Нові справи</span><b class=\"${NC.length?'g':''}\">${NC.length}</b></div></div>\n <div class=\"box\"><h2>Строки на цьому тижні</h2>${hot.length?`<div class=\"list\">${hot.map(x=>dRow(x)).join('')}</div>`:'<p class=\"empty\">Найближчі 7 днів без строків.</p>'}</div>\n <div class=\"box\"><div class=\"kv\"><h2>Моніторинг судів</h2><small>${s?fts(s.ts):esc(S.updated||'')}</small></div>\n ${S.err?`<p class=\"err\">${esc(S.err)}</p>`:''}\n ${s?`<div class=\"kv\"><span>Останній прогін</span><span class=\"num\">${s.ok} / ${s.planned}</span></div><div class=\"bar\" aria-hidden=\"true\"><i style=\"width:${pct(s.ok,s.planned)}%\"></i></div>${!s.full&&s.rotation?`<div class=\"kv\" style=\"border:0;padding-top:4px\"><span>Коло по черзі</span><span class=\"num\">${s.cursor} / ${s.rotation}</span></div><div class=\"bar\" aria-hidden=\"true\"><i class=\"a\" style=\"width:${pct(s.cursor,s.rotation)}%\"></i></div>`:''}`:'<p class=\"empty\">Лічильники зʼявляться після першого прогону.</p>'}\n <small>Дату й час засідання звіряйте з ЄСІТС.</small></div></div></div>`;\n}\nfunction wDl(){\n const all=C.flatMap(c=>c.dl.map(d=>({c,d}))).sort((a,b)=>(a.d.done-b.d.done)||(a.d.due-b.d.due)),act=all.filter(x=>!x.d.done).length;\n return `<header class=\"top\"><p class=\"eyebrow\">Активних: ${act} · виконаних: ${all.length-act}</p><h1>Строки</h1></header>\n <div class=\"toolbar\"><button class=\"btn\" data-a=\"sheet\" data-v=\"dlnew\">Додати строк</button><p class=\"empty\" style=\"padding:0\">Календарні дні; з суботи чи неділі строк переноситься на понеділок; святкові дні не враховано.</p></div>\n <div class=\"fill\">${all.length?tbl(dlCols,all.map(dlTr)):'<p class=\"empty\">Строків ще немає. Додайте строк кнопкою вище, з картки справи або з документа суду.</p>'}</div>`;\n}\nfunction navList(){const r=listCases();return r.some(c=>c.key===S.cid)?r:C}\nfunction navBar(c,docBack){\n const L=navList(),i=L.findIndex(x=>x.key===c.key);\n return `<div class=\"navbar\"><button data-a=\"${docBack?'docback':'back'}\">‹ ${docBack?'До справи '+esc(c.num):'До списку справ'}</button>${docBack?'':`<button data-a=\"flip\" data-v=\"-1\"${i>0?'':' disabled'}>‹ Попередня</button><button data-a=\"flip\" data-v=\"1\"${i>=0&&i<L.length-1?'':' disabled'}>Наступна ›</button><span>${i>=0?`${i+1} з ${L.length} · `:''}клавіші ← → гортають справи, Esc повертає до списку</span>`}</div>`;\n}\nfunction wCase(c){\n const up=c.ev.filter(e=>left(e.d)>=0),D=DOCS[c.key]||{};\n return `${navBar(c,false)}<header class=\"top\"><p class=\"eyebrow\"><span class=\"num\">№ ${esc(c.num)}</span> · ${TYPES[c.type]}${c.role?' · '+esc(c.role):''}${c.tracked?' · стеження за номером':''}</p><h1 title=\"${esc(c.parties||c.client)}\">${esc(sn(c.client))}</h1>${c.subj?`<p class=\"eyebrow\" title=\"${esc(c.subj)}\">${esc(c.subj)}</p>`:''}</header>\n <div class=\"two\"><div class=\"fill\"><dl class=\"meta\"><div><dt>Суд</dt><dd>${esc(c.court)}</dd></div><div><dt>Суддя</dt><dd>${esc(c.judge)}</dd></div>${scanInfo(c)}${c.parties?`<div><dt>Сторони</dt><dd>${esc(c.parties)}</dd></div>`:''}</dl>\n <div class=\"acts\"><button class=\"btn ghost sm\" data-a=\"copy\" data-v=\"${esc(c.key)}\">Скопіювати реквізити</button><button class=\"btn ghost sm\" data-a=\"sheet\" data-v=\"hear\">Додати засідання</button><button class=\"btn ghost sm\" data-a=\"sheet\" data-v=\"dl\">Розрахувати строк</button>${c.tracked?`<button class=\"btn danger sm\" data-a=\"untrack\" data-v=\"${esc(c.num)}\">Не стежити за номером</button>`:`<button class=\"btn ghost sm\" data-a=\"track\" data-v=\"${esc(c.num)}\">Стежити за номером</button>`}</div>\n <h2>Засідання</h2>${up.length?tbl([['Дата','20%'],['Час','10%'],['Суд','30%'],['Зал','10%'],['Через','12%'],['','18%']],up.map(e=>`<tr><td>${fdS(e.d)}</td><td class=\"b\">${e.tm||'–'}</td>${cell(sc(e.court||c.court))}${cell((e.rm||'').replace('зал/каб. ',''),'m')}<td class=\"act\">${chip(left(e.d))}</td><td class=\"act\">${e.src==='cli'&&!e.sure?`<button class=\"btn ghost\" data-a=\"gcal\" data-v=\"${c.ev.indexOf(e)}\" title=\"Збіг лише за ПІБ. Якщо це ваш клієнт, додайте засідання в календар\">У календар</button>`:''}</td></tr>`)):'<p class=\"empty\">Не призначено. Щойно дата з\\'явиться на сайті суду, бот її знайде.</p>'}\n <h2>Процесуальні строки</h2>${c.dl.length?tbl([['','8%'],['Останній день','26%'],['Що подаємо','40%'],['Через','16%'],['','10%']],c.dl.map(d=>`<tr class=\"${d.done?'done':''}\"><td class=\"act\"><button class=\"chk${d.done?' on':''}\" data-a=\"dldone\" data-v=\"${esc(d.key)}\" aria-label=\"Позначити строк виконаним\"></button></td><td>${fdS(d.due)}</td><td class=\"b\" title=\"${esc(d.t+(d.b?' · '+d.b:''))}\">${esc(d.t)}</td><td class=\"act\">${d.done?'виконано':chip(left(d.due))}</td><td class=\"act\"><button class=\"x\" data-a=\"dldel\" data-v=\"${esc(d.key)}\" aria-label=\"Видалити строк\" title=\"Видалити строк\">✕</button></td></tr>`)):'<p class=\"empty\">Строків немає.</p>'}</div>\n <div class=\"stack\"><div class=\"hrow\"><h2>Документи суду${D.rows?` (${D.rows.length})`:''}</h2>${D.loading?'<span class=\"spin\"></span>':'<button class=\"btn ghost sm\" data-a=\"docs\">Оновити з реєстру</button>'}</div>\n <div class=\"fill\">${(D.rows||[]).length?tbl([['Дата','17%'],['Документ','20%'],['Суть','41%'],['Суддя','22%']],D.rows.map(d=>{const pend=(d.findings||[]).filter((f,i)=>!(d.applied||[]).includes(i));return `<tr data-a=\"doc\" data-v=\"${esc(d.id)}\">${cell(d.date)}${cell(d.form,'b')}<td title=\"${esc((d.labels||[]).join(' · '))}\">${esc((d.labels||[]).join(' · '))}${pend.length?` <span class=\"wr\">${(d.labels||[]).length?'· ':''}є дані для внесення</span>`:''}${!(d.labels||[]).length&&!pend.length?'<span style=\"color:var(--muted)\">відкрийте, щоб прочитати</span>':''}</td>${cell(sn(d.judge),'m')}</tr>`})):''}\n ${D.loading&&!(D.rows||[]).length?'<p class=\"empty\">Шукаю в реєстрі судових рішень.</p>':''}\n ${D.err?`<p class=\"err\">${esc(D.err)}</p><a class=\"btn ghost sm\" href=\"https://reyestr.court.gov.ua/\" target=\"_blank\" rel=\"noopener\">Відкрити пошук у реєстрі</a>`:''}\n ${D.rows&&!D.rows.length&&!D.loading&&!D.err?'<p class=\"empty\">У реєстрі рішень у цій справі поки нічого немає.</p>':''}</div></div></div>`;\n}\nconst ICON={today:'<circle cx=\"12\" cy=\"12\" r=\"4\"/><path d=\"M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4\"/>',cases:'<path d=\"M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z\"/>',cal:'<rect x=\"3\" y=\"5\" width=\"18\" height=\"16\" rx=\"2\"/><path d=\"M3 10h18M8 3v4M16 3v4\"/>',dl:'<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M12 7v5l3 2\"/>',mon:'<path d=\"M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/>'};\nconst TABS=[['today','Сьогодні'],['cases','Справи'],['cal','Календар'],['dl','Строки'],['mon','Моніторинг']];\nconst VIEWS={today:vToday,cases:vCases,cal:vCal,dl:vDl,mon:vMon};\nconst WVIEWS={today:wToday,cases:wCases,cal:vCal,dl:wDl,mon:vMon};\nlet lastKey='',lastSheet=null,lastMon=null;const SCROLL={};\nfunction render(){\n const app=document.getElementById('app');\n if(!S.token){app.innerHTML=vLogin();return}\n if(!S.ready){app.innerHTML=!S.err?'<div class=\"login\"><div class=\"row\"><span class=\"spin\"></span><span class=\"main\"><small>Завантажую справи</small></span></div></div>':`<div class=\"login\"><p class=\"err\">${esc(S.err)}</p><button class=\"btn\" data-a=\"reload\">Спробувати ще раз</button><button class=\"btn ghost\" data-a=\"logout\">Вийти</button></div>`;return}\n const c=byKey(S.cid),wide=WIDE.matches,tab=c?'cases':S.tab,key=(wide?'w':'m')+tab+'|'+S.cid+'|'+S.doc;\n if(lastKey)SCROLL[lastKey]=[...app.querySelectorAll('.scr,.fill,.agenda,.cal')].map(el=>el.scrollTop);\n app.classList.toggle('enter',key!==lastKey);app.classList.toggle('sheet-in',!!S.sheet&&S.sheet!==lastSheet);lastSheet=S.sheet;app.classList.toggle('fold-in',key===lastKey&&lastMon!==null&&S.mon!==lastMon);lastMon=S.mon;lastKey=key;\n const badge={dl:dls().filter(x=>left(x.d.due)<=2).length,today:NC.length};\n if(wide){\n  const v=c?(S.doc?vDoc(c,S.doc):wCase(c)):WVIEWS[tab]();\n  app.innerHTML=`<aside class=\"side\"><div class=\"brand\"><b>Мої судові справи</b><small>Адвокат Осадько О.О.</small></div>\n   <nav>${TABS.map(([k,t])=>`<button class=\"${tab===k?'on':''}\" data-a=\"tab\" data-v=\"${k}\"><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\">${ICON[k]}</svg><span>${t}</span>${badge[k]?`<em>${badge[k]}</em>`:''}</button>`).join('')}</nav>\n   <div class=\"sidefoot\"><small>${S.err?esc(S.err):'Бот оновив перелік '+esc(S.updated||'(час невідомий)')+(S.scan?'<br>'+esc(scanShort())+(cycleShort()?'<br>'+esc(cycleShort()):''):'')}</small><button data-a=\"reload\"${S.busy?' disabled':''}>Оновити дані</button><button data-a=\"scan\">Запустити прогін</button><button data-a=\"theme\">${theme.eff()==='dark'?'Денна тема':'Нічна тема'}</button><button data-a=\"logout\">Вийти</button></div></aside>\n   <div class=\"mainarea\"><section class=\"scr pane${tab==='mon'||(c&&S.doc)?' free':''}\">${v}</section></div>${sheet()}`;\n }else{\n  const v=c?(S.doc?vDoc(c,S.doc):vCase(c)):VIEWS[S.tab]();\n  app.innerHTML=`<main class=\"scr\">${v}</main><nav class=\"tabs\">${TABS.map(([k,t])=>`<button class=\"${(S.tab===k&&!c)||(c&&k==='cases')?'on':''}\" data-a=\"tab\" data-v=\"${k}\"><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\">${ICON[k]}</svg>${t}${badge[k]?`<em>${badge[k]}</em>`:''}</button>`).join('')}</nav>${sheet()}`;\n }\n const pos=SCROLL[key]||[];app.querySelectorAll('.scr,.fill,.agenda,.cal').forEach((el,i)=>{el.scrollTop=pos[i]||0});\n}\nconst WIDE=matchMedia('(min-width:960px)');\nWIDE.addEventListener('change',()=>render());\nfunction openCase(k){S.cid=k;S.doc=null;if(WIDE.matches)S.tab='cases';delete SCROLL[(WIDE.matches?'w':'m')+'cases|'+k+'|null'];render();const x=byKey(k);if(x)loadDocs(x,false)}\nfunction flip(step){const L=navList(),i=L.findIndex(x=>x.key===S.cid),n=L[i+step];if(i>=0&&n)openCase(n.key)}\ndocument.addEventListener('keydown',e=>{\n if(e.key==='Escape'&&S.sheet){S.sheet=null;S.preset=null;render();return}\n if(!WIDE.matches||S.sheet||!S.cid||/^(INPUT|SELECT|TEXTAREA)$/.test((e.target||{}).tagName||''))return;\n if(e.key==='Escape'){if(S.doc)S.doc=null;else S.cid=null;render()}\n else if(!S.doc&&e.key==='ArrowRight'){e.preventDefault();flip(1)}\n else if(!S.doc&&e.key==='ArrowLeft'){e.preventDefault();flip(-1)}\n});\nlet tt;function toast(m){const t=document.getElementById('toast');t.textContent=m;t.classList.add('show');clearTimeout(tt);tt=setTimeout(()=>t.classList.remove('show'),2600)}\n\n// ── дії ──\ndocument.addEventListener('click',async e=>{\n const b=e.target.closest('[data-a]');if(!b)return;const a=b.dataset.a,v=b.dataset.v,c=byKey(S.cid);\n if(a==='close'){if(e.target!==b)return;S.sheet=null;S.preset=null}\n else if(a==='tab'){S.tab=v;S.cid=null;S.doc=null}\n else if(a==='open'){openCase(v);return}\n else if(a==='flip'){flip(+v);return}\n else if(a==='theme')theme.toggle();\n else if(a==='fold'){S.mon=S.mon===v?'':v;store.set('cc_mon',S.mon||'none')}\n else if(a==='gmode'){await act('groups',{id:b.dataset.g,mode:v},'Режим збережено. Діятиме з наступного прогону.');return}\n else if(a==='sort'){S.sort=S.sort.k===v?{k:v,d:-S.sort.d}:{k:v,d:1}}\n else if(a==='back'){S.cid=null;S.doc=null}\n else if(a==='docback')S.doc=null;\n else if(a==='doc'){S.doc=v;render();loadDoc(v,false);return}\n else if(a==='doctext'){loadDoc(S.doc,true);return}\n else if(a==='docs'){if(c)loadDocs(c,true);return}\n else if(a==='filter')S.filter=v;\n else if(a==='sheet')S.sheet=v;\n else if(a==='calnav'){S.calM=new Date(S.calM.getFullYear(),S.calM.getMonth()+ +v,1);S.calD=null}\n else if(a==='calday')S.calD=S.calD&&+S.calD===+v?null:new Date(+v);\n else if(a==='caltoday'){S.calM=new Date(T0.getFullYear(),T0.getMonth(),1);S.calD=null}\n else if(a==='calall')S.calD=null;\n else if(a==='reload'){load(false);return}\n else if(a==='logout'){api('logout',{}).catch(()=>{});logout();return}\n else if(a==='scan'){try{await api('scan',{});toast('Прогін запущено. Результат буде за кілька хвилин.')}catch(err){toast(err.message)}return}\n else if(a==='track'){await act('track',{add:v},'Справу поставлено на стеження');return}\n else if(a==='untrack'){await act('track',{remove:v},'Стеження припинено');return}\n else if(a==='ncdone'){await act('newcase',{dismiss:v});return}\n else if(a==='unname'){await act('names',{remove:v},'Клієнта прибрано');return}\n else if(a==='dldone'){const d=C.flatMap(x=>x.dl).find(x=>x.key===v);if(d)await act('deadline',{done:v,value:!d.done});return}\n else if(a==='dldel'){await act('deadline',{remove:v},'Строк видалено. Подію в календарі приберіть вручну.');return}\n else if(a==='gcal'){const ev=c&&c.ev[+v];if(ev){try{await api('gcal',{item:ev.raw});toast('Засідання поставлено в чергу календаря')}catch(err){toast(err.message)}}return}\n else if(a==='apply'){\n  const row=((DOCS[c.key]||{}).rows||[]).find(d=>d.id===S.doc)||{},X=DOC[S.doc]||{},f=(X.findings||row.findings||[])[+v];if(!f)return;\n  if(f.kind==='deadline'){S.preset={title:f.title,days:f.days,basis:`${(row.form||'документ').toLowerCase()} від ${row.date||''}`,doc:S.doc,idx:+v};S.sheet='dl'}\n  else{const ok=await act('hearing',{number:c.num,date:f.date,time:f.time||'',court:row.court||c.court,judge:row.judge||'',forma:row.kind||'',note:`За документом суду: ${(row.form||'').toLowerCase()} від ${row.date||''}`,doc:S.doc,idx:+v},'Засідання додано');if(ok)loadDoc(S.doc,false);return}\n }\n else if(a==='copy'){const x=byKey(v),txt=`Справа № ${x.num}\\n${x.court}\\nСуддя: ${x.judge}`;\n  try{navigator.clipboard.writeText(txt).then(()=>toast('Реквізити скопійовано'),()=>toast('Не вдалося скопіювати'))}catch(_){toast('Не вдалося скопіювати')}return}\n render();\n});\ndocument.addEventListener('input',e=>{if(e.target.id==='q'){S.q=e.target.value;document.getElementById('caselist').innerHTML=caseList()}});\ndocument.addEventListener('change',async e=>{const g=e.target&&e.target.dataset?e.target.dataset.g:'';if(!g)return;await act('groups',{id:g,mode:e.target.value},'Режим збережено. Діятиме з наступного прогону.')});\ndocument.addEventListener('submit',async e=>{\n e.preventDefault();const f=e.target.dataset.f,c=byKey(S.cid),val=id=>{const el=document.getElementById(id);return el?el.value.trim():''};\n if(f==='login'){S.busy=true;S.err='';const pw=val('pw');render();\n  try{const j=await api('login',{password:pw});S.token=j.token;store.set('cc_token',j.token);S.busy=false;await load(false)}catch(err){S.busy=false;S.err=err.message;S.token='';render()}return}\n if(f==='name'){await act('names',{add:val('newname')},'Клієнта додано');return}\n if(f==='track'){const ok=await act('track',{add:val('newnum')},'Справу поставлено на стеження');if(ok){S.sheet=null;render()}return}\n if(f==='dl'&&c){const list=(S.preset?[[S.preset.title,S.preset.days,S.preset.basis]]:[]).concat(TPL[c.type]||TPL.civ),t=list[+val('dltpl')]||list[0],from=pd(val('dlfrom')),due=plus(from,t[1]);\n  const p=S.preset&&+val('dltpl')===0?S.preset:null;\n  const ok=await act('deadline',{add:{number:c.num,date:fd(due),title:t[0],note:`${t[1]} дн. від ${fd(from)}, ${t[2]}`},doc:p?p.doc:undefined,idx:p?p.idx:undefined},'Строк до '+fd(due));\n  if(ok){S.sheet=null;S.preset=null;render();if(p)loadDoc(p.doc,false)}return}\n if(f==='dlnew'){const ok=await act('deadline',{add:{number:val('dncase'),date:fd(pd(val('dndate'))),title:val('dntitle'),note:'дату вказано вручну'}},'Строк додано');if(ok){S.sheet=null;render()}return}\n if(f==='hear'&&c){const d=pd(val('hdate'));const ok=await act('hearing',{number:c.num,date:fd(d),time:val('htime'),court:c.court,judge:c.judge==='не визначено'?'':c.judge,courtroom:val('hroom'),note:'Додано вручну'},'Засідання додано');if(ok){S.sheet=null;render()}return}\n});\nif(S.token)load(false);else render();\n</script>\n</body>\n</html>\n";/*APP_HTML_END*/
const APP_ICON = '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';

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cronScan(env));
  },
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
    // Налаштування обходу для бота: режими груп судів і «суди ваших справ».
    if (request.method === 'GET' && url.pathname === '/court_cfg') {
      if ((request.headers.get('X-Auth-Token') || '') !== env.AUTH_TOKEN) {
        return new Response('forbidden', { status: 403 });
      }
      return Response.json({ groups: await getCourtGroups(env), own_courts: await ownCourts(env) });
    }
    // Статистика прогону від бота: лічильники для вебзастосунку та час останньої
    // успішної перевірки кожного суду (court_last).
    if (request.method === 'POST' && url.pathname === '/court_stats') {
      if ((request.headers.get('X-Auth-Token') || '') !== env.AUTH_TOKEN) {
        return new Response('forbidden', { status: 403 });
      }
      let o; try { o = await request.json(); } catch { return new Response('bad', { status: 400 }); }
      if (!o || typeof o !== 'object') return new Response('bad', { status: 400 });
      const scanned = Array.isArray(o.scanned) ? o.scanned.slice(0, 1500).map(String) : [];
      delete o.scanned;
      o.dead_names = Array.isArray(o.dead_names) ? o.dead_names.slice(0, 400).map(String) : [];
      o.own = Array.isArray(o.own) ? o.own.slice(0, 100).map(String) : [];
      o.groups = Array.isArray(o.groups) ? o.groups.slice(0, 20) : [];
      await env.KV.put('court_stats', JSON.stringify(o));
      // Журнал прогонів для застосунку: один запис на прогін, зберігаємо 7 днів.
      {
        const tsS = Number(o.ts) || Math.floor(Date.now() / 1000);
        const num = (v) => Number(v) || 0;
        const rs = (await env.KV.get('court_run_src', 'json')) || {};
        const src = rs.ts && Date.now() - rs.ts < 90 * 60000 ? String(rs.src || '') : '';
        if (rs.ts) await env.KV.delete('court_run_src');
        let lg = (await env.KV.get('court_log', 'json')) || [];
        if (!Array.isArray(lg)) lg = [];
        if (!lg.some((e) => e.ts === tsS)) {
          lg.push({ ts: tsS, src, full: !!o.full, dur: num(o.duration), planned: num(o.planned),
            ok: num(o.ok), failed: num(o.failed), dead: num(o.dead), cut: num(o.cut) });
        }
        lg = lg.filter((e) => e && e.ts >= tsS - 7 * 86400).sort((a, b) => a.ts - b.ts).slice(-250);
        await env.KV.put('court_log', JSON.stringify(lg));
      }
      if (scanned.length) {
        const last = (await env.KV.get('court_last', 'json')) || {};
        const ts = Number(o.ts) || Math.floor(Date.now() / 1000);
        for (const n of scanned) last[n] = ts;
        await env.KV.put('court_last', JSON.stringify(last));
      }
      return Response.json({ ok: true });
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
