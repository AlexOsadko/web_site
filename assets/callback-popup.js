// Спливаюче вікно «Замовити дзвінок».
// Показується через 30 с перебування на сайті; після закриття — повторно кожні 120 с.
// Таймер зберігається в sessionStorage, тож переживає переходи між сторінками.
// Після успішного надсилання більше не показується (у межах сесії).
(function () {
  var FIRST = 30000;   // перша поява — 30 секунд
  var REPEAT = 120000; // повтор після закриття — 120 секунд

  // Ендпоінти (як і в формах на головній). Порожньо = лист на пошту.
  var NOTIFY_ENDPOINT = "";  // URL Cloudflare Worker (Telegram)
  var WEB3FORMS_KEY = "";    // ключ web3forms.com (пошта)

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
        '<button type="submit" class="btn btn-primary">Передзвоніть мені</button>' +
        '<p class="cb-ok">Дякую! Я зателефоную вам найближчим часом.</p>' +
      "</form>" +
    "</div>";
  if (document.body) document.body.appendChild(modal);

  var form = modal.querySelector(".cb-form");
  var okEl = modal.querySelector(".cb-ok");
  var timer;

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
        body: JSON.stringify({ name: name, phone: phone, source: "Замовити дзвінок (спливаюче вікно)", page: location.href }),
      }).then(function (r) { if (!r.ok) throw new Error("bad"); }).then(done).catch(mail);
    } else if (WEB3FORMS_KEY) {
      fetch("https://api.web3forms.com/submit", {
        method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ access_key: WEB3FORMS_KEY, subject: "Замовити дзвінок", name: name, phone: phone }),
      }).then(function (r) { return r.json(); }).then(done).catch(mail);
    } else {
      mail();
    }
  });

  schedule();
})();
