// ─────────────────────────────────────────────────────────────────────────
// Cloudflare Worker: приймає заявки з форм сайту й надсилає їх у Telegram.
//
// Токен бота НЕ зберігається в коді сайту (він публічний) — він живе тут,
// у секретах воркера. Форма на сайті лише шле дані на URL цього воркера.
//
// НАЛАШТУВАННЯ (Cloudflare → ваш Worker → Settings → Variables and Secrets):
//   TELEGRAM_BOT_TOKEN  — токен бота від @BotFather                  (тип: Secret)
//   TELEGRAM_CHAT_ID    — ваш chat_id (дізнатися через @userinfobot)  (тип: Secret)
//   TURNSTILE_SECRET    — Secret Key віджета Turnstile (перевірка від спаму) (тип: Secret)
//   ALLOWED_ORIGIN      — https://osadko.online   (необов'язково, обмежує доступ)
// ─────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
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
    // Боти, що б'ють напряму по адресі воркера, або не шлють Origin,
    // або шлють чужий — таких тихо відхиляємо.
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

    // Антиспам №3: Turnstile-токен обовʼязковий завжди.
    // Справжня форма й попап його додають; прямий POST від бота — ні.
    const token = String(data.token || "");
    if (!token) return json({ ok: false, error: "no-token" }, 403, cors);

    // Перевірка Turnstile (якщо задано TURNSTILE_SECRET у секретах воркера).
    if (env.TURNSTILE_SECRET) {
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
  },
};

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
