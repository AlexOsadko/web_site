// Чат на сайті → Telegram.
// Відвідувач пише у віконце на osadko.online → повідомлення приходить адвокату
// в Telegram (окремий бот). Відповідь реплаєм у Telegram з'являється в чаті на сайті.
// Cloudflare Worker + база D1 (binding DB). Налаштування — див. README.md поруч.
//
// Змінні воркера:
//   CHAT_BOT_TOKEN   (Secret)  токен бота від @BotFather
//   WEBHOOK_SECRET   (Secret)  довгий випадковий рядок (захист вебхука й /setup)
//   OWNER_CHAT       (Text)    ваш Telegram id (бот підкаже його на /start)
//   TURNSTILE_SECRET (Secret)  опційно: секрет Cloudflare Turnstile (антиспам)
//   ALLOWED_ORIGINS  (Text)    опційно: дозволені сайти через кому

const MAX_LEN = 2000;          // символів в одному повідомленні
const RETAIN_DAYS = 30;        // листування старше — видаляється
const ACTIVE_MIN = 30;         // «активна» розмова для відповіді без реплаю
const DEFAULT_ORIGINS = 'https://osadko.online,https://www.osadko.online';
// Кнопки внизу чату з ботом
const BTN_LIST = '📋 Розмови';
const BTN_HELP = '❓ Як відповідати';
const MENU = { keyboard: [[{ text: BTN_LIST }, { text: BTN_HELP }]], resize_keyboard: true, is_persistent: true };
const HELP = 'Бот чату на сайті працює ✅\n\nНові повідомлення з сайту приходять сюди. Щоб відповісти — зробіть <b>реплай</b> на повідомлення клієнта. Якщо зараз активна лише одна розмова, можна писати і без реплаю.\n\n' +
  '<b>📋 Розмови</b> — останні розмови; натисніть на потрібну, щоб побачити все листування.\n' +
  'Під кожним новим зверненням — кнопки <b>📋 Уся розмова</b> і <b>🗑 Видалити</b>.\n' +
  'Також працюють команди /list, /view і /del (реплаєм на повідомлення клієнта).';
const convButtons = (sid) => ({ inline_keyboard: [[{ text: '📋 Уся розмова', callback_data: 'v:' + sid }, { text: '🗑 Видалити', callback_data: 'd:' + sid }]] });

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const cors = corsHeaders(env, req.headers.get('Origin') || '');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      await ensureSchema(env);
      if (url.pathname === '/tg' && req.method === 'POST') return await onTelegram(req, env);
      if (url.pathname === '/setup') return await onSetup(env, url);
      if (url.pathname === '/chat/send' && req.method === 'POST') {
        if (!cors['Access-Control-Allow-Origin']) throw new HttpError(403, 'origin');
        return json(await onSend(req, env), cors);
      }
      if (url.pathname === '/chat/poll' && req.method === 'GET') return json(await onPoll(url, env), cors);
      if (url.pathname === '/chat/delete' && req.method === 'POST') {
        if (!cors['Access-Control-Allow-Origin']) throw new HttpError(403, 'origin');
        return json(await onDelete(req, env), cors);
      }
      if (url.pathname === '/chat/seen' && req.method === 'POST') {
        if (!cors['Access-Control-Allow-Origin']) throw new HttpError(403, 'origin');
        return json(await onSeen(req, env), cors);
      }
      if (url.pathname === '/') return new Response('osadko chat: ok');
      return new Response('not found', { status: 404 });
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, cors, e.status);
      console.log('chat error', e && e.stack || e);
      return json({ error: 'server' }, cors, 500);
    }
  }
};

// ── Допоміжне ──────────────────────────────────────────────────────
function corsHeaders(env, origin) {
  const allowed = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(',').map((s) => s.trim());
  const h = { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' };
  if (allowed.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(data, headers = {}, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clean = (s, n) => String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, n);
const now = () => Date.now();

function randomId(bytes) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function shortCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const a = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(a, (x) => abc[x % abc.length]).join('');
}

async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

async function tg(env, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${env.CHAT_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  return r.json().catch(() => ({ ok: false }));
}

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  if (!env.DB) throw new Error('D1 binding "DB" is missing');
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, code TEXT, created INTEGER, last INTEGER, page TEXT, contact TEXT, iph TEXT)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, sid TEXT, who TEXT, text TEXT, t INTEGER)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS msgs_sid ON msgs (sid, id)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS tgmap (tg INTEGER PRIMARY KEY, sid TEXT)')
  ]);
  // Колонки для позначки «прочитано» (додаються до вже створеної таблиці)
  for (const col of ['tg INTEGER', 'seen INTEGER']) {
    try { await env.DB.prepare(`ALTER TABLE msgs ADD COLUMN ${col}`).run(); } catch (e) { /* уже є */ }
  }
  schemaReady = true;
}

async function purgeOld(env) {
  const cut = now() - RETAIN_DAYS * 864e5;
  const old = 'SELECT id FROM sessions WHERE last < ?1';
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM msgs WHERE sid IN (${old})`).bind(cut),
    env.DB.prepare(`DELETE FROM tgmap WHERE sid IN (${old})`).bind(cut),
    env.DB.prepare('DELETE FROM sessions WHERE last < ?1').bind(cut)
  ]);
}

async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  const fd = new FormData();
  fd.append('secret', env.TURNSTILE_SECRET);
  fd.append('response', token);
  if (ip) fd.append('remoteip', ip);
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: fd });
  const j = await r.json().catch(() => ({}));
  return !!j.success;
}

function pagePath(page) {
  try { const u = new URL(page); return decodeURIComponent(u.pathname) || '/'; } catch (e) { return ''; }
}

// ── Відвідувач надсилає повідомлення ───────────────────────────────
async function onSend(req, env) {
  const b = await req.json().catch(() => null);
  if (!b) throw new HttpError(400, 'bad json');
  if (b.hp) return { ok: true, sid: '', id: 0 };            // honeypot: тихо ігноруємо
  const text = clean(b.text, MAX_LEN);
  const contact = clean(b.contact, 100);
  if (!text && !contact) throw new HttpError(400, 'empty');
  const ip = req.headers.get('CF-Connecting-IP') || '';
  const t = now();

  let s = null;
  if (typeof b.sid === 'string' && /^[\w-]{20,40}$/.test(b.sid)) {
    s = await env.DB.prepare('SELECT * FROM sessions WHERE id = ?1').bind(b.sid).first();
  }

  if (!s) {
    if (!text) throw new HttpError(400, 'empty');
    const iph = await sha256(ip + '|' + (env.WEBHOOK_SECRET || ''));
    const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE iph = ?1 AND created > ?2').bind(iph, t - 36e5).first();
    if (recent && recent.n >= 5) throw new HttpError(429, 'rate');
    if (!(await verifyTurnstile(env, b.token, ip))) throw new HttpError(403, 'captcha');
    s = { id: randomId(18), code: shortCode(), created: t, last: t, page: clean(b.page, 300), contact: '', iph };
    await env.DB.prepare('INSERT INTO sessions (id, code, created, last, page, contact, iph) VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6)')
      .bind(s.id, s.code, t, s.page, '', iph).run();
    s.isNew = true;
    await purgeOld(env);
  } else {
    const burst = await env.DB.prepare("SELECT COUNT(*) AS n FROM msgs WHERE sid = ?1 AND who = 'me' AND t > ?2").bind(s.id, t - 6e4).first();
    if (burst && burst.n >= 8) throw new HttpError(429, 'rate');
    const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM msgs WHERE sid = ?1 AND who = 'me'").bind(s.id).first();
    if (total && total.n >= 150) throw new HttpError(429, 'limit');
  }

  let id = 0;
  if (text) {
    const r = await env.DB.prepare("INSERT INTO msgs (sid, who, text, t) VALUES (?1, 'me', ?2, ?3)").bind(s.id, text, t).run();
    id = r.meta && r.meta.last_row_id || 0;
  }
  const newContact = contact && contact !== s.contact;
  await env.DB.prepare('UPDATE sessions SET last = ?2, contact = CASE WHEN ?3 <> \'\' THEN ?3 ELSE contact END WHERE id = ?1')
    .bind(s.id, t, contact).run();

  // У Telegram
  const lines = [];
  if (s.isNew) {
    lines.push(`💬 <b>Чат із сайту</b> · #${s.code}`);
    const label = clean(b.title, 120) || pagePath(s.page);
    if (label) {
      const link = /^https:\/\/(www\.)?osadko\.online\//.test(s.page) ? s.page : '';
      lines.push(link ? `📄 Сторінка: <a href="${esc(link).replace(/"/g, '&quot;')}">${esc(label)}</a>` : `📄 Сторінка: ${esc(label)}`);
    }
    lines.push('');
    lines.push(esc(text));
    if (contact) lines.push(`📞 Контакт: <code>${esc(contact)}</code>`);
    lines.push('');
    lines.push('<i>Відповідайте реплаєм на це повідомлення — відповідь з\'явиться в чаті на сайті.</i>');
  } else {
    if (text) lines.push(`💬 <b>#${s.code}</b>: ${esc(text)}`);
    if (newContact) lines.push(`📞 <b>#${s.code}</b> залишив контакт: <code>${esc(contact)}</code>`);
  }
  let delivered = true;
  if (lines.length) {
    const res = await tg(env, 'sendMessage', {
      chat_id: env.OWNER_CHAT, text: lines.join('\n'), parse_mode: 'HTML', link_preview_options: { is_disabled: true },
      ...(s.isNew ? { reply_markup: convButtons(s.id) } : {})
    });
    delivered = !!res.ok;
    if (res.ok) await env.DB.prepare('INSERT OR REPLACE INTO tgmap (tg, sid) VALUES (?1, ?2)').bind(res.result.message_id, s.id).run();
    else console.log('telegram send failed', JSON.stringify(res));
  }
  return { ok: true, sid: s.id, id, delivered };
}

// ── Відвідувач отримує нові повідомлення ───────────────────────────
async function onPoll(url, env) {
  const sid = url.searchParams.get('sid') || '';
  if (!/^[\w-]{20,40}$/.test(sid)) throw new HttpError(400, 'sid');
  const after = Math.max(0, parseInt(url.searchParams.get('after') || '0', 10) || 0);
  const r = await env.DB.prepare('SELECT id, who, text, t FROM msgs WHERE sid = ?1 AND id > ?2 ORDER BY id LIMIT 100').bind(sid, after).all();
  return { msgs: r.results || [] };
}

// ── Натискання на кнопки під повідомленнями ────────────────────────
async function onButton(env, cq) {
  const ack = (text) => tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text } : {}) });
  const chatId = cq.message && String(cq.message.chat.id);
  if (!env.OWNER_CHAT || String(cq.from.id) !== String(env.OWNER_CHAT) || chatId !== String(env.OWNER_CHAT)) return ack('Недоступно');
  const [act, sid] = String(cq.data || '').split(':');
  if (act === 'x') {
    await ack();
    return tg(env, 'editMessageText', { chat_id: chatId, message_id: cq.message.message_id, text: 'Скасовано.' });
  }
  const s = sid && await env.DB.prepare('SELECT * FROM sessions WHERE id = ?1').bind(sid).first();
  if (!s) return ack('Розмову не знайдено — можливо, її вже видалено');
  if (act === 'v') { await ack(); return sendTranscript(env, chatId, s); }
  if (act === 'd') {
    await ack();
    return tg(env, 'sendMessage', {
      chat_id: chatId, parse_mode: 'HTML', text: `Видалити розмову <b>#${s.code}</b>? Листування буде стерто з сервера, клієнт його більше не побачить.`,
      reply_markup: { inline_keyboard: [[{ text: '🗑 Так, видалити', callback_data: 'D:' + s.id }, { text: 'Скасувати', callback_data: 'x' }]] }
    });
  }
  if (act === 'D') {
    await deleteSession(env, s.id);
    await ack('Видалено');
    return tg(env, 'editMessageText', { chat_id: chatId, message_id: cq.message.message_id, parse_mode: 'HTML', text: `🗑 Розмову <b>#${s.code}</b> видалено з сервера.` });
  }
  return ack();
}

function setHook(env, origin) {
  return tg(env, 'setWebhook', { url: `${origin}/tg`, secret_token: env.WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'] });
}

// ── Перегляд усієї розмови в Telegram ──────────────────────────────
function kyivTime(t) {
  try {
    return new Date(t).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch (e) { return new Date(t).toISOString().slice(5, 16).replace('T', ' '); }
}

async function sendTranscript(env, chatId, s) {
  const r = await env.DB.prepare('SELECT who, text, t FROM msgs WHERE sid = ?1 ORDER BY id LIMIT 300').bind(s.id).all();
  const msgs = r.results || [];
  const head = [`📋 <b>Розмова #${s.code}</b> · почата ${esc(kyivTime(s.created))}`];
  if (s.contact) head.push(`📞 Контакт: <code>${esc(s.contact)}</code>`);
  const pp = pagePath(s.page);
  if (pp) head.push(`📄 Сторінка: ${pp === '/' || pp === '/index.html' ? 'Головна' : esc(pp)}`);
  const parts = [head.join('\n')];
  for (const x of msgs) {
    parts.push(`${x.who === 'adv' ? '⚖️ <b>Ви</b>' : '👤 <b>Клієнт</b>'} · ${esc(kyivTime(x.t))}\n${esc(x.text)}`);
  }
  if (!msgs.length) parts.push('<i>Повідомлень немає.</i>');
  // Telegram: до 4096 символів в одному повідомленні — ділимо
  const chunks = [];
  let cur = '';
  for (const p of parts) {
    const piece = p.length > 3900 ? p.slice(0, 3900) + '…' : p;
    if ((cur + '\n\n' + piece).length > 3900) { chunks.push(cur); cur = piece; }
    else cur = cur ? cur + '\n\n' + piece : piece;
  }
  if (cur) chunks.push(cur);
  let lastId = 0;
  for (let i = 0; i < chunks.length; i++) {
    const last = i === chunks.length - 1;
    const res = await tg(env, 'sendMessage', {
      chat_id: chatId, text: chunks[i], parse_mode: 'HTML', link_preview_options: { is_disabled: true },
      ...(last ? { reply_markup: { inline_keyboard: [[{ text: '🗑 Видалити розмову', callback_data: 'd:' + s.id }]] } } : {})
    });
    if (res.ok) lastId = res.result.message_id;
  }
  // Реплай на останню частину — відповідь піде в цю розмову
  if (lastId) await env.DB.prepare('INSERT OR REPLACE INTO tgmap (tg, sid) VALUES (?1, ?2)').bind(lastId, s.id).run();
}

// ── Видалення розмови (відвідувачем на сайті або адвокатом через /del) ─
async function deleteSession(env, sid) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM msgs WHERE sid = ?1').bind(sid),
    env.DB.prepare('DELETE FROM tgmap WHERE sid = ?1').bind(sid),
    env.DB.prepare('DELETE FROM sessions WHERE id = ?1').bind(sid)
  ]);
}

async function onDelete(req, env) {
  const b = await req.json().catch(() => null);
  if (!b || typeof b.sid !== 'string' || !/^[\w-]{20,40}$/.test(b.sid)) throw new HttpError(400, 'sid');
  const s = await env.DB.prepare('SELECT id, code FROM sessions WHERE id = ?1').bind(b.sid).first();
  if (!s) throw new HttpError(404, 'gone');
  await deleteSession(env, s.id);
  await tg(env, 'sendMessage', { chat_id: env.OWNER_CHAT, parse_mode: 'HTML', text: `🗑 <b>#${s.code}</b>: клієнт видалив розмову на сайті. Відповідати в неї вже не можна.` });
  return { ok: true };
}

// ── Відвідувач побачив відповіді → позначка 👀 на них у Telegram ────
async function onSeen(req, env) {
  const b = await req.json().catch(() => null);
  if (!b || typeof b.sid !== 'string' || !/^[\w-]{20,40}$/.test(b.sid)) throw new HttpError(400, 'sid');
  const upto = Math.max(0, parseInt(b.upto, 10) || 0);
  const r = await env.DB.prepare("SELECT id, tg FROM msgs WHERE sid = ?1 AND who = 'adv' AND id <= ?2 AND seen IS NULL AND tg IS NOT NULL ORDER BY id LIMIT 20")
    .bind(b.sid, upto).all();
  const rows = r.results || [];
  if (!rows.length) return { ok: true, n: 0 };
  await env.DB.prepare("UPDATE msgs SET seen = ?3 WHERE sid = ?1 AND who = 'adv' AND id <= ?2 AND seen IS NULL").bind(b.sid, upto, now()).run();
  for (const x of rows) {
    await tg(env, 'setMessageReaction', { chat_id: env.OWNER_CHAT, message_id: x.tg, reaction: [{ type: 'emoji', emoji: '👀' }] });
  }
  return { ok: true, n: rows.length };
}

// ── Вебхук Telegram: адвокат відповідає ────────────────────────────
async function onTelegram(req, env) {
  if (!env.WEBHOOK_SECRET || req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
    return new Response('forbidden', { status: 403 });
  }
  const u = await req.json().catch(() => ({}));
  if (u.callback_query) { await onButton(env, u.callback_query); return new Response('ok'); }
  const m = u.message;
  if (!m || !m.chat) return new Response('ok');
  const chatId = String(m.chat.id);

  if (!env.OWNER_CHAT) {
    await tg(env, 'sendMessage', { chat_id: chatId, text: `Ваш Telegram id: ${chatId}\nВпишіть його у змінну OWNER_CHAT воркера.` });
    return new Response('ok');
  }
  if (chatId !== String(env.OWNER_CHAT)) {
    await tg(env, 'sendMessage', { chat_id: chatId, text: 'Це службовий бот чату на сайті osadko.online. Написати адвокату: @adv_osadko' });
    return new Response('ok');
  }

  const say = (text, extra) => tg(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true }, ...(extra || {}) });

  if (m.text && (/^\/(start|help)\b/.test(m.text) || m.text === BTN_HELP)) {
    if (m.text !== BTN_HELP) { await setCommands(env); await setHook(env, new URL(req.url).origin); }
    await say(HELP, { reply_markup: MENU });
    return new Response('ok');
  }
  if (m.text && /^\/del\b/.test(m.text)) {
    const rep = m.reply_to_message;
    const row = rep && await env.DB.prepare('SELECT sid FROM tgmap WHERE tg = ?1').bind(rep.message_id).first();
    const s = row && await env.DB.prepare('SELECT id, code FROM sessions WHERE id = ?1').bind(row.sid).first();
    if (!s) { await say('Щоб видалити розмову, надішліть /del <b>реплаєм</b> на повідомлення клієнта.'); return new Response('ok'); }
    await deleteSession(env, s.id);
    await say(`🗑 Розмову #${s.code} видалено з сервера. Клієнт її більше не побачить.`);
    return new Response('ok');
  }
  if (m.text && /^\/view/.test(m.text)) {
    let s = null;
    const mc = m.text.match(/^\/view_([A-Z0-9]{4})\b/);
    if (mc) s = await env.DB.prepare('SELECT * FROM sessions WHERE code = ?1 ORDER BY last DESC').bind(mc[1]).first();
    else if (m.reply_to_message) {
      const row = await env.DB.prepare('SELECT sid FROM tgmap WHERE tg = ?1').bind(m.reply_to_message.message_id).first();
      if (row) s = await env.DB.prepare('SELECT * FROM sessions WHERE id = ?1').bind(row.sid).first();
    }
    if (!s) { await say('Розмову не знайдено. Надішліть /view <b>реплаєм</b> на повідомлення клієнта або виберіть розмову в /list.'); return new Response('ok'); }
    await sendTranscript(env, chatId, s);
    return new Response('ok');
  }
  if (m.text && (/^\/list\b/.test(m.text) || m.text === BTN_LIST)) {
    const r = await env.DB.prepare('SELECT id, code, last, contact FROM sessions ORDER BY last DESC LIMIT 10').all();
    const rows = (r.results || []).map((x) => {
      const ago = Math.round((now() - x.last) / 6e4);
      const when = ago < 60 ? ago + ' хв' : ago < 2880 ? Math.round(ago / 60) + ' год' : Math.round(ago / 1440) + ' дн';
      return [{ text: `#${x.code} · ${when} тому${x.contact ? ' · ' + x.contact : ''}`.slice(0, 60), callback_data: 'v:' + x.id }];
    });
    await say(rows.length ? 'Останні розмови — натисніть, щоб переглянути:' : 'Розмов ще немає.', rows.length ? { reply_markup: { inline_keyboard: rows } } : { reply_markup: MENU });
    return new Response('ok');
  }

  const text = clean(m.text || m.caption || '', MAX_LEN);
  if (!text) { await say('Поки що в чат на сайті можна надсилати лише текст.'); return new Response('ok'); }

  let sid = null;
  const rep = m.reply_to_message;
  if (rep) {
    const row = await env.DB.prepare('SELECT sid FROM tgmap WHERE tg = ?1').bind(rep.message_id).first();
    if (row) sid = row.sid;
    else { await say('Не знайшов, до якої розмови це повідомлення (можливо, вона старша за 30 днів).'); return new Response('ok'); }
  } else {
    const r = await env.DB.prepare('SELECT id FROM sessions WHERE last > ?1 ORDER BY last DESC LIMIT 2').bind(now() - ACTIVE_MIN * 6e4).all();
    const act = r.results || [];
    if (act.length === 1) sid = act[0].id;
    else {
      await say(act.length ? 'Зараз кілька активних розмов — зробіть <b>реплай</b> на повідомлення потрібного клієнта.' : 'Немає активної розмови. Щоб відповісти, зробіть <b>реплай</b> на повідомлення клієнта.');
      return new Response('ok');
    }
  }

  const s = await env.DB.prepare('SELECT id, code FROM sessions WHERE id = ?1').bind(sid).first();
  if (!s) { await say('Розмову не знайдено (можливо, вже видалена).'); return new Response('ok'); }
  const t = now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO msgs (sid, who, text, t, tg) VALUES (?1, 'adv', ?2, ?3, ?4)").bind(s.id, text, t, m.message_id),
    env.DB.prepare('UPDATE sessions SET last = ?2 WHERE id = ?1').bind(s.id, t),
    env.DB.prepare('INSERT OR REPLACE INTO tgmap (tg, sid) VALUES (?1, ?2)').bind(m.message_id, s.id)
  ]);
  return new Response('ok');
}

function setCommands(env) {
  return tg(env, 'setMyCommands', { commands: [{ command: 'list', description: 'Останні розмови' }, { command: 'view', description: 'Уся розмова (реплаєм)' }, { command: 'del', description: 'Видалити розмову (реплаєм)' }, { command: 'help', description: 'Як відповідати' }] });
}

// ── Разове налаштування вебхука: відкрити /setup?key=WEBHOOK_SECRET ─
async function onSetup(env, url) {
  if (!env.WEBHOOK_SECRET || url.searchParams.get('key') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
  const me = await tg(env, 'getMe', {});
  const hook = await tg(env, 'setWebhook', {
    url: `${url.origin}/tg`, secret_token: env.WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true
  });
  await setCommands(env);
  const ok = me.ok && hook.ok;
  const lines = [
    ok ? '✅ Готово.' : '❌ Помилка — перевірте CHAT_BOT_TOKEN.',
    me.ok ? `Бот: @${me.result.username}` : `getMe: ${JSON.stringify(me)}`,
    `Вебхук: ${JSON.stringify(hook)}`,
    env.OWNER_CHAT ? `OWNER_CHAT: ${env.OWNER_CHAT}` : 'OWNER_CHAT ще не задано: напишіть боту /start — він підкаже ваш id.'
  ];
  return new Response(lines.join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
