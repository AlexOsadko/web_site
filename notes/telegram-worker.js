// ─────────────────────────────────────────────────────────────────────────
// Cloudflare Worker для сайту адвоката.
//
//   POST / → приймає заявки з форм і надсилає їх у Telegram.
//
// НАЛАШТУВАННЯ (Cloudflare → ваш Worker → Settings → Variables and Secrets):
//     TELEGRAM_BOT_TOKEN  — токен бота від @BotFather                     (Secret)
//     TELEGRAM_CHAT_ID    — ваш chat_id (через @userinfobot)              (Secret)
//     TURNSTILE_SECRET    — Secret Key віджета Turnstile                  (Secret)
//     ALLOWED_ORIGIN      — https://osadko.online (обмежує доступ)        (Text)
// ─────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    return handleLead(request, env);
  },
};

// ── Заявки з форм → Telegram ────────────────────────────────────────────
async function handleLead(request, env) {
  const allow = env.ALLOWED_ORIGIN || "*";
  const cors = {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  if (request.method !== "POST")
    return new Response("Method Not Allowed", { status: 405, headers: cors });

  // Антиспам №1: заявку приймаємо ЛИШЕ з нашого сайту.
  if (env.ALLOWED_ORIGIN) {
    const origin = request.headers.get("Origin") || "";
    const referer = request.headers.get("Referer") || "";
    const okOrigin =
      origin === env.ALLOWED_ORIGIN || referer.startsWith(env.ALLOWED_ORIGIN);
    if (!okOrigin) return json({ ok: false, error: "origin" }, 403, cors);
  }

  let data;
  try {
    data = await request.json();
  } catch {
    return json({ ok: false, error: "bad json" }, 400, cors);
  }

  // Антиспам №2: приховане поле-пастка (боти його заповнюють).
  if (data.company) return json({ ok: true }, 200, cors); // тихо ігноруємо

  // Перевірка Turnstile — лише якщо задано TURNSTILE_SECRET І заявка містить токен.
  if (env.TURNSTILE_SECRET && data.token) {
    const token = String(data.token || "");
    const verify = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          secret: env.TURNSTILE_SECRET,
          response: token,
          remoteip: request.headers.get("CF-Connecting-IP") || "",
        }),
      }
    );
    const outcome = await verify.json().catch(() => ({ success: false }));
    if (!outcome.success) return json({ ok: false, error: "turnstile" }, 403, cors);
  }

  const name = String(data.name || "").slice(0, 200);
  const phone = String(data.phone || "").slice(0, 60);
  const message = String(data.message || "").slice(0, 2000);
  const source = String(data.source || "Заявка з сайту").slice(0, 120);
  const page = String(data.page || "").slice(0, 300);

  if (!name && !phone) return json({ ok: false, error: "empty" }, 400, cors);

  const text =
    `🔔 <b>${esc(source)}</b>\n` +
    `👤 Імʼя: ${esc(name) || "—"}\n` +
    `📞 Телефон: ${esc(phone) || "—"}` +
    (message ? `\n📝 ${esc(message)}` : "") +
    (page ? `\n🔗 ${esc(page)}` : "");

  const tg = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    }
  );

  if (!tg.ok) return json({ ok: false, error: "telegram" }, 502, cors);
  return json({ ok: true }, 200, cors);
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
