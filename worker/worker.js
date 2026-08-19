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
    [{ text: '⚖️ Справи адвоката', callback_data: 'crep' }],
  ] };
}

async function showCourtReport(env) {
  const rep = await env.KV.get('court_report', 'json');
  if (!rep || !rep.items || !rep.items.length) {
    return tg(env, 'sendMessage', {
      chat_id: env.REVIEW_CHAT, parse_mode: 'HTML',
      text: '⚖️ <b>Справи адвоката</b>\nПоки немає даних. Звіт оновлюється під час ' +
        'планового прогону (тричі на день) — після першого прогону тут зʼявиться список.',
      reply_markup: courtMenuKb(),
    });
  }
  const lines = rep.items.slice(0, 50).map((it, i) =>
    `${i + 1}. <b>${esc(it.number)}</b> · ${esc(it.date)}\n` +
    `    ${esc(it.judge || '')}${it.judge ? ' · ' : ''}${esc(it.court || '')}`);
  let txt = `⚖️ <b>Справи адвоката: ${rep.count}</b>\n` +
    `<i>оновлено: ${esc(rep.updated || '')}</i>\n\n` + lines.join('\n');
  if (rep.count > 50) txt += `\n\n… та ще ${rep.count - 50}.`;
  return tg(env, 'sendMessage', {
    chat_id: env.REVIEW_CHAT, parse_mode: 'HTML', text: txt,
    disable_web_page_preview: true, reply_markup: courtMenuKb(),
  });
}

async function showCourtMenu(env, prefix = '') {
  const arr = await getNames(env);
  await tg(env, 'sendMessage', {
    chat_id: env.REVIEW_CHAT, parse_mode: 'HTML',
    text: prefix + '⚖️ <b>Клієнти під наглядом (суд)</b>\nУсього прізвищ: <b>' +
      arr.length + '</b>\n\nОберіть дію:',
    reply_markup: courtMenuKb(),
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
    const [action, pid] = (cq.data || '').split(':');

    // --- меню бота відстеження судових справ ---
    if (['cmenu', 'cadd', 'clist', 'cedit', 'cdel', 'crep'].includes(action)) {
      await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
      if (action === 'cmenu') return showCourtMenu(env);
      if (action === 'crep') return showCourtReport(env);
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

    // Виклик меню керування клієнтами
    if (/^(\/menu|\/court|\/klienty|\/клієнти|\/клиенти|меню|клієнти)$/i.test(body)) {
      await env.KV.delete('court_await');
      return showCourtMenu(env);
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
    // Звіт «справи адвоката» від бота (зберігається для перегляду з меню).
    if (request.method === 'POST' && url.pathname === '/court_report') {
      if ((request.headers.get('X-Auth-Token') || '') !== env.AUTH_TOKEN) {
        return new Response('forbidden', { status: 403 });
      }
      let o; try { o = await request.json(); } catch { return new Response('bad', { status: 400 }); }
      await env.KV.put('court_report', JSON.stringify(o));
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
