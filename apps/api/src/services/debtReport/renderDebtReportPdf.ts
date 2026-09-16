/**
 * Печатный «Реестр задолженности» — A4 альбомный, рабочий документ обзвона.
 *
 * Альбомная ориентация выбрана не из вкуса: у строки девять колонок, и одна из
 * них — пустая графа под запись ручкой. В портрете либо исчезает разбивка
 * «выставлено / оплачено / остаток», либо графа для пометок сужается до
 * бесполезной. Это внутренний документ, а не клиентский, — лист в альбом.
 *
 * Композиция: шапка с организацией и датой среза → полоса итогов → таблица,
 * сгруппированная по клиентам (шапка группы, строки проектов, подытог) →
 * общий итог с суммой прописью → подписи. Клиенты идут по остроте долга,
 * а не по алфавиту: сотрудник звонит сверху вниз.
 */
import fs from "node:fs";
import path from "node:path";

import Decimal from "decimal.js";
import PDFDocument from "pdfkit";

import { rublesInWords } from "../../utils/amountInWords";
import { OVER_AGED_DAYS, type DebtReportDocument, type DebtReportRow } from "./buildDebtReport";

type Doc = InstanceType<typeof PDFDocument>;
type FontSet = { body: string; bold: string };

const MM = 72 / 25.4;
const PAGE = { width: 841.89, height: 595.28 };
const MARGIN = { top: 12 * MM, right: 12 * MM, bottom: 12 * MM, left: 12 * MM };
const CONTENT_W = PAGE.width - MARGIN.left - MARGIN.right;
const RIGHT_X = MARGIN.left + CONTENT_W;
const NBSP = " ";

/** Палитра сметы (renderPdf.ts) — документ из той же семьи. */
const C = {
  ink: "#0f172a",
  ink2: "#334155",
  muted: "#64748b",
  faint: "#94a3b8",
  hairline: "#cbd5e1",
  grid: "#334155",
  accent: "#1e3a8a",
  accentSoft: "#eef2ff",
  accentBorder: "#c7d2fe",
  rose: "#9f1239",
  roseSoft: "#fff1f2",
  amber: "#92400e",
};

const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

// ── Шрифты ──────────────────────────────────────────────────────────────────

function resolveFonts(doc: Doc): FontSet {
  const ttf = process.env.SMETA_PDF_FONT_TTF?.trim();
  const boldTtf = process.env.SMETA_PDF_FONT_BOLD_TTF?.trim();
  if (ttf && fs.existsSync(ttf)) {
    doc.registerFont("DebtBody", ttf);
    doc.registerFont("DebtBold", boldTtf && fs.existsSync(boldTtf) ? boldTtf : ttf);
    return { body: "DebtBody", bold: "DebtBold" };
  }
  // __dirname = .../apps/api/src/services/debtReport → 3 уровня до apps/api
  const root = path.resolve(__dirname, "..", "..", "..");
  const regular = path.join(root, "assets", "fonts", "DejaVuSans.ttf");
  const bold = path.join(root, "assets", "fonts", "DejaVuSans-Bold.ttf");
  if (fs.existsSync(regular)) {
    doc.registerFont("DebtBody", regular);
    doc.registerFont("DebtBold", fs.existsSync(bold) ? bold : regular);
    return { body: "DebtBody", bold: "DebtBold" };
  }
  return { body: "Helvetica", bold: "Helvetica-Bold" };
}

// ── Формат ──────────────────────────────────────────────────────────────────

/** «52 102,00» — разряды неразрывным пробелом, всегда две копейки. */
function money(v: Decimal | string | number): string {
  return new Decimal(v.toString())
    .toDecimalPlaces(2)
    .toNumber()
    .toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function shortDate(d: Date | null): string {
  if (!d) return "—";
  return `${String(d.getDate()).padStart(2, "0")} ${MONTHS_SHORT[d.getMonth()]}${NBSP}${String(d.getFullYear()).slice(2)}`;
}

function fullDate(d: Date): string {
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
}

/** «12 дней» / «1 день» — склонение для колонки просрочки. */
function daysLabel(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n}${NBSP}день`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${n}${NBSP}дня`;
  return `${n}${NBSP}дней`;
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

// ── Колонки ─────────────────────────────────────────────────────────────────

type Align = "left" | "right" | "center";
interface Col {
  key: string;
  title: string;
  w: number;
  align: Align;
}

// Сумма ширин = 269 мм = ширина контента альбомного A4 при полях 12 мм.
const COLS: Col[] = [
  { key: "n", title: "№", w: 8 * MM, align: "left" },
  { key: "date", title: "Дата проекта", w: 19 * MM, align: "left" },
  { key: "project", title: "Проект", w: 66 * MM, align: "left" },
  { key: "final", title: "Выставлено", w: 25 * MM, align: "right" },
  { key: "paid", title: "Оплачено", w: 25 * MM, align: "right" },
  { key: "debt", title: "Остаток", w: 27 * MM, align: "right" },
  { key: "due", title: "Срок", w: 20 * MM, align: "left" },
  { key: "overdue", title: "Просрочка", w: 21 * MM, align: "left" },
  { key: "note", title: "Дата контакта / результат", w: 58 * MM, align: "left" },
];
const PROJECT_COL = 2;
const COL_X = COLS.reduce<number[]>(
  (acc, _c, i) => [...acc, i === 0 ? MARGIN.left : acc[i - 1] + COLS[i - 1].w],
  [],
);
const NOTE_COL = COLS.length - 1;
const CELL_PAD = 3;

interface Ctx {
  doc: Doc;
  fonts: FontSet;
  y: number;
}

function hline(ctx: Ctx, y: number, weight: number, color: string, x1 = MARGIN.left, x2 = RIGHT_X): void {
  ctx.doc.save().lineWidth(weight).strokeColor(color).moveTo(x1, y).lineTo(x2, y).stroke().restore();
}

function eyebrow(ctx: Ctx, text: string, x: number, y: number, w: number, align: Align = "left"): void {
  ctx.doc
    .font(ctx.fonts.body)
    .fontSize(7)
    .fillColor(C.muted)
    .text(text.toUpperCase(), x, y, { width: w, align, lineBreak: false, characterSpacing: 0.5 });
}

/**
 * Однострочный текст «по размеру»: ужимаем кегль, потом режем многоточием.
 * pdfkit при заданной width переносит строку даже с lineBreak:false, а перенос
 * внутри ячейки таблицы ломает сетку.
 */
function oneLine(
  ctx: Ctx,
  text: string,
  x: number,
  y: number,
  w: number,
  opts: { bold?: boolean; maxSize: number; minSize: number; color?: string; align?: Align },
): number {
  const { doc, fonts } = ctx;
  doc.font(opts.bold ? fonts.bold : fonts.body);
  let size = opts.maxSize;
  while (size > opts.minSize && doc.fontSize(size).widthOfString(text) > w) size -= 0.25;
  doc.fontSize(size);
  let out = text;
  while (out.length > 1 && doc.widthOfString(out) > w) out = `${out.slice(0, -2).trimEnd()}…`;
  doc.fillColor(opts.color ?? C.ink).text(out, x, y, { width: w, align: opts.align ?? "left", lineBreak: false });
  // Фактическая ширина — чтобы соседний текст встал вплотную, а не наехал:
  // после усадки кегля замер по исходному размеру врал бы.
  return doc.widthOfString(out);
}

/**
 * Ячейка в две строки с многоточием: названия проектов бывают длиннее любой
 * разумной колонки, а ужимать их до 6 pt — значит напечатать нечитаемое.
 */
function twoLines(ctx: Ctx, text: string, x: number, y: number, w: number, size: number): void {
  const { doc, fonts } = ctx;
  doc.font(fonts.body).fontSize(size).fillColor(C.ink);
  doc.text(text, x, y, { width: w, height: size * 2.35, ellipsis: true, lineGap: 0 });
}

const ROW_H = 22;
const GROUP_H = 19;
const SUBTOTAL_H = 15;

function bottomLimit(): number {
  return PAGE.height - MARGIN.bottom - 14;
}

function drawTableHeader(ctx: Ctx): void {
  const h = 15;
  ctx.doc.save().fillColor(C.accentSoft).rect(MARGIN.left, ctx.y, CONTENT_W, h).fill().restore();
  hline(ctx, ctx.y, 0.75, C.grid);
  COLS.forEach((c, i) => {
    const pad = c.align === "right" ? 0 : CELL_PAD;
    // oneLine, а не eyebrow: «Дата контакта / результат» в 58 мм переносится
    // второй строкой и наезжает на первую строку таблицы.
    oneLine(ctx, c.title.toUpperCase(), COL_X[i] + pad, ctx.y + 4.5, c.w - CELL_PAD - pad, {
      maxSize: 7,
      minSize: 5.5,
      color: C.muted,
      align: c.align,
    });
  });
  hline(ctx, ctx.y + h, 0.75, C.grid);
  ctx.y += h;
}

/** Новая страница + повтор шапки таблицы. Возвращает true, если перенесли. */
function ensureRoom(ctx: Ctx, needed: number): boolean {
  if (ctx.y + needed <= bottomLimit()) return false;
  ctx.doc.addPage();
  ctx.y = MARGIN.top;
  drawTableHeader(ctx);
  return true;
}

// ── Блоки документа ─────────────────────────────────────────────────────────

function drawHeader(ctx: Ctx, doc0: DebtReportDocument): void {
  const { doc, fonts } = ctx;
  const orgBits = [doc0.org.name, doc0.org.phone, doc0.org.email].filter(Boolean).join(`${NBSP}·${NBSP}`);
  if (orgBits) {
    oneLine(ctx, orgBits, MARGIN.left, ctx.y, CONTENT_W, { maxSize: 8.5, minSize: 7, color: C.muted });
    ctx.y += 12;
  }
  doc.font(fonts.bold).fontSize(15).fillColor(C.ink).text(doc0.title, MARGIN.left, ctx.y, {
    width: CONTENT_W * 0.6,
    lineBreak: false,
  });
  doc
    .font(fonts.body)
    .fontSize(9)
    .fillColor(C.ink2)
    .text(`по состоянию на ${fullDate(doc0.asOf)}`, MARGIN.left, ctx.y + 5, {
      width: CONTENT_W,
      align: "right",
      lineBreak: false,
    });
  ctx.y += 20;
  hline(ctx, ctx.y, 2.5, C.accent);
  ctx.y += 10;
}

function drawSummary(ctx: Ctx, doc0: DebtReportDocument): void {
  const { doc, fonts } = ctx;
  const t = doc0.totals;
  const cells: Array<{ label: string; value: string; tone?: string }> = [
    { label: "Клиентов", value: String(t.clientsCount) },
    { label: "Долгов", value: String(t.bookingsCount) },
    { label: "Всего к взысканию", value: `${money(t.total)}${NBSP}₽` },
    { label: "Из них просрочено", value: `${money(t.overdue)}${NBSP}₽`, tone: t.overdue.gt(0) ? C.rose : undefined },
    {
      label: `Старше ${OVER_AGED_DAYS} дней · ${t.overAgedCount}`,
      value: `${money(t.overAged)}${NBSP}₽`,
      tone: t.overAgedCount > 0 ? C.rose : undefined,
    },
  ];
  const h = 30;
  const w = CONTENT_W / cells.length;
  doc.save().fillColor(C.accentSoft).rect(MARGIN.left, ctx.y, CONTENT_W, h).fill().restore();
  hline(ctx, ctx.y, 0.75, C.accentBorder);
  hline(ctx, ctx.y + h, 0.75, C.accentBorder);
  cells.forEach((c, i) => {
    const x = MARGIN.left + i * w;
    if (i > 0) {
      doc.save().lineWidth(0.5).strokeColor(C.accentBorder).moveTo(x, ctx.y + 4).lineTo(x, ctx.y + h - 4).stroke().restore();
    }
    eyebrow(ctx, c.label, x + 8, ctx.y + 5, w - 16);
    oneLine(ctx, c.value, x + 8, ctx.y + 14, w - 16, {
      bold: true,
      maxSize: 11,
      minSize: 8,
      color: c.tone ?? C.ink,
    });
  });
  ctx.y += h + 8;

  if (doc0.note) {
    doc.font(fonts.body).fontSize(9).fillColor(C.ink2);
    const noteH = doc.heightOfString(doc0.note, { width: CONTENT_W - 16 });
    doc.save().lineWidth(0.5).strokeColor(C.hairline).rect(MARGIN.left, ctx.y, CONTENT_W, noteH + 10).stroke().restore();
    doc.text(doc0.note, MARGIN.left + 8, ctx.y + 5, { width: CONTENT_W - 16 });
    ctx.y += noteH + 16;
  }
}

function drawClientHeader(ctx: Ctx, client: DebtReportDocument["clients"][number], includeContacts: boolean): void {
  const { doc, fonts } = ctx;
  doc.save().fillColor("#f1f5f9").rect(MARGIN.left, ctx.y, CONTENT_W, GROUP_H).fill().restore();
  hline(ctx, ctx.y, 0.5, C.hairline);

  const name = client.legalName ?? client.clientName;
  const contacts = includeContacts
    ? [client.phone, client.email].filter(Boolean).join(`${NBSP}·${NBSP}`)
    : "";
  const rightText = `${client.rows.length}${NBSP}${plural(client.rows.length, "долг", "долга", "долгов")}${NBSP}·${NBSP}${money(client.total)}${NBSP}₽`;
  doc.font(fonts.body).fontSize(9);
  const rightW = Math.min(doc.widthOfString(rightText) + 10, CONTENT_W * 0.35);
  const nameW = CONTENT_W - rightW - 12;

  const nameUsed = oneLine(ctx, name, MARGIN.left + CELL_PAD, ctx.y + 5.5, nameW, {
    bold: true,
    maxSize: 10,
    minSize: 8,
  });
  const restW = nameW - nameUsed - 10;
  if (contacts && restW > 40) {
    oneLine(ctx, contacts, MARGIN.left + CELL_PAD + nameUsed + 10, ctx.y + 6.5, restW, {
      maxSize: 8.5,
      minSize: 7,
      color: C.muted,
    });
  }
  oneLine(ctx, rightText, RIGHT_X - rightW - CELL_PAD, ctx.y + 6, rightW, {
    bold: true,
    maxSize: 9,
    minSize: 7.5,
    color: client.overdue.gt(0) ? C.rose : C.ink2,
    align: "right",
  });
  ctx.y += GROUP_H;
  hline(ctx, ctx.y, 0.5, C.hairline);
}

function drawRow(ctx: Ctx, row: DebtReportRow, index: number): void {
  const { doc } = ctx;
  const aged = (row.daysOverdue ?? 0) > OVER_AGED_DAYS;
  if (aged) {
    doc.save().fillColor(C.roseSoft).rect(MARGIN.left, ctx.y, CONTENT_W, ROW_H).fill().restore();
  }

  const projectLabel = row.docNumber ? `${row.projectName}  ·  ${row.docNumber}` : row.projectName;
  const overdueText =
    row.daysOverdue !== null && row.daysOverdue > 0 ? daysLabel(row.daysOverdue) : row.isOverdue ? "просрочен" : "—";

  const cells: Array<{ text: string; bold?: boolean; color?: string }> = [
    { text: String(index) },
    { text: shortDate(row.startDate), color: C.ink2 },
    { text: projectLabel },
    { text: money(row.finalAmount), color: C.ink2 },
    { text: row.amountPaid.gt(0) ? money(row.amountPaid) : "—", color: C.ink2 },
    { text: money(row.outstanding), bold: true, color: row.isOverdue ? C.rose : C.ink },
    { text: shortDate(row.expectedPaymentDate), color: C.ink2 },
    { text: overdueText, bold: aged, color: row.isOverdue ? C.rose : C.faint },
    { text: "" }, // графа для пометок — заполняется ручкой
  ];

  cells.forEach((cell, i) => {
    if (!cell.text) return;
    const col = COLS[i];
    const pad = col.align === "right" ? 0 : CELL_PAD;
    if (i === PROJECT_COL) {
      twoLines(ctx, cell.text, COL_X[i] + pad, ctx.y + 3, col.w - CELL_PAD - pad, 8);
      return;
    }
    oneLine(ctx, cell.text, COL_X[i] + pad, ctx.y + 7, col.w - CELL_PAD - pad, {
      bold: cell.bold,
      maxSize: 8.5,
      minSize: 6.5,
      color: cell.color,
      align: col.align,
    });
  });

  // Линейка в графе пометок — видно, что тут пишут от руки.
  const noteX = COL_X[NOTE_COL] + CELL_PAD;
  hline(ctx, ctx.y + ROW_H - 4.5, 0.4, C.hairline, noteX, RIGHT_X - CELL_PAD);

  ctx.y += ROW_H;
  hline(ctx, ctx.y, 0.4, C.hairline);
}

function drawClientSubtotal(ctx: Ctx, client: DebtReportDocument["clients"][number]): void {
  const label = !client.overdue.gt(0)
    ? "Итого по клиенту"
    : client.overdue.equals(client.total)
      ? "Итого по клиенту · просрочено полностью"
      : `Итого по клиенту · просрочено ${money(client.overdue)}${NBSP}₽`;
  const debtX = COL_X[5];
  oneLine(ctx, label, MARGIN.left + CELL_PAD, ctx.y + 4, debtX - MARGIN.left - CELL_PAD * 2, {
    maxSize: 8.5,
    minSize: 7,
    color: client.overdue.gt(0) ? C.rose : C.muted,
    align: "right",
  });
  oneLine(ctx, `${money(client.total)}${NBSP}₽`, debtX, ctx.y + 3.5, COLS[5].w - CELL_PAD, {
    bold: true,
    maxSize: 9.5,
    minSize: 8,
    align: "right",
  });
  ctx.y += SUBTOTAL_H;
  hline(ctx, ctx.y, 0.75, C.grid);
}

function drawGrandTotal(ctx: Ctx, doc0: DebtReportDocument): void {
  const { doc, fonts } = ctx;
  const bandH = 26;
  if (ctx.y + bandH + 46 > bottomLimit()) {
    doc.addPage();
    ctx.y = MARGIN.top;
  }
  ctx.y += 6;
  const blockW = 120 * MM;
  const x = RIGHT_X - blockW;
  doc.save().fillColor(C.accentSoft).rect(x, ctx.y, blockW, bandH).fill().restore();
  hline(ctx, ctx.y, 0.75, C.accentBorder, x, RIGHT_X);
  hline(ctx, ctx.y + bandH, 0.75, C.accentBorder, x, RIGHT_X);
  doc
    .font(fonts.bold)
    .fontSize(9.5)
    .fillColor(C.accent)
    .text("ВСЕГО К ВЗЫСКАНИЮ", x + 10, ctx.y + 8.5, { lineBreak: false, characterSpacing: 0.5 });
  oneLine(ctx, `${money(doc0.totals.total)}${NBSP}₽`, x, ctx.y + 6.5, blockW - 10, {
    bold: true,
    maxSize: 13,
    minSize: 10,
    color: C.accent,
    align: "right",
  });
  ctx.y += bandH + 8;

  doc.font(fonts.bold).fontSize(9.5).fillColor(C.ink);
  const words = `Сумма прописью: ${rublesInWords(doc0.totals.total.toString())}`;
  const wh = doc.heightOfString(words, { width: CONTENT_W });
  doc.text(words, MARGIN.left, ctx.y, { width: CONTENT_W });
  ctx.y += wh + 10;
}

function drawSignatures(ctx: Ctx): void {
  const { doc, fonts } = ctx;
  if (ctx.y + 40 > bottomLimit()) {
    doc.addPage();
    ctx.y = MARGIN.top;
  }
  const colW = CONTENT_W / 2 - 20;
  const rows: Array<[string, string]> = [
    ["Отчёт составил", "должность, подпись, расшифровка"],
    ["Принял к взысканию", "должность, подпись, расшифровка"],
  ];
  rows.forEach(([label, hint], i) => {
    const x = MARGIN.left + i * (colW + 40);
    doc.font(fonts.body).fontSize(9).fillColor(C.ink2).text(label, x, ctx.y, { width: colW, lineBreak: false });
    const lineX = x + 92;
    const lineW = colW - 92;
    doc.save().lineWidth(0.6).strokeColor(C.ink).moveTo(lineX, ctx.y + 11).lineTo(lineX + lineW, ctx.y + 11).stroke().restore();
    doc.font(fonts.body).fontSize(6.5).fillColor(C.faint).text(hint, lineX, ctx.y + 13.5, { width: lineW, align: "center", lineBreak: false });
  });
  ctx.y += 32;
}

function drawFooters(ctx: Ctx, doc0: DebtReportDocument): void {
  const { doc, fonts } = ctx;
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const fy = PAGE.height - MARGIN.bottom + 4;
    doc.font(fonts.body).fontSize(7).fillColor(C.faint);
    doc.text(`${doc0.title} · по состоянию на ${fullDate(doc0.asOf)}`, MARGIN.left, fy, {
      width: CONTENT_W - 120,
      lineBreak: false,
      ellipsis: true,
    });
    doc.text(`Стр. ${i - range.start + 1} из ${range.count}`, RIGHT_X - 120, fy, {
      width: 120,
      align: "right",
      lineBreak: false,
    });
  }
}

// ── Вход ────────────────────────────────────────────────────────────────────

export async function renderDebtReportPdf(report: DebtReportDocument): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    // Поля НУЛЕВЫЕ, отступы держим сами (MARGIN): при ненулевых полях pdfkit
    // добавляет страницу сам, как только текст доходит до нижнего поля, —
    // параллельно с нашей ручной пагинацией. Получались полупустые листы:
    // 36 строк разъезжались на 9 страниц вместо 4. Тот же приём, что в
    // смете (renderPdf.ts) — там это уже задокументировано.
    margins: { top: 0, right: 0, bottom: 0, left: 0 },
    bufferPages: true,
    autoFirstPage: true,
    info: {
      Title: `${report.title} — ${fullDate(report.asOf)}`,
      Author: report.org.name ?? "Light Rental",
      Subject: "Задолженность клиентов к взысканию",
    },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const ctx: Ctx = { doc, fonts: resolveFonts(doc), y: MARGIN.top };

  drawHeader(ctx, report);
  drawSummary(ctx, report);
  drawTableHeader(ctx);

  let n = 0;
  for (const client of report.clients) {
    // Шапку клиента не отрываем от первой его строки — иначе на разрыве
    // страницы остаётся имя без единого долга под ним.
    ensureRoom(ctx, GROUP_H + ROW_H);
    drawClientHeader(ctx, client, report.includeContacts);
    for (const row of client.rows) {
      ensureRoom(ctx, ROW_H);
      drawRow(ctx, row, ++n);
    }
    ensureRoom(ctx, SUBTOTAL_H);
    drawClientSubtotal(ctx, client);
  }

  drawGrandTotal(ctx, report);
  drawSignatures(ctx);
  drawFooters(ctx, report);

  doc.end();
  return done;
}
