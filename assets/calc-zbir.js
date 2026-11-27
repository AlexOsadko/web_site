/* Калькулятор судового збору (Закон України «Про судовий збір», ст. 4).
   Прожитковий мінімум для працездатних осіб на 1 січня року подання — у data-pm
   на формі (його підставляє білдер), щоб щороку міняти лише одне число. */
(function () {
  var form = document.getElementById('zbirForm');
  if (!form) return;
  var PM = parseFloat(form.getAttribute('data-pm')) || 0;
  var $ = function (id) { return document.getElementById(id); };
  var money = function (n) {
    return (Math.round(n * 100) / 100).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' грн';
  };
  var pm = function (k) { return k + ' прожиткового мінімуму (' + money(k * PM) + ')'; };

  /* Які види заяв доступні в якому суді. */
  var KINDS = {
    civil: [['mayn', 'Позов майнового характеру (стягнення грошей, майна)'],
            ['nemayn', 'Позов немайнового характеру'],
            ['shlub', 'Розірвання шлюбу'],
            ['podil', 'Поділ майна подружжя'],
            ['alim', 'Стягнення аліментів'],
            ['nakaz', 'Заява про видачу судового наказу'],
            ['okreme', 'Заява окремого провадження (встановлення факту тощо)'],
            ['zaochne', 'Заява про перегляд заочного рішення']],
    gosp: [['mayn', 'Позов майнового характеру (стягнення боргу)'],
           ['nemayn', 'Позов немайнового характеру'],
           ['nakaz', 'Заява про видачу судового наказу']],
    adm: [['nemayn', 'Позов немайнового характеру (оскарження рішення, дій, бездіяльності)'],
          ['mayn', 'Позов майнового характеру']]
  };
  var NEEDS_PRICE = { mayn: 1, podil: 1 };

  function fillKinds() {
    var sel = $('zbKind'), cur = sel.value, list = KINDS[$('zbCourt').value];
    sel.innerHTML = list.map(function (k) { return '<option value="' + k[0] + '">' + k[1] + '</option>'; }).join('');
    if (list.some(function (k) { return k[0] === cur; })) sel.value = cur;
  }

  /* Ставка в суді першої інстанції: {sum, how, norm, free} */
  function base(court, who, kind, price) {
    var legal = who === 'yur';                       // юридична особа
    var fop = who === 'fop';
    if (kind === 'alim') {
      return { sum: 0, free: true, how: 'Позивачі у справах про стягнення аліментів звільнені від сплати судового збору.',
               norm: 'п. 3 ч. 1 ст. 5 Закону «Про судовий збір»' };
    }
    if (kind === 'shlub') return { sum: 0.4 * PM, how: pm(0.4), norm: 'пп. 3 п. 1 ч. 2 ст. 4' };
    if (kind === 'nakaz') return { sum: 0.1 * PM, how: pm(0.1), norm: court === 'gosp' ? 'пп. 4-1 п. 2 ч. 2 ст. 4' : 'пп. 4-1 п. 1 ч. 2 ст. 4' };
    if (kind === 'okreme' || kind === 'zaochne') {
      var k = legal || fop ? 0.5 : 0.2;
      return { sum: k * PM, how: pm(k), norm: 'п. 1 ч. 2 ст. 4' };
    }
    if (kind === 'podil') {
      return pct(price, 1, 0.4, 3, 'пп. 3 п. 1 ч. 2 ст. 4');
    }
    if (kind === 'nemayn') {
      if (court === 'gosp') return { sum: PM, how: pm(1), norm: 'пп. 2 п. 2 ч. 2 ст. 4' };
      var kk = legal || fop ? 1 : 0.4;
      return { sum: kk * PM, how: pm(kk), norm: court === 'adm' ? 'пп. 1 п. 3 ч. 2 ст. 4' : 'пп. 2 п. 1 ч. 2 ст. 4' };
    }
    /* майновий позов */
    if (court === 'gosp') return pct(price, 1.5, 1, 350, 'пп. 1 п. 2 ч. 2 ст. 4');
    if (court === 'adm') {
      return legal || fop ? pct(price, 1.5, 1, 10, 'пп. 1 п. 3 ч. 2 ст. 4') : pct(price, 1, 0.4, 5, 'пп. 1 п. 3 ч. 2 ст. 4');
    }
    return legal ? pct(price, 1.5, 1, 350, 'пп. 1 п. 1 ч. 2 ст. 4') : pct(price, 1, 0.4, 5, 'пп. 1 п. 1 ч. 2 ст. 4');
  }
  function pct(price, p, minK, maxK, norm) {
    var raw = price * p / 100, mn = minK * PM, mx = maxK * PM, sum = raw, note = '';
    if (raw < mn) { sum = mn; note = ' Це менше за мінімум, тому береться мінімум: ' + pm(minK) + '.'; }
    else if (raw > mx) { sum = mx; note = ' Це більше за максимум, тому береться максимум: ' + pm(maxK) + '.'; }
    return { sum: sum, norm: norm,
      how: p.toString().replace('.', ',') + '% від ціни позову ' + money(price) + ' = ' + money(raw) + '.' + note };
  }

  function calc() {
    var court = $('zbCourt').value, who = $('zbWho').value, kind = $('zbKind').value, stage = $('zbStage').value;
    var price = parseFloat(String($('zbPrice').value).replace(/\s/g, '').replace(',', '.')) || 0;
    var needPrice = !!NEEDS_PRICE[kind];
    $('zbPriceRow').hidden = !needPrice;
    var out = $('zbOut');
    if (needPrice && price <= 0) {
      out.innerHTML = '<p class="zb-hint">Вкажіть ціну позову — суму, яку просите стягнути, або вартість майна.</p>';
      return;
    }
    var b = base(court, who, kind, price), sum = b.sum, steps = [b.how], norm = b.norm;
    if (b.free) {
      out.innerHTML = '<p class="zb-sum">0,00 грн</p><p class="zb-how">' + b.how + '</p><p class="zb-norm">Підстава: ' + b.norm + '.</p>';
      return;
    }
    if (stage === 'ukhvala') {
      var ku = (who === 'fiz' && court !== 'gosp') ? 0.2 : 1;
      sum = ku * PM; steps = ['Скарга на ухвалу суду: ' + pm(ku) + '.']; norm = 'ч. 2 ст. 4';
    } else if (stage === 'apel' || stage === 'kas') {
      var mult = stage === 'apel' ? 150 : 200;
      steps.push((stage === 'apel' ? 'Апеляційна' : 'Касаційна') + ' скарга на рішення: ' + mult + '% ставки за подання позову = ' + money(sum * mult / 100) + '.');
      sum = sum * mult / 100;
    }
    if ($('zbEsud').checked) {
      steps.push('Подання через «Електронний суд»: коефіцієнт 0,8 (ч. 3 ст. 4).');
      sum = sum * 0.8;
    }
    out.innerHTML = '<p class="zb-sum">' + money(sum) + '</p>'
      + '<ol class="zb-how">' + steps.map(function (s) { return '<li>' + s + '</li>'; }).join('') + '</ol>'
      + '<p class="zb-norm">Підстава: ' + norm + ' Закону «Про судовий збір». Прожитковий мінімум на 1 січня: ' + money(PM) + '.</p>'
      + (stage === 'apel' || stage === 'kas' ? '<p class="zb-norm">Якщо оскаржуєте рішення лише частково, збір рахується від оспорюваної суми.</p>' : '');
  }

  $('zbCourt').addEventListener('change', function () { fillKinds(); calc(); });
  ['zbWho', 'zbKind', 'zbStage', 'zbEsud'].forEach(function (id) { $(id).addEventListener('change', calc); });
  $('zbPrice').addEventListener('input', calc);
  form.addEventListener('submit', function (e) { e.preventDefault(); calc(); });
  fillKinds(); calc();
})();
