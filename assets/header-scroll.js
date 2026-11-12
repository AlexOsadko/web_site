// Шкала прогресу гортання + приховування шапки при скролі вниз / показ при скролі вгору.
(function () {
  var h = document.querySelector('.site-header');

  // Шкала прогресу: тонка смуга вгорі, що заповнюється в міру гортання.
  var bar = document.createElement('div');
  bar.className = 'scroll-progress';
  bar.setAttribute('aria-hidden', 'true');
  if (document.body) document.body.appendChild(bar);

  var last = window.scrollY;

  function update() {
    var y = window.scrollY;
    var docH = document.documentElement.scrollHeight - window.innerHeight;
    var ratio = docH > 0 ? Math.min(1, Math.max(0, y / docH)) : 0;
    bar.style.transform = 'scaleX(' + ratio + ')';

    if (h) {
      // не ховати біля верху та коли відкрите мобільне меню
      if (y > last && y > 90 && !h.querySelector('.site-nav.open')) h.classList.add('hidden');
      else if (y < last) h.classList.remove('hidden');
    }
    last = y;
  }

  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update, { passive: true });
  update();
})();

/* Перемикач теми (день/ніч). Ініціалізація теми — інлайн у <head>. */
(function () {
  var btn = document.getElementById('themeToggle');
  var r = document.documentElement;
  function toggle() {
    var next = r.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    r.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch (e) {}
    label();
  }
  if (btn) btn.addEventListener('click', toggle);
  // Телефон: у шапці кнопки теми немає — перемикач у мобільному меню
  var nav = document.getElementById('nav'), mb = null;
  function label() {
    if (!mb) return;
    var dark = r.getAttribute('data-theme') === 'dark';
    mb.innerHTML = (dark
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/></svg>Денна тема'
      : '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>Нічна тема');
    mb.setAttribute('aria-pressed', dark ? 'true' : 'false');
  }
  if (nav && btn) {
    mb = document.createElement('button');
    mb.type = 'button';
    mb.className = 'nav-theme';
    mb.addEventListener('click', toggle);
    nav.appendChild(mb);
    label();
  }
})();

/* Мобільне меню: гамбургер відкриває/закриває навігацію (спільно для всіх сторінок). */
(function () {
  var btn = document.getElementById('navToggle');
  var nav = document.getElementById('nav');
  if (!btn || !nav) return;
  btn.addEventListener('click', function () {
    var open = nav.classList.toggle('open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  nav.querySelectorAll('a').forEach(function (a) {
    a.addEventListener('click', function () {
      nav.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    });
  });
})();
