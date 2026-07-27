#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Канонічний білдер сайту адвоката Олександра Осадька.

Єдине джерело правди — файли даних content/articles/<slug>.json.
Скрипт генерує зі спільного шаблону:
  • articles/<slug>.html   — SEO-сторінка кожної статті (JSON-LD, FAQ, breadcrumbs, keywords, «читайте також»);
  • articles/index.html    — каталог статей із фільтром за категоріями;
  • index.html             — оновлює лічильник статей на головній (кількість змінюється автоматично);
  • sitemap.xml, robots.txt — для індексації в пошукових системах.

Кількість статей на сайті обчислюється автоматично з кількості файлів даних
і підставляється всюди, де вона згадується. Тобто після додавання нової статті
(вручну або через AI-генератор tools/generate_article.py) достатньо перезапустити
цей скрипт — і сайт оновиться сам.

Використання:
    python3 tools/build.py
"""
import os, re, json, glob, html

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONTENT = os.path.join(ROOT, "content", "articles")
CONTENT_LANDINGS = os.path.join(ROOT, "content", "landings")
ART = os.path.join(ROOT, "articles")
POSLUGY = os.path.join(ROOT, "poslugy")
BASE_URL = "https://osadko.online/"
ART_BASE_URL = BASE_URL + "articles/"
POSLUGY_BASE_URL = BASE_URL + "poslugy/"
DATE_LABEL = "Липень 2026"

# ---------- КАТЕГОРІЇ ----------
CATS = {
    "civil":    "Цивільні справи та борги",
    "family":   "Сімейні справи",
    "labor":    "Трудові спори",
    "criminal": "Кримінальні справи",
    "military": "Військове право та мобілізація",
    "auto":     "ДТП та автоправо",
    "realty":   "Нерухомість і спадщина",
    "business": "Бізнес і господарські спори",
    "admin":    "Адміністративні спори з держорганами",
    "social":   "Пенсійні та соціальні виплати",
    "process":  "Судовий процес",
}
SHORT_CAT = {
    "civil": "Борги та договори", "family": "Сімейне право", "labor": "Трудові спори",
    "criminal": "Кримінальні справи", "military": "Військове право", "auto": "ДТП та авто",
    "realty": "Нерухомість", "business": "Бізнес", "admin": "Адмінспори",
    "social": "Пенсії та соцвиплати", "process": "Судовий процес",
}
ORDER = ["civil", "family", "labor", "criminal", "military", "auto",
         "realty", "business", "admin", "social", "process"]

KW_BASE = {
    "civil": "стягнення боргу, цивільний адвокат, позов, договір, відшкодування шкоди",
    "family": "сімейний адвокат, розлучення, аліменти, поділ майна, батьківські права",
    "labor": "трудовий спір, незаконне звільнення, невиплата зарплати, трудовий адвокат",
    "criminal": "кримінальний адвокат, захисник, допит, обшук, запобіжний захід",
    "auto": "автоюрист, ДТП, позбавлення прав, страхове відшкодування, оскарження штрафу",
    "realty": "нерухомість, спадщина, заповіт, купівля квартири, земельні спори",
    "business": "адвокат для бізнесу, господарський спір, договір, ФОП, стягнення боргу",
    "military": "військовий адвокат, мобілізація, ВЛК, відстрочка, СЗЧ, звільнення з військової служби",
    "admin": "адміністративний спір, оскарження рішення, КАСУ, адвокат, держоргани, субсидія",
    "social": "пенсійний адвокат, перерахунок пенсії, соціальні виплати, ВПО, інвалідність, субсидія",
    "process": "судовий процес, позовна заява, апеляція, виконавче провадження, адвокат у суді",
}
CAT_NOTE = {
    "civil": "тут важливо правильно зібрати докази, дотримати строків і грамотно сформулювати вимоги.",
    "family": "тут на кону не лише майно, а й стосунки з близькими та інтереси дітей.",
    "labor": "тут діють скорочені строки й особливі гарантії, а роботодавець зазвичай має юриста.",
    "criminal": "тут кожне слово має значення, а помилка на початку може коштувати свободи.",
    "auto": "тут результат часто залежить від процедури оформлення та фіксації обставин.",
    "realty": "тут ціна помилки висока, а угоду чи спадщину можуть оскаржити роками пізніше.",
    "business": "тут важливо передбачити ризики заздалегідь і діяти на випередження.",
    "military": "тут ідеться про службу, свободу й життя, а строки на оскарження стислі — діяти треба швидко й точно.",
    "admin": "тут проти вас держорган зі штатними юристами, а процесуальні строки в адмінсправах особливо стислі.",
    "social": "тут кожна виплата рахується, а відмови органів часто ґрунтуються на формальностях, які можна оскаржити.",
    "process": "тут виграє той, хто знає процедуру і не пропускає процесуальних строків.",
}
NOTE_LINK = '<a href="../#contacts">зв\'яжіться зі мною</a>'

# Описи категорій для тематичних сторінок-хабів.
CAT_DESC = {
    "civil": "Борги, розписки, договори, відшкодування шкоди та захист прав споживачів. Пояснюю, як стягнути борг, скласти претензію й відстояти свої інтереси в цивільних спорах.",
    "family": "Розлучення, поділ майна, аліменти, батьківські права та шлюбний договір. Розбираю сімейні питання зрозуміло — з фокусом на інтересах дітей і збереженні нервів.",
    "labor": "Незаконне звільнення, невиплата зарплати, скорочення та трудові гарантії. Нагадую про скорочені строки й пояснюю, як захистити свої права перед роботодавцем.",
    "criminal": "Допит, затримання, обшук, запобіжні заходи та права потерпілого. Тут кожне слово має значення — пояснюю, як діяти, щоб не нашкодити собі.",
    "auto": "ДТП, європротокол, позбавлення прав, штрафи та страхове відшкодування. Показую, як правильно зафіксувати обставини й отримати повну виплату.",
    "realty": "Спадщина, заповіт, купівля квартири, дарування та земельні спори. Допомагаю уникнути помилок, через які угоду чи спадщину оскаржують роками пізніше.",
    "business": "Договори, стягнення боргів, реєстрація та ліквідація ФОП, захист репутації. Раджу, як передбачити ризики заздалегідь і діяти на випередження.",
    "process": "Позовна заява, судовий збір, апеляція, виконавче провадження та мирова угода. Пояснюю процедуру крок за кроком — щоб ви не пропустили процесуальних строків.",
    "military": "Мобілізація, ВЛК, відстрочки, СЗЧ, звільнення зі служби, контракт і виплати військовим. Пояснюю, як діяти законно й захистити свої права під час служби та мобілізації.",
    "admin": "Оскарження рішень, дій і бездіяльності органів влади, штрафів, відмов у наданні послуг, ліцензій і дозволів. Показую, як судитися з державою за правилами КАСУ.",
    "social": "Перерахунок і призначення пенсії, соціальні виплати, статус і виплати ВПО, інвалідність та субсидії. Допомагаю оскаржити відмови органів і домогтися належних вам виплат.",
}

# Авто-перелінковка: ключова фраза → slug статті. Білдер робить першу згадку
# фрази у тексті посиланням на відповідну статтю (не більше MAX_AUTOLINKS на статтю,
# без самопосилань). Нові статті вплітаються автоматично — достатньо додати фразу.
MAX_AUTOLINKS = 12
LINK_TERMS = {
    "неустойки": "stiahnennia-neustojky-za-dogovorom", "неустойку": "stiahnennia-neustojky-za-dogovorom", "неустойка": "stiahnennia-neustojky-za-dogovorom",
    "прогул": "zvilnennia-za-prohul", "прогулу": "zvilnennia-za-prohul",
    "опікунство": "oformlennia-opikunstva-nad-dytynoyu", "опікунства": "oformlennia-opikunstva-nad-dytynoyu", "опікуном": "oformlennia-opikunstva-nad-dytynoyu",
    "корпоративного договору": "zminy-do-korporatyvnoho-dogovoru", "корпоративний договір": "zminy-do-korporatyvnoho-dogovoru",
    "фіктивний правочин": "spir-pro-vyznannya-pravochynu-fiktyvnym", "фіктивного правочину": "spir-pro-vyznannya-pravochynu-fiktyvnym",
    "зміни імені": "zmina-imeni-ta-prizvyshcha", "зміну імені": "zmina-imeni-ta-prizvyshcha", "зміна прізвища": "zmina-imeni-ta-prizvyshcha",
    "режим майна подружжя": "pravovyj-rezhym-mayna-podruzhzhya",
    "спадкування за заповітом": "spadkuvannya-za-zapovitom-osoblyvosti",
    "аліменти": "alimenty-na-dytynu", "аліментів": "alimenty-na-dytynu", "аліменти на дитину": "alimenty-na-dytynu",
    "розлучення": "rozirvannya-shlyubu", "розлученні": "rozirvannya-shlyubu", "розлучення в україні": "rozirvannya-shlyubu",
    "спадщині": "spadschyna-pryynyaty", "спадщиною": "spadschyna-pryynyaty",
    "заповіті": "zapovit",
    "претензію": "pretenziya", "претензії": "pretenziya",
    "позов": "yak-podaty-pozov", "позову": "yak-podaty-pozov", "позовом": "yak-podaty-pozov",
    "штраф": "oskarzhennia-shtrafu", "штрафу": "oskarzhennia-shtrafu",
    "виконавчої служби": "vykonavche-provadzhennya",
    "позовної давності": "pozovna-davnist", "позовна давність": "pozovna-davnist",
    "судовий наказ": "sudovyi-nakaz", "судового наказу": "sudovyi-nakaz",
    "досудову претензію": "pretenziya", "досудової претензії": "pretenziya", "досудова претензія": "pretenziya",
    "моральної шкоди": "moralna-shkoda", "моральну шкоду": "moralna-shkoda",
    "поділ майна": "podil-maina-podruzhzhya", "поділу майна": "podil-maina-podruzhzhya",
    "розірвання шлюбу": "rozirvannya-shlyubu", "розірванні шлюбу": "rozirvannya-shlyubu",
    "аліменти на дитину": "alimenty-na-dytynu", "аліментів на дитину": "alimenty-na-dytynu",
    "шлюбний договір": "shlyubnyi-dohovir", "шлюбного договору": "shlyubnyi-dohovir",
    "позбавлення батьківських прав": "pozbavlennya-batkivskyh-prav",
    "встановлення батьківства": "vstanovlennya-batkivstva",
    "незаконне звільнення": "nezakonne-zvilnennya", "незаконного звільнення": "nezakonne-zvilnennya",
    "невиплати зарплати": "nevyplata-zarplaty", "невиплата зарплати": "nevyplata-zarplaty",
    "скорочення штату": "skorochennya-shtatu",
    "європротокол": "evroprotokol",
    "запобіжний захід": "zapobizhnyi-zahid", "запобіжного заходу": "zapobizhnyi-zahid",
    "домашнього насильства": "domashnie-nasylstvo", "домашнє насильство": "domashnie-nasylstvo",
    "прийняти спадщину": "spadschyna-pryynyaty", "прийняття спадщини": "spadschyna-pryynyaty",
    "заповіту": "zapovit", "заповіт": "zapovit",
    "дарування": "daruvannya-neruhomosti",
    "купівлі квартири": "kupivlya-kvartyry", "купівля квартири": "kupivlya-kvartyry",
    "земельні спори": "zemelni-spory", "земельних спорів": "zemelni-spory",
    "довічного утримання": "dovichne-utrymannya",
    "реєстрація фоп": "reyestratsiya-fop", "реєстрації фоп": "reyestratsiya-fop",
    "банкрутства фізичної особи": "bankrutstvo-fizychnoi-osoby", "банкрутство фізичної особи": "bankrutstvo-fizychnoi-osoby",
    "виконавче провадження": "vykonavche-provadzhennya", "виконавчого провадження": "vykonavche-provadzhennya",
    "апеляційну скаргу": "apelyatsiya", "апеляційної скарги": "apelyatsiya",
    "судові витрати": "sudovi-vytraty", "судових витрат": "sudovi-vytraty",
    "судовий збір": "sudovi-vytraty", "судового збору": "sudovi-vytraty",
    "забезпечення позову": "zabezpechennya-pozovu",
    "мирову угоду": "myrova-uhoda", "мирова угода": "myrova-uhoda",
    "медіації": "dosudove-vrehulyuvannya", "медіація": "dosudove-vrehulyuvannya",
    "позовну заяву": "yak-podaty-pozov", "позовної заяви": "yak-podaty-pozov",
    "розписку": "rozpyska-pro-pozyku", "розписки": "rozpyska-pro-pozyku", "розписка": "rozpyska-pro-pozyku",
    "обшуку": "obshuk", "обшук": "obshuk",
    "затримання": "zatrymannya",
    "затоплення квартири": "zatoplennia-kvartyry", "затопили квартиру": "zatoplennia-kvartyry",
    "виїзд дитини за кордон": "vyizd-dytyny-za-kordon", "виїзду дитини за кордон": "vyizd-dytyny-za-kordon",
    "виробнича травма": "vyrobnycha-travma", "виробничої травми": "vyrobnycha-travma",
    "судимості": "znyattia-sudymosti", "судимість": "znyattia-sudymosti",
    "тотальне пошкодження": "total-avto",
    "іпотечного кредиту": "ipoteka-prava-pozychalnyka", "іпотеки": "ipoteka-prava-pozychalnyka",
    "податкова перевірка": "podatkova-perevirka", "податкової перевірки": "podatkova-perevirka",
    "податкове повідомлення-рішення": "podatkova-perevirka",
    "касаційної скарги": "kasatsiine-oskarzhennia", "касаційну скаргу": "kasatsiine-oskarzhennia", "касації": "kasatsiine-oskarzhennia",
    # --- додаткові фрази для щільнішої перелінковки ---
    "не повертають борг": "yak-povernuty-borh", "повернення боргу": "yak-povernuty-borh",
    "стягнення боргу з контрагента": "stiahnennia-borhu-kontragent",
    "договір оренди": "dohovir-orendy-kvartyry", "оренди квартири": "dohovir-orendy-kvartyry",
    "розірвання договору": "rozirvannya-dohovoru", "розірвати договір": "rozirvannya-dohovoru",
    "захист прав споживачів": "zahyst-spozhyvachiv", "права споживача": "zahyst-spozhyvachiv", "неякісний товар": "zahyst-spozhyvachiv",
    "неякісна послуга": "neyakisna-posluha", "неякісну послугу": "neyakisna-posluha",
    "матеріальної шкоди": "vidshkoduvannya-shkody", "відшкодування збитків": "vidshkoduvannya-shkody",
    "аліменти на дружину": "alimenty-na-druzhynu", "утримання подружжя": "alimenty-na-druzhynu",
    "поділ бізнесу": "podil-maina-podruzhzhya",
    "стягнення заборгованості з аліментів": "stiahnennia-zaborhovanosti-alimenty", "борг з аліментів": "stiahnennia-zaborhovanosti-alimenty",
    "місце проживання дитини": "mistse-prozhyvannya-dytyny", "місця проживання дитини": "mistse-prozhyvannya-dytyny",
    "трудовий договір": "trudovyi-vs-tsph", "договір цпх": "trudovyi-vs-tsph",
    "звільнення за власним бажанням": "zvilnennya-vlasne-bazhannya",
    "мобінг": "mobinh-na-roboti", "мобінгу": "mobinh-na-roboti",
    "виробничої травми на роботі": "vyrobnycha-travma",
    "на допит": "pershyi-dopyt", "виклик на допит": "pershyi-dopyt",
    "права потерпілого": "poterpilyi-prava", "потерпілого": "poterpilyi-prava",
    "заяву про злочин": "zayava-pro-zlochyn", "заява про злочин": "zayava-pro-zlochyn",
    "умовно-дострокове звільнення": "umovno-dostrokove",
    "закриття кримінального провадження": "zakryttia-kryminalnoho-provadzhennia",
    "дтп": "dtp-algorytm", "після дтп": "dtp-algorytm",
    "європротоколу": "evroprotokol",
    "позбавлення водійських прав": "pozbavlennya-prav", "водійських прав": "pozbavlennya-prav",
    "оскарження штрафу": "oskarzhennia-shtrafu", "штраф з камери": "oskarzhennia-shtrafu",
    "страхове відшкодування": "strahove-vidshkoduvannya", "виплату за осцпв": "strahove-vidshkoduvannya",
    "спадкові спори": "spory-pro-spadschynu", "спори про спадщину": "spory-pro-spadschynu",
    "договір дарування": "daruvannya-neruhomosti",
    "земельної ділянки": "zemelni-spory",
    "приватизація земельної ділянки": "pryvatyzatsiia-zemli", "приватизувати земельну ділянку": "pryvatyzatsiia-zemli",
    "договору довічного утримання": "dovichne-utrymannya",
    "ліквідація підприємства": "likvidatsiya-pidpryyemstva", "ліквідувати підприємство": "likvidatsiya-pidpryyemstva",
    "договір постачання": "dohovir-postachannya",
    "ділової репутації": "zahyst-reputatsiyi", "захист репутації": "zahyst-reputatsiyi",
    "судових витрат": "sudovi-vytraty",
    "заочне рішення": "zaochne-rishennia", "заочного рішення": "zaochne-rishennia",
    "усиновлення дитини": "usynovlennia-dytyny", "усиновлення": "usynovlennia-dytyny",
    "реєстрацію фоп": "reyestratsiya-fop",
    "персональних даних": "zahyst-personalnyh-danyh", "персональні дані": "zahyst-personalnyh-danyh",
    "опіка": "opika-pikluvannia", "опіку": "opika-pikluvannia", "опіки та піклування": "opika-pikluvannia",
    "невикористану відпустку": "kompensatsiia-vidpustka", "компенсацію за відпустку": "kompensatsiia-vidpustka",
    "апеляція на вирок": "apelyatsiia-na-vyrok", "вироку": "apelyatsiia-na-vyrok", "вирок": "apelyatsiia-na-vyrok",
    "регрес": "rehres-strakhovoi", "регресну вимогу": "rehres-strakhovoi",
    "самочинне будівництво": "uzakonennia-samobudu", "самочинного будівництва": "uzakonennia-samobudu", "самочинну споруду": "uzakonennia-samobudu",
    "торгову марку": "reyestratsiia-torhovoi-marky", "торгової марки": "reyestratsiia-torhovoi-marky", "торгова марка": "reyestratsiia-torhovoi-marky",
    "відвід судді": "vidvid-suddi", "відвід": "vidvid-suddi", "відводу": "vidvid-suddi",
    # --- військове право та мобілізація ---
    "влк": "vlk-oskarzhennia", "військово-лікарської комісії": "vlk-oskarzhennia", "військово-лікарська комісія": "vlk-oskarzhennia",
    "відстрочка від мобілізації": "vidstrochka-mobilizatsiya", "відстрочку від мобілізації": "vidstrochka-mobilizatsiya", "відстрочки від мобілізації": "vidstrochka-mobilizatsiya",
    "сзч": "szch-vidpovidalnist", "самовільне залишення частини": "szch-vidpovidalnist", "самовільного залишення частини": "szch-vidpovidalnist",
    "звільнення з військової служби": "zvilnennya-z-viyskovoi-sluzhby", "звільнення зі служби": "zvilnennya-z-viyskovoi-sluzhby",
    "тцк та сп": "oskarzhennia-tck", "рішень тцк": "oskarzhennia-tck", "рішення тцк": "oskarzhennia-tck",
    "статус убд": "vyplaty-viyskovym-ubd", "убд": "vyplaty-viyskovym-ubd", "виплати військовим": "vyplaty-viyskovym-ubd", "виплати військовослужбовцям": "vyplaty-viyskovym-ubd",
    # --- адміністративні спори ---
    "адміністративний позов": "administratyvnyi-pozov", "адміністративного позову": "administratyvnyi-pozov", "адміністративним позовом": "administratyvnyi-pozov",
    "бездіяльність органу": "bezdiyalnist-organu", "бездіяльності органу": "bezdiyalnist-organu", "протиправну бездіяльність": "bezdiyalnist-organu",
    "публічної інформації": "dostup-do-publichnoi-informatsii", "публічну інформацію": "dostup-do-publichnoi-informatsii", "запит на інформацію": "dostup-do-publichnoi-informatsii",
    "адміністративної послуги": "vidmova-administratyvna-posluha", "адміністративну послугу": "vidmova-administratyvna-posluha", "адміністративних послуг": "vidmova-administratyvna-posluha",
    "місцевого самоврядування": "oskarzhennia-mistsevoi-vlady", "органів місцевого самоврядування": "oskarzhennia-mistsevoi-vlady",
    "адміністративне правопорушення": "administratyvnyi-aresht", "адміністративного правопорушення": "administratyvnyi-aresht",
    # --- пенсійні та соціальні виплати ---
    "перерахунок пенсії": "pererahunok-pensii", "перерахунку пенсії": "pererahunok-pensii",
    "призначенні пенсії": "vidmova-u-pensii", "відмова у пенсії": "vidmova-u-pensii", "відмову у призначенні пенсії": "vidmova-u-pensii",
    "статус впо": "vyplaty-vpo", "впо": "vyplaty-vpo", "внутрішньо переміщеної особи": "vyplaty-vpo", "переселенця": "vyplaty-vpo",
    "інвалідності": "invalidnist-msek", "мсек": "invalidnist-msek", "групу інвалідності": "invalidnist-msek",
    "субсидію": "subsydiya", "субсидії": "subsydiya", "житлова субсидія": "subsydiya", "житлової субсидії": "subsydiya",
    "трудового стажу": "pidtverdzhennia-stazhu", "трудовий стаж": "pidtverdzhennia-stazhu", "страхового стажу": "pidtverdzhennia-stazhu",
    # --- ст. 130 КУпАП (керування у стані сп'яніння) ---
    "керування у стані сп'яніння": "st-130-kupap", "130 купап": "st-130-kupap", "стані сп'яніння": "st-130-kupap",
    "огляду на стан сп'яніння": "ogljad-na-spjaninnja", "огляд на стан сп'яніння": "ogljad-na-spjaninnja", "огляд на сп'яніння": "ogljad-na-spjaninnja",
    "відмова від огляду": "vidmova-vid-ogljadu", "відмову від огляду": "vidmova-vid-ogljadu", "відмови від огляду": "vidmova-vid-ogljadu",
    # --- нова партія ---
    "колектор": "zahyst-vid-kolektoriv", "колекторів": "zahyst-vid-kolektoriv", "колекторами": "zahyst-vid-kolektoriv", "колектори": "zahyst-vid-kolektoriv",
    "завдаток": "zavdatok-avans", "завдатку": "zavdatok-avans", "завдатком": "zavdatok-avans",
    "упущена вигода": "upushchena-vyhoda", "упущену вигоду": "upushchena-vyhoda", "упущеної вигоди": "upushchena-vyhoda",
    "дисциплінарне стягнення": "dystsyplinarne-styagnennia", "дисциплінарного стягнення": "dystsyplinarne-styagnennia", "догана": "dystsyplinarne-styagnennia", "догану": "dystsyplinarne-styagnennia", "догани": "dystsyplinarne-styagnennia",
    "аліменти на повнолітню дитину": "alimenty-povnolitni", "аліментів на повнолітню дитину": "alimenty-povnolitni",
    "забудовник": "spory-z-zabudovnykom", "забудовника": "spory-z-zabudovnykom", "забудовником": "spory-z-zabudovnykom", "новобудові": "spory-z-zabudovnykom", "новобудову": "spory-z-zabudovnykom",
    "поліса осцпв": "dtp-bez-strakhovky", "без поліса осцпв": "dtp-bez-strakhovky", "без страховки": "dtp-bez-strakhovky",
    "борг за комунальні послуги": "borg-za-komunalku", "заборгованість за комунальні послуги": "borg-za-komunalku", "борг за комуналку": "borg-za-komunalku",
}

# Головна: 6 обраних статей у секції «Статті» (curated).
FEATURED = ["yak-povernuty-borh", "rozirvannya-shlyubu", "pershyi-dopyt",
            "nezakonne-zvilnennya", "dtp-algorytm", "spadschyna-pryynyaty"]

# Плаваючі кнопки швидкого зв'язку (однакові на всіх сторінках).
FAB_HTML = """<div class="fab" aria-label="Швидкий зв'язок">
  <div class="fab-group">
  <a class="fab-btn fab-call" href="tel:+380934664443" aria-label="Подзвонити">
    <svg viewBox="0 0 24 24"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>
  </a>
  <a class="fab-btn fab-tg" href="https://t.me/adv_osadko" target="_blank" rel="noopener" aria-label="Telegram">
    <svg viewBox="0 0 24 24"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
  </a>
  <a class="fab-btn fab-wa" href="https://wa.me/380934664443" target="_blank" rel="noopener" aria-label="WhatsApp">
    <svg viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.885-9.885 9.885M20.52 3.449C18.24 1.245 15.24 0 12.045 0 5.463 0 .104 5.359.101 11.945c0 2.096.548 4.142 1.588 5.945L0 24l6.335-1.652a11.882 11.882 0 005.71 1.446h.005c6.585 0 11.946-5.359 11.949-11.945a11.821 11.821 0 00-3.479-8.4"/></svg>
  </a>
  <a class="fab-btn fab-vb" href="viber://chat?number=%2B380934664443" aria-label="Viber">
    <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
  </a>
  </div>
  <button class="fab-btn fab-toggle" type="button" aria-expanded="false" aria-label="Зв'язатися" onclick="this.parentElement.classList.toggle('open');this.setAttribute('aria-expanded',this.parentElement.classList.contains('open'))">
    <span class="fab-swap"><svg class="fi fi-phone" viewBox="0 0 24 24" fill="currentColor"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg><svg class="fi fi-mail" viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4.25-8 5-8-5V6l8 5 8-5v2.25z"/></svg><svg class="fi fi-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg></span>
  </button>
  <button class="fab-btn fab-top" type="button" onclick="window.scrollTo({top:0,behavior:'smooth'})" aria-label="Нагору">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>
  </button>
</div>"""


def esc(s):
    return html.escape(s)


def plural_uk(n, forms):
    """forms = (one, few, many): 1 стаття / 2 статті / 5 статей."""
    n = abs(int(n))
    if n % 10 == 1 and n % 100 != 11:
        return forms[0]
    if 2 <= n % 10 <= 4 and not (12 <= n % 100 <= 14):
        return forms[1]
    return forms[2]


def strip_tags(s):
    return re.sub(r"<[^>]+>", "", s)


def reading_time(body_html):
    words = len(strip_tags(body_html).split())
    return max(2, round(words / 160))


# ---------- ЗАВАНТАЖЕННЯ ДАНИХ ----------
def load_articles():
    arts = []
    for path in glob.glob(os.path.join(CONTENT, "*.json")):
        with open(path, encoding="utf-8") as f:
            a = json.load(f)
        a.setdefault("order", 10_000)
        if a["cat"] not in CATS:
            raise ValueError(f"{path}: невідома категорія '{a['cat']}'")
        arts.append(a)
    # Стабільний, детермінований порядок: спочатку за полем order, потім за slug.
    arts.sort(key=lambda a: (a["order"], a["slug"]))
    return arts


# ---------- РЕНДЕР ТІЛА СТАТТІ ----------
def blocks_to_html(blocks):
    out = []
    for b in blocks:
        t = b["type"]
        if t == "h2":
            out.append(f'  <h2 class="body-reveal">{b["text"]}</h2>')
        elif t == "h3":
            out.append(f'  <h3 class="body-reveal">{b["text"]}</h3>')
        elif t == "p":
            out.append(f'  <p class="body-reveal">{b["text"]}</p>')
        elif t in ("ul", "ol"):
            items = "\n".join(f"    <li>{i}</li>" for i in b["items"])
            out.append(f'  <{t} class="body-reveal">\n{items}\n  </{t}>')
        elif t == "seealso":
            links = "".join(
                f'<a href="{it["slug"]}.html">{esc(it["title"])}</a>' for it in b["items"])
            out.append(
                '  <aside class="seealso body-reveal">'
                '<span class="seealso-label">Читайте також</span>'
                f'<span class="seealso-links">{links}</span></aside>')
    return "\n\n".join(out)


_UK_LETTER = "[а-яіїєґ'ʼ’]"
_MORPH_MIN_STEM = 5   # мінімальна незмінна основа слова
_MORPH_MAX_END = 4    # скільки літер закінчення може відрізнятися
_morph_cache = {}


def _morph_pattern(phrase):
    """Регекс, що зіставляє фразу з урахуванням українських відмінкових закінчень.
    Короткі слова (<5 літер) матчаться точно; довші — за основою + змінне закінчення."""
    pat = _morph_cache.get(phrase)
    if pat is not None:
        return pat
    words = phrase.split()
    if len(words) == 1:
        # Однослівні анкори — лише точний збіг (морфологія на одному слові
        # дає хибні збіги через спільні основи різних лексем, напр. завдаток/завдати).
        body = re.escape(phrase)
    else:
        parts = []
        for w in words:
            if len(w) < _MORPH_MIN_STEM:
                parts.append(re.escape(w))
            else:
                stem = w[:max(_MORPH_MIN_STEM, len(w) - 3)]
                parts.append(re.escape(stem) + _UK_LETTER + "{0,%d}" % _MORPH_MAX_END)
        body = r"\s+".join(parts)
    pat = re.compile(r"(?<![\w’ʼ'\-])(" + body + r")(?![\w’ʼ'\-])", re.IGNORECASE)
    _morph_cache[phrase] = pat
    return pat


def _autolink_text(text, cur_slug, valid_slugs, used, terms):
    """Вставляє посилання на першу згадку ключових фраз у рядку тексту."""
    if "<a " in text:
        return text
    for phrase, slug in terms:
        if len(used) >= MAX_AUTOLINKS:
            break
        if slug == cur_slug or slug in used or slug not in valid_slugs:
            continue
        pat = _morph_pattern(phrase)
        m = pat.search(text)
        if not m:
            continue
        before = text[:m.start()]
        if before.count("<a ") > before.count("</a>"):  # уже всередині посилання
            continue
        text = before + f'<a href="{slug}.html">{m.group(1)}</a>' + text[m.end():]
        used.add(slug)
    return text


def autolink_blocks(blocks, cur_slug, valid_slugs):
    """Робить перші згадки ключових фраз (в абзацах і списках) посиланнями на статті."""
    used = set()
    terms = sorted(LINK_TERMS.items(), key=lambda kv: -len(kv[0]))
    out = []
    for b in blocks:
        if len(used) >= MAX_AUTOLINKS:
            out.append(b)
        elif b["type"] == "p":
            out.append({"type": "p", "text": _autolink_text(b["text"], cur_slug, valid_slugs, used, terms)})
        elif b["type"] in ("ul", "ol"):
            items = [_autolink_text(it, cur_slug, valid_slugs, used, terms) for it in b["items"]]
            out.append({"type": b["type"], "items": items})
        else:
            out.append(b)
    return out


def closing_blocks(cat, h1):
    topic = h1[0].lower() + h1[1:]
    return [
        {"type": "h2", "text": "Чим може допомогти адвокат"},
        {"type": "p", "text": f"Питання, як-от «{topic.rstrip('.')}», рідко бувають типовими: "
                              f"{CAT_NOTE[cat]} Адвокат Олександр Осадько проаналізує вашу ситуацію, "
                              f"чесно оцінить перспективи, підготує документи і візьме на себе спілкування "
                              f"із судом та іншою стороною. Це економить час, гроші й нерви, а головне — "
                              f"підвищує шанси на результат. Щоб отримати пораду саме для вашого випадку, "
                              + NOTE_LINK + "."},
    ]


def build_faq_html(faq):
    out = []
    for item in faq:
        out.append(f'''    <details>
      <summary>{esc(item["q"])}</summary>
      <p>{esc(item["a"])}</p>
    </details>''')
    return "\n".join(out)


AUTO_ANCHOR_STOP = {
    "адвокат", "юрист", "консультація", "договір", "суд", "заява", "позов",
    "право", "права", "порядок", "питання", "справа", "стаття", "закон",
    "україні", "україна", "як", "що",
}
AUTO_ANCHOR_TAIL = {
    "і", "та", "й", "з", "із", "зі", "у", "в", "на", "за", "до", "для",
    "від", "про", "по", "а", "чи", "о", "як", "що", "цього", "цих",
    "через", "її", "його", "їх", "свого", "своїх", "цим", "цією",
}


def build_auto_anchors(arts):
    """Для статей без ручного анкора генерує анкор із заголовка — ширша перелінковка.
    Додаються лише однозначні (одна ціль) фрази, довші за 13 символів."""
    covered = set(LINK_TERMS.values())
    existing = set(LINK_TERMS.keys())
    cand = {}
    for a in arts:
        if a["slug"] in covered:
            continue
        phrase = re.split(r"[:—–(]", a["h1"].lower())[0].strip(" .,:;")
        words = phrase.split()[:4]
        if words and words[0] in AUTO_ANCHOR_STOP:
            words = words[1:]
        while words and words[-1] in AUTO_ANCHOR_TAIL:
            words = words[:-1]
        phrase = " ".join(words)
        if len(words) < 2 or len(phrase) < 14 or phrase in existing:
            continue
        cand.setdefault(phrase, set()).add(a["slug"])
    added = 0
    for phrase, slugs in cand.items():
        if len(slugs) == 1:
            LINK_TERMS[phrase] = next(iter(slugs))
            added += 1
    return added


_KW_RE = re.compile(r"[Ѐ-ӿ]{4,}")


def _kw(a):
    return set(_KW_RE.findall((a["title"] + " " + a.get("desc", "")).lower()))


def build_related_html(cur_slug, cat, allmeta):
    cur = next((x for x in allmeta if x["slug"] == cur_slug), None)
    ck = _kw(cur) if cur else set()
    same = [a for a in allmeta if a["cat"] == cat and a["slug"] != cur_slug]
    rest = [a for a in allmeta if a["cat"] != cat and a["slug"] != cur_slug]
    # найрелевантніші з тієї ж теми (за перетином ключових слів) + суміжні з різних категорій
    same.sort(key=lambda a: -len(ck & _kw(a)))
    rest.sort(key=lambda a: -len(ck & _kw(a)))
    diverse, seen = [], set()
    for a in rest:
        if a["cat"] not in seen:
            diverse.append(a)
            seen.add(a["cat"])
        if len(diverse) >= 3:
            break
    pick = same[:3] + diverse
    if len(pick) < 6:
        extra = [a for a in (same + rest) if a not in pick]
        pick += extra[:6 - len(pick)]
    pick = pick[:6]
    out = []
    for a in pick:
        out.append(f'''      <a class="related-card reveal" href="{a['slug']}.html">
        <span class="cat cat-{a['cat']}">{esc(SHORT_CAT[a['cat']])}</span>
        <h3>{esc(a['title'])}</h3>
      </a>''')
    return "\n".join(out)


def build_inline_seealso(cur_slug, cat, allmeta, n=3):
    """Контекстний інлайн-блок «Читайте також» усередині статті — щільніша
    перелінковка незалежно від того, чи трапляються в тексті ключові фрази.
    Обирає найрелевантніші статті за перетином ключових слів; та ж категорія
    отримує невеликий бонус."""
    cur = next((x for x in allmeta if x["slug"] == cur_slug), None)
    if not cur:
        return None
    ck = _kw(cur)
    cands = [a for a in allmeta if a["slug"] != cur_slug]
    cands.sort(key=lambda a: (-(len(ck & _kw(a)) + (1 if a["cat"] == cat else 0)),
                              a["title"]))
    pick = cands[:n]
    if not pick:
        return None
    return {"type": "seealso",
            "items": [{"slug": a["slug"], "title": a["title"]} for a in pick]}


def inject_seealso(blocks, seealso):
    """Вставляє інлайн-блок перелінковки в середину статті — між розділами,
    приблизно посередині, але не перед першим і не перед завершальними."""
    if not seealso:
        return blocks
    blocks = list(blocks)
    h2i = [i for i, b in enumerate(blocks) if b.get("type") == "h2"]
    if len(h2i) >= 4:
        pos = h2i[2]
    elif len(h2i) >= 2:
        pos = h2i[1]
    else:
        pos = len(blocks)
    blocks.insert(pos, seealso)
    return blocks


def _wordcount(blocks):
    n = 0
    for b in blocks:
        if b.get("type") == "p":
            n += len(strip_tags(b.get("text", "")).split())
        elif b.get("type") in ("ul", "ol"):
            for it in b.get("items", []):
                n += len(strip_tags(it).split())
    return n


def build_jsonld(a, faq):
    slug, cat, title, desc, h1 = a["slug"], a["cat"], a["title"], a["desc"], a["h1"]
    url = ART_BASE_URL + slug + ".html"
    wc = _wordcount(a.get("blocks", [])) + sum(len((it.get("a", "")).split()) for it in faq)
    article = {
        "@type": "Article", "headline": h1[:110], "description": desc, "inLanguage": "uk",
        "image": [BASE_URL + "assets/og-image.jpg"],
        "datePublished": a.get("date_published", "2026-07-01"),
        "dateModified": a.get("date_modified", "2026-07-11"),
        "articleSection": CATS[cat],
        "wordCount": wc,
        "isAccessibleForFree": True,
        "author": {"@type": "Person", "name": "Олександр Осадько", "jobTitle": "Адвокат",
                   "url": BASE_URL},
        "publisher": {
            "@type": "Organization", "name": "Адвокат Олександр Осадько",
            "logo": {"@type": "ImageObject", "url": BASE_URL + "assets/logo-mark.png"},
        },
        "mainEntityOfPage": {"@type": "WebPage", "@id": url},
    }
    crumbs = {
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Головна", "item": BASE_URL},
            {"@type": "ListItem", "position": 2, "name": "Статті", "item": ART_BASE_URL},
            {"@type": "ListItem", "position": 3, "name": CATS[cat], "item": ART_BASE_URL + cat + ".html"},
            {"@type": "ListItem", "position": 4, "name": title, "item": url},
        ],
    }
    faqpage = {
        "@type": "FAQPage",
        "mainEntity": [
            {"@type": "Question", "name": item["q"],
             "acceptedAnswer": {"@type": "Answer", "text": item["a"]}}
            for item in faq
        ],
    }
    graph = {"@context": "https://schema.org", "@graph": [article, crumbs, faqpage]}
    return json.dumps(graph, ensure_ascii=False)


ARTICLE_PAGE = """<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script>document.documentElement.classList.add('js')</script>
  <script defer src="../assets/ga.js?v=5"></script>
  <title>{title} — адвокат Олександр Осадько</title>
  <meta name="description" content="{desc}">
  <meta name="keywords" content="{kw}">
  <link rel="canonical" href="{url}">
  <meta name="robots" content="index, follow">
  <meta property="og:type" content="article">
  <meta property="og:title" content="{title}">
  <meta property="og:description" content="{desc}">
  <meta property="og:url" content="{url}">
  <meta property="og:site_name" content="Адвокат Олександр Осадько">
  <meta property="og:locale" content="uk_UA">
  <meta property="og:image" content="{ogimg}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="{ogimg}">
  <link rel="icon" type="image/png" href="../assets/logo-mark.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="preload" as="style" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,800&family=Inter:wght@300;400;500&display=swap" onload="this.onload=null;this.rel='stylesheet'">
  <noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,800&family=Inter:wght@300;400;500&display=swap"></noscript>
  <link rel="stylesheet" href="../css/style.css?v=83">
  <script>(function(){{try{{var t=localStorage.getItem('theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.setAttribute('data-theme',t);}}catch(e){{}}}})();</script>
  <script defer src="../assets/header-scroll.js?v=15"></script>
  <script defer src="../assets/callback-popup.js?v=20"></script>
  <script type="application/ld+json">{jsonld}</script>
</head>
<body>
<a class="skip-link" href="#main">Перейти до вмісту</a>

<header class="site-header">
  <div class="container header-inner">
    <a href="../" class="brand">
      <span class="brand-mark"><img src="../assets/logo-mark.png" alt="Логотип адвоката Осадька" width="36" height="36"></span>
      Адвокат Осадько Олександр
    </a>
    <nav class="site-nav" id="nav">
      <a href="../#about">Про мене</a>
      <a href="../poslugy/">Послуги</a>
      <a href="../articles/">Статті</a>
      <a href="../zrazky/">Зразки</a>
      <a href="../kontakty/">Контакти</a>
      <a href="../#contacts" class="nav-cta">Консультація</a>
    </nav>
    <button class="theme-toggle" id="themeToggle" type="button" aria-label="Змінити тему (день/ніч)">
      <svg class="i-moon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
      <svg class="i-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/></svg>
    </button>
    <button class="nav-toggle" id="navToggle" type="button" aria-label="Відкрити меню" aria-expanded="false"><span></span><span></span><span></span></button>
  </div>
</header>

<main id="main" class="article-page">
  <nav class="crumbs" aria-label="Хлібні крихти">
    <a href="../">Головна</a><span>/</span>
    <a href="./">Статті</a><span>/</span>
    <a href="{cat}.html">{catname}</a><span>/</span>
    <span class="cur">{crumb}</span>
  </nav>
  <span class="cat cat-{cat}">{catname}</span>
  <h1>{h1}</h1>
  <p class="meta-line">Оновлено: {date} · <span>⏱ {read} хв читання</span> · Адвокат Олександр Осадько</p>

{body}

  <h2 id="faq">Часті запитання</h2>
  <div class="faq">
{faq}
  </div>

  <p class="article-note">
    Ця стаття має загальний інформаційний характер і не є юридичною
    консультацією. Кожна ситуація індивідуальна — щоб отримати пораду саме для
    вашого випадку, <a href="../#contacts">зв'яжіться з адвокатом</a>.
  </p>

  <aside class="related">
    <h2>Читайте також</h2>
    <div class="related-grid">
{related}
    </div>
  </aside>
</main>

{fab}

<footer class="site-footer">
  <div class="container footer-inner">
    <span class="brand">
      <span class="brand-mark" style="width:28px;height:28px"><img src="../assets/logo-mark.png" alt="" width="28" height="28" loading="lazy" decoding="async"></span>
      Адвокат Осадько Олександр
    </span>
    <span>© <span id="year"></span> Адвокат Олександр Осадько · <a href="../privacy/">Політика конфіденційності</a></span>
  </div>
</footer>

<script>
  document.getElementById('year').textContent = new Date().getFullYear();
  // Плавна поява тексту статті та карток при гортанні
  const io = new IntersectionObserver((es) => {
    es.forEach(x => { if (x.isIntersecting) { x.target.classList.add('in'); io.unobserve(x.target); } });
  }, { threshold: 0.12 });
  document.querySelectorAll('.body-reveal, .reveal').forEach(el => io.observe(el));
</script>

</body>
</html>
"""


def render_article(a, allmeta):
    faq = a.get("faq", [])
    valid = {x["slug"] for x in allmeta}
    body_blocks = inject_seealso(a["blocks"], build_inline_seealso(a["slug"], a["cat"], allmeta))
    full_blocks = autolink_blocks(body_blocks, a["slug"], valid) + closing_blocks(a["cat"], a["h1"])
    body = blocks_to_html(full_blocks)
    kw = f"{a['title'].lower()}, адвокат, юрист, {KW_BASE[a['cat']]}, Україна, консультація адвоката"
    repl = {
        "{title}": esc(a["title"]), "{desc}": esc(a["desc"]), "{kw}": esc(kw),
        "{url}": ART_BASE_URL + a["slug"] + ".html", "{jsonld}": build_jsonld(a, faq),
        "{cat}": a["cat"], "{catname}": CATS[a["cat"]], "{crumb}": esc(a["title"]),
        "{ogimg}": BASE_URL + "assets/og-image.jpg",
        "{h1}": esc(a["h1"]), "{date}": DATE_LABEL, "{read}": str(reading_time(body)),
        "{body}": body, "{faq}": build_faq_html(faq), "{related}": build_related_html(a["slug"], a["cat"], allmeta),
        "{fab}": FAB_HTML,
    }
    page = ARTICLE_PAGE
    for k, v in repl.items():
        page = page.replace(k, v)
    return page


# ---------- КАТАЛОГ articles/index.html ----------
def render_catalog(arts):
    n = len(arts)
    groups_html = []
    for cat in ORDER:
        items = [a for a in arts if a["cat"] == cat]
        if not items:
            continue
        cards = []
        for a in items:
            cards.append(f'''      <a class="mini-card reveal" href="{a['slug']}.html">
        <span class="cat cat-{cat}">{esc(SHORT_CAT[cat])}</span>
        <h3>{esc(a['title'])}</h3>
        <p>{esc(a['desc'])}</p>
        <span class="more">Читати →</span>
      </a>''')
        groups_html.append(f'''    <div class="cat-group" data-cat="{cat}">
      <div class="cat-group-head">
        <span class="cat cat-{cat}">{esc(SHORT_CAT[cat])}</span>
        <h2><a href="{cat}.html">{esc(CATS[cat])}</a></h2>
        <span class="count">{len(items)} {plural_uk(len(items), ("стаття","статті","статей"))}</span>
      </div>
      <div class="cat-grid">
{chr(10).join(cards)}
      </div>
    </div>''')

    filter_btns = ['      <button class="active" data-f="all">Усі</button>']
    for cat in ORDER:
        if any(a["cat"] == cat for a in arts):
            filter_btns.append(f'      <button data-f="{cat}">{esc(SHORT_CAT[cat])}</button>')

    materials = plural_uk(n, ("матеріал", "матеріали", "матеріалів"))
    return f'''<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script defer src="../assets/ga.js?v=5"></script>
  <title>Статті — Олександр Осадько, адвокат</title>
  <meta name="description" content="Юридичні статті адвоката Олександра Осадька: борги та договори, сімейне право, трудові спори, кримінальні справи, ДТП, нерухомість, бізнес і судовий процес.">
  <link rel="canonical" href="{ART_BASE_URL}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="Статті — адвокат Олександр Осадько">
  <meta property="og:url" content="{ART_BASE_URL}">
  <meta property="og:site_name" content="Адвокат Олександр Осадько">
  <meta property="og:image" content="{BASE_URL}assets/og-image.jpg">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="{BASE_URL}assets/og-image.jpg">
  <link rel="icon" type="image/png" href="../assets/logo-mark.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="preload" as="style" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,800&family=Inter:wght@300;400;500&display=swap" onload="this.onload=null;this.rel='stylesheet'">
  <noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,800&family=Inter:wght@300;400;500&display=swap"></noscript>
  <link rel="stylesheet" href="../css/style.css?v=83">
  <script>(function(){{try{{var t=localStorage.getItem('theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.setAttribute('data-theme',t);}}catch(e){{}}}})();</script>
  <script defer src="../assets/header-scroll.js?v=15"></script>
  <script defer src="../assets/callback-popup.js?v=20"></script>
</head>
<body>
<a class="skip-link" href="#main">Перейти до вмісту</a>

<header class="site-header">
  <div class="container header-inner">
    <a href="../" class="brand">
      <span class="brand-mark"><img src="../assets/logo-mark.png" alt="Логотип адвоката Осадька" width="36" height="36"></span>
      Адвокат Осадько Олександр
    </a>
    <nav class="site-nav" id="nav">
      <a href="../#about">Про мене</a>
      <a href="../poslugy/">Послуги</a>
      <a href="./">Статті</a>
      <a href="../zrazky/">Зразки</a>
      <a href="../kontakty/">Контакти</a>
      <a href="../#contacts" class="nav-cta">Консультація</a>
    </nav>
    <button class="theme-toggle" id="themeToggle" type="button" aria-label="Змінити тему (день/ніч)">
      <svg class="i-moon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
      <svg class="i-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/></svg>
    </button>
    <button class="nav-toggle" id="navToggle" type="button" aria-label="Відкрити меню" aria-expanded="false"><span></span><span></span><span></span></button>
  </div>
</header>

<main id="main">
  <section class="catalog-hero">
    <div class="container">
      <a href="../" class="back-link">← На головну</a>
      <h1>Статті</h1>
      <p>Пояснюю правові питання простою мовою — {n} {materials} про борги, сім'ю, роботу, кримінальні справи, ДТП, нерухомість і бізнес. Оберіть тему нижче.</p>
      <input type="search" id="q" class="catalog-search" placeholder="🔍 Пошук статті за темою або ключовим словом…" autocomplete="off" aria-label="Пошук статей">
      <div class="cat-filter" id="filter">
{chr(10).join(filter_btns)}
      </div>
    </div>
  </section>

  <section class="catalog">
    <div class="container" id="groups">
{chr(10).join(groups_html)}
      <p class="no-results" id="noResults" hidden>За вашим запитом нічого не знайдено. Спробуйте інші слова або оберіть тему вище.</p>
    </div>
  </section>
</main>

{FAB_HTML}

<footer class="site-footer">
  <div class="container footer-inner">
    <span class="brand">
      <span class="brand-mark" style="width:28px;height:28px"><img src="../assets/logo-mark.png" alt="" width="28" height="28" loading="lazy" decoding="async"></span>
      Адвокат Осадько Олександр
    </span>
    <span>© <span id="year"></span> Адвокат Олександр Осадько · <a href="../privacy/">Політика конфіденційності</a></span>
  </div>
</footer>

<script>
  document.getElementById('year').textContent = new Date().getFullYear();
  // Фільтр за категоріями + живий пошук
  const q = document.getElementById('q');
  const btns = document.querySelectorAll('#filter button');
  const groups = document.querySelectorAll('#groups .cat-group');
  const noRes = document.getElementById('noResults');
  let activeCat = 'all';
  function apply() {{
    const term = (q.value || '').trim().toLowerCase();
    let total = 0;
    groups.forEach(g => {{
      const catOk = (activeCat === 'all' || g.dataset.cat === activeCat);
      let shown = 0;
      g.querySelectorAll('.mini-card').forEach(card => {{
        const vis = catOk && (term === '' || card.textContent.toLowerCase().includes(term));
        card.style.display = vis ? '' : 'none';
        if (vis) {{ card.classList.add('in'); shown++; }}
      }});
      g.style.display = shown ? '' : 'none';
      total += shown;
    }});
    noRes.hidden = total !== 0;
  }}
  btns.forEach(b => b.addEventListener('click', () => {{
    btns.forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    activeCat = b.dataset.f;
    apply();
  }}));
  q.addEventListener('input', apply);
  // Поява при скролі
  const io = new IntersectionObserver((e) => {{
    e.forEach(x => {{ if (x.isIntersecting) {{ x.target.classList.add('in'); io.unobserve(x.target); }} }});
  }}, {{ threshold: 0.08 }});
  document.querySelectorAll('.reveal').forEach(el => io.observe(el));
</script>
</body>
</html>
'''


# ---------- ТЕМАТИЧНА СТОРІНКА-ХАБ articles/<cat>.html ----------
def render_hub(cat, arts):
    items = [a for a in arts if a["cat"] == cat]
    n = len(items)
    cards = []
    for a in items:
        cards.append(f'''      <a class="mini-card reveal" href="{a['slug']}.html">
        <span class="cat cat-{cat}">{esc(SHORT_CAT[cat])}</span>
        <h3>{esc(a['title'])}</h3>
        <p>{esc(a['desc'])}</p>
        <span class="more">Читати →</span>
      </a>''')
    others = "\n".join(
        f'        <a class="cat cat-{c}" href="{c}.html">{esc(SHORT_CAT[c])}</a>'
        for c in ORDER if c != cat and any(x["cat"] == c for x in arts)
    )
    url = ART_BASE_URL + cat + ".html"
    jsonld = json.dumps({"@context": "https://schema.org", "@graph": [
        {"@type": "CollectionPage", "name": CATS[cat], "description": CAT_DESC[cat],
         "inLanguage": "uk", "url": url},
        {"@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Головна", "item": BASE_URL},
            {"@type": "ListItem", "position": 2, "name": "Статті", "item": ART_BASE_URL},
            {"@type": "ListItem", "position": 3, "name": CATS[cat], "item": url},
        ]},
    ]}, ensure_ascii=False)
    return f'''<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script defer src="../assets/ga.js?v=5"></script>
  <title>{esc(CATS[cat])} — статті адвоката Олександра Осадька</title>
  <meta name="description" content="{esc(CAT_DESC[cat])}">
  <meta name="keywords" content="{esc(KW_BASE[cat])}, адвокат, юрист, Україна">
  <link rel="canonical" href="{url}">
  <meta name="robots" content="index, follow">
  <meta property="og:type" content="website">
  <meta property="og:title" content="{esc(CATS[cat])} — статті адвоката">
  <meta property="og:description" content="{esc(CAT_DESC[cat])}">
  <meta property="og:url" content="{url}">
  <meta property="og:site_name" content="Адвокат Олександр Осадько">
  <meta property="og:locale" content="uk_UA">
  <meta property="og:image" content="{BASE_URL}assets/og-image.jpg">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="{BASE_URL}assets/og-image.jpg">
  <link rel="icon" type="image/png" href="../assets/logo-mark.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="preload" as="style" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,800&family=Inter:wght@300;400;500&display=swap" onload="this.onload=null;this.rel='stylesheet'">
  <noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,800&family=Inter:wght@300;400;500&display=swap"></noscript>
  <link rel="stylesheet" href="../css/style.css?v=83">
  <script>(function(){{try{{var t=localStorage.getItem('theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.setAttribute('data-theme',t);}}catch(e){{}}}})();</script>
  <script defer src="../assets/header-scroll.js?v=15"></script>
  <script defer src="../assets/callback-popup.js?v=20"></script>
  <script type="application/ld+json">{jsonld}</script>
</head>
<body>
<a class="skip-link" href="#main">Перейти до вмісту</a>

<header class="site-header">
  <div class="container header-inner">
    <a href="../" class="brand">
      <span class="brand-mark"><img src="../assets/logo-mark.png" alt="Логотип адвоката Осадька" width="36" height="36"></span>
      Адвокат Осадько Олександр
    </a>
    <nav class="site-nav" id="nav">
      <a href="../#about">Про мене</a>
      <a href="../poslugy/">Послуги</a>
      <a href="./">Статті</a>
      <a href="../zrazky/">Зразки</a>
      <a href="../kontakty/">Контакти</a>
      <a href="../#contacts" class="nav-cta">Консультація</a>
    </nav>
    <button class="theme-toggle" id="themeToggle" type="button" aria-label="Змінити тему (день/ніч)">
      <svg class="i-moon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
      <svg class="i-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/></svg>
    </button>
    <button class="nav-toggle" id="navToggle" type="button" aria-label="Відкрити меню" aria-expanded="false"><span></span><span></span><span></span></button>
  </div>
</header>

<main id="main">
  <section class="catalog-hero">
    <div class="container">
      <nav class="crumbs" aria-label="Хлібні крихти">
        <a href="../">Головна</a><span>/</span>
        <a href="./">Статті</a><span>/</span>
        <span class="cur">{esc(CATS[cat])}</span>
      </nav>
      <span class="cat cat-{cat}">{esc(SHORT_CAT[cat])}</span>
      <h1>{esc(CATS[cat])}</h1>
      <p>{esc(CAT_DESC[cat])} Усього {n} {plural_uk(n, ("стаття", "статті", "статей"))}.</p>
    </div>
  </section>

  <section class="catalog">
    <div class="container">
      <div class="cat-grid">
{chr(10).join(cards)}
      </div>
      <div class="hub-others">
        <span class="hub-others-label">Інші теми:</span>
{others}
      </div>
    </div>
  </section>
</main>

{FAB_HTML}

<footer class="site-footer">
  <div class="container footer-inner">
    <span class="brand">
      <span class="brand-mark" style="width:28px;height:28px"><img src="../assets/logo-mark.png" alt="" width="28" height="28" loading="lazy" decoding="async"></span>
      Адвокат Осадько Олександр
    </span>
    <span>© <span id="year"></span> Адвокат Олександр Осадько · <a href="../privacy/">Політика конфіденційності</a></span>
  </div>
</footer>

<script>
  document.getElementById('year').textContent = new Date().getFullYear();
  const io = new IntersectionObserver((e) => {{
    e.forEach(x => {{ if (x.isIntersecting) {{ x.target.classList.add('in'); io.unobserve(x.target); }} }});
  }}, {{ threshold: 0.08 }});
  document.querySelectorAll('.reveal').forEach(el => io.observe(el));
</script>
</body>
</html>
'''


# ---------- ОНОВЛЕННЯ ЛІЧИЛЬНИКА НА ГОЛОВНІЙ ----------
def update_homepage_count(n):
    """Оновлює лише кількість статей на index.html (обрані картки лишаються без змін)."""
    idx_path = os.path.join(ROOT, "index.html")
    with open(idx_path, encoding="utf-8") as f:
        idx = f.read()
    materials = plural_uk(n, ("матеріал", "матеріали", "матеріалів"))
    articles_word = plural_uk(n, ("статтю", "статті", "статей"))
    idx, c1 = re.subn(r'Усього <span class="stat-count"[^>]*>\d+</span> матеріал\w* за темами\.',
                      f'Усього <span class="stat-count" data-to="{n}">{n}</span> {materials} за темами.', idx)
    idx, c2 = re.subn(r'Переглянути всі <span class="stat-count"[^>]*>\d+</span> стат\w+ →',
                      f'Переглянути всі <span class="stat-count" data-to="{n}">{n}</span> {articles_word} →', idx)
    with open(idx_path, "w", encoding="utf-8") as f:
        f.write(idx)
    return c1, c2


# ---------- SITEMAP + ROBOTS ----------
def write_sitemap(arts, landings=None):
    import datetime
    landings = landings or []
    today = datetime.date.today().isoformat()
    cats_present = [c for c in ORDER if any(a["cat"] == c for a in arts)]
    # (loc, lastmod, changefreq, priority)
    # Каталожні сторінки — у вигляді директорій (з кінцевою «/»), а не index.html:
    # GitHub Pages перенаправляє /dir/index.html → /dir/, тож index.html-URL у мапі
    # створювали б у Search Console «Сторінку з переадресацією».
    entries = [
        (BASE_URL, today, "weekly", "1.0"),
        (ART_BASE_URL, today, "weekly", "0.8"),
        (BASE_URL + "zrazky/", today, "monthly", "0.5"),
        (BASE_URL + "kontakty/", today, "monthly", "0.6"),
        (BASE_URL + "privacy/", "2026-07-01", "yearly", "0.3"),
    ]
    if landings:
        entries.append((POSLUGY_BASE_URL, today, "monthly", "0.7"))
    # Посадкові лендінги послуг — вищий пріоритет (конверсійні сторінки).
    entries += [(POSLUGY_BASE_URL + l["slug"] + ".html",
                 l.get("date_modified") or today, "monthly", "0.8") for l in landings]
    entries += [(ART_BASE_URL + c + ".html", today, "weekly", "0.7") for c in cats_present]
    # Для кожної статті — її РЕАЛЬНА дата зміни (точний сигнал свіжості для Google,
    # а не однакова дата збірки на всіх сторінках).
    for a in arts:
        lm = a.get("date_modified") or a.get("date_published") or today
        entries.append((ART_BASE_URL + a["slug"] + ".html", lm, "monthly", "0.7"))
    body = "\n".join(
        f"  <url><loc>{loc}</loc><lastmod>{lm}</lastmod>"
        f"<changefreq>{cf}</changefreq><priority>{pr}</priority></url>"
        for (loc, lm, cf, pr) in entries
    )
    xml = ('<?xml version="1.0" encoding="UTF-8"?>\n'
           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
           + body + "\n</urlset>\n")
    with open(os.path.join(ROOT, "sitemap.xml"), "w", encoding="utf-8") as f:
        f.write(xml)


def write_robots():
    txt = ("User-agent: *\n"
           "Allow: /\n"
           "# Памʼятки — lead-магніти: доступ лише через форму, не індексувати напряму.\n"
           "Disallow: /assets/pamyatka-\n\n"
           f"Sitemap: {BASE_URL}sitemap.xml\n")
    with open(os.path.join(ROOT, "robots.txt"), "w", encoding="utf-8") as f:
        f.write(txt)


# ---------- ПОСАДКОВІ ЛЕНДІНГИ ПОСЛУГ ----------

# Конверсійні сторінки під конкретні послуги (для реклами/переходів). Контент —
# у content/landings/*.json; білдер рендерить їх у poslugy/<slug>.html у фірмовому
# стилі, з CTA (дзвінок + месенджери) і розміткою LegalService/FAQPage.
LANDING_CTA = """  <div class="lp-cta">
    <a class="lp-btn lp-btn-call" href="tel:+380934664443">Зателефонувати</a>
    <a class="lp-btn lp-btn-tg" href="https://t.me/adv_osadko" target="_blank" rel="noopener">Telegram</a>
    <a class="lp-btn lp-btn-wa" href="https://wa.me/380934664443" target="_blank" rel="noopener">WhatsApp</a>
    <a class="lp-btn lp-btn-vb" href="viber://chat?number=%2B380934664443">Viber</a>
  </div>"""


def build_landing_jsonld(l):
    url = POSLUGY_BASE_URL + l["slug"] + ".html"
    service = {
        "@type": "LegalService", "name": l["h1"], "description": l["desc"],
        "url": url, "inLanguage": "uk",
        "areaServed": "UA",
        "provider": {
            "@type": "Attorney", "name": "Адвокат Олександр Осадько", "url": BASE_URL,
            "telephone": "+380934664443",
        },
    }
    crumbs = {
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Головна", "item": BASE_URL},
            {"@type": "ListItem", "position": 2, "name": l["service"], "item": url},
        ],
    }
    graph = {"@context": "https://schema.org", "@graph": [service, crumbs]}
    if l.get("faq"):
        graph["@graph"].append({
            "@type": "FAQPage",
            "mainEntity": [
                {"@type": "Question", "name": it["q"],
                 "acceptedAnswer": {"@type": "Answer", "text": it["a"]}}
                for it in l["faq"]
            ],
        })
    return json.dumps(graph, ensure_ascii=False)


LANDING_PAGE = """<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script>document.documentElement.classList.add('js')</script>
  <script defer src="../assets/ga.js?v=5"></script>
  <title>{title} — адвокат Олександр Осадько</title>
  <meta name="description" content="{desc}">
  <link rel="canonical" href="{url}">
  <meta name="robots" content="index, follow">
  <meta property="og:type" content="website">
  <meta property="og:title" content="{title}">
  <meta property="og:description" content="{desc}">
  <meta property="og:url" content="{url}">
  <meta property="og:site_name" content="Адвокат Олександр Осадько">
  <meta property="og:locale" content="uk_UA">
  <meta property="og:image" content="{ogimg}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="{ogimg}">
  <link rel="icon" type="image/png" href="../assets/logo-mark.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="preload" as="style" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,800&family=Inter:wght@300;400;500&display=swap" onload="this.onload=null;this.rel='stylesheet'">
  <noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,800&family=Inter:wght@300;400;500&display=swap"></noscript>
  <link rel="stylesheet" href="../css/style.css?v=83">
  <script>(function(){{try{{var t=localStorage.getItem('theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.setAttribute('data-theme',t);}}catch(e){{}}}})();</script>
  <script defer src="../assets/header-scroll.js?v=15"></script>
  <script type="application/ld+json">{jsonld}</script>
</head>
<body>
<a class="skip-link" href="#main">Перейти до вмісту</a>

<header class="site-header">
  <div class="container header-inner">
    <a href="../" class="brand">
      <span class="brand-mark"><img src="../assets/logo-mark.png" alt="Логотип адвоката Осадька" width="36" height="36"></span>
      Адвокат Осадько Олександр
    </a>
    <nav class="site-nav" id="nav">
      <a href="../#about">Про мене</a>
      <a href="../poslugy/">Послуги</a>
      <a href="../articles/">Статті</a>
      <a href="../zrazky/">Зразки</a>
      <a href="../kontakty/">Контакти</a>
      <a href="../#contacts" class="nav-cta">Консультація</a>
    </nav>
    <button class="theme-toggle" id="themeToggle" type="button" aria-label="Змінити тему (день/ніч)">
      <svg class="i-moon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
      <svg class="i-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/></svg>
    </button>
    <button class="nav-toggle" id="navToggle" type="button" aria-label="Відкрити меню" aria-expanded="false"><span></span><span></span><span></span></button>
  </div>
</header>

<main id="main" class="lp">
  <section class="lp-hero">
    <div class="container">
      <h1>{h1}</h1>
      <p class="lp-sub">{subtitle}</p>
{cta}
      <p class="lp-intro">{intro}</p>
    </div>
  </section>

  <section class="lp-section container">
    <h2>Коли варто звернутися</h2>
    <ul class="lp-situations">
{situations}
    </ul>
  </section>

  <section class="lp-section container">
    <h2>Що ви отримаєте</h2>
    <div class="lp-benefits">
{benefits}
    </div>
  </section>

  <section class="lp-section container">
    <h2>Як я працюю</h2>
    <ol class="lp-steps">
{steps}
    </ol>
  </section>

  <section class="lp-section container">
    <h2>Часті запитання</h2>
    <div class="faq">
{faq}
    </div>
  </section>

  <section class="lp-final">
    <div class="container">
      <h2>{final_title}</h2>
      <p>{final_text}</p>
{cta}
      <p class="lp-more">{more}</p>
    </div>
  </section>
</main>

{fab}

<footer class="site-footer">
  <div class="container footer-inner">
    <span class="brand">
      <span class="brand-mark" style="width:28px;height:28px"><img src="../assets/logo-mark.png" alt="" width="28" height="28" loading="lazy" decoding="async"></span>
      Адвокат Осадько Олександр
    </span>
    <span>© <span id="year"></span> Адвокат Олександр Осадько · <a href="../privacy/">Політика конфіденційності</a></span>
  </div>
</footer>

<script>
  document.getElementById('year').textContent = new Date().getFullYear();
  const io = new IntersectionObserver((es) => {
    es.forEach(x => { if (x.isIntersecting) { x.target.classList.add('in'); io.unobserve(x.target); } });
  }, { threshold: 0.12 });
  document.querySelectorAll('.body-reveal, .reveal').forEach(el => io.observe(el));
</script>

</body>
</html>
"""


def load_landings():
    items = []
    if not os.path.isdir(CONTENT_LANDINGS):
        return items
    for path in glob.glob(os.path.join(CONTENT_LANDINGS, "*.json")):
        with open(path, encoding="utf-8") as f:
            items.append(json.load(f))
    items.sort(key=lambda l: (l.get("order", 10_000), l["slug"]))
    return items


def render_landing(l):
    situations = "\n".join(f'      <li>{esc(s)}</li>' for s in l["situations"])
    benefits = "\n".join(
        f'      <div class="lp-benefit reveal"><h3>{esc(b["t"])}</h3><p>{esc(b["d"])}</p></div>'
        for b in l["benefits"])
    steps = "\n".join(
        f'      <li class="reveal"><span class="lp-step-t">{esc(s["t"])}</span>'
        f'<span class="lp-step-d">{esc(s["d"])}</span></li>'
        for s in l["steps"])
    faq = "\n".join(
        f'      <details><summary>{esc(it["q"])}</summary><p>{esc(it["a"])}</p></details>'
        for it in l.get("faq", []))
    rel = l.get("related")
    more = (f'Хочете розібратися детальніше? Читайте статтю: '
            f'<a href="../articles/{rel["slug"]}.html">{esc(rel["title"])}</a>.') if rel else \
           'Ця сторінка має загальний інформаційний характер і не є юридичною консультацією.'
    repl = {
        "{title}": esc(l["title"]), "{desc}": esc(l["desc"]),
        "{url}": POSLUGY_BASE_URL + l["slug"] + ".html",
        "{ogimg}": BASE_URL + "assets/og-image.jpg",
        "{jsonld}": build_landing_jsonld(l),
        "{h1}": esc(l["h1"]), "{subtitle}": esc(l["subtitle"]), "{intro}": esc(l["intro"]),
        "{situations}": situations, "{benefits}": benefits, "{steps}": steps, "{faq}": faq,
        "{final_title}": esc(l.get("final_title", "Готові допомогти")),
        "{final_text}": esc(l["final_text"]), "{more}": more,
        "{cta}": LANDING_CTA, "{fab}": FAB_HTML,
    }
    page = LANDING_PAGE
    for k, v in repl.items():
        page = page.replace(k, v)
    return page


# ---------- ОКРЕМІ СТОРІНКИ: ПОСЛУГИ ТА КОНТАКТИ ----------

# Спільний каркас сторінки (глибина 1 рівень, шляхи `../`), із тією ж шапкою,
# темою, підвалом і FAB, що й решта сайту. Використовується для poslugy/index.html
# (перелік послуг) та kontakty/index.html (контакти).
PAGE_SHELL = """<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script>document.documentElement.classList.add('js')</script>
  <script defer src="../assets/ga.js?v=5"></script>
  <title>{title} — адвокат Олександр Осадько</title>
  <meta name="description" content="{desc}">
  <link rel="canonical" href="{url}">
  <meta name="robots" content="index, follow">
  <meta property="og:type" content="website">
  <meta property="og:title" content="{title}">
  <meta property="og:description" content="{desc}">
  <meta property="og:url" content="{url}">
  <meta property="og:site_name" content="Адвокат Олександр Осадько">
  <meta property="og:locale" content="uk_UA">
  <meta property="og:image" content="{ogimg}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="{ogimg}">
  <link rel="icon" type="image/png" href="../assets/logo-mark.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="preload" as="style" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,800&family=Inter:wght@300;400;500&display=swap" onload="this.onload=null;this.rel='stylesheet'">
  <noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,800&family=Inter:wght@300;400;500&display=swap"></noscript>
  <link rel="stylesheet" href="../css/style.css?v=83">
  <script>(function(){{try{{var t=localStorage.getItem('theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.setAttribute('data-theme',t);}}catch(e){{}}}})();</script>
  <script defer src="../assets/header-scroll.js?v=15"></script>
  <script defer src="../assets/callback-popup.js?v=20"></script>
  {jsonld}
</head>
<body>
<a class="skip-link" href="#main">Перейти до вмісту</a>

<header class="site-header">
  <div class="container header-inner">
    <a href="../" class="brand">
      <span class="brand-mark"><img src="../assets/logo-mark.png" alt="Логотип адвоката Осадька" width="36" height="36"></span>
      Адвокат Осадько Олександр
    </a>
    <nav class="site-nav" id="nav">
      <a href="../#about">Про мене</a>
      <a href="../poslugy/">Послуги</a>
      <a href="../articles/">Статті</a>
      <a href="../zrazky/">Зразки</a>
      <a href="../kontakty/">Контакти</a>
      <a href="../#contacts" class="nav-cta">Консультація</a>
    </nav>
    <button class="theme-toggle" id="themeToggle" type="button" aria-label="Змінити тему (день/ніч)">
      <svg class="i-moon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
      <svg class="i-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/></svg>
    </button>
    <button class="nav-toggle" id="navToggle" type="button" aria-label="Відкрити меню" aria-expanded="false"><span></span><span></span><span></span></button>
  </div>
</header>

{main}

{fab}

<footer class="site-footer">
  <div class="container footer-inner">
    <span class="brand">
      <span class="brand-mark" style="width:28px;height:28px"><img src="../assets/logo-mark.png" alt="" width="28" height="28" loading="lazy" decoding="async"></span>
      Адвокат Осадько Олександр
    </span>
    <span>© <span id="year"></span> Адвокат Олександр Осадько · <a href="../privacy/">Політика конфіденційності</a></span>
  </div>
</footer>

<script>
  document.getElementById('year').textContent = new Date().getFullYear();
  const io = new IntersectionObserver((es) => {
    es.forEach(x => { if (x.isIntersecting) { x.target.classList.add('in'); io.unobserve(x.target); } });
  }, { threshold: 0.12 });
  document.querySelectorAll('.body-reveal, .reveal').forEach(el => io.observe(el));
</script>
{extra}
</body>
</html>
"""

# Обробник форми заявки + Cloudflare Turnstile — той самий механізм, що на
# головній (релей у Telegram із поштовим fallback). Вставляється лише на
# сторінку «Контакти», де є форма.
CONTACT_SCRIPTS = """<script>
  // NOTIFY_ENDPOINT — релей (Cloudflare Worker), що надсилає заявку в Telegram.
  const NOTIFY_ENDPOINT = "https://osadko-relay.espir3.workers.dev";
  const formStart = Date.now();
  function submitLead(form, okId, source) {
    if (form.elements['company'] && form.elements['company'].value) return; // honeypot
    if (Date.now() - formStart < 2000) return;                              // часова пастка
    const name = form.elements['name'] ? form.elements['name'].value.trim() : '';
    const phone = form.elements['phone'] ? form.elements['phone'].value.trim() : '';
    const message = form.elements['message'] ? form.elements['message'].value.trim() : '';
    const tf = form.querySelector('[name="cf-turnstile-response"]');
    const token = tf ? tf.value : '';
    const ok = document.getElementById(okId);
    const showOk = () => { form.reset(); if (ok) ok.style.display = 'block'; if (window.turnstile) turnstile.reset(); if (window.osadkoConversion) window.osadkoConversion(); };
    const mailFallback = () => {
      const body = 'Джерело: ' + source + '\\nІмʼя: ' + name + '\\nТелефон: ' + phone +
        (message ? '\\nПитання: ' + message : '');
      window.location.href = 'mailto:adv.osadko@gmail.com?subject=' +
        encodeURIComponent(source) + '&body=' + encodeURIComponent(body);
    };
    if (NOTIFY_ENDPOINT) {
      fetch(NOTIFY_ENDPOINT, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, phone, message, source, page: location.href, token })
      }).then(r => { if (!r.ok) throw new Error('bad'); return r; }).then(showOk).catch(mailFallback);
    } else { mailFallback(); }
  }
  const leadForm = document.getElementById('leadForm');
  if (leadForm) leadForm.addEventListener('submit', (e) => {
    e.preventDefault(); submitLead(leadForm, 'formOk', 'Заявка на консультацію (Контакти)');
  });
</script>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>"""

SERVICE_ICON = {
    "rozluchennia": "💍", "st-130-kupap": "🚗", "kryminalnyi-zahyst": "🛡️",
    "pensiine-sotsialne": "🧾", "tsyvilne-pravo": "📄", "tck": "🪖",
}

# Контактний блок — ті самі реальні дані, що на головній (адреса, телефон,
# e-mail, графік, мапа). Єдине джерело — щоб не розходилося.
CONTACT_LINES = """      <div class="contact-item">
        <span class="ci-ico"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 6-9 12-9 12s-9-6-9-12a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg></span>
        <div><span class="label">Адреса офісу</span>
          <a class="value" href="https://maps.google.com/?q=просп.%20Повітряних%20Сил%2C%2020%2F1%2C%20Київ" target="_blank" rel="noopener">03049, м. Київ, просп. Повітряних Сил, 20/1, оф. 2</a></div>
      </div>
      <div class="contact-item">
        <span class="ci-ico"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.13.96.36 1.9.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0122 16.92z"/></svg></span>
        <div><span class="label">Телефон</span>
          <a class="value" href="tel:+380934664443">+38 (093) 466-44-43</a></div>
      </div>
      <div class="contact-item">
        <span class="ci-ico"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg></span>
        <div><span class="label">E-mail</span>
          <a class="value" href="mailto:adv.osadko@gmail.com">adv.osadko@gmail.com</a></div>
      </div>
      <div class="contact-item">
        <span class="ci-ico"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span>
        <div><span class="label">Графік роботи</span>
          <span class="value">Пн–Пт, 9:00–18:00</span></div>
      </div>
      <div class="contact-map">
        <iframe title="Мапа: офіс на просп. Повітряних Сил, 20/1, Київ" loading="lazy" src="https://maps.google.com/maps?q=просп.%20Повітряних%20Сил%2C%2020%2F1%2C%20Київ&hl=uk&z=16&output=embed"></iframe>
      </div>"""


def render_services_index(landings):
    cards = []
    for l in landings:
        ic = SERVICE_ICON.get(l["slug"], "⚖️")
        cards.append(
            f'        <a class="card reveal" href="{l["slug"]}.html">\n'
            f'          <div class="ic">{ic}</div>\n'
            f'          <h3>{esc(l["service"])}</h3>\n'
            f'          <p>{esc(l["subtitle"])}</p>\n'
            f'          <span class="more">Детальніше <span>→</span></span>\n'
            f'        </a>')
    url = POSLUGY_BASE_URL
    jsonld = json.dumps({
        "@context": "https://schema.org", "@type": "CollectionPage",
        "name": "Послуги адвоката Олександра Осадька", "url": url, "inLanguage": "uk",
    }, ensure_ascii=False)
    main = (
        '<main id="main" class="lp">\n'
        '  <section class="lp-hero"><div class="container">\n'
        '    <h1>Послуги адвоката</h1>\n'
        '    <p class="lp-sub">Основні напрями, у яких я допомагаю. Оберіть послугу — на сторінці '
        'детально розписано, коли варто звернутися, що ви отримаєте і як я працюю.</p>\n'
        '  </div></section>\n'
        '  <section class="lp-section container">\n'
        '    <div class="cards">\n' + "\n".join(cards) + '\n    </div>\n'
        '    <p class="section-sub" style="margin-top:28px">Не знайшли свою ситуацію? '
        'Дивіться <a href="../articles/">статті за темами</a> або '
        '<a href="../kontakty/">напишіть мені</a> — розберемо ваш випадок.</p>\n'
        '  </section>\n'
        '</main>')
    return (PAGE_SHELL
            .replace("{title}", "Послуги адвоката").replace("{desc}",
             "Послуги адвоката Олександра Осадька: розлучення, ДТП, кримінальний захист, "
             "трудові спори, спадщина, спори з ТЦК. Детально по кожному напряму.")
            .replace("{url}", url).replace("{ogimg}", BASE_URL + "assets/og-image.jpg")
            .replace("{jsonld}", f'<script type="application/ld+json">{jsonld}</script>')
            .replace("{main}", main).replace("{fab}", FAB_HTML).replace("{extra}", ""))


def render_contacts():
    url = BASE_URL + "kontakty/"
    jsonld = json.dumps({
        "@context": "https://schema.org", "@type": "Attorney",
        "name": "Адвокат Олександр Осадько", "url": BASE_URL,
        "telephone": "+380934664443", "email": "adv.osadko@gmail.com",
        "address": {"@type": "PostalAddress", "streetAddress": "просп. Повітряних Сил, 20/1, оф. 2",
                    "addressLocality": "Київ", "postalCode": "03049", "addressCountry": "UA"},
        "openingHours": "Mo-Fr 09:00-18:00", "areaServed": "UA",
    }, ensure_ascii=False)
    main = (
        '<main id="main">\n'
        '  <h1 class="sr-only">Контакти адвоката Олександра Осадька</h1>\n'
        '  <section class="section" id="contacts"><div class="container">\n'
        '    <div class="contacts-grid">\n'
        '      <div class="contacts-card reveal">\n'
        '        <span class="section-kicker" style="color:var(--blue2)">Контакти</span>\n'
        '        <h2 class="section-title">Обговоримо вашу справу</h2>\n'
        '        <p>Залиште заявку — відповім у найкоротший термін (у середньому за 15 хвилин) '
        'і запропоную зручний час. Перша консультація безкоштовна.</p>\n'
        '        <form class="lead-form" id="leadForm">\n'
        '          <label>Ваше ім\'я\n'
        '            <input name="name" type="text" required placeholder="Ім\'я" autocomplete="name">\n'
        '          </label>\n'
        '          <label>Телефон\n'
        '            <input name="phone" type="tel" required placeholder="+38 (0__) ___-__-__" inputmode="tel" autocomplete="tel">\n'
        '          </label>\n'
        '          <label>Коротко про ситуацію\n'
        '            <textarea name="message" placeholder="Опишіть ваше питання"></textarea>\n'
        '          </label>\n'
        '          <input type="text" name="company" class="hp-field" tabindex="-1" autocomplete="off" aria-hidden="true">\n'
        '          <div class="cf-turnstile" data-sitekey="0x4AAAAAAD1Dx9AvRT4v-VoQ" data-theme="dark" data-size="flexible"></div>\n'
        '          <button class="btn btn-primary" type="submit">Замовити консультацію</button>\n'
        '          <div class="form-ok" id="formOk">Дякую! Заявку надіслано — зв\'яжуся найближчим часом.</div>\n'
        '        </form>\n'
        '      </div>\n'
        '      <div class="contact-lines reveal">\n' + CONTACT_LINES + '\n      </div>\n'
        '    </div>\n'
        '  </div></section>\n'
        '</main>')
    return (PAGE_SHELL
            .replace("{title}", "Контакти").replace("{desc}",
             "Контакти адвоката Олександра Осадька: залиште заявку у формі, телефон, "
             "Telegram, WhatsApp, Viber, e-mail, адреса офісу в Києві та графік роботи.")
            .replace("{url}", url).replace("{ogimg}", BASE_URL + "assets/og-image.jpg")
            .replace("{jsonld}", f'<script type="application/ld+json">{jsonld}</script>')
            .replace("{main}", main).replace("{fab}", FAB_HTML).replace("{extra}", CONTACT_SCRIPTS))


# ---------- ГОЛОВНИЙ ПРОХІД ----------
def main():
    os.makedirs(ART, exist_ok=True)
    arts = load_articles()
    n = len(arts)
    auto_anchors = build_auto_anchors(arts)

    for a in arts:
        page = render_article(a, arts)
        with open(os.path.join(ART, a["slug"] + ".html"), "w", encoding="utf-8") as f:
            f.write(page)

    with open(os.path.join(ART, "index.html"), "w", encoding="utf-8") as f:
        f.write(render_catalog(arts))

    hubs = [c for c in ORDER if any(a["cat"] == c for a in arts)]
    for c in hubs:
        with open(os.path.join(ART, c + ".html"), "w", encoding="utf-8") as f:
            f.write(render_hub(c, arts))

    landings = load_landings()
    if landings:
        os.makedirs(POSLUGY, exist_ok=True)
        for l in landings:
            with open(os.path.join(POSLUGY, l["slug"] + ".html"), "w", encoding="utf-8") as f:
                f.write(render_landing(l))
        # Окрема сторінка «Послуги» (перелік → лендінги).
        with open(os.path.join(POSLUGY, "index.html"), "w", encoding="utf-8") as f:
            f.write(render_services_index(landings))
    # Окрема сторінка «Контакти».
    kontakty_dir = os.path.join(ROOT, "kontakty")
    os.makedirs(kontakty_dir, exist_ok=True)
    with open(os.path.join(kontakty_dir, "index.html"), "w", encoding="utf-8") as f:
        f.write(render_contacts())

    c1, c2 = update_homepage_count(n)
    write_sitemap(arts, landings)
    write_robots()

    missing_slug = [s for s in FEATURED if s not in {a["slug"] for a in arts}]
    print(f"Побудовано статей: {n}; тематичних хабів: {len(hubs)}; лендінгів послуг: {len(landings)}")
    print(f"Авто-анкорів згенеровано: {auto_anchors}; усього анкорів: {len(LINK_TERMS)}")
    print(f"Оновлено лічильник на головній: секція={c1}, кнопка={c2}")
    if missing_slug:
        print(f"⚠ Обрані статті відсутні в даних: {missing_slug}")
    print("Готово: articles/, poslugy/, articles/index.html, index.html, sitemap.xml, robots.txt")


if __name__ == "__main__":
    main()
