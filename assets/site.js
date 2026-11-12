/* Спільне для всіх сторінок у стилі «E»:
   — шапка на головній: прозора над першим екраном, біла після нього;
   — кнопка телефону / номер → вибір: подзвонити, Telegram, Viber, WhatsApp. */
/* Джерело візиту для заявок: на вході на сайт запамʼятовуємо, звідки прийшли
   (Google Ads, пошук, соцмережі, інший сайт, напряму) — лише в sessionStorage,
   до кінця візиту. Форми додають це до заявки як поле attr (window.osadkoAttr). */
(function () {
  var KEY = "osadkoAttr";
  function read() { try { return JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch (e) { return null; } }
  function host(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return ""; } }
  var stored = read();
  var q; try { q = new URLSearchParams(location.search); } catch (e) { q = { get: function () { return null; } }; }
  var gclid = q.get("gclid") || q.get("gbraid") || q.get("wbraid") || "";
  var utm = q.get("utm_source") || "";
  var ref = document.referrer ? host(document.referrer) : "";
  var external = ref && ref !== location.hostname.replace(/^www\./, "");
  if (gclid || utm || external || !stored) {
    var ch;
    if (gclid) ch = "Google Ads";
    else if (utm) ch = utm + (q.get("utm_medium") ? " / " + q.get("utm_medium") : "");
    else if (!external) ch = "Напряму";
    else if (/(^|\.)(google|bing|duckduckgo|yahoo|ecosia|yandex)\./.test(ref)) ch = "Пошук";
    else if (/(^|\.)(facebook|fb|instagram|t|telegram|tiktok|youtube|linkedin|threads|viber)\./.test(ref)) ch = "Соцмережі";
    else ch = "Інший сайт";
    // «Напряму» не перезаписує вже відоме джерело цього візиту
    if (ch !== "Напряму" || !stored) {
      stored = { ch: ch, camp: q.get("utm_campaign") || "", ref: external ? ref : "",
                 land: location.pathname, gclid: gclid };
      try { sessionStorage.setItem(KEY, JSON.stringify(stored)); } catch (e) {}
    }
  }
  window.osadkoAttr = function () { return read() || stored; };
})();

(function () {
  // Чат на сайті (assets/chat.js) — поруч із цим файлом, з тією ж версією
  var me = document.currentScript && document.currentScript.src;
  if (me) {
    var cs = document.createElement('script');
    cs.src = me.replace(/site\.js(\?.*)?$/, 'chat.js$1');
    cs.defer = true;
    document.head.appendChild(cs);
  }

  var yr = document.getElementById('year');
  if (yr && !yr.textContent) yr.textContent = new Date().getFullYear();

  var head = document.querySelector('.hm-head');
  if (!head) return;

  // Шапка (лише на головній, де є перший екран із фото)
  var hero = document.querySelector('.hm-hero');
  if (hero) {
    var upd = function () {
      var y = window.scrollY;
      head.classList.toggle('scrolled', y > 10);
      head.classList.toggle('solid', y > hero.offsetHeight - 90);
    };
    window.addEventListener('scroll', upd, { passive: true });
    window.addEventListener('resize', upd);
    upd();
  }

  // Вибір способу звʼязку
  var heroWrap = document.querySelector('.hm-cw-hero');
  var headWrap = document.querySelector('.hm-cw-head');
  function closeAll() {
    document.querySelectorAll('.hm-cw.open').forEach(function (w) { w.classList.remove('open'); });
    document.querySelectorAll('.hm-num, .js-pick').forEach(function (b) { b.setAttribute('aria-expanded', 'false'); });
  }
  function toggle(wrap, btn) {
    if (!wrap) return;
    var willOpen = !wrap.classList.contains('open');
    closeAll();
    if (willOpen) { wrap.classList.add('open'); btn.setAttribute('aria-expanded', 'true'); }
  }
  var heroBtn = heroWrap && heroWrap.querySelector('.hm-num');
  if (heroBtn) heroBtn.addEventListener('click', function (e) { e.stopPropagation(); toggle(heroWrap, heroBtn); });
  document.querySelectorAll('.js-pick').forEach(function (b) {
    b.addEventListener('click', function (e) { e.stopPropagation(); toggle(headWrap, b); });
  });
  document.addEventListener('click', function (e) { if (!e.target.closest('.hm-menu')) closeAll(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeAll(); });
  // На головній: якщо шапка знову стала прозорою — закрити її меню
  if (hero) window.addEventListener('scroll', function () {
    if (headWrap && headWrap.classList.contains('open') && !head.classList.contains('solid')) closeAll();
  }, { passive: true });
})();

// Нижня панель на телефоні: «Подзвонити» і «Написати» (відкриває чат на сайті).
// З'являється, коли кнопки першого екрана (головна, сторінки послуг) прокручено;
// на решті сторінок — одразу.
(function () {
  if (document.querySelector(".mbar") || /\/(dogovir|p|vidguk\/kartka)\//.test(location.pathname)) return;
  var ICON_TEL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>';
  var ICON_CHAT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2z"/></svg>';
  function init() {
    var bar = document.createElement("div");
    bar.className = "mbar";
    bar.innerHTML = '<a class="mb-call" href="tel:+380934664443">' + ICON_TEL + 'Подзвонити</a>'
      + '<button type="button" class="mb-chat js-chat">' + ICON_CHAT + 'Написати</button>';
    document.body.appendChild(bar);
    document.body.classList.add("has-mbar");
    // Панель не дублює кнопки першого екрана: з'являється, коли вони сховалися
    var hero = document.querySelector(".hm-hero") || document.querySelector(".lp-cta2");
    if (!hero) { bar.classList.add("show"); return; }
    var upd = function () { bar.classList.toggle("show", hero.getBoundingClientRect().bottom < 120); };
    upd();
    window.addEventListener("scroll", upd, { passive: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();

// ── Перевірка форм заявки: зрозумілі підказки під полями замість стандартних
// повідомлень браузера; телефон — 10 цифр (0XX…) або міжнародний формат.
// Спрацьовує раніше за обробники форм (фаза перехоплення), тож неправильна
// заявка не надсилається. Також — повідомлення про збій відправки.
(function () {
  function phoneError(v) {
    var d = String(v || "").replace(/\D/g, "");
    if (!d) return "Вкажіть номер телефону, щоб я міг передзвонити.";
    if (/^0\d{9}$/.test(d) || /^380\d{9}$/.test(d) || /^80\d{9}$/.test(d)) return "";
    if (/^\+/.test(String(v).trim()) && d.length >= 11 && d.length <= 15 && !/^380/.test(d)) return ""; // іноземний номер
    return "Перевірте номер: потрібно 10 цифр, наприклад 093 466 44 43.";
  }
  function fieldMsg(input, text) {
    var wrap = input.closest("label") || input.parentNode;
    var id = (input.form && input.form.id ? input.form.id + "-" : "f-") + input.name + "-err";
    var el = wrap.querySelector(".f-err");
    if (!text) {
      if (el) el.remove();
      input.removeAttribute("aria-invalid");
      input.classList.remove("f-bad");
      return;
    }
    if (!el) { el = document.createElement("span"); el.className = "f-err"; el.id = id; el.setAttribute("role", "alert"); wrap.appendChild(el); }
    el.textContent = text;
    input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-describedby", el.id);
    input.classList.add("f-bad");
  }
  function check(form) {
    var bad = null;
    var nm = form.elements["name"], ph = form.elements["phone"];
    if (nm && nm.required) {
      var e1 = nm.value.trim() ? "" : "Вкажіть, як до вас звертатися.";
      fieldMsg(nm, e1); if (e1 && !bad) bad = nm;
    }
    if (ph && (ph.required || ph.value.trim())) {
      var e2 = phoneError(ph.value);
      fieldMsg(ph, e2); if (e2 && !bad) bad = ph;
    }
    return bad;
  }
  function isLeadForm(f) { return f && f.tagName === "FORM" && f.elements && f.elements["phone"]; }
  function init() {
    document.querySelectorAll("form").forEach(function (f) { if (isLeadForm(f)) f.noValidate = true; });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
  document.addEventListener("submit", function (e) {
    var f = e.target;
    if (!isLeadForm(f)) return;
    var fail = f.querySelector(".form-fail"); if (fail) fail.remove();
    var bad = check(f);
    if (bad) { e.preventDefault(); e.stopImmediatePropagation(); bad.focus(); }
  }, true);
  document.addEventListener("input", function (e) {
    var t = e.target;
    if (t && t.classList && t.classList.contains("f-bad")) fieldMsg(t, "");
  }, true);

  // Збій відправки: людина бачить, що заявка НЕ пішла, і як звʼязатися інакше
  window.osadkoFormFail = function (form, mailHref) {
    var old = form.querySelector(".form-fail"); if (old) old.remove();
    var el = document.createElement("div");
    el.className = "form-fail"; el.setAttribute("role", "alert");
    el.innerHTML = '<b>Не вдалося надіслати заявку.</b> Подзвоніть: <a href="tel:+380934664443">093&nbsp;466&nbsp;44&nbsp;43</a> ' +
      'або напишіть у <a href="https://t.me/adv_osadko" target="_blank" rel="noopener">Telegram</a>' +
      (mailHref ? ' · <a class="ff-mail" href="">надіслати поштою</a>' : '') + '.';
    if (mailHref) el.querySelector(".ff-mail").href = mailHref;
    var btn = form.querySelector("button[type=submit]");
    if (btn) { btn.disabled = false; btn.insertAdjacentElement("afterend", el); } else form.appendChild(el);
  };
})();
