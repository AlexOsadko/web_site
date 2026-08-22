// Cloudflare Worker — МИТТЄВА обробка кнопок Telegram для каналу
// «Про право простою мовою». Приймає вебхук Telegram і реагує на натискання
// ✅ Опублікувати / ✏️ Редагувати / 🗑 Відхилити за секунди.
//
// Прив'язки (Cloudflare → Worker → Settings → Variables):
//   KV Namespace binding:  KV
//   Секрети / змінні:
//     TELEGRAM_BOT_TOKEN  — токен бота (@BotFather)
//     TELEGRAM_CHANNEL    — @pro100_law (куди публікувати)
//     REVIEW_CHAT         — ваш Telegram id (куди йдуть чернетки)
//     AUTH_TOKEN          — спільний секрет із GitHub (BOT_WORKER_SECRET)
//     WEBHOOK_SECRET      — (опц.) секрет вебхука Telegram (setWebhook secret_token)
//     CONTACT_URL         — (опц.) куди веде кнопка «Консультація адвоката»
//     CONTACT_LABEL       — (опц.) напис на кнопці
//     CTA_EVERY           — (опц.) кнопку «до адвоката» кожен N-й пост (типово 6)

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

function renderOriginal(d) {
  let msg = `<b>${esc(d.headline)}</b>\n\n${esc(d.body)}`;
  if (d.tags && d.tags.length) msg += `\n\n${d.tags.join(' ')}`;
  return msg;
}

function draftKeyboard(pid) {
  return { inline_keyboard: [
    [{ text: '✅ Опублікувати в канал', callback_data: `pub:${pid}` }],
    [{ text: '✏️ Редагувати', callback_data: `edit:${pid}` },
     { text: '🗑 Відхилити', callback_data: `rej:${pid}` }],
  ] };
}

async function getStats(env) {
  return (await env.KV.get('stats', 'json')) || { generated: 0, published: 0, edited: 0, rejected: 0 };
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
    [{ text: '👥 Справи клієнтів', callback_data: 'crepc' }],
    [{ text: '⚖️ Справи адвоката', callback_data: 'crep' }],
    [{ text: '🔔 Нагадування', callback_data: 'crem' }],
    [{ text: '🔄 Терміновий прогін зараз', callback_data: 'crun' }],
  ] };
}

// Постійна клавіатура-меню, закріплена біля поля вводу.
function courtReplyKb() {
  return {
    keyboard: [
      [{ text: '➕ Додати клієнта' }],
      [{ text: '👥 Справи клієнтів' }, { text: '⚖️ Справи адвоката' }],
      [{ text: '🔔 Нагадування' }, { text: '📋 Список клієнтів' }],
      [{ text: '🔄 Терміновий прогін' }],
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: 'Оберіть дію в меню нижче…',
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
    { command: 'clients', description: '👥 Справи клієнтів' },
    { command: 'advocate', description: '⚖️ Справи адвоката' },
    { command: 'reminders', description: '🔔 Нагадування' },
    { command: 'list', description: '📋 Список клієнтів' },
    { command: 'add', description: '➕ Додати клієнта' },
    { command: 'restart', description: '🔄 Терміновий прогін' },
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

// Перелік справ, за якими надійдуть нагадування (найближчі засідання).
// Кожну можна прибрати з нагадувань (🗑 — назавжди, як у «Прихованих»).
async function showReminders(env) {
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
  if (!list.length) {
    return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, parse_mode: 'HTML',
      text: '🔔 <b>Нагадування</b>\nНемає найближчих засідань. Перелік оновлюється під час прогону.',
      reply_markup: { inline_keyboard: [[{ text: '↩️ Меню', callback_data: 'cmenu' }]] } });
  }
  const cap = Math.min(list.length, 15);
  let txt = `🔔 <b>Найближчі засідання: ${list.length}</b>\n<i>🗑 — прибрати справу з нагадувань</i>\n`;
  const kb = [];
  for (let n = 0; n < cap; n++) {
    const r = list[n];
    const mark = r.days <= 1 ? '🔴' : (r.days <= 3 ? '🟠' : '🗓');
    const when = r.days === 0 ? 'сьогодні' : (r.days === 1 ? 'завтра' : `за ${r.days} дн.`);
    const tag = r.kind === 'clients' ? '👥' : '⚖️';
    txt += `\n${mark} <b>${when}</b> · ${tag} № ${esc(r.it.number)}\n` +
      `    📅 ${esc(r.it.date)} · 🏛 ${cut(r.it.court, 60)}\n`;
    kb.push([{ text: `🗑 ${when} · № ${(r.it.number || '').slice(0, 18)}`,
              callback_data: `cremdel:${r.kind}:${r.gi}` }]);
  }
  if (list.length > cap) txt += `\n… та ще ${list.length - cap}.`;
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
  const PER = 5;
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
    if (it.description) txt += `    📋 ${cut(it.description, 220)}\n`;
    if (it.involved) txt += `    👥 ${cut(it.involved, 400)}\n`;
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
async function bump(env, key) {
  const s = await getStats(env);
  s[key] = (s[key] || 0) + 1;
  await env.KV.put('stats', JSON.stringify(s));
}

async function countPending(env) {
  let count = 0, cursor;
  do {
    const l = await env.KV.list({ prefix: 'draft:', cursor });
    count += l.keys.length;
    if (l.list_complete) break;
    cursor = l.cursor;
  } while (cursor);
  return count;
}

function parsePost(text) {
  text = (text || '').trim();
  const nl = text.indexOf('\n');
  let headline = nl === -1 ? text : text.slice(0, nl);
  let body = nl === -1 ? '' : text.slice(nl + 1);
  headline = headline.trim().replace(/^["'«#]+/, '').replace(/["'»]+$/, '').trim();
  body = body.replace(/\n{3,}/g, '\n\n').trim();
  return { headline, body };
}

// Надіслати (або повторно надіслати) повідомлення-чернетку з кнопками.
async function sendDraft(env, draft, pid, header = '') {
  draft.text = renderOriginal(draft);
  const text = header +
    '🧪 <b>ЧЕРНЕТКА — перевірте перед публікацією.</b>\n' +
    `<i>тип: ${esc(draft.type)} · ${esc(draft.area)}</i>\n\n` + draft.text;
  const res = await tg(env, 'sendMessage', {
    chat_id: env.REVIEW_CHAT, text, parse_mode: 'HTML',
    disable_web_page_preview: true, reply_markup: draftKeyboard(pid),
  });
  if (res.ok) {
    draft.review_msg = res.result.message_id;
    await env.KV.put(`draft:${pid}`, JSON.stringify(draft));
  }
  return res.ok;
}

async function publishDraft(env, draft) {
  const ctaEvery = parseInt(env.CTA_EVERY || '6', 10);
  const counter = parseInt((await env.KV.get('counter')) || '0', 10);
  const cta = ctaEvery > 0 && ((counter + 1) % ctaEvery === 0);
  const params = {
    chat_id: env.TELEGRAM_CHANNEL, text: draft.text, parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (cta && env.CONTACT_URL) {
    params.reply_markup = { inline_keyboard: [[
      { text: env.CONTACT_LABEL || '⚖️ Консультація адвоката', url: env.CONTACT_URL },
    ]] };
  }
  const res = await tg(env, 'sendMessage', params);
  if (res.ok) await env.KV.put('counter', String(counter + 1));
  return res.ok;
}

// Реєстрація нової чернетки від GitHub-бота (генерація через Anthropic там).
async function handleRegister(request, env) {
  const got = request.headers.get('X-Auth-Token') || '';
  if (got !== env.AUTH_TOKEN) {
    // діагностика (не розкриваємо самі токени, лише довжини)
    const info = `register auth mismatch: got_len=${got.length} expected_len=${(env.AUTH_TOKEN || '').length} expected_set=${!!env.AUTH_TOKEN}`;
    console.log(info);
    return new Response(info, { status: 403 });
  }
  const o = await request.json();
  const pid = String(Date.now()) + Math.floor(Math.random() * 1000);
  const draft = { headline: o.headline, body: o.body, tags: o.tags || [],
                  type: o.type || '', area: o.area || '' };
  const ok = await sendDraft(env, draft, pid);
  if (ok) await bump(env, 'generated');
  return Response.json({ ok });
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

    // --- меню бота відстеження судових справ ---
    if (['cmenu', 'cadd', 'clist', 'cedit', 'cdel', 'crep', 'crepc', 'crun',
         'chide', 'cunhide', 'chidden', 'cunhide1', 'cpurge1', 'cpurge',
         'crem', 'cremdel', 'crepp', 'cnoop'].includes(action)) {
      await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
      if (action === 'cnoop') return;
      if (action === 'cmenu') return showCourtMenu(env);
      if (action === 'crep') return showCourtReport(env, 'advocate', 0);
      if (action === 'crepc') return showCourtReport(env, 'clients', 0);
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
      if (action === 'crem') return showReminders(env);
      // Прибрати справу з нагадувань назавжди (більше не показувати й не нагадувати).
      if (action === 'cremdel') {
        const kind = pid === 'clients' ? 'clients' : 'advocate';
        const i = parseInt(parts[2], 10);
        const { visible } = await visibleReport(env, kind);
        if (!isNaN(i) && visible[i]) await addDeleted(env, kind, itemKey(visible[i]));
        return showReminders(env);
      }
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

    const draft = pid ? await env.KV.get(`draft:${pid}`, 'json') : null;

    if (action === 'pub') {
      if (!draft) return tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Чернетку не знайдено.' });
      if (await publishDraft(env, draft)) {
        await bump(env, 'published');
        await env.KV.delete(`draft:${pid}`);
        await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Опубліковано ✅' });
        if (chat && mid) await tg(env, 'editMessageText', { chat_id: chat, message_id: mid, parse_mode: 'HTML', disable_web_page_preview: true, text: '✅ <b>Опубліковано в канал</b>\n\n' + draft.text });
      } else {
        await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Не вдалося опублікувати.' });
      }
    } else if (action === 'rej') {
      if (draft) { await bump(env, 'rejected'); await env.KV.delete(`draft:${pid}`); }
      await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Відхилено 🗑' });
      if (draft && chat && mid) await tg(env, 'editMessageText', { chat_id: chat, message_id: mid, parse_mode: 'HTML', disable_web_page_preview: true, text: '🗑 <b>Відхилено</b>\n\n' + draft.text });
    } else if (action === 'edit') {
      if (!draft) return tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Чернетку не знайдено.' });
      await env.KV.put('awaiting_edit', pid);
      await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Надішліть виправлений текст' });
      if (chat && mid) await tg(env, 'editMessageText', { chat_id: chat, message_id: mid, parse_mode: 'HTML', disable_web_page_preview: true, text: '✏️ <b>Редагування…</b> Скопіюйте текст нижче, відредагуйте й надішліть назад.\n\n' + draft.text });
      await tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, parse_mode: 'HTML', text: '✏️ Натисніть на текст нижче, щоб <b>скопіювати</b>, відредагуйте у полі вводу й надішліть назад одним повідомленням (1-й рядок — заголовок). Хештеги додам сам. Скасувати — /cancel.' });
      // поточний текст як «код» — Telegram показує кнопку «копіювати» (один тап)
      await tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, parse_mode: 'HTML', text: '<pre>' + esc(draft.headline + '\n\n' + draft.body) + '</pre>' });
    }
    return;
  }

  // --- звичайні повідомлення (редагування / команди) ---
  if (update.message) {
    const m = update.message;
    const chat = m.chat && m.chat.id;
    if (String(chat) !== String(env.REVIEW_CHAT)) return;
    const body = (m.text || '').trim();
    const awaiting = await env.KV.get('awaiting_edit');
    const courtAwait = await env.KV.get('court_await');

    // Скасування (діє і для меню суду, і для редагування новин)
    if (/^(\/cancel|cancel|скасувати)$/i.test(body)) {
      if (courtAwait) {
        await env.KV.delete('court_await');
        return showCourtMenu(env, '↩️ Скасовано.\n\n');
      }
      // інакше — нижче обробить скасування редагування новин
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
          '/cancel — ↩️ скасувати', reply_markup: courtReplyKb() });
    }

    // Кнопки закріпленої клавіатури-меню (натискання = звичайне повідомлення)
    if (/^➕/.test(body) || /^(\/add|додати клієнта)$/i.test(body)) {
      await env.KV.put('court_await', 'add');
      return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT,
        text: "➕ Надішліть ПІБ клієнта (Прізвище Ім'я По-батькові). Скасувати — /cancel." });
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

    if (awaiting) {
      const draft = await env.KV.get(`draft:${awaiting}`, 'json');
      if (/^(\/cancel|cancel|скасувати)$/i.test(body)) {
        await env.KV.delete('awaiting_edit');
        if (draft) await sendDraft(env, draft, awaiting, '↩️ <b>Редагування скасовано.</b>\n\n');
        return;
      }
      if (!draft) {
        await env.KV.delete('awaiting_edit');
        return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, text: 'Чернетку не знайдено — редагування скасовано.' });
      }
      const { headline, body: newBody } = parsePost(body);
      if (!headline || !newBody) {
        return tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, text: 'Потрібні заголовок (1-й рядок) і текст. Надішліть ще раз або /cancel.' });
      }
      draft.headline = headline; draft.body = newBody;
      await env.KV.delete('awaiting_edit');
      await bump(env, 'edited');
      await sendDraft(env, draft, awaiting, '✏️ <b>Оновлена чернетка.</b>\n\n');
      return;
    }

    if (/^(\/stats|статистика)$/i.test(body)) {
      const s = await getStats(env);
      const pend = await countPending(env);
      const txt = '📊 <b>Статистика авторських постів</b>\n' +
        `• Згенеровано: ${s.generated || 0}\n• Опубліковано: ${s.published || 0}\n` +
        `• Відредаговано: ${s.edited || 0}\n• Відхилено: ${s.rejected || 0}\n` +
        `• Чекають рішення: ${pend}`;
      await tg(env, 'sendMessage', { chat_id: env.REVIEW_CHAT, parse_mode: 'HTML', text: txt });
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/register') {
      return handleRegister(request, env);
    }
    // Список ПІБ для бота відстеження судових справ (за спільним секретом).
    if (request.method === 'GET' && url.pathname === '/court_names') {
      if ((request.headers.get('X-Auth-Token') || '') !== env.AUTH_TOKEN) {
        return new Response('forbidden', { status: 403 });
      }
      const arr = (await env.KV.get('court_names', 'json')) || [];
      return Response.json({ names: arr });
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
    // Звіт «справи адвоката» від бота (зберігається для перегляду з меню).
    if (request.method === 'POST' && url.pathname === '/court_report') {
      if ((request.headers.get('X-Auth-Token') || '') !== env.AUTH_TOKEN) {
        return new Response('forbidden', { status: 403 });
      }
      let o; try { o = await request.json(); } catch { return new Response('bad', { status: 400 }); }
      const kind = (o.kind === 'clients') ? 'clients' : 'advocate';
      await env.KV.put('court_report_' + kind, JSON.stringify(o));
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
