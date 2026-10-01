// Google Analytics 4 + Google Consent Mode v2.
// gtag.js вантажиться завжди; до згоди — cookieless-сигнали (без cookie й ідентифікації),
// після згоди («Прийняти») — повноцінне вимірювання з cookie.
(function () {
  var GA_ID = "G-YS9JTNL11Q";
  var KEY = "cookieConsent";

  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  window.gtag = gtag;

  var stored = null;
  try { stored = localStorage.getItem(KEY); } catch (e) {}

  // Consent Mode v2 — стан за замовчуванням (до вибору користувача — denied).
  // Якщо користувач раніше натиснув «Прийняти» — одразу вмикаємо і аналітику,
  // і рекламні сигнали (щоб Google Ads рахував конверсії повноцінно, з cookie).
  var granted = (stored === "granted");
  gtag("consent", "default", {
    ad_storage: granted ? "granted" : "denied",
    ad_user_data: granted ? "granted" : "denied",
    ad_personalization: granted ? "granted" : "denied",
    analytics_storage: granted ? "granted" : "denied",
    wait_for_update: 500
  });

  // gtag.js вантажиться завжди (перевірка встановлення Google проходить).
  var s = document.createElement("script");
  s.async = true;
  s.src = "https://www.googletagmanager.com/gtag/js?id=" + GA_ID;
  document.head.appendChild(s);
  gtag("js", new Date());
  gtag("config", GA_ID);

  // Google Ads — робочий акаунт (adv.osadko@gmail.com, 624-250-0421).
  var ADS_ID = "AW-18401189598";
  gtag("config", ADS_ID);
  // Ярлик конверсії «Призначення зустрічі» цього акаунта.
  var CONV_LABEL2 = "AW-18401189598/Cj8ICMiJ_eQcEN69r8ZE";
  // Щоб розвести телефон/месенджер в окрему конверсію «Контакт» того ж
  // акаунта — вписати її ярлик сюди й використати в microContact().
  var CONV_CONTACT = null; // напр. "AW-18401189598/XXXX" — поки не задано

  // Викликати В МОМЕНТ успішного звернення (не при завантаженні сторінки).
  // Consent Mode сам обере cookie/cookieless-режим за станом згоди.
  window.osadkoConversion = function () {
    gtag("event", "conversion", { send_to: CONV_CONTACT || CONV_LABEL2 });
  };

  function grant() {
    gtag("consent", "update", {
      ad_storage: "granted",
      ad_user_data: "granted",
      ad_personalization: "granted",
      analytics_storage: "granted"
    });
  }
  function deny() {
    gtag("consent", "update", {
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
      analytics_storage: "denied"
    });
  }

  // Події-конверсії (Consent Mode сам вирішує cookie/cookieless за станом згоди).
  function track(name, params) { gtag("event", name, params || {}); }
  window.osadkoTrack = track;

  // Мікроконверсія в Google Ads: дзвінок і месенджер — це теж «Контакт».
  // Дедуплікація за типом у межах одного перегляду, щоб не роздувати статистику.
  var microFired = {};
  function microContact(kind) {
    if (microFired[kind]) return;
    microFired[kind] = true;
    if (window.osadkoConversion) window.osadkoConversion();
  }

  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a") : null;
    if (!a) return;
    var href = a.getAttribute("href") || "";
    if (href.indexOf("tel:") === 0) { track("click_phone"); microContact("phone"); }
    else if (href.indexOf("mailto:") === 0) track("click_email");
    else if (href.indexOf("t.me/") > -1) { track("click_messenger", { channel: "telegram" }); microContact("telegram"); }
    else if (href.indexOf("wa.me") > -1 || href.indexOf("whatsapp") > -1) { track("click_messenger", { channel: "whatsapp" }); microContact("whatsapp"); }
    else if (href.indexOf("viber:") === 0) { track("click_messenger", { channel: "viber" }); microContact("viber"); }
    else if (/\.docx($|\?)/i.test(href)) track("download_template", { file: href.split("/").pop() });
    else if (/\.pdf($|\?)/i.test(href)) track("download_pamyatka", { file: (href.split("/").pop() || "").split("?")[0] });
  }, true);

  document.addEventListener("submit", function (e) {
    var f = e.target;
    if (!f) return;
    if (f.id === "leadForm") { track("generate_lead", { form: "contacts" }); microContact("form"); }
    else if (f.classList && f.classList.contains("cb-form")) { track("generate_lead", { form: "popup" }); microContact("form"); }
  }, true);

  // ── Банер згоди на cookie ──
  function buildBanner() {
    var inSub = /\/(articles|zrazky|privacy)\//.test(location.pathname);
    var policyUrl = (inSub ? "../" : "") + "privacy/index.html";
    var b = document.createElement("div");
    b.className = "cookie-banner";
    b.setAttribute("role", "dialog");
    b.setAttribute("aria-label", "Згода на використання cookie");
    b.innerHTML =
      '<p>Ми використовуємо файли cookie для аналітики та реклами (Google Analytics і Google Ads), ' +
      'щоб покращувати сайт і оцінювати ефективність реклами. ' +
      'Деталі — у <a href="' + policyUrl + '">Політиці конфіденційності</a>.</p>' +
      '<div class="cookie-actions">' +
        '<button type="button" class="btn btn-primary ck-accept">Прийняти</button>' +
        '<button type="button" class="btn btn-ghost ck-decline">Відхилити</button>' +
      '</div>';
    document.body.appendChild(b);
    b.querySelector(".ck-accept").addEventListener("click", function () {
      try { localStorage.setItem(KEY, "granted"); } catch (e) {}
      b.remove(); grant();
    });
    b.querySelector(".ck-decline").addEventListener("click", function () {
      try { localStorage.setItem(KEY, "denied"); } catch (e) {}
      b.remove(); deny();
    });
  }

  if (!stored) {
    if (document.body) buildBanner();
    else document.addEventListener("DOMContentLoaded", buildBanner);
  }
})();
