// ─────────────────────────────────────────────────────────────────────────
// Cloudflare Worker: приймає заявки з форм сайту й надсилає їх у Telegram.
//
// Токен бота НЕ зберігається в коді сайту (він публічний) — він живе тут,
// у секретах воркера. Форма на сайті лише шле дані на URL цього воркера.
//
// НАЛАШТУВАННЯ (Cloudflare → ваш Worker → Settings → Variables and Secrets):
//   TELEGRAM_BOT_TOKEN  — токен бота від @BotFather                (тип: Secret)
//   TELEGRAM_CHAT_ID    — ваш chat_id (дізнатися через @userinfobot) (тип: Secret)
//   ALLOWED_ORIGIN      — https://alexosadko.github.io   (необов'язково, обмежує доступ)
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

    let data;
    try {
      data = await request.json();
    } catch {
      return json({ ok: false, error: "bad json" }, 400, cors);
    }

    // Антиспам: приховане поле-пастка (боти його заповнюють).
    if (data.company) return json({ ok: true }, 200, cors); // тихо ігноруємо

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
