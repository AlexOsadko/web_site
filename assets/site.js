/* Спільне для всіх сторінок у стилі «E»:
   — шапка на головній: прозора над першим екраном, біла після нього;
   — кнопка телефону / номер → вибір: подзвонити, Telegram, Viber, WhatsApp. */
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
