// Google Analytics 4 (gtag.js). ID в одному місці; підключається у <head> усіх сторінок.
(function () {
  var GA_ID = "G-YS9JTNL11Q";
  var s = document.createElement("script");
  s.async = true;
  s.src = "https://www.googletagmanager.com/gtag/js?id=" + GA_ID;
  document.head.appendChild(s);
  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag("js", new Date());
  gtag("config", GA_ID);
})();
