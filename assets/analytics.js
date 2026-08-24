/* Аналітика й конверсії: GA4 + Google Ads.
   ─────────────────────────────────────────────────────────────────────
   ЯК УВІМКНУТИ (одноразово):
   1) Впишіть свої ID нижче — GA4_ID і ADS_ID.
   2) Впишіть мітки конверсій ADS_LEAD_LABEL і ADS_CALL_LABEL
      (це рядок, що йде після «AW-XXXXXXXXX/» у фрагменті конверсії).
   Поки стоять значення-плейсхолдери — скрипт НІЧОГО не вантажить,
   сайт працює як звичайно (жодних помилок).

   Що відстежується як конверсія:
   • «Заявка» — успішна відправка форми (виклик window.osadkoConversion з lead-form.js);
   • «Дзвінок» — клік по номеру (посилання tel:);
   • Клік у месенджер (Telegram/WhatsApp/Viber) — подія + за бажанням конверсія.
   ───────────────────────────────────────────────────────────────────── */
(function () {
  "use strict";

  // ── НАЛАШТУВАННЯ: вставте свої значення ──────────────────────────────
  var GA4_ID = "G-YS9JTNL11Q";   // GA4 → Адміністратор → Потоки даних → Ідентифікатор вимірювання
  var ADS_ID = "AW-XXXXXXXXX";   // Google Ads → Інструменти → Конверсії → тег (починається з AW-)
  var ADS_LEAD_LABEL = "";       // мітка конверсії «Заявка з сайту»
  var ADS_CALL_LABEL = "";       // мітка конверсії «Дзвінок з сайту»
  var COUNT_MESSENGERS = true;   // клік у месенджер рахувати як конверсію «заявка»?
  // ─────────────────────────────────────────────────────────────────────

  var hasGA4 = /^G-/.test(GA4_ID) && GA4_ID !== "G-XXXXXXXXXX";
  var hasAds = /^AW-/.test(ADS_ID) && ADS_ID !== "AW-XXXXXXXXX";

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = window.gtag || gtag;

  if (hasGA4 || hasAds) {
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + (hasGA4 ? GA4_ID : ADS_ID);
    document.head.appendChild(s);
    gtag("js", new Date());
    if (hasGA4) gtag("config", GA4_ID);
    if (hasAds) gtag("config", ADS_ID);
  }

  function adsConversion(label) {
    if (hasAds && label) gtag("event", "conversion", { send_to: ADS_ID + "/" + label });
  }

  // Викликається з lead-form.js після успішної відправки форми.
  window.osadkoConversion = function () {
    gtag("event", "generate_lead", { type: "form" });
    adsConversion(ADS_LEAD_LABEL);
  };

  // Кліки по телефону та месенджерах (делеговано, ловимо навіть у динамічних блоках).
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    var href = a.getAttribute("href") || "";
    if (href.indexOf("tel:") === 0) {
      gtag("event", "call_click", { method: "phone" });
      adsConversion(ADS_CALL_LABEL);
    } else if (/t\.me\/|wa\.me\/|api\.whatsapp|whatsapp\.com|viber:/i.test(href)) {
      var m = /t\.me/i.test(href) ? "telegram"
            : /wa\.me|whatsapp/i.test(href) ? "whatsapp" : "viber";
      gtag("event", "contact_click", { method: m });
      if (COUNT_MESSENGERS) adsConversion(ADS_LEAD_LABEL);
    }
  }, true);
})();
