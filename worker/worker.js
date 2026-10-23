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

function courtMenuKb() {
  return { inline_keyboard: [
    [{ text: '➕ Додати клієнта', callback_data: 'cadd' }],
    [{ text: '📋 Список / кількість', callback_data: 'clist' }],
    [{ text: '📑 Повний список', callback_data: 'crepall' }],
    [{ text: '👥 Справи клієнтів', callback_data: 'crepc' }],
    [{ text: '⚖️ Справи адвоката', callback_data: 'crep' }],
    [{ text: '🔔 Нагадування', callback_data: 'crem' }],
    [{ text: '🔄 Терміновий прогін зараз', callback_data: 'crun' }],
    [{ text: '🔎 Пошук практики', callback_data: 'cvs' }, { text: '📰 Свіжа практика', callback_data: 'cdig' }],
    [{ text: '🤖 Завдання агенту (документи + AI)', callback_data: 'cagent' }],
  ] };
}

// Постійна клавіатура-меню, закріплена біля поля вводу.
function courtReplyKb() {
  return {
    keyboard: [
      [{ text: '📑 Повний список' }],
      [{ text: '👥 Справи клієнтів' }, { text: '⚖️ Справи адвоката' }],
      [{ text: '🔎 Пошук практики' }, { text: '📰 Свіжа практика' }],
      [{ text: '🤖 Завдання агенту' }],
      [{ text: '📋 Список клієнтів' }, { text: '🔔 Нагадування' }],
      [{ text: '➕ Додати клієнта' }, { text: '🔄 Терміновий прогін' }],
    ],
    resize_keyboard: true,
    input_field_placeholder: 'Оберіть дію (меню можна згорнути ☰)',
  };
}

// Запуск GitHub Action «Відстеження судових справ» на вимогу (workflow_dispatch).
async function triggerScan(env) {
  const repo = env.GH_REPO || 'AlexOsadko/web_site';
  const wf = env.GH_WORKFLOW || 'court-watch.yml';
  const r = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/${wf}/dispatches`,
    { method: 'POST', headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'osadko-court-bot',
        'Content-Type': 'application/json',
      }, body: JSON.stringify({ ref: 'main', inputs: { dry_run: false } }) });
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
async function showCourtReportAll(env, page = 0) {
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
  const all = [...byKey.values()].sort(caseCmp);
  const updated = a.updated || c.updated || '';
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
    '\n<i>⚖️ — ваші · 👥 — клієнтів</i>\n';
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
  rows.push([{ text: '↩️ Меню', callback_data: 'cmenu' }]);
  return tg(env, 'sendMessage', {
    chat_id: env.REVIEW_CHAT, parse_mode: 'HTML', text: txt,
    disable_web_page_preview: true, reply_markup: { inline_keyboard: rows },
  });
}

async function showCourtMenu(env, prefix = '') {
  const arr = await getNames(env);
  // Закріплюємо меню-клавіатуру біля поля вводу + дублюємо кнопки в повідомленні.
  await tg(env, 'sendMessage', {
    chat_id: env.REVIEW_CHAT, parse_mode: 'HTML',
    text: prefix + '⚖️ <b>Меню суду</b> закріплено внизу ⬇️\nКлієнтів під наглядом: <b>' +
      arr.length + '</b>',
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

async function agentFiles(env) {
  const l = await env.KV.list({ prefix: 'agent_file_' });
  const out = [];
  for (const k of l.keys) {
    const f = await env.KV.get(k.name, 'json');
    if (f) out.push({ key: k.name, ...f });
  }
  return out.sort((a, b) => (a.mid || 0) - (b.mid || 0));
}
async function clearAgentFiles(env) {
  const l = await env.KV.list({ prefix: 'agent_file_' });
  for (const k of l.keys) await env.KV.delete(k.name);
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

// Прийом файлу: зберегти; одиночний файл із підписом — одразу в роботу;
// альбом — одна відповідь на групу з кнопками (підпис альбому запам'ятовуємо).
async function onAgentFile(env, m, file, caption) {
  if (file.size > 20 * 1024 * 1024) {
    return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT,
      text: '⚠️ Файл більший за 20 МБ — Telegram не дає боту його завантажити. Надішліть менший файл.' });
  }
  await env.KV.put('agent_file_' + m.message_id, JSON.stringify({ ...file, mid: m.message_id }),
    { expirationTtl: 7200 });
  await env.KV.put('court_await', 'agent');
  if (caption && !m.media_group_id) return startAgent(env, caption);
  if (caption) await env.KV.put('agent_caption', caption, { expirationTtl: 7200 });
  if (m.media_group_id) {
    const g = 'agent_grp_' + m.media_group_id;
    if (await env.KV.get(g)) return;
    await env.KV.put(g, '1', { expirationTtl: 600 });
  }
  const n = (await agentFiles(env)).length;
  return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, parse_mode: 'HTML',
    text: `📎 Отримано${m.media_group_id ? ' альбом' : ''}. Файлів у роботі: <b>${n}</b>.\n`
      + 'Надішліть ще файли або напишіть завдання своїми словами чи оберіть кнопку:',
    reply_markup: agentKb(!!caption || !!(await env.KV.get('agent_caption'))) });
}

async function startAgent(env, text) {
  if (!env.GH_DISPATCH_TOKEN) {
    return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, parse_mode: 'HTML',
      text: '⚠️ Не вдалося запустити: ' + ghWhy(env, 0) });
  }
  const files = (await agentFiles(env)).map(({ key, ...f }) => f);
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
  await clearAgentFiles(env);
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
        await clearAgentFiles(env);
        await env.KV.delete('court_await');
        return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, text: '🗑 Файли скинуто.' });
      }
      const files = await agentFiles(env);
      if (pid === 'cap') {
        const cap = await env.KV.get('agent_caption');
        if (!cap) return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, text: 'Підпис застарів — напишіть завдання ще раз.' });
        return startAgent(env, cap);
      }
      const pr = AGENT_PRESETS[pid];
      if (!pr) return;
      if (!files.length) {
        return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT,
          text: 'Файлів немає (минуло понад 2 год або вже використані) — надішліть документи ще раз.' });
      }
      return startAgent(env, pr.task);
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
      // швидкий прогін, щоб додати без очікування планового (з тротлінгом ~90с)
      if (env.GH_TOKEN) {
        const last = parseInt((await env.KV.get('court_run_at')) || '0', 10);
        if (Date.now() - last >= 90000) { await triggerScan(env); await env.KV.put('court_run_at', String(Date.now())); }
      }
      return;
    }

    // --- меню бота відстеження судових справ ---
    if (['cmenu', 'cadd', 'clist', 'cedit', 'cdel', 'crep', 'crepc', 'crepall', 'crun',
         'chide', 'cunhide', 'chidden', 'cunhide1', 'cpurge1', 'cpurge',
         'crem', 'cremdel', 'crempg', 'crepp', 'cnoop', 'cvs', 'cdig'].includes(action)) {
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
      if (action === 'crun') {
        const txt = await urgentScan(env);
        return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, parse_mode: 'HTML', text: txt });
      }
      if (action === 'clist') return showCourtList(env);
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
    const courtAwait = await env.KV.get('court_await');
    const file = msgFile(m);

    // AI-агент: будь-який файл (Word/PDF/фото) іде в роботу агенту; текст після
    // кнопки «🤖» або поки є завантажені файли — це завдання.
    if (file) return onAgentFile(env, m, file, body);
    const isMenu = /^(📑|👥|⚖️|🔎|📰|📋|🔔|➕|🔄|🤖)/.test(body)
      || /^(\/|cancel$|скасувати$|меню$)/i.test(body);
    if (courtAwait === 'agent' && body && !isMenu) {
      if (body.length < 10) {
        return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT,
          text: 'Напишіть завдання детальніше (або /cancel).' });
      }
      return startAgent(env, body);
    }

    // Скасування введення (ПІБ клієнта, тема пошуку практики)
    if (/^(\/cancel|cancel|скасувати)$/i.test(body)) {
      await env.KV.delete('court_await');
      if (courtAwait === 'agent') await clearAgentFiles(env);
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
          '/add — ➕ додати клієнта\n/restart — 🔄 терміновий прогін\n' +
          '/vs &lt;тема&gt; — 🔎 практика судів за темою (або кнопка «🔎 Пошук практики»)\n' +
          '/digest — 📰 свіжа практика зараз (щоранку приходить сама)\n' +
          '/agent — 🤖 завдання агенту: надішліть Word/PDF і напишіть, що зробити\n' +
          '/cancel — ↩️ скасувати', reply_markup: courtReplyKb() });
    }

    // Кнопки закріпленої клавіатури-меню (натискання = звичайне повідомлення)
    if (/^➕/.test(body) || /^(\/add|додати клієнта)$/i.test(body)) {
      await env.KV.put('court_await', 'add');
      return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT,
        text: "➕ Надішліть ПІБ клієнта (Прізвище Ім'я По-батькові). Скасувати — /cancel." });
    }
    if (/^📑/.test(body) || /^\/all$/i.test(body) || /повний список/i.test(body)) {
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Список ПІБ для бота відстеження судових справ (за спільним секретом).
    if (request.method === 'GET' && url.pathname === '/court_names') {
      if ((request.headers.get('X-Auth-Token') || '') !== env.AUTH_TOKEN) {
        return new Response('forbidden', { status: 403 });
      }
      const arr = (await env.KV.get('court_names', 'json')) || [];
      return Response.json({ names: arr });
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
