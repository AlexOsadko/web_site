/* Чат на сайті → Telegram адвоката (Cloudflare Worker, див. worker/chat/).
   Відкривається з меню «Подзвонити / Telegram / …» та кнопки «Чат на сайті» в
   контактах; окремої плаваючої кнопки немає. Відповідь адвоката підтягується
   опитуванням воркера: часто — коли вікно відкрите, рідко — коли закрите.
   Поки ENDPOINT порожній — нічого не показується. */
(function () {
  "use strict";
  var ENDPOINT = window.OSADKO_CHAT_ENDPOINT || "https://osadko-chat.espir3.workers.dev";
  var TS_SITEKEY = "0x4AAAAAAD1Dx9AvRT4v-VoQ";        // Turnstile (той самий, що й у формах)
  var KEY = "osadkoChat";
  // Окрема іконка чату: "fab" — кнопка в правому нижньому куті, "head" — у шапці, "both", "" — без неї
  var LAUNCHER = window.OSADKO_CHAT_LAUNCHER != null ? window.OSADKO_CHAT_LAUNCHER : "fab";
  if (!ENDPOINT || !window.fetch || !document.querySelector) return;
  ENDPOINT = ENDPOINT.replace(/\/+$/, "");

  var me = document.currentScript && document.currentScript.src || "";
  var BASE = me ? me.replace(/assets\/chat\.js.*$/, "") : "/";

  var st = load();
  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) {}
  }

  var ICON_CHAT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm3 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm5 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm5 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/></svg>';
  var ICON_SEND = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.4 20.4 21.9 12 3.4 3.6 3.4 10.1 16 12 3.4 13.9z"/></svg>';

  // ── Точки входу ────────────────────────────────────────────────────
  function addEntries() {
    document.querySelectorAll(".hm-menu").forEach(function (menu) {
      if (menu.querySelector(".hm-o-chat")) return;
      var b = document.createElement("button");
      b.type = "button";
      b.className = "hm-opt hm-o-chat js-chat";
      b.setAttribute("role", "menuitem");
      b.innerHTML = "<i>" + ICON_CHAT + "</i><span><b>Чат на сайті</b><em>написати тут, без месенджерів</em></span>";
      menu.appendChild(b);
    });
    document.querySelectorAll(".hm-msgs").forEach(function (box) {
      if (box.querySelector(".hm-chat")) return;
      var b = document.createElement("button");
      b.type = "button";
      b.className = "hm-pill hm-soft hm-chat js-chat";
      b.textContent = "Чат на сайті";
      box.appendChild(b);
    });
    // Ряди кнопок месенджерів на «Контактах» і сторінках послуг — окремий рядок під ними
    document.querySelectorAll(".lp-btn-vb").forEach(function (vb) {
      var row = vb.parentNode;
      if (!row || (row.nextElementSibling && row.nextElementSibling.classList.contains("lp-chatlink"))) return;
      var b = document.createElement("button");
      b.type = "button";
      b.className = "lp-chatlink js-chat";
      b.innerHTML = ICON_CHAT + "<span>Або напишіть у чат прямо тут, на сайті</span>";
      row.parentNode.insertBefore(b, row.nextSibling);
    });
  }

  // ── Окрема іконка чату ─────────────────────────────────────────────
  var fab = null;
  function addLauncher() {
    if (/head|both/.test(LAUNCHER)) {
      var c = document.querySelector(".hm-head .hm-c");
      var ref = c && (c.querySelector(".hm-tel") || c.querySelector(".theme-toggle"));
      if (ref && !c.querySelector(".hm-chat-h")) {
        var h = document.createElement("button");
        h.type = "button";
        h.className = "hm-chat-h js-chat";
        h.setAttribute("aria-label", "Написати в чат");
        h.title = "Написати в чат";
        h.innerHTML = ICON_CHAT;
        c.insertBefore(h, ref);
      }
    }
    if (/fab|both/.test(LAUNCHER)) {
      fab = document.createElement("button");
      fab.type = "button";
      fab.className = "hc-fab js-chat";
      fab.setAttribute("aria-label", "Написати в чат");
      fab.innerHTML = "<i>" + ICON_CHAT + "</i><span>Написати в чат</span>";
      document.body.appendChild(fab);
      // Поки видно банер cookie (він унизу екрана) — кнопку не показуємо, щоб не перекривати
      var sync = function () { fab.classList.toggle("hc-hide", !!document.querySelector(".cookie-banner")); };
      sync();
      if (window.MutationObserver) new MutationObserver(sync).observe(document.body, { childList: true });
      setTimeout(function () { fab.classList.add("show"); }, 1200);
    }
  }

  // ── Вікно чату (створюється при першому відкритті) ─────────────────
  var panel, body, form, ta, sendBtn, toast, tsBox;
  var rendered = {};
  var tsToken = "", tsWidget = null;

  function build() {
    if (panel) return;
    panel = document.createElement("div");
    panel.className = "hc-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Чат з адвокатом");
    panel.innerHTML =
      '<div class="hc-top">' +
        '<img src="' + BASE + 'assets/logo-mark.png" alt="" width="40" height="40">' +
        '<div class="hc-who"><b>Олександр Осадько</b><span>Адвокат · відповідаю тут, у чаті</span></div>' +
        '<button type="button" class="hc-x" aria-label="Закрити чат"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>' +
      "</div>" +
      '<div class="hc-body" aria-live="polite"></div>' +
      '<div class="hc-ts"></div>' +
      '<form class="hc-form" novalidate>' +
        '<textarea rows="1" maxlength="2000" placeholder="Коротко опишіть вашу ситуацію…" aria-label="Повідомлення"></textarea>' +
        '<input type="text" name="company" class="hp-field" tabindex="-1" autocomplete="off" aria-hidden="true">' +
        '<button type="submit" class="hc-send" aria-label="Надіслати">' + ICON_SEND + "</button>" +
      "</form>" +
      '<p class="hc-note">Не надсилайте тут паспортних даних і документів. <a href="' + BASE + 'privacy/">Конфіденційність</a></p>';
    document.body.appendChild(panel);
    body = panel.querySelector(".hc-body");
    form = panel.querySelector(".hc-form");
    ta = form.querySelector("textarea");
    sendBtn = form.querySelector(".hc-send");
    tsBox = panel.querySelector(".hc-ts");

    panel.querySelector(".hc-x").addEventListener("click", close);
    form.addEventListener("submit", function (e) { e.preventDefault(); send(); });
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });
    ta.addEventListener("input", grow);

    sys("Добрий день! Опишіть коротко, що сталося, — я відповім тут. У робочий час (Пн–Пт, 9:00–18:00) зазвичай відповідаю швидко, в інший час — щойно побачу повідомлення.", "hc-greet");
  }

  function grow() {
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 140) + "px";
  }

  function fmtTime(t) {
    var d = new Date(t);
    return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  }

  function bubble(who, text, t, id) {
    if (id && rendered[id]) return null;
    var el = document.createElement("div");
    el.className = "hc-msg " + (who === "me" ? "hc-me" : "hc-adv");
    var p = document.createElement("p");
    p.textContent = text;
    el.appendChild(p);
    if (t) {
      var s = document.createElement("small");
      s.textContent = fmtTime(t);
      el.appendChild(s);
    }
    if (id) { rendered[id] = el; el.setAttribute("data-id", id); }
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
    return el;
  }

  function sys(text, cls) {
    var el = document.createElement("div");
    el.className = "hc-msg hc-adv" + (cls ? " " + cls : "");
    var p = document.createElement("p");
    p.textContent = text;
    el.appendChild(p);
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
    return el;
  }

  function failNote() {
    var el = document.createElement("div");
    el.className = "hc-fail";
    el.innerHTML = 'Не вдалося доставити повідомлення. Напишіть у <a href="https://t.me/adv_osadko" target="_blank" rel="noopener">Telegram</a> або зателефонуйте: <a href="tel:+380934664443">+38 (093) 466 44 43</a>.';
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
  }

  function askContact() {
    if (st.contact || panel.querySelector(".hc-ask")) return;
    var el = sys("Дякую, повідомлення отримав. Залиште, будь ласка, телефон або нік у Telegram — щоб я міг відповісти, навіть якщо ви закриєте сторінку.", "hc-ask");
    var f = document.createElement("form");
    f.className = "hc-cform";
    f.innerHTML = '<input type="text" inputmode="tel" autocomplete="tel" maxlength="100" placeholder="+380… або @нік" aria-label="Телефон або Telegram"><button type="submit">Зберегти</button>';
    el.appendChild(f);
    body.scrollTop = body.scrollHeight;
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var inp = f.querySelector("input");
      var v = inp.value.trim();
      if (v.replace(/\D/g, "").length < 7 && !/^@?[A-Za-z0-9_]{4,}$/.test(v)) { inp.focus(); inp.classList.add("bad"); return; }
      f.querySelector("button").disabled = true;
      post({ sid: st.sid, contact: v }).then(function () {
        st.contact = 1; save();
        f.remove();
        sys("Дякую! Контакт збережено — я звʼяжуся з вами.");
        if (window.osadkoTrack) window.osadkoTrack("chat_contact");
      }).catch(function () { f.querySelector("button").disabled = false; failNote(); });
    });
  }

  // ── Мережа ─────────────────────────────────────────────────────────
  function post(data) {
    data.page = location.href;
    return fetch(ENDPOINT + "/chat/send", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || "http"); e.code = j.error; throw e; }
        return j;
      });
    });
  }

  function loadTS() {
    if (st.sid || tsWidget !== null || !TS_SITEKEY) return;
    tsWidget = 0;
    var go = function () {
      try {
        tsWidget = window.turnstile.render(tsBox, {
          sitekey: TS_SITEKEY, appearance: "interaction-only", size: "flexible",
          callback: function (t) { tsToken = t; },
          "expired-callback": function () { tsToken = ""; }
        });
      } catch (e) {}
    };
    if (window.turnstile) return go();
    var s = document.querySelector('script[src*="turnstile/v0/api.js"]');
    if (!s) {
      s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
      s.async = true;
      document.head.appendChild(s);
    }
    s.addEventListener("load", go);
  }

  function waitToken() {
    if (st.sid || tsToken || !TS_SITEKEY) return Promise.resolve(tsToken);
    return new Promise(function (res) {
      var n = 0;
      var iv = setInterval(function () {
        if (tsToken || ++n > 30) { clearInterval(iv); res(tsToken); }
      }, 200);
    });
  }

  var sending = false;
  function send() {
    var text = ta.value.trim();
    if (!text || sending) return;
    if (form.elements.company.value) return;
    sending = true;
    sendBtn.disabled = true;
    var first = !st.sid;
    var el = bubble("me", text, Date.now());
    el.classList.add("hc-pending");
    ta.value = ""; grow();
    waitToken().then(function (token) {
      return post({ sid: st.sid, text: text, token: first ? token : "" });
    }).then(function (j) {
      el.classList.remove("hc-pending");
      if (j.id) { rendered[j.id] = el; el.setAttribute("data-id", j.id); }
      if (j.sid) { st.sid = j.sid; }
      ta.placeholder = "Напишіть повідомлення…";
      st.act = Date.now();
      save();
      if (first) {
        if (window.osadkoTrack) window.osadkoTrack("chat_start");
        if (window.osadkoContact) window.osadkoContact("chat");
      }
      if (j.delivered === false) failNote();
      else if (first) askContact();
      schedule(1500);
    }).catch(function (e) {
      el.classList.remove("hc-pending");
      el.classList.add("hc-err");
      if (!ta.value) { ta.value = text; grow(); }
      if (e && e.code === "rate") sys("Забагато повідомлень поспіль — зачекайте хвилину, будь ласка.");
      else failNote();
      if (first && window.turnstile && tsWidget) { try { window.turnstile.reset(tsWidget); } catch (x) {} tsToken = ""; }
    }).then(function () { sending = false; sendBtn.disabled = false; });
  }

  // ── Опитування ─────────────────────────────────────────────────────
  var timer = null, polling = false;
  function isOpen() { return panel && panel.classList.contains("open"); }

  function schedule(ms) {
    clearTimeout(timer);
    if (!st.sid || document.hidden) return;
    if (ms == null) {
      if (isOpen()) ms = 3000;
      else if (Date.now() - (st.act || 0) < 3 * 36e5) ms = 20000;
      else return;
    }
    timer = setTimeout(poll, ms);
  }

  function poll() {
    if (!st.sid || polling) return;
    polling = true;
    var after = panel ? (st.after || 0) : (st.seen || 0);
    fetch(ENDPOINT + "/chat/poll?sid=" + encodeURIComponent(st.sid) + "&after=" + after, { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : { msgs: [] }; })
      .then(function (j) {
        var msgs = j.msgs || [];
        var fresh = 0;
        msgs.forEach(function (m) {
          if (panel) {
            bubble(m.who, m.text, m.t, m.id);
            st.after = Math.max(st.after || 0, m.id);
          }
          if (m.who === "adv" && m.id > (st.seen || 0)) {
            if (isOpen()) st.seen = m.id;
            else { fresh = m; }
            st.act = Date.now();
          }
        });
        save();
        if (fresh) notify(fresh.text);
      })
      .catch(function () {})
      .then(function () { polling = false; schedule(); });
  }

  function notify(text) {
    if (!toast) {
      toast = document.createElement("button");
      toast.type = "button";
      toast.className = "hc-toast";
      toast.addEventListener("click", function () { open(); });
      document.body.appendChild(toast);
    }
    toast.innerHTML = "<i>" + ICON_CHAT + "</i><span><b>Відповідь адвоката</b><em></em></span>";
    toast.querySelector("em").textContent = text.length > 90 ? text.slice(0, 88) + "…" : text;
    toast.classList.add("show");
    if (fab) fab.classList.add("hc-away");
  }

  // ── Відкрити / закрити ─────────────────────────────────────────────
  function open() {
    build();
    document.querySelectorAll(".hm-cw.open").forEach(function (w) { w.classList.remove("open"); });
    if (toast) toast.classList.remove("show");
    panel.classList.add("open");
    if (fab) fab.classList.add("hc-away");
    document.documentElement.classList.add("hc-lock");
    loadTS();
    if (st.sid) { ta.placeholder = "Напишіть повідомлення…"; poll(); }
    setTimeout(function () { ta.focus(); }, 60);
    if (window.osadkoTrack) window.osadkoTrack("chat_open");
  }

  function close() {
    if (!panel) return;
    panel.classList.remove("open");
    if (fab) fab.classList.remove("hc-away");
    document.documentElement.classList.remove("hc-lock");
    var last = 0;
    for (var k in rendered) if (+k > last && rendered[k].classList.contains("hc-adv")) last = +k;
    if (last > (st.seen || 0)) { st.seen = last; save(); }
    schedule();
  }

  // Повідомлення, що вже є в розмові, при новому завантаженні сторінки
  // показуємо з початку (after=0) — st.after скидається.
  st.after = 0;

  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest(".js-chat");
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    open();
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && isOpen()) close(); });
  document.addEventListener("visibilitychange", function () { if (!document.hidden) poll(); else clearTimeout(timer); });

  addEntries();
  addLauncher();
  if (st.sid) schedule(4000);
})();
