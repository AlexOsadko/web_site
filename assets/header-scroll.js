// Ховає шапку при прокручуванні вниз і показує при прокручуванні вгору.
(function () {
  var h = document.querySelector('.site-header');
  if (!h) return;
  var last = window.scrollY;
  window.addEventListener('scroll', function () {
    var y = window.scrollY;
    // не ховати біля самого верху та коли відкрите мобільне меню
    if (y > last && y > 90 && !h.querySelector('.site-nav.open')) {
      h.classList.add('hidden');
    } else if (y < last) {
      h.classList.remove('hidden');
    }
    last = y;
  }, { passive: true });
})();
