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
  if (!btn) return;
  btn.addEventListener('click', function () {
    var r = document.documentElement;
    var next = r.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    r.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch (e) {}
  });
})();
