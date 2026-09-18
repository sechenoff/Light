/**
 * Печатный «Акт инвентаризации» — A4 альбомный (спека §7, мокап
 * final-inventory.html «Акт инвентаризации»).
 *
 * Композиция: шапка (организация слева, «Акт инвентаризации № N» и дата справа,
 * метка «ЧЕРНОВИК» / «ОТМЕНЕНА» посередине) → строка охвата и времени → четыре
 * плитки сводки → раздел 1 «Расхождения» таблицей → раздел 2 «Сверено без
 * расхождений» и раздел 3 «Не посчитано» компактными списками в две колонки →
 * подписи «Пересчитали: …» и «Руководитель».
 *
 * Альбом — как у реестра задолженности: у строки расхождения восемь колонок, и
 * две из них — текст (решение и причина). В портрете они сужаются до
 * нечитаемого.
 *
 * Пагинация ручная, поля в конструкторе PDFDocument НУЛЕВЫЕ: при ненулевых
 * pdfkit сам вставляет страницу, как только текст доходит до нижнего поля, —
 * параллельно с нашей пагинацией, и документ разъезжается на полупустые листы
 * (история — в renderDebtReportPdf.ts и renderBillPdf.ts).
 *
 * Подписи никогда не стоят одни на листе: раздел 3 — всегда последний, и его
 * хвост (или строка «пусто») переносится на новую страницу вместе с ними. Лист
 * с одними подписями оторван от акта — подписанный лист можно подменить.
 */
import fs from "node:fs";
import path from "node:path";

import PDFDocument from "pdfkit";

import {
  actStamp,
  actStatusNotes,
  type ActDecisionState,
  type ActDiscrepancyRow,
  type StockCountActDocument,
} from "./buildStockCountAct";
import {
  fmtCountingWindow,
  fmtDateLong,
  fmtInt,
  fmtShortDateTime,
  fmtTime,
  NBSP,
  pluralRu,
  positionsLabel,
  signed,
} from "./format";

type Doc = InstanceType<typeof PDFDocument>;
type FontSet = { body: string; bold: string };
type Align = "left" | "right" | "center";

const MM = 72 / 25.4;
const PAGE = { width: 841.89, height: 595.28 };
const MARGIN = { top: 12 * MM, right: 12 * MM, bottom: 12 * MM, left: 12 * MM };
const CONTENT_W = PAGE.width - MARGIN.left - MARGIN.right;
const RIGHT_X = MARGIN.left + CONTENT_W;
const SEP = `${NBSP}${NBSP}·${NBSP}${NBSP}`;

/** Палитра документов проката (смета, реестр долгов) — акт из той же семьи. */
const C = {
  ink: "#0f172a",
  ink2: "#334155",
  muted: "#64748b",
  faint: "#94a3b8",
  hairline: "#cbd5e1",
  accent: "#1e3a8a",
  rose: "#9f1239",
  roseSoft: "#fff1f2",
  emerald: "#047857",
  amber: "#92400e",
  amberSoft: "#fffbeb",
  amberBorder: "#fcd34d",
  slateSoft: "#f8fafc",
};

// ── Шрифты ──────────────────────────────────────────────────────────────────

function resolveFonts(doc: Doc): FontSet {
  const ttf = process.env.SMETA_PDF_FONT_TTF?.trim();
  const boldTtf = process.env.SMETA_PDF_FONT_BOLD_TTF?.trim();
  if (ttf && fs.existsSync(ttf)) {
    doc.registerFont("ActBody", ttf);
    doc.registerFont("ActBold", boldTtf && fs.existsSync(boldTtf) ? boldTtf : ttf);
    return { body: "ActBody", bold: "ActBold" };
  }
  // __dirname = .../apps/api/src/services/stockCount/act → 4 уровня до apps/api
  // (в сборке — .../apps/api/dist/services/stockCount/act, тоже 4).
  const root = path.resolve(__dirname, "..", "..", "..", "..");
  const regular = path.join(root, "assets", "fonts", "DejaVuSans.ttf");
  const bold = path.join(root, "assets", "fonts", "DejaVuSans-Bold.ttf");
  if (fs.existsSync(regular)) {
    doc.registerFont("ActBody", regular);
    doc.registerFont("ActBold", fs.existsSync(bold) ? bold : regular);
    return { body: "ActBody", bold: "ActBold" };
  }
  return { body: "Helvetica", bold: "Helvetica-Bold" };
}

// ── Контекст и примитивы ────────────────────────────────────────────────────

interface Ctx {
  doc: Doc;
  fonts: FontSet;
  y: number;
  /**
   * Сколько содержательных блоков (строк, плиток, строк «пусто») легло на каждую
   * страницу. Подписи содержимым НЕ считаются: лист, на котором только они, —
   * пустой лист, оторванный от акта.
   */
  pageBlocks: number[];
}

function bottomLimit(): number {
  return PAGE.height - MARGIN.bottom - 14;
}

function newPage(ctx: Ctx): void {
  ctx.doc.addPage();
  ctx.y = MARGIN.top;
  ctx.pageBlocks.push(0);
}

function markContent(ctx: Ctx): void {
  ctx.pageBlocks[ctx.pageBlocks.length - 1] += 1;
}

function hline(ctx: Ctx, y: number, weight: number, color: string, x1 = MARGIN.left, x2 = RIGHT_X): void {
  ctx.doc.save().lineWidth(weight).strokeColor(color).moveTo(x1, y).lineTo(x2, y).stroke().restore();
}

/**
 * Однострочный текст «по размеру»: ужимаем кегль, потом режем многоточием.
 * pdfkit при заданной width переносит строку даже с lineBreak:false, а перенос
 * в ячейке таблицы ломает сетку. Возвращает фактическую ширину.
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
  return doc.widthOfString(out);
}

interface Block {
  text: string;
  size: number;
  bold?: boolean;
  maxLines: number;
}

/** Высота текста в несколько строк — не больше maxLines строк. */
function measureBlock(ctx: Ctx, block: Block, w: number): number {
  const { doc, fonts } = ctx;
  doc.font(block.bold ? fonts.bold : fonts.body).fontSize(block.size);
  const lineH = doc.currentLineHeight(true);
  const full = doc.heightOfString(block.text, { width: w, lineGap: 0 });
  return Math.min(full, lineH * block.maxLines);
}

/** Текст в несколько строк с многоточием на последней уместившейся. */
function drawBlock(ctx: Ctx, block: Block, x: number, y: number, w: number, color: string): void {
  const { doc, fonts } = ctx;
  doc.font(block.bold ? fonts.bold : fonts.body).fontSize(block.size).fillColor(color);
  const lineH = doc.currentLineHeight(true);
  doc.text(block.text, x, y, { width: w, height: lineH * block.maxLines + 1, ellipsis: true, lineGap: 0 });
}

// ── Шапка, сводка ───────────────────────────────────────────────────────────

function drawStamp(ctx: Ctx, stamp: string, top: number): number {
  const { doc, fonts } = ctx;
  const color = stamp === "ОТМЕНЕНА" ? C.rose : C.amber;
  const w = 150;
  const h = 26;
  const x = MARGIN.left + (CONTENT_W - w) / 2;
  doc.save().lineWidth(1.5).strokeColor(color).rect(x, top, w, h).stroke().restore();
  doc
    .font(fonts.bold)
    .fontSize(14)
    .fillColor(color)
    .text(stamp, x, top + 6, { width: w, align: "center", lineBreak: false, characterSpacing: 2 });
  return top + h;
}

function drawHeader(ctx: Ctx, act: StockCountActDocument): void {
  const top = ctx.y;
  // Левая колонка заканчивается раньше метки «ЧЕРНОВИК» (она по центру, 150 pt).
  const leftW = CONTENT_W * 0.38;
  let leftY = top;
  if (act.org.name) {
    oneLine(ctx, act.org.name, MARGIN.left, leftY, leftW, { bold: true, maxSize: 12, minSize: 9 });
    leftY += 15;
  }
  // Реквизиты: строка «ИНН · телефон · почта», адрес — отдельной строкой, чтобы
  // перенос не рвал его посередине. Пустое поле просто не печатается.
  const phone = act.org.phone ? act.org.phone.replace(/ /g, NBSP) : null;
  const contacts = [act.org.inn ? `ИНН${NBSP}${act.org.inn}` : null, phone, act.org.email]
    .filter((v): v is string => Boolean(v))
    .join(SEP);
  if (contacts) {
    oneLine(ctx, contacts, MARGIN.left, leftY, leftW, { maxSize: 8, minSize: 6.5, color: C.ink2 });
    leftY += 11;
  }
  if (act.org.address) {
    const block: Block = { text: act.org.address, size: 8, maxLines: 2 };
    const h = measureBlock(ctx, block, leftW);
    drawBlock(ctx, block, MARGIN.left, leftY, leftW, C.ink2);
    leftY += h;
  }

  const rightW = CONTENT_W * 0.36;
  const rightX = RIGHT_X - rightW;
  oneLine(ctx, `Акт инвентаризации № ${act.number}`, rightX, top, rightW, {
    bold: true,
    maxSize: 15,
    minSize: 11,
    align: "right",
  });
  const dateLine = act.isDraft
    ? `на ${fmtDateLong(act.docDate)}, ${fmtTime(act.docDate)}`
    : `от ${fmtDateLong(act.docDate)}`;
  oneLine(ctx, dateLine, rightX, top + 19, rightW, { maxSize: 9.5, minSize: 8, color: C.ink2, align: "right" });
  const rightY = top + 32;

  const stamp = actStamp(act);
  const stampY = stamp ? drawStamp(ctx, stamp, top) : top;

  ctx.y = Math.max(leftY, rightY, stampY) + 4;
  hline(ctx, ctx.y, 1.5, C.ink);
  ctx.y += 7;
}

function metaItems(act: StockCountActDocument): string[] {
  const items = [`Охват: ${act.scope.label}`];
  if (act.counters.length > 0 && act.countingFrom && act.countingTo) {
    items.push(`Считали: ${act.counters.join(", ")} · ${fmtCountingWindow(act.countingFrom, act.countingTo, act.docDate)}`);
  } else {
    items.push("Считали: ещё никто");
  }
  items.push(`Начата: ${fmtShortDateTime(act.startedAt)} · ${act.startedBy}`);
  if (act.status === "CLOSED" && act.closedAt) {
    items.push(`Завершена: ${fmtShortDateTime(act.closedAt)}${act.closedBy ? ` · ${act.closedBy}` : ""}`);
  } else if (act.status === "CANCELLED" && act.cancelledAt) {
    items.push(`Отменена: ${fmtShortDateTime(act.cancelledAt)}`);
  } else {
    items.push(`Черновик сформирован: ${fmtShortDateTime(act.generatedAt)}`);
  }
  return items;
}

function drawMeta(ctx: Ctx, act: StockCountActDocument): void {
  const { doc, fonts } = ctx;
  const text = metaItems(act).join(`${NBSP}${NBSP}${NBSP}${NBSP}`);
  doc.font(fonts.body).fontSize(9).fillColor(C.ink2);
  const h = doc.heightOfString(text, { width: CONTENT_W, lineGap: 1 });
  doc.text(text, MARGIN.left, ctx.y, { width: CONTENT_W, lineGap: 1 });
  ctx.y += h + 8;
}

function drawSummary(ctx: Ctx, act: StockCountActDocument): void {
  const { doc } = ctx;
  const s = act.summary;
  // «19 / 47 шт» — позиций / штук; пустое расхождение — просто «0».
  const posQty = (positions: number, qty: number) =>
    positions > 0 ? `${fmtInt(positions)} / ${fmtInt(qty)}${NBSP}шт` : "0";
  const boxes: Array<{ value: string; label: string; color?: string }> = [
    {
      value: `${fmtInt(s.counted)} из ${fmtInt(s.lines)}`,
      label: s.uncounted > 0 ? `посчитано${SEP}${fmtInt(s.uncounted)} не посчитано` : "позиций посчитано",
    },
    { value: fmtInt(s.matched), label: "сошлось" },
    {
      value: posQty(s.shortagePositions, s.shortageQty),
      label: "недостача",
      color: s.shortagePositions > 0 ? C.rose : undefined,
    },
    {
      value: posQty(s.surplusPositions, s.surplusQty),
      label: "излишек",
      color: s.surplusPositions > 0 ? C.emerald : undefined,
    },
  ];
  const gap = 6;
  const w = (CONTENT_W - gap * (boxes.length - 1)) / boxes.length;
  const h = 32;
  boxes.forEach((b, i) => {
    const x = MARGIN.left + i * (w + gap);
    doc.save().lineWidth(0.6).strokeColor(C.hairline).rect(x, ctx.y, w, h).stroke().restore();
    oneLine(ctx, b.value, x + 7, ctx.y + 5, w - 14, { bold: true, maxSize: 12.5, minSize: 9, color: b.color });
    oneLine(ctx, b.label, x + 7, ctx.y + 20, w - 14, { maxSize: 8, minSize: 6.5, color: C.muted });
  });
  ctx.y += h + 8;
  markContent(ctx);
}

function drawNotes(ctx: Ctx, act: StockCountActDocument): void {
  const { doc, fonts } = ctx;
  const notes = actStatusNotes(act);
  if (notes.length === 0) return;
  const warn = act.status !== "CLOSED";
  const text = notes.join(" ");
  doc.font(fonts.body).fontSize(8.5);
  const h = doc.heightOfString(text, { width: CONTENT_W - 16 }) + 8;
  doc
    .save()
    .fillColor(warn ? C.amberSoft : C.slateSoft)
    .rect(MARGIN.left, ctx.y, CONTENT_W, h)
    .fill()
    .restore();
  doc
    .save()
    .fillColor(warn ? C.amberBorder : C.hairline)
    .rect(MARGIN.left, ctx.y, 2.5, h)
    .fill()
    .restore();
  doc.fillColor(warn ? C.amber : C.ink2).text(text, MARGIN.left + 9, ctx.y + 4, { width: CONTENT_W - 16 });
  ctx.y += h + 8;
}

// ── Заголовки разделов ──────────────────────────────────────────────────────

const SECTION_TITLE_H = 18;

function drawSectionTitle(ctx: Ctx, title: string, aside: string | null): void {
  const { doc, fonts } = ctx;
  doc.font(fonts.bold).fontSize(10.5).fillColor(C.ink);
  const used = oneLine(ctx, title, MARGIN.left, ctx.y, CONTENT_W * 0.6, { bold: true, maxSize: 10.5, minSize: 9 });
  if (aside) {
    oneLine(ctx, aside, MARGIN.left + used + 10, ctx.y + 1.5, CONTENT_W - used - 10, {
      maxSize: 8.5,
      minSize: 7,
      color: C.muted,
    });
  }
  ctx.y += SECTION_TITLE_H;
}

interface Col {
  title: string;
  w: number;
  align: Align;
}

const HEADER_H = 14;
const CELL_PAD = 3;

function drawColumnHeader(ctx: Ctx, cols: Col[], x0: number): void {
  let x = x0;
  const width = cols.reduce((s, c) => s + c.w, 0);
  for (const c of cols) {
    const pad = c.align === "right" ? 0 : CELL_PAD;
    oneLine(ctx, c.title.toUpperCase(), x + pad, ctx.y + 3, c.w - CELL_PAD - pad, {
      maxSize: 7,
      minSize: 5.5,
      color: C.ink2,
      align: c.align,
    });
    x += c.w;
  }
  hline(ctx, ctx.y + HEADER_H - 2, 0.75, C.ink, x0, x0 + width);
}

// ── Раздел 1: расхождения ───────────────────────────────────────────────────

// Сумма ширин = 273 мм = ширина контента альбомного A4 (297 мм) при полях 12 мм.
const DISC_COLS: Col[] = [
  { title: "№", w: 8 * MM, align: "left" },
  { title: "Наименование", w: 66 * MM, align: "left" },
  { title: "Категория", w: 30 * MM, align: "left" },
  { title: "По учёту", w: 17 * MM, align: "right" },
  { title: "Факт", w: 14 * MM, align: "right" },
  { title: "Разн.", w: 14 * MM, align: "right" },
  { title: "Решение", w: 68 * MM, align: "left" },
  { title: "Причина / примечание", w: 56 * MM, align: "left" },
];
const DISC_X = DISC_COLS.reduce<number[]>(
  (acc, _c, i) => [...acc, i === 0 ? MARGIN.left : acc[i - 1] + DISC_COLS[i - 1].w],
  [],
);
const ROW_PAD_Y = 3.5;
const ROW_MIN_H = 16;

const DECISION_COLOR: Record<ActDecisionState, string> = {
  applied: C.ink,
  planned: C.ink2,
  none: C.amber,
  skipped: C.muted,
};

function cellW(i: number): number {
  const c = DISC_COLS[i];
  return c.w - CELL_PAD - (c.align === "right" ? 0 : CELL_PAD);
}

function discBlocks(row: ActDiscrepancyRow): { name: Block; decision: Block; note: Block | null } {
  return {
    name: { text: row.name, size: 8.5, maxLines: 2 },
    decision: { text: row.decisionLabel, size: 8.5, bold: row.decisionState === "none", maxLines: 2 },
    note: row.note ? { text: row.note, size: 8, maxLines: 3 } : null,
  };
}

function discRowHeight(ctx: Ctx, row: ActDiscrepancyRow): number {
  const b = discBlocks(row);
  const heights = [
    measureBlock(ctx, b.name, cellW(1)),
    measureBlock(ctx, b.decision, cellW(6)),
    b.note ? measureBlock(ctx, b.note, cellW(7)) : 0,
  ];
  return Math.max(ROW_MIN_H, Math.max(...heights) + ROW_PAD_Y * 2);
}

function drawDiscRow(ctx: Ctx, row: ActDiscrepancyRow, index: number, h: number): void {
  const b = discBlocks(row);
  const textY = ctx.y + ROW_PAD_Y;
  const x = (i: number) => DISC_X[i] + (DISC_COLS[i].align === "right" ? 0 : CELL_PAD);
  const num = (i: number, text: string, color = C.ink2, bold = false) =>
    oneLine(ctx, text, x(i), textY, cellW(i), { maxSize: 8.5, minSize: 6.5, color, align: "right", bold });

  oneLine(ctx, String(index), x(0), textY, cellW(0), { maxSize: 8.5, minSize: 6.5, color: C.muted });
  drawBlock(ctx, b.name, x(1), textY, cellW(1), C.ink);
  oneLine(ctx, row.category, x(2), textY + 0.5, cellW(2), { maxSize: 8, minSize: 6.5, color: C.ink2 });
  num(3, fmtInt(row.expected));
  num(4, fmtInt(row.counted));
  num(5, signed(row.diff), row.diff < 0 ? C.rose : C.emerald, true);
  drawBlock(ctx, b.decision, x(6), textY, cellW(6), DECISION_COLOR[row.decisionState]);
  if (b.note) drawBlock(ctx, b.note, x(7), textY + 0.5, cellW(7), C.ink2);

  ctx.y += h;
  hline(ctx, ctx.y, 0.4, C.hairline);
  markContent(ctx);
}

function discAside(act: StockCountActDocument): string | null {
  const s = act.summary;
  const parts: string[] = [];
  if (s.shortagePositions > 0) {
    parts.push(
      `недостача: ${positionsLabel(s.shortagePositions)}, ${fmtInt(s.shortageQty)}${NBSP}шт`,
    );
  }
  if (s.surplusPositions > 0) {
    parts.push(`излишек: ${positionsLabel(s.surplusPositions)}, ${fmtInt(s.surplusQty)}${NBSP}шт`);
  }
  return parts.length > 0 ? parts.join(SEP) : null;
}

function drawEmptyLine(ctx: Ctx, text: string): void {
  oneLine(ctx, text, MARGIN.left, ctx.y, CONTENT_W, { maxSize: 9, minSize: 8, color: C.muted });
  ctx.y += 16;
  markContent(ctx);
}

function drawDiscrepancies(ctx: Ctx, act: StockCountActDocument): void {
  const title = "1. Расхождения";
  const rows = act.discrepancies;
  if (rows.length === 0) {
    if (ctx.y + SECTION_TITLE_H + 16 > bottomLimit()) newPage(ctx);
    drawSectionTitle(ctx, title, null);
    drawEmptyLine(
      ctx,
      act.summary.counted > 0 ? "Расхождений нет — всё посчитанное сошлось с учётом." : "Ещё ничего не посчитано.",
    );
    ctx.y += 8;
    return;
  }
  const aside = discAside(act);
  const firstH = discRowHeight(ctx, rows[0]);
  if (ctx.y + SECTION_TITLE_H + HEADER_H + firstH > bottomLimit()) newPage(ctx);
  drawSectionTitle(ctx, title, aside);
  drawColumnHeader(ctx, DISC_COLS, MARGIN.left);
  ctx.y += HEADER_H;

  rows.forEach((row, i) => {
    const h = discRowHeight(ctx, row);
    if (ctx.y + h > bottomLimit()) {
      newPage(ctx);
      drawSectionTitle(ctx, `${title} (продолжение)`, null);
      drawColumnHeader(ctx, DISC_COLS, MARGIN.left);
      ctx.y += HEADER_H;
    }
    drawDiscRow(ctx, row, i + 1, h);
  });
  ctx.y += 12;
}

// ── Разделы 2 и 3: компактные списки в две колонки ──────────────────────────

const LIST_GAP = 8 * MM;
const HALF_W = (CONTENT_W - LIST_GAP) / 2;
const LIST_ROW_H = 13;

interface ListSpec {
  title: string;
  emptyText: string;
  cols: Col[];
  rows: string[][];
}

function drawListRow(ctx: Ctx, cols: Col[], x0: number, y: number, cells: string[]): void {
  let x = x0;
  cols.forEach((c, i) => {
    const pad = c.align === "right" ? 0 : CELL_PAD;
    // Кегль почти не ужимаем: в плотном списке строка в 6,5 pt среди строк в 8 pt
    // выглядит опечаткой — длинное название просто режется многоточием.
    oneLine(ctx, cells[i] ?? "", x + pad, y + 2.5, c.w - CELL_PAD - pad, {
      maxSize: 8,
      minSize: 7.5,
      color: i === 0 ? C.muted : i === 1 ? C.ink : C.ink2,
      align: c.align,
    });
    x += c.w;
  });
  hline(ctx, y + LIST_ROW_H, 0.3, C.hairline, x0, x0 + HALF_W);
}

/**
 * Сколько строк списка класть в колонку, если список начинается с y.
 *
 * keepWith > 0 — высота того, что обязано встать на одну страницу с хвостом
 * списка (подписи). Если последний кусок списка влезает, а подписи за ним уже
 * нет, на следующую страницу уходят KEEP_WITH_SIGNATURES строк: подписи всегда
 * стоят под содержимым акта, а не одни на пустом листе.
 *
 * < 1 — «начинай раздел с новой страницы».
 */
function listPerColumn(y: number, remaining: number, keepWith: number): number {
  const avail = Math.floor((bottomLimit() - y - HEADER_H) / LIST_ROW_H);
  let per = Math.min(avail, Math.ceil(remaining / 2));
  if (keepWith > 0 && per * 2 >= remaining) {
    // Последний кусок списка: за ним — отступ раздела (12) и подписи.
    const room = Math.floor((bottomLimit() - y - HEADER_H - 12 - keepWith) / LIST_ROW_H);
    if (per > room) per = Math.min(per, Math.floor((remaining - KEEP_WITH_SIGNATURES) / 2));
  }
  return per;
}

/**
 * Список «столбиками»: на каждой странице левая колонка заполняется сверху
 * вниз, затем правая — читается как газета, а не зигзагом. На последней
 * странице остаток делится пополам, чтобы колонки были одной высоты.
 *
 * keepWith — см. listPerColumn: высота подписей, если раздел последний.
 */
function drawTwoColumnList(ctx: Ctx, spec: ListSpec, aside: string | null, keepWith = 0): void {
  if (spec.rows.length === 0) {
    // Заголовок, строка «пусто», отступ — и, если раздел последний, подписи.
    if (ctx.y + SECTION_TITLE_H + 16 + 8 + keepWith > bottomLimit()) newPage(ctx);
    drawSectionTitle(ctx, spec.title, aside);
    drawEmptyLine(ctx, spec.emptyText);
    ctx.y += 8;
    return;
  }
  if (listPerColumn(ctx.y + SECTION_TITLE_H, spec.rows.length, keepWith) < 1) newPage(ctx);
  drawSectionTitle(ctx, spec.title, aside);

  let i = 0;
  let first = true;
  while (i < spec.rows.length) {
    if (!first) {
      newPage(ctx);
      drawSectionTitle(ctx, `${spec.title} (продолжение)`, null);
    }
    first = false;
    const remaining = spec.rows.length - i;
    const perColumn = Math.max(1, listPerColumn(ctx.y, remaining, keepWith));
    const right = remaining > perColumn;
    drawColumnHeader(ctx, spec.cols, MARGIN.left);
    if (right) drawColumnHeader(ctx, spec.cols, MARGIN.left + HALF_W + LIST_GAP);
    ctx.y += HEADER_H;
    for (let r = 0; r < perColumn; r++) {
      const y = ctx.y + r * LIST_ROW_H;
      const left = spec.rows[i + r];
      if (left) drawListRow(ctx, spec.cols, MARGIN.left, y, left);
      const rightRow = spec.rows[i + perColumn + r];
      if (rightRow) drawListRow(ctx, spec.cols, MARGIN.left + HALF_W + LIST_GAP, y, rightRow);
    }
    ctx.y += perColumn * LIST_ROW_H;
    markContent(ctx);
    i += Math.min(remaining, perColumn * 2);
  }
  ctx.y += 12;
}

const MATCHED_COLS: Col[] = [
  { title: "№", w: 8 * MM, align: "left" },
  { title: "Наименование", w: 74 * MM, align: "left" },
  { title: "Категория", w: 34 * MM, align: "left" },
  { title: "Кол-во", w: HALF_W - 116 * MM, align: "right" },
];

const UNCOUNTED_COLS: Col[] = [
  { title: "№", w: 8 * MM, align: "left" },
  { title: "Наименование", w: 82 * MM, align: "left" },
  { title: "Категория", w: HALF_W - 90 * MM, align: "left" },
];

function drawMatched(ctx: Ctx, act: StockCountActDocument): void {
  const qty = act.matched.reduce((s, r) => s + r.qty, 0);
  drawTwoColumnList(
    ctx,
    {
      title: "2. Сверено без расхождений",
      emptyText: "Сошедшихся позиций нет.",
      cols: MATCHED_COLS,
      rows: act.matched.map((r, i) => [String(i + 1), r.name, r.category, fmtInt(r.qty)]),
    },
    act.matched.length > 0 ? `${positionsLabel(act.matched.length)}, ${fmtInt(qty)}${NBSP}шт` : null,
  );
}

/** Раздел 3 — всегда последний: его хвост стоит на одной странице с подписями. */
function drawUncounted(ctx: Ctx, act: StockCountActDocument): void {
  drawTwoColumnList(
    ctx,
    {
      title: "3. Не посчитано",
      emptyText: "Все позиции охвата посчитаны.",
      cols: UNCOUNTED_COLS,
      rows: act.uncounted.map((r, i) => [String(i + 1), r.name, r.category]),
    },
    act.uncounted.length > 0
      ? `${positionsLabel(act.uncounted.length)} ${pluralRu(act.uncounted.length, "осталась", "остались", "остались")} не ${pluralRu(act.uncounted.length, "сверена", "сверены", "сверены")}`
      : null,
    signaturesHeight(act),
  );
}

// ── Подписи и колонтитул ────────────────────────────────────────────────────

const SIG_PER_ROW = 3;
const SIG_GAP = 24;
const SIG_ROW_H = 40;
/** Сколько строк раздела 3 уходит на новую страницу вместе с подписями. */
const KEEP_WITH_SIGNATURES = 2;

/** Высота блока подписей: отступ + ряды по SIG_PER_ROW ячеек (счётчики + руководитель). */
function signaturesHeight(act: StockCountActDocument): number {
  const cells = Math.max(1, act.counters.length) + 1;
  return 8 + Math.ceil(cells / SIG_PER_ROW) * SIG_ROW_H;
}

function drawSignatures(ctx: Ctx, act: StockCountActDocument): void {
  const { doc, fonts } = ctx;
  const cells: Array<{ label: string; hint: string }> = [
    ...(act.counters.length > 0 ? act.counters : [""]).map((name) => ({
      label: name ? `Пересчитали: ${name}` : "Пересчитали:",
      hint: name ? "подпись" : "подпись, расшифровка",
    })),
    { label: "Руководитель", hint: "подпись, расшифровка" },
  ];
  const rows = Math.ceil(cells.length / SIG_PER_ROW);
  // Страховка: раздел 3 уже оставил место под подписи (keepWith), сюда
  // попадать не должны — иначе подписи окажутся одни на новом листе.
  if (ctx.y + signaturesHeight(act) > bottomLimit()) newPage(ctx);
  ctx.y += 8;
  const w = (CONTENT_W - SIG_GAP * (SIG_PER_ROW - 1)) / SIG_PER_ROW;
  cells.forEach((cell, i) => {
    const x = MARGIN.left + (i % SIG_PER_ROW) * (w + SIG_GAP);
    const y = ctx.y + Math.floor(i / SIG_PER_ROW) * SIG_ROW_H;
    oneLine(ctx, cell.label, x, y, w, { maxSize: 9, minSize: 7.5, color: C.ink2 });
    doc.save().lineWidth(0.6).strokeColor(C.ink).moveTo(x, y + 24).lineTo(x + w, y + 24).stroke().restore();
    doc
      .font(fonts.body)
      .fontSize(6.5)
      .fillColor(C.faint)
      .text(cell.hint, x, y + 26.5, { width: w, align: "center", lineBreak: false });
  });
  // Подписи — не содержимое: лист, на котором только они, считается пустым.
  ctx.y += rows * SIG_ROW_H;
}

function drawFooters(ctx: Ctx, act: StockCountActDocument): void {
  const { doc, fonts } = ctx;
  const range = doc.bufferedPageRange();
  const status = act.status === "OPEN" ? " · черновик" : act.status === "CANCELLED" ? " · отменена" : "";
  const left = `Акт инвентаризации № ${act.number}${status} · время московское`;
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const fy = PAGE.height - MARGIN.bottom + 4;
    doc.font(fonts.body).fontSize(7).fillColor(C.faint);
    doc.text(left, MARGIN.left, fy, { width: CONTENT_W - 120, lineBreak: false });
    doc.text(`Стр. ${i - range.start + 1} из ${range.count}`, RIGHT_X - 120, fy, {
      width: 120,
      align: "right",
      lineBreak: false,
    });
  }
}

// ── Вход ────────────────────────────────────────────────────────────────────

export interface ActPdfResult {
  buffer: Buffer;
  /**
   * Содержательных блоков на каждой странице (подписи не в счёт) — пустых
   * страниц и страниц с одними подписями быть не должно.
   */
  pageBlocks: number[];
}

/** PDF акта + раскладка по страницам (для проверки пагинации в тестах). */
export async function renderStockCountActPdfDetailed(act: StockCountActDocument): Promise<ActPdfResult> {
  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    // Поля НУЛЕВЫЕ, отступы держим сами (MARGIN) — см. шапку файла.
    margins: { top: 0, right: 0, bottom: 0, left: 0 },
    bufferPages: true,
    autoFirstPage: true,
    info: {
      Title: `Акт инвентаризации № ${act.number}`,
      Author: act.org.name ?? "Light Rental",
      Subject: "Инвентаризация склада",
    },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const ctx: Ctx = { doc, fonts: resolveFonts(doc), y: MARGIN.top, pageBlocks: [0] };

  drawHeader(ctx, act);
  drawMeta(ctx, act);
  drawSummary(ctx, act);
  drawNotes(ctx, act);
  drawDiscrepancies(ctx, act);
  drawMatched(ctx, act);
  drawUncounted(ctx, act);
  drawSignatures(ctx, act);
  drawFooters(ctx, act);

  doc.end();
  return { buffer: await done, pageBlocks: ctx.pageBlocks };
}

export async function renderStockCountActPdf(act: StockCountActDocument): Promise<Buffer> {
  return (await renderStockCountActPdfDetailed(act)).buffer;
}
