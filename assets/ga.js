// Google Analytics 4 зі згодою на cookie + події-конверсії.
// GA завантажується ЛИШЕ після згоди (localStorage cookieConsent=granted).
(function () {
  var GA_ID = "G-YS9JTNL11Q";
  var KEY = "cookieConsent";

  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  window.gtag = gtag;

  var granted = false;

  function loadGA() {
    if (granted) return;
    granted = true;
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + GA_ID;
    document.head.appendChild(s);
    gtag("js", new Date());
    gtag("config", GA_ID);
  }

  // Відправка події лише за наявності згоди.
  function track(name, params) {
    if (!granted) return;
    gtag("event", name, params || {});
  }
  window.osadkoTrack = track;

  // ── Події-конверсії (слухачі ставимо завжди; без згоди вони мовчать) ──
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a") : null;
    if (!a) return;
    var href = a.getAttribute("href") || "";
    if (href.indexOf("tel:") === 0) track("click_phone");
    else if (href.indexOf("mailto:") === 0) track("click_email");
    else if (href.indexOf("t.me/") > -1) track("click_messenger", { channel: "telegram" });
    else if (href.indexOf("wa.me") > -1 || href.indexOf("whatsapp") > -1) track("click_messenger", { channel: "whatsapp" });
    else if (href.indexOf("viber:") === 0) track("click_messenger", { channel: "viber" });
    else if (/\.docx($|\?)/i.test(href)) track("download_template", { file: href.split("/").pop() });
  }, true);

  document.addEventListener("submit", function (e) {
    var f = e.target;
    if (!f) return;
    if (f.id === "leadForm") track("generate_lead", { form: "contacts" });
    else if (f.classList && f.classList.contains("cb-form")) track("generate_lead", { form: "popup" });
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
      '<p>Ми використовуємо файли cookie для аналітики (Google Analytics), щоб покращувати сайт. ' +
      'Деталі — у <a href="' + policyUrl + '">Політиці конфіденційності</a>.</p>' +
      '<div class="cookie-actions">' +
        '<button type="button" class="btn btn-primary ck-accept">Прийняти</button>' +
        '<button type="button" class="btn btn-ghost ck-decline">Відхилити</button>' +
      '</div>';
    document.body.appendChild(b);
    b.querySelector(".ck-accept").addEventListener("click", function () {
      try { localStorage.setItem(KEY, "granted"); } catch (e) {}
      b.remove(); loadGA();
    });
    b.querySelector(".ck-decline").addEventListener("click", function () {
      try { localStorage.setItem(KEY, "denied"); } catch (e) {}
      b.remove();
    });
  }

  var choice = null;
  try { choice = localStorage.getItem(KEY); } catch (e) {}
  if (choice === "granted") loadGA();
  else if (choice === "denied") { /* без аналітики */ }
  else if (document.body) buildBanner();
  else document.addEventListener("DOMContentLoaded", buildBanner);
})();
