/* Обробник inline-форм заявки на статтях і лендінгах.
   Тей самий релей (Cloudflare Worker → Telegram), що й форми на головній.
   Антиспам: honeypot (поле company) + часова пастка. Токен Turnstile тут не
   використовується (як і у lead-магніті) — за потреби worker приймає token:''.
   Якщо запит не пройшов — резервний варіант через поштовий клієнт (mailto),
   щоб заявка не загубилася. */
(function () {
  "use strict";
  var NOTIFY_ENDPOINT = "https://osadko-relay.espir3.workers.dev";
  var MAIL = "adv.osadko@gmail.com";
  var formStart = Date.now();

  function attach(form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      // honeypot: приховане поле company має лишатися порожнім
      if (form.elements["company"] && form.elements["company"].value) return;
      // часова пастка: миттєве надсилання = бот
      if (Date.now() - formStart < 2000) return;
      var name = form.elements["name"] ? form.elements["name"].value.trim() : "";
      var phone = form.elements["phone"] ? form.elements["phone"].value.trim() : "";
      var message = form.elements["message"] ? form.elements["message"].value.trim() : "";
      if (!name || !phone) return;
      var source = form.getAttribute("data-source") || "Заявка з сайту";
      var ok = form.querySelector(".form-ok");
      var btn = form.querySelector("button[type=submit]");

      var showOk = function () {
        form.reset();
        if (ok) ok.style.display = "block";
        if (btn) btn.disabled = false;
        if (window.osadkoConversion) window.osadkoConversion();
      };
      var mailFallback = function () {
        var body = "Джерело: " + source + "\nІмʼя: " + name + "\nТелефон: " + phone +
          (message ? "\nПитання: " + message : "");
        window.location.href = "mailto:" + MAIL + "?subject=" +
          encodeURIComponent(source) + "&body=" + encodeURIComponent(body);
      };

      if (btn) btn.disabled = true;
      fetch(NOTIFY_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name, phone: phone, message: message,
          source: source, page: location.href, token: ""
        })
      })
        .then(function (r) { if (!r.ok) throw new Error("bad"); return r; })
        .then(showOk)
        .catch(function () { if (btn) btn.disabled = false; mailFallback(); });
    });
  }

  var forms = document.querySelectorAll("form.js-lead-form");
  for (var i = 0; i < forms.length; i++) attach(forms[i]);
})();
