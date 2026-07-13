// Спливаюче вікно «Замовити дзвінок».
// Показується через 30 с перебування на сайті; після закриття — повторно кожні 120 с.
// Таймер зберігається в sessionStorage, тож переживає переходи між сторінками.
// Після успішного надсилання більше не показується (у межах сесії).
(function () {
  var FIRST = 45000;   // перша поява — 45 секунд
  var REPEAT = 180000; // повтор після закриття — 180 секунд (3 хв)
  var VER = "18";      // зміна версії скидає збережений стан таймера (нові тайминги діють одразу)

  // Ендпоінти (як і в формах на головній). Порожньо = лист на пошту.
  var NOTIFY_ENDPOINT = "https://osadko-relay.espir3.workers.dev";  // Cloudflare Worker (relay → Telegram)
  var TS_SITEKEY = "0x4AAAAAAD1Dx9AvRT4v-VoQ";  // Turnstile Site Key (публічний)

  // Підвантажуємо скрипт Turnstile, якщо його ще немає на сторінці.
  if (!document.querySelector('script[src*="turnstile/v0/api.js"]')) {
    var _ts = document.createElement("script");
    _ts.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    _ts.async = true; _ts.defer = true;
    (document.head || document.documentElement).appendChild(_ts);
  }

  // Скидання старого стану при новій версії (щоб зміни таймінгів діяли й у відкритій вкладці).
  if (sessionStorage.getItem("cbVer") !== VER) {
    sessionStorage.removeItem("cbDone");
    sessionStorage.removeItem("cbNext");
    sessionStorage.setItem("cbVer", VER);
  }

  if (sessionStorage.getItem("cbDone") === "1") return; // вже залишив заявку

  // ── Розмітка вікна ───────────────────────────────────────────────
  var modal = document.createElement("div");
  modal.className = "cb-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-label", "Замовити дзвінок");
  modal.innerHTML =
    '<div class="cb-backdrop"></div>' +
    '<div class="cb-card">' +
      '<button type="button" class="cb-close" aria-label="Закрити">&times;</button>' +
      "<h3>Замовити дзвінок</h3>" +
      "<p>Залиште номер — адвокат передзвонить і безкоштовно зорієнтує щодо вашої ситуації.</p>" +
      '<form class="cb-form" novalidate>' +
        '<input type="text" name="name" placeholder="Ваше імʼя" autocomplete="name" aria-label="Ваше імʼя">' +
        '<input type="tel" name="phone" placeholder="Номер телефону" required autocomplete="tel" aria-label="Номер телефону">' +
        '<input type="text" name="company" class="hp-field" tabindex="-1" autocomplete="off" aria-hidden="true">' +
        '<div class="cb-ts"></div>' +
        '<button type="submit" class="btn btn-primary">Передзвоніть мені</button>' +
        '<p class="cb-ok">Дякую! Я зателефоную вам найближчим часом.</p>' +
      "</form>" +
    "</div>";
  if (document.body) document.body.appendChild(modal);

  var form = modal.querySelector(".cb-form");
  var okEl = modal.querySelector(".cb-ok");
  var timer;

  // ── Turnstile у вікні (рендеримо при першому відкритті) ───────────
  var tsWidgetId = null, tsToken = "";
  function ensureTS(cb) {
    if (window.turnstile) return cb();
    var n = 0, t = setInterval(function () {
      if (window.turnstile) { clearInterval(t); cb(); }
      else if (++n > 40) { clearInterval(t); }   // ~8 с очікування
    }, 200);
  }
  function renderTS() {
    var holder = modal.querySelector(".cb-ts");
    if (!holder) return;
    ensureTS(function () {
      if (tsWidgetId !== null) { window.turnstile.reset(tsWidgetId); tsToken = ""; return; }
      tsWidgetId = window.turnstile.render(holder, {
        sitekey: TS_SITEKEY, theme: "light",
        callback: function (tok) { tsToken = tok; },
        "error-callback": function () { tsToken = ""; },
        "expired-callback": function () { tsToken = ""; }
      });
    });
  }

  function getNext() {
    var n = parseInt(sessionStorage.getItem("cbNext") || "0", 10);
    if (!n) { n = Date.now() + FIRST; sessionStorage.setItem("cbNext", String(n)); }
    return n;
  }
  function setNext(ms) {
    sessionStorage.setItem("cbNext", String(Date.now() + ms));
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(show, Math.max(0, getNext() - Date.now()));
  }
  function show() {
    if (sessionStorage.getItem("cbDone") === "1") return;
    if (modal.classList.contains("open")) return;
    modal.classList.add("open");
    renderTS();
    setNext(REPEAT); // старт відліку повтору (переживе і закриття, і перехід сторінки)
  }
  function hide() { modal.classList.remove("open"); }
  function dismiss() { hide(); setNext(REPEAT); schedule(); }

  modal.querySelector(".cb-close").addEventListener("click", dismiss);
  modal.querySelector(".cb-backdrop").addEventListener("click", dismiss);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && modal.classList.contains("open")) dismiss();
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (form.elements["company"] && form.elements["company"].value) return; // honeypot
    var name = form.elements["name"].value.trim();
    var phone = form.elements["phone"].value.trim();
    if (!phone) { form.elements["phone"].focus(); return; }
    var done = function () {
      sessionStorage.setItem("cbDone", "1");
      form.reset();
      if (okEl) okEl.style.display = "block";
      setTimeout(hide, 2500);
    };
    var mail = function () {
      sessionStorage.setItem("cbDone", "1"); // людина вже надіслала — більше не турбувати
      hide();
      location.href = "mailto:adv.osadko@gmail.com?subject=" +
        encodeURIComponent("Замовити дзвінок") + "&body=" +
        encodeURIComponent("Джерело: спливаюче вікно\nІмʼя: " + name + "\nТелефон: " + phone);
    };
    if (NOTIFY_ENDPOINT) {
      fetch(NOTIFY_ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name, phone: phone, token: tsToken, source: "Замовити дзвінок (спливаюче вікно)", page: location.href }),
      }).then(function (r) { if (!r.ok) throw new Error("bad"); }).then(done).catch(mail);
    } else {
      mail();
    }
  });

  schedule();
})();
