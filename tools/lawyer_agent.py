#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AI-агенти адвоката (бот «Судові засідання та практика»).

  draft   — «✍️ Чернетка документа»: за описом (і, за бажанням, файлом) складає
            процесуальний документ і надсилає DOCX (оформлення за ДСТУ 4163-2020)
            та перелік того, що адвокату треба перевірити.
  analyze — «📄 Аналіз документа»: розбір рішення/ухвали/позову/протоколу:
            суть, що вирішено, строк і порядок оскарження, слабкі місця, що робити.

Завдання воркфлоу отримує лише як id (AGENT_JOB); сам опис і file_id забирає
з Worker (/agent_job, одноразово). Репозиторій публічний, логи відкриті — тому
сюди НЕ друкуємо ні тексту справи, ні ПІБ, ні назв файлів: лише тип і лічильники.

Env: AGENT_JOB, BOT_WORKER_URL, BOT_WORKER_SECRET, TELEGRAM_BOT_TOKEN,
     TELEGRAM_REVIEW_CHAT, ANTHROPIC_API_KEY, AGENT_MODEL (необов'язково).
"""
import base64
import io
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import uuid

TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
CHAT = os.environ.get("TELEGRAM_REVIEW_CHAT", "").strip()
WORKER_URL = os.environ.get("BOT_WORKER_URL", "").strip().rstrip("/")
WORKER_SECRET = os.environ.get("BOT_WORKER_SECRET", "").strip()
MODEL = os.environ.get("AGENT_MODEL", "claude-opus-5-5").strip()
ADVOCATE = "Осадько Олександр Олексійович"

SEP = "===ПЕРЕВІРИТИ==="

DRAFT_SYSTEM = f"""Ти — досвідчений помічник українського адвоката ({ADVOCATE}). Складаєш
ЧЕРНЕТКИ процесуальних документів (позови, апеляційні/касаційні скарги, клопотання,
заяви, заперечення, відзиви, пояснення, скарги у справах про адмінправопорушення тощо)
українською мовою, за чинним законодавством України (ЦПК, ГПК, КАС, КПК, КУпАП, ЦК,
СК, КЗпП тощо) з урахуванням вимог процесуального закону до форми і змісту документа.

Правила:
- Посилайся на конкретні статті (частини, пункти) законів. Позиції Верховного Суду
  наводь лише ті, у яких упевнений (номер справи і дата); якщо не впевнений — не
  вигадуй, а напиши загально «усталена практика ВС» і внеси пункт у перелік перевірки.
- Невідомі дані (ПІБ, адреси, РНОКПП, номери справ, дати, суми) не вигадуй — став
  місце для заповнення у квадратних дужках: [ПІБ позивача], [дата постанови].
- Представник — адвокат {ADVOCATE}; реквізити ордера/договору — у дужках для заповнення.
- Пиши ділово, аргументовано, без води; структуруй мотивувальну частину.

Формат відповіді — ЛИШЕ текст документа простою розміткою, без markdown-зірочок:
  >> рядок         — шапка праворуч (суд, сторони, адреси, номер справи), по рядку
  # НАЗВА          — назва документа (по центру, великими)
  ## Підзаголовок  — назва розділу (по центру)
  - пункт          — пункт переліку («ПРОШУ:», «Додатки:»)
  звичайний рядок  — абзац (по ширині, з відступом)
  _[дата] | О. О. Осадько_ — останній рядок: дата ліворуч, підпис праворуч
Після документа окремим рядком напиши {SEP}, а після нього — 3–8 коротких пунктів
(кожен з «- »): що адвокату треба перевірити або дописати перед поданням
(строки, судовий збір, докази, сумнівні посилання)."""

ANALYZE_SYSTEM = f"""Ти — досвідчений помічник українського адвоката ({ADVOCATE}). Тобі
надсилають процесуальний документ (рішення, постанову, ухвалу, позов, протокол тощо).
Зроби стислий практичний розбір УКРАЇНСЬКОЮ для адвоката, без вступів, за схемою:

<b>📄 Що це</b> — вид документа, суд/орган, дата, номер справи (як у документі).
<b>⚖️ Суть</b> — сторони (процесуальні ролі), предмет, ключові обставини (3–6 речень).
<b>🧾 Що вирішено / чого просять</b> — резолютивна частина або вимоги.
<b>⏰ Строк і порядок оскарження</b> — норма закону, строк, з якого моменту рахується,
  куди і через кого подається; якщо в документі є дата — порахуй кінцеву дату
  (зазнач, що строк треба звірити з датою вручення/отримання).
<b>🎯 Слабкі місця і аргументи</b> — процесуальні порушення, недоведені обставини,
  неправильне застосування норм; з посиланням на статті. Позиції ВС — лише ті, у яких
  упевнений (номер справи); інакше не вигадуй.
<b>✅ Що зробити</b> — 3–5 конкретних кроків.

Якщо адвокат поставив питання — спершу коротко дай відповідь на нього.
Відповідай лише на основі наданого документа; чого в ньому немає — так і пиши.
Формат: Telegram HTML — лише теги <b>, <i>; без markdown, без таблиць."""


def log(msg):
    print(msg, flush=True)


# ─────────────────────────── Worker і Telegram ───────────────────────────
def fetch_job(job_id):
    req = urllib.request.Request(
        f"{WORKER_URL}/agent_job?id={urllib.parse.quote(job_id)}",
        headers={"X-Auth-Token": WORKER_SECRET, "User-Agent": "osadko-agent"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def tg_api(method, data=None, files=None):
    url = f"https://api.telegram.org/bot{TOKEN}/{method}"
    if files:
        boundary = uuid.uuid4().hex
        body = io.BytesIO()
        for k, v in (data or {}).items():
            body.write(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n"
                       f"{v}\r\n".encode("utf-8"))
        for k, (fname, content, ctype) in files.items():
            body.write(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"; "
                       f"filename=\"{fname}\"\r\nContent-Type: {ctype}\r\n\r\n".encode("utf-8"))
            body.write(content)
            body.write(b"\r\n")
        body.write(f"--{boundary}--\r\n".encode())
        req = urllib.request.Request(url, data=body.getvalue(), headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}"})
    else:
        req = urllib.request.Request(url, data=json.dumps(data or {}).encode("utf-8"),
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def tg_text(text):
    """Надсилає HTML-текст частинами до ~3900 символів (ліміт Telegram 4096)."""
    parts, cur = [], ""
    for para in text.split("\n"):
        if len(cur) + len(para) + 1 > 3900 and cur:
            parts.append(cur)
            cur = ""
        cur += para + "\n"
    if cur.strip():
        parts.append(cur)
    for p in parts:
        try:
            r = tg_api("sendMessage", {"chat_id": CHAT, "text": p, "parse_mode": "HTML",
                                       "disable_web_page_preview": True})
            if not r.get("ok"):
                raise RuntimeError("html")
        except Exception:  # зламаний HTML від моделі — надсилаємо як звичайний текст
            tg_api("sendMessage", {"chat_id": CHAT, "text": re.sub(r"<[^>]+>", "", p)})
        time.sleep(0.4)


def tg_download(file_id):
    info = tg_api("getFile", {"file_id": file_id})
    path = info["result"]["file_path"]
    with urllib.request.urlopen(f"https://api.telegram.org/file/bot{TOKEN}/{path}",
                                timeout=60) as r:
        return r.read(), path


# ───────────────────────────── вміст для Claude ─────────────────────────────
def file_blocks(file):
    """Файл із Telegram → блоки повідомлення для Claude (PDF / фото / DOCX / текст)."""
    if not file:
        return []
    raw, path = tg_download(file["file_id"])
    name = (file.get("name") or path).lower()
    mime = (file.get("mime") or "").lower()
    log(f"Файл: {len(raw) // 1024} КБ, тип {mime or name.rsplit('.', 1)[-1]}")
    if name.endswith(".pdf") or mime == "application/pdf":
        return [{"type": "document", "source": {"type": "base64", "media_type": "application/pdf",
                                                "data": base64.b64encode(raw).decode()}}]
    if mime.startswith("image/") or re.search(r"\.(jpe?g|png|webp|gif)$", name):
        mt = mime if mime.startswith("image/") else "image/jpeg"
        if mt == "image/jpg":
            mt = "image/jpeg"
        return [{"type": "image", "source": {"type": "base64", "media_type": mt,
                                             "data": base64.b64encode(raw).decode()}}]
    if name.endswith(".docx"):
        import docx
        d = docx.Document(io.BytesIO(raw))
        text = "\n".join(p.text for p in d.paragraphs)
        return [{"type": "text", "text": "Текст доданого документа (DOCX):\n\n" + text[:150000]}]
    try:
        return [{"type": "text", "text": "Текст доданого файлу:\n\n" + raw.decode("utf-8")[:150000]}]
    except UnicodeDecodeError:
        raise RuntimeError("непідтримуваний тип файлу")


def ask_claude(system, content, max_tokens):
    import anthropic
    client = anthropic.Anthropic()
    r = client.beta.messages.create(
        model=MODEL,
        max_tokens=max_tokens,
        output_config={"effort": "high"},
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        system=system,
        messages=[{"role": "user", "content": content}],
    )
    if r.stop_reason == "refusal":
        raise RuntimeError("модель відмовилась відповідати")
    log(f"Claude: вхід {r.usage.input_tokens} · вихід {r.usage.output_tokens} токенів")
    return "".join(b.text for b in r.content if getattr(b, "type", "") == "text").strip()


# ─────────────────────────── DOCX за ДСТУ 4163-2020 ───────────────────────────
def build_docx(text):
    """Проста розмітка моделі → DOCX: Times New Roman 14, поля 30/10/20/20 мм,
    абзацний відступ 1,25 см, вирівнювання по ширині, міжрядковий 1,15."""
    import docx
    from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT
    from docx.oxml.ns import qn
    from docx.shared import Cm, Pt

    d = docx.Document()
    sec = d.sections[0]
    sec.page_height, sec.page_width = Cm(29.7), Cm(21)
    sec.left_margin, sec.right_margin = Cm(3), Cm(1)
    sec.top_margin, sec.bottom_margin = Cm(2), Cm(2)
    st = d.styles["Normal"]
    st.font.name = "Times New Roman"
    st.font.size = Pt(14)
    st.element.rPr.rFonts.set(qn("w:eastAsia"), "Times New Roman")
    pf = st.paragraph_format
    pf.space_after = Pt(0)
    pf.space_before = Pt(0)
    pf.line_spacing = 1.15

    def para(txt, align=WD_ALIGN_PARAGRAPH.JUSTIFY, indent=True, bold=False,
             left=None, before=0, upper=False):
        p = d.add_paragraph()
        p.alignment = align
        if indent:
            p.paragraph_format.first_line_indent = Cm(1.25)
        if left is not None:
            p.paragraph_format.left_indent = left
        if before:
            p.paragraph_format.space_before = Pt(before)
        run = p.add_run(txt.upper() if upper else txt)
        run.bold = bold
        return p

    for raw in text.splitlines():
        line = raw.rstrip()
        s = line.strip().replace("**", "")
        if not s:
            continue
        if s.startswith(">>"):
            para(s[2:].strip(), WD_ALIGN_PARAGRAPH.LEFT, indent=False, left=Cm(8.5))
        elif s.startswith("## "):
            para(s[3:].strip(), WD_ALIGN_PARAGRAPH.CENTER, indent=False, bold=True, before=6)
        elif s.startswith("# "):
            para(s[2:].strip(), WD_ALIGN_PARAGRAPH.CENTER, indent=False, bold=True,
                 before=12, upper=True)
        elif s.startswith("- "):
            para("– " + s[2:].strip(), indent=True)
        elif s.startswith("_") and s.endswith("_") and len(s) > 2:
            # дата ліворуч, «________ підпис» праворуч (табуляція по правому полю)
            left, _, right = s[1:-1].partition("|")
            p = para(left.strip(" _"), WD_ALIGN_PARAGRAPH.LEFT, indent=False, before=18)
            p.paragraph_format.tab_stops.add_tab_stop(Cm(17), WD_TAB_ALIGNMENT.RIGHT)
            if right.strip(" _"):
                p.add_run("\t____________ " + right.strip(" _"))
        else:
            para(s)
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


def doc_title(text):
    for line in text.splitlines():
        if line.strip().startswith("# "):
            return line.strip()[2:].strip()
    return "Документ"


def safe_filename(title):
    t = re.sub(r"[^\w\s-]", "", title, flags=re.UNICODE).strip()
    t = re.sub(r"\s+", "_", t)[:60] or "Документ"
    return f"Чернетка_{t}_{time.strftime('%d.%m.%Y')}.docx"


# ─────────────────────────────────── main ───────────────────────────────────
def run_draft(job):
    content = file_blocks(job.get("file"))
    content.append({"type": "text", "text": "Завдання адвоката:\n" + (
        job.get("text") or "Склади відповідний процесуальний документ за доданим файлом.")})
    out = ask_claude(DRAFT_SYSTEM, content, 16000)
    doc, _, check = out.partition(SEP)
    title = doc_title(doc)
    data = build_docx(doc)
    cap = f"✍️ <b>Чернетка:</b> {title}\nПеревірте й доповніть перед поданням."
    tg_api("sendDocument", {"chat_id": CHAT, "caption": cap[:1000], "parse_mode": "HTML"},
           files={"document": (safe_filename(title), data,
                               "application/vnd.openxmlformats-officedocument."
                               "wordprocessingml.document")})
    items = [re.sub(r"^[-•]\s*", "", x).strip() for x in check.splitlines() if x.strip()]
    if items:
        esc = lambda x: x.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        tg_text("🔍 <b>Що перевірити:</b>\n" + "\n".join(f"• {esc(x)}" for x in items))
    log(f"Чернетка: {len(doc)} символів, пунктів перевірки: {len(items)}")


def run_analyze(job):
    content = file_blocks(job.get("file"))
    q = (job.get("text") or "").strip()
    content.append({"type": "text", "text": (f"Питання адвоката: {q}" if q else
                                             "Зроби розбір документа.")})
    out = ask_claude(ANALYZE_SYSTEM, content, 6000)
    tg_text(out)
    log(f"Аналіз: {len(out)} символів")


def main():
    job_id = os.environ.get("AGENT_JOB", "").strip()
    if not (job_id and WORKER_URL and WORKER_SECRET and TOKEN and CHAT):
        log("Немає AGENT_JOB або секретів воркера/Telegram.")
        sys.exit(1)
    try:
        job = fetch_job(job_id)
    except Exception as e:
        log(f"Завдання не знайдено або вже виконане: {type(e).__name__}")
        sys.exit(1)
    kind = job.get("kind")
    log(f"Агент: {kind} · опис {len(job.get('text') or '')} символів · "
        f"файл: {'так' if job.get('file') else 'ні'}")
    try:
        if kind == "draft":
            run_draft(job)
        elif kind == "analyze":
            run_analyze(job)
        else:
            raise RuntimeError("невідомий тип завдання")
    except Exception as e:
        # У лог — лише тип помилки (повідомлення може містити фрагменти даних).
        log(f"Помилка: {type(e).__name__}")
        tg_api("sendMessage", {"chat_id": CHAT, "text":
                               f"⚠️ Не вдалося виконати ({type(e).__name__}). "
                               "Спробуйте ще раз або надішліть файл в іншому форматі."})
        sys.exit(1)


if __name__ == "__main__":
    main()
