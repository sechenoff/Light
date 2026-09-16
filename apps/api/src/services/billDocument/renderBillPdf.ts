/**
 * Печатная форма «Счёт на оплату» — A4 портрет, в типичном случае один лист.
 *
 * Композиция — концепт A дизайн-панели («Канон 1С, доведённый»,
 * docs/mockups/bill-invoice/concept-A.html) с правками судей: бухгалтерия
 * контрагента ищет глазами знакомые зоны, поэтому состав и порядок блоков —
 * как в 1С, а типографика — из семьи сметы проекта (renderPdf.ts).
 *
 *  1. банк-блок «как в платёжном поручении» (сетка тёмными линиями 0,5 pt);
 *  2. заголовок «Счёт на оплату № … от … г.» + акцентная линия 2,5 pt и
 *     микро-сводка «К оплате · Без НДС · Оплатить до»;
 *  3. Поставщик / Покупатель / Основание строками «метка → значение»;
 *  4. таблица позиций без вертикальных клеток и зебры;
 *  5. итоги правым столбиком: Итого → пометка о налоге → плашка «ВСЕГО К ОПЛАТЕ»;
 *  6. «Сумма прописью: …» полужирно;
 *  7. зона оплаты: назначение платежа в рамке (копируемая строка ≤ 210 знаков)
 *     + срок оплаты слева, QR по ГОСТ Р 56042-2014 30×30 мм справа;
 *  8. подпись ИП + «М.П.».
 *
 * Ровно один набор банковских реквизитов на листе (реквизиты банка покупателя
 * не печатаются), пустые поля не печатаются, весь текст — копируемый.
 * Смысл несут вес и размер, а не цвет: документ переживает ч/б-копию.
 */
import fs from "node:fs";
import path from "node:path";

import bwipjs from "bwip-js";
import Decimal from "decimal.js";
import PDFDocument from "pdfkit";

import type { BillWithLines } from "../billService";
import { parsePayerSnapshot, parseSellerSnapshot, type PayerSnapshot, type SellerSnapshot } from "../billService";
import { rublesInWords } from "../../utils/amountInWords";
import { toMoscowDateString } from "../../utils/moscowDate";

type Doc = InstanceType<typeof PDFDocument>;
type FontSet = { body: string; bold: string };

const MM = 72 / 25.4;
const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = { top: 14 * MM, right: 16 * MM, bottom: 14 * MM, left: 16 * MM };
const CONTENT_W = PAGE.width - MARGIN.left - MARGIN.right; // ≈ 178 мм
const RIGHT_X = MARGIN.left + CONTENT_W;
const NBSP = " ";

/** Палитра сметы (renderPdf.ts): синий — только линия-акцент и тинт плашки. */
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
};

const MONTHS_GENITIVE = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

const DEFAULT_TAX_NOTE = "Без НДС";
const PURPOSE_MAX = 210;

// ── Шрифты — тот же способ, что у сметы ─────────────────────────────────────

function apiPackageRoot(): string {
  // __dirname = .../apps/api/src/services/billDocument → 3 уровня до apps/api
  return path.resolve(__dirname, "..", "..", "..");
}

function resolveFonts(doc: Doc): FontSet {
  const ttf = process.env.SMETA_PDF_FONT_TTF?.trim();
  const boldTtf = process.env.SMETA_PDF_FONT_BOLD_TTF?.trim();
  if (ttf && fs.existsSync(ttf)) {
    doc.registerFont("BillBody", ttf);
    doc.registerFont("BillBold", boldTtf && fs.existsSync(boldTtf) ? boldTtf : ttf);
    return { body: "BillBody", bold: "BillBold" };
  }
  const root = apiPackageRoot();
  const regular = path.join(root, "assets", "fonts", "DejaVuSans.ttf");
  const bold = path.join(root, "assets", "fonts", "DejaVuSans-Bold.ttf");
  if (fs.existsSync(regular)) {
    doc.registerFont("BillBody", regular);
    doc.registerFont("BillBold", fs.existsSync(bold) ? bold : regular);
    return { body: "BillBody", bold: "BillBold" };
  }
  return { body: "Helvetica", bold: "Helvetica-Bold" };
}

// ── Форматирование ──────────────────────────────────────────────────────────

/** «52 102,00» — разряды через NBSP, десятичная запятая, всегда две копейки. */
export function money(value: Decimal | string | number): string {
  const n = new Decimal(value.toString()).toDecimalPlaces(2).toNumber();
  return n.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const rub = (value: Decimal | string | number): string => `${money(value)}${NBSP}руб.`;

function qty(value: Decimal | string): string {
  const d = new Decimal(value.toString());
  return d.isInteger() ? d.toString() : d.toDecimalPlaces(3).toString().replace(".", ",");
}

/** «16 сентября 2026 г.» — как в шапке бланка. */
export function longDate(date: Date): string {
  const [y, m, d] = toMoscowDateString(date).split("-").map(Number);
  return `${d} ${MONTHS_GENITIVE[m - 1]} ${y} г.`;
}

function shortDate(date: Date): string {
  const [y, m, d] = toMoscowDateString(date).split("-");
  return `${d}.${m}.${y}`;
}

/** Плательщик: юрлицо — по реквизитам, физлицо — просто имя. Банк покупателя не печатается. */
function payerTitle(p: PayerSnapshot): string {
  const parts = [p.legalName ?? p.name];
  if (p.inn) parts.push(`ИНН${NBSP}${p.inn}`);
  if (p.kpp) parts.push(`КПП${NBSP}${p.kpp}`);
  if (p.ogrn) parts.push(`${p.ogrn.length === 15 ? "ОГРНИП" : "ОГРН"}${NBSP}${p.ogrn}`);
  const address = p.legalAddress ?? p.postalAddress;
  if (address) parts.push(address);
  const contact = [p.phone ? `тел.:${NBSP}${p.phone}` : null, p.email].filter(Boolean).join(", ");
  if (contact) parts.push(contact);
  return parts.join(", ");
}

function sellerTitle(s: SellerSnapshot): string {
  const parts = [s.name];
  if (s.inn) parts.push(`ИНН${NBSP}${s.inn}`);
  if (s.kpp) parts.push(`КПП${NBSP}${s.kpp}`);
  if (s.ogrn) parts.push(`${s.ogrn.length === 15 ? "ОГРНИП" : "ОГРН"}${NBSP}${s.ogrn}`);
  if (s.address) parts.push(s.address);
  const contact = [s.phone ? `тел.:${NBSP}${s.phone}` : null, s.email].filter(Boolean).join(", ");
  if (contact) parts.push(contact);
  return parts.join(", ");
}

/**
 * Назначение платежа — готовая строка, которую бухгалтер копирует в платёжку:
 * ≤ 210 знаков (лимит поля 24 платёжного поручения и Purpose в ГОСТ-QR).
 * «Без НДС» — всегда в конце: иначе банк-клиент дописывает «в т. ч. НДС 20 %».
 */
export function paymentPurpose(bill: BillWithLines, taxNote: string | null): string {
  const base = `Оплата по счёту № ${bill.number} от ${shortDate(bill.date)}`;
  const firstLine = bill.lines[0]?.name?.trim();
  const lower = (v: string) => `${v.charAt(0).toLowerCase()}${v.slice(1)}`;
  const basis = bill.basis?.trim();
  // Одна позиция — «за <позицию>»; несколько — ссылка на основание (смету/договор).
  const subject =
    bill.lines.length === 1 && firstLine ? ` за ${lower(firstLine)}` : basis ? `, ${lower(basis)}` : "";
  const tax = taxNote && !/без ндс/i.test(taxNote) ? taxNote : DEFAULT_TAX_NOTE;
  const full = `${base}${subject}. ${tax}`;
  if (full.length <= PURPOSE_MAX) return full;
  // Длинное название позиции режем, пометку о налоге сохраняем.
  const room = PURPOSE_MAX - base.length - tax.length - 4;
  const cut = room > 20 ? `${subject.slice(0, room).trimEnd()}…` : "";
  return `${base}${cut}. ${tax}`;
}

/**
 * Строка для QR по ГОСТ Р 56042-2014: «ST0001» + «2» (UTF-8) + обязательные
 * поля в каноническом порядке, затем дополнительные. Сумма — в копейках.
 * Без счёта/БИК/банка QR бессмыслен — тогда его просто нет; пустые поля не
 * пишем (банк ругается на пустые значения). КПП у ИП нет — не передаём.
 */
export function buildGostPaymentQr(bill: BillWithLines, seller: SellerSnapshot, purpose: string): string | null {
  if (!seller.rschet || !seller.bankBik || !seller.bankName) return null;
  const sanitize = (v: string, max: number) => v.replace(/[|\r\n]+/g, " ").trim().slice(0, max);
  const fields: Array<[string, string | null, number]> = [
    ["Name", seller.name, 160],
    ["PersonalAcc", seller.rschet, 20],
    ["BankName", seller.bankName, 45],
    ["BIC", seller.bankBik, 9],
    ["CorrespAcc", seller.kschet, 20],
    ["PayeeINN", seller.inn, 12],
    ["KPP", seller.kpp, 9],
    ["Sum", new Decimal(bill.total.toString()).mul(100).toDecimalPlaces(0).toString(), 18],
    ["Purpose", purpose, PURPOSE_MAX],
  ];
  const body = fields
    .filter((f): f is [string, string, number] => Boolean(f[1]))
    .map(([k, v, max]) => `${k}=${sanitize(v, max)}`)
    .join("|");
  return `ST00012|${body}`;
}

async function renderQrPng(text: string): Promise<Buffer | null> {
  try {
    // bwip-js кодирует `text` в UTF-8 сам (binarytext=false) — ровно то, что
    // требует ST00012. Коррекция M — стандарт платёжных QR; `eclevel` — опция
    // BWIPP, в d.ts bwip-js её нет, отсюда расширенный тип.
    const opts = { bcid: "qrcode", text, scale: 6, eclevel: "M" } as Parameters<typeof bwipjs.toBuffer>[0];
    const png = await bwipjs.toBuffer(opts);
    return Buffer.isBuffer(png) ? png : null;
  } catch {
    return null;
  }
}

// ── Рисование ───────────────────────────────────────────────────────────────

interface Ctx {
  doc: Doc;
  fonts: FontSet;
  y: number;
}

function hline(ctx: Ctx, y: number, weight: number, color: string, x1 = MARGIN.left, x2 = RIGHT_X): void {
  ctx.doc.save().lineWidth(weight).strokeColor(color).moveTo(x1, y).lineTo(x2, y).stroke().restore();
}

function ensure(ctx: Ctx, needed: number): boolean {
  if (ctx.y + needed <= PAGE.height - MARGIN.bottom) return false;
  ctx.doc.addPage();
  ctx.y = MARGIN.top;
  return true;
}

function eyebrow(ctx: Ctx, text: string, x: number, y: number, width: number, align: "left" | "right" | "center" = "left"): void {
  ctx.doc.font(ctx.fonts.body).fontSize(7.5).fillColor(C.muted)
    .text(text.toUpperCase(), x, y, { width, align, lineBreak: false, characterSpacing: 0.6 });
}

/**
 * Однострочный текст «по размеру»: уменьшаем кегль до minSize, дальше режем с
 * многоточием. pdfkit при заданной width переносит строку даже с lineBreak:false,
 * а перенос в ячейке банк-блока или в колонке «Ед.» ломает сетку.
 */
function fitOneLine(
  ctx: Ctx,
  text: string,
  width: number,
  opts: { bold?: boolean; maxSize: number; minSize: number; color?: string },
): { text: string; size: number } {
  const { doc, fonts } = ctx;
  doc.font(opts.bold ? fonts.bold : fonts.body);
  let size = opts.maxSize;
  while (size > opts.minSize && doc.fontSize(size).widthOfString(text) > width) size -= 0.5;
  doc.fontSize(size);
  let out = text;
  while (out.length > 1 && doc.widthOfString(out) > width) out = `${out.slice(0, -2).trimEnd()}…`;
  doc.fillColor(opts.color ?? C.ink);
  return { text: out, size };
}

function oneLine(
  ctx: Ctx,
  text: string,
  x: number,
  y: number,
  width: number,
  opts: { bold?: boolean; maxSize: number; minSize: number; color?: string; align?: "left" | "right" | "center" },
): number {
  const fitted = fitOneLine(ctx, text, width, opts);
  ctx.doc.text(fitted.text, x, y, { width, lineBreak: false, align: opts.align ?? "left" });
  return fitted.size;
}

/** Банк-блок «как в платёжном поручении»: имя ~100 мм | метка 16 мм | значение 62 мм. */
function drawBankBlock(ctx: Ctx, seller: SellerSnapshot): void {
  const { doc, fonts } = ctx;
  const x0 = MARGIN.left;
  const nameW = 100 * MM;
  const labelW = 16 * MM;
  const valueW = CONTENT_W - nameW - labelW;
  const xLabel = x0 + nameW;
  const xValue = xLabel + labelW;
  const row = 17;
  const top = ctx.y;

  const cell = (x: number, y: number, w: number, h: number) => {
    doc.save().lineWidth(0.5).strokeColor(C.grid).rect(x, y, w, h).stroke().restore();
  };
  const caption = (text: string, x: number, y: number, w: number) => {
    doc.font(fonts.body).fontSize(6.5).fillColor(C.muted).text(text, x + 4, y + 2.5, { width: w - 8, lineBreak: false });
  };
  const label = (text: string, x: number, y: number) => {
    doc.font(fonts.body).fontSize(8).fillColor(C.ink2).text(text, x + 4, y + 5, { width: labelW - 8, lineBreak: false });
  };
  const account = (text: string, y: number, bold = false) => {
    // Номера счетов — без пробелов: копируются в банк-клиент одним куском.
    doc.font(bold ? fonts.bold : fonts.body).fontSize(10).fillColor(C.ink)
      .text(text, xValue + 4, y + 4.5, { width: valueW - 8, lineBreak: false, characterSpacing: 0 });
  };

  // Ярус 1: банк получателя (2 строки) | БИК / Сч. №
  cell(x0, top, nameW, row * 2);
  oneLine(ctx, seller.bankName ?? "—", x0 + 4, top + 5, nameW - 8, { bold: true, maxSize: 9.5, minSize: 7.5 });
  caption("Банк получателя", x0, top + row + 1, nameW);
  cell(xLabel, top, labelW, row);
  cell(xValue, top, valueW, row);
  label("БИК", xLabel, top);
  account(seller.bankBik ?? "—", top);
  cell(xLabel, top + row, labelW, row);
  cell(xValue, top + row, valueW, row);
  label("Сч. №", xLabel, top + row);
  account(seller.kschet ?? "—", top + row);

  // Ярус 2: ИНН | КПП ; получатель (2 строки) | Сч. № (3 строки)
  const y2 = top + row * 2;
  const half = nameW / 2;
  cell(x0, y2, half, row);
  cell(x0 + half, y2, nameW - half, row);
  doc.font(fonts.body).fontSize(8.5).fillColor(C.ink).text(`ИНН${NBSP}${seller.inn ?? "—"}`, x0 + 4, y2 + 4.5, { width: half - 8, lineBreak: false });
  doc.text(`КПП${NBSP}${seller.kpp ?? ""}`, x0 + half + 4, y2 + 4.5, { width: nameW - half - 8, lineBreak: false });
  cell(x0, y2 + row, nameW, row * 2);
  oneLine(ctx, seller.name, x0 + 4, y2 + row + 5, nameW - 8, { bold: true, maxSize: 9, minSize: 7 });
  caption("Получатель", x0, y2 + row * 2 + 1, nameW);
  cell(xLabel, y2, labelW, row * 3);
  cell(xValue, y2, valueW, row * 3);
  label("Сч. №", xLabel, y2);
  account(seller.rschet ?? "—", y2, true);

  ctx.y = y2 + row * 3 + 6 * MM;
}

function drawTitle(ctx: Ctx, bill: BillWithLines, taxNote: string): void {
  const { doc, fonts } = ctx;
  const title = `Счёт на оплату № ${bill.number} от ${longDate(bill.date)}`;
  const summaryParts = [`К оплате ${rub(bill.total)}`, taxNote];
  if (bill.dueDate) summaryParts.push(`Оплатить до ${shortDate(bill.dueDate)}`);
  const summary = summaryParts.join(`${NBSP}·${NBSP}`);

  doc.font(fonts.bold).fontSize(14);
  const titleW = doc.widthOfString(title);
  doc.font(fonts.body).fontSize(8.5);
  const summaryW = doc.widthOfString(summary);
  const sameAxis = titleW + summaryW + 14 <= CONTENT_W;

  doc.font(fonts.bold).fontSize(14).fillColor(C.ink).text(title, MARGIN.left, ctx.y, { width: CONTENT_W, lineBreak: false });
  if (sameAxis) {
    doc.font(fonts.body).fontSize(8.5).fillColor(C.ink2)
      .text(summary, MARGIN.left, ctx.y + 5, { width: CONTENT_W, align: "right", lineBreak: false });
    ctx.y += 19;
  } else {
    ctx.y += 19;
    doc.font(fonts.body).fontSize(8.5).fillColor(C.ink2).text(summary, MARGIN.left, ctx.y, { width: CONTENT_W, lineBreak: false });
    ctx.y += 12;
  }
  hline(ctx, ctx.y + 2, 2.5, C.accent);
  ctx.y += 12;
}

/** Строка «метка → значение» во всю ширину (как в 1С), метка — eyebrow в колонке 40 мм. */
function drawMetaRow(ctx: Ctx, labelText: string, value: string, bold: boolean): void {
  const { doc, fonts } = ctx;
  const labelW = 46 * MM;
  doc.font(bold ? fonts.bold : fonts.body).fontSize(9.5);
  const h = doc.heightOfString(value, { width: CONTENT_W - labelW });
  ensure(ctx, h + 6);
  eyebrow(ctx, labelText, MARGIN.left, ctx.y + 1.5, labelW - 6);
  doc.font(bold ? fonts.bold : fonts.body).fontSize(9.5).fillColor(C.ink)
    .text(value, MARGIN.left + labelW, ctx.y, { width: CONTENT_W - labelW, lineGap: 1.5 });
  ctx.y += Math.max(h, 11) + 5;
}

// Таблица: № 8 | наименование 96 | кол-во 14 | ед. 14 | цена 23 | сумма 23 мм
const COLS: Array<{ title: string; w: number; align: "left" | "right" }> = [
  { title: "№", w: 8 * MM, align: "left" },
  { title: "Товары (работы, услуги)", w: 92 * MM, align: "left" },
  { title: "Кол-во", w: 14 * MM, align: "right" },
  { title: "Ед.", w: 18 * MM, align: "right" },
  { title: "Цена", w: 23 * MM, align: "right" },
  { title: "Сумма", w: 23 * MM, align: "right" },
];
const COL_X = COLS.reduce<number[]>((acc, c, i) => [...acc, i === 0 ? MARGIN.left : acc[i - 1] + COLS[i - 1].w], []);
const CELL_PAD = 4;

function drawTableHeader(ctx: Ctx): void {
  const h = 16;
  hline(ctx, ctx.y, 0.75, C.grid);
  COLS.forEach((c, i) => {
    const pad = i === 1 ? 0 : CELL_PAD;
    eyebrow(ctx, c.title, COL_X[i] + (c.align === "left" ? pad : 0), ctx.y + 4.5, c.w - pad, c.align);
  });
  hline(ctx, ctx.y + h, 0.5, C.grid);
  ctx.y += h;
}

function drawTable(ctx: Ctx, bill: BillWithLines): void {
  const { doc, fonts } = ctx;
  drawTableHeader(ctx);
  for (const line of bill.lines) {
    doc.font(fonts.body).fontSize(9);
    const nameH = doc.heightOfString(line.name, { width: COLS[1].w - CELL_PAD, lineGap: 1 });
    const rowH = Math.max(19, nameH + 9);
    if (ctx.y + rowH > PAGE.height - MARGIN.bottom - 14) {
      doc.addPage();
      ctx.y = MARGIN.top;
      drawTableHeader(ctx);
    }
    const cells = [String(line.position), line.name, qty(line.quantity), line.unit, money(line.price), money(line.sum)];
    cells.forEach((text, i) => {
      const col = COLS[i];
      if (i === 1) {
        doc.font(fonts.body).fontSize(9).fillColor(C.ink)
          .text(text, COL_X[i], ctx.y + 4.5, { width: col.w - CELL_PAD, align: "left", lineGap: 1 });
        return;
      }
      oneLine(ctx, text, COL_X[i] + (col.align === "left" ? CELL_PAD : 0), ctx.y + 4.5, col.w - CELL_PAD, {
        maxSize: 9, minSize: 7, color: C.ink2, align: col.align,
      });
    });
    ctx.y += rowH;
    hline(ctx, ctx.y, 0.4, C.hairline);
  }
}

function drawTotals(ctx: Ctx, bill: BillWithLines, taxNote: string): void {
  const { doc, fonts } = ctx;
  const blockW = 106 * MM;
  const valueW = 42 * MM;
  const x = RIGHT_X - blockW;
  const xValue = RIGHT_X - valueW;
  const bandH = 26;
  ensure(ctx, 15 * 2 + bandH + 40);
  ctx.y += 7;

  // «Всего наименований…» — слева, на одной оси с итогами (экономит строку).
  const count = bill.lines.length;
  oneLine(ctx, `Всего наименований${NBSP}${count}, на сумму ${rub(bill.total)}`, MARGIN.left, ctx.y + 1, x - MARGIN.left - 10, {
    maxSize: 8.5, minSize: 7, color: C.ink2,
  });

  doc.font(fonts.body).fontSize(9.5).fillColor(C.ink2);
  doc.text("Итого:", x, ctx.y, { width: blockW - valueW - 8, align: "right", lineBreak: false });
  doc.fillColor(C.ink).text(money(bill.total), xValue, ctx.y, { width: valueW, align: "right", lineBreak: false });
  ctx.y += 15;
  // Пометка о налоге — не мельче основного текста: спрятанное «без НДС»
  // заставляет плательщика подставить НДС в платёжку.
  oneLine(ctx, taxNote, x, ctx.y, blockW, { maxSize: 9.5, minSize: 8, color: C.ink2, align: "right" });
  ctx.y += 17;

  // Плашка — самый крупный числовой элемент документа; тинт ≤ 8 %, в ч/б — светло-серый.
  doc.save().fillColor(C.accentSoft).rect(x, ctx.y, blockW, bandH).fill().restore();
  hline(ctx, ctx.y, 0.75, C.accentBorder, x, RIGHT_X);
  hline(ctx, ctx.y + bandH, 0.75, C.accentBorder, x, RIGHT_X);
  doc.font(fonts.bold).fontSize(9.5).fillColor(C.accent)
    .text("ВСЕГО К ОПЛАТЕ", x + 10, ctx.y + 8.5, { lineBreak: false, characterSpacing: 0.5 });
  doc.font(fonts.bold).fontSize(13).fillColor(C.accent)
    .text(rub(bill.total), x, ctx.y + 6.5, { width: blockW - 10, align: "right", lineBreak: false });
  ctx.y += bandH + 10;

  // Сумма прописью — полная ширина, полужирно, без скобок.
  doc.font(fonts.bold).fontSize(10).fillColor(C.ink);
  const words = `Сумма прописью: ${rublesInWords(bill.total.toString())}`;
  const wh = doc.heightOfString(words, { width: CONTENT_W });
  ensure(ctx, wh + 8);
  doc.text(words, MARGIN.left, ctx.y, { width: CONTENT_W });
  ctx.y += wh + 6;
  hline(ctx, ctx.y, 0.5, C.hairline);
  ctx.y += 10;
}

async function drawPaymentZone(
  ctx: Ctx,
  bill: BillWithLines,
  purpose: string,
  taxNote: string,
  qrText: string | null,
): Promise<void> {
  const { doc, fonts } = ctx;
  const qrSize = 30 * MM;
  const quiet = 2 * MM;
  const gap = 8 * MM;
  const leftW = qrText ? CONTENT_W - qrSize - quiet * 2 - gap : CONTENT_W;
  const png = qrText ? await renderQrPng(qrText) : null;

  // Высота левой колонки — заранее, чтобы блок не разорвался на страницы.
  doc.font(fonts.body).fontSize(9);
  const purposeH = doc.heightOfString(purpose, { width: leftW - 14, lineGap: 1.5 });
  let leftH = 11 + purposeH + 12 + 3 + 14 + 14;
  if (bill.dueDate) leftH += 26;
  if (bill.notes) {
    doc.font(fonts.body).fontSize(8.5);
    leftH += doc.heightOfString(bill.notes, { width: leftW }) + 8;
  }
  const rightH = png ? qrSize + quiet * 2 + 22 : 0;
  // Подпись резервируем ВМЕСТЕ с зоной оплаты: по отдельности у длинного счёта
  // зона влезала в остаток страницы, а подпись — уже нет, и последний лист
  // выходил пустым с одной строчкой «ИП ____ (Фамилия)».
  ensure(ctx, Math.max(leftH, rightH) + 8 + SIGNATURE_H);
  const top = ctx.y;

  // Левая колонка
  let y = top;
  eyebrow(ctx, "Назначение платежа", MARGIN.left, y, leftW);
  y += 11;
  const frameH = purposeH + 12;
  doc.save().lineWidth(0.5).strokeColor(C.grid).rect(MARGIN.left, y, leftW, frameH).stroke().restore();
  doc.font(fonts.body).fontSize(9).fillColor(C.ink).text(purpose, MARGIN.left + 7, y + 6, { width: leftW - 14, lineGap: 1.5 });
  y += frameH + 3;
  doc.font(fonts.body).fontSize(7.5).fillColor(C.muted)
    .text("Скопируйте в поле «Назначение платежа» платёжного поручения", MARGIN.left, y, { width: leftW, lineBreak: false });
  y += 14;
  if (bill.dueDate) {
    eyebrow(ctx, "Оплатить до", MARGIN.left, y, leftW);
    y += 10;
    doc.font(fonts.bold).fontSize(9.5).fillColor(C.ink).text(longDate(bill.dueDate), MARGIN.left, y, { width: leftW, lineBreak: false });
    y += 16;
  }
  doc.font(fonts.body).fontSize(7.5).fillColor(C.muted)
    .text(`В платёжном поручении укажите пометку «${taxNote}».`, MARGIN.left, y, { width: leftW, lineBreak: false, ellipsis: true });
  y += 14;
  if (bill.notes) {
    doc.font(fonts.body).fontSize(8.5).fillColor(C.ink2).text(bill.notes, MARGIN.left, y, { width: leftW });
    y = doc.y + 8;
  }

  // Правая колонка: QR с тихой зоной и подписью
  if (png) {
    const qx = RIGHT_X - qrSize - quiet;
    doc.save().fillColor("#ffffff").rect(qx - quiet, top - quiet, qrSize + quiet * 2, qrSize + quiet * 2).fill().restore();
    doc.image(png, qx, top, { width: qrSize, height: qrSize });
    doc.font(fonts.bold).fontSize(8).fillColor(C.ink)
      .text("Оплатить по QR", qx - quiet - 6, top + qrSize + quiet + 2, { width: qrSize + quiet * 2 + 12, align: "center", lineBreak: false });
    doc.font(fonts.body).fontSize(6.5).fillColor(C.muted)
      .text("сканируйте в приложении банка", qx - quiet - 6, top + qrSize + quiet + 12, { width: qrSize + quiet * 2 + 12, align: "center", lineBreak: false });
  }

  ctx.y = Math.max(y, top + rightH) + 10;
}

/** Высота блока подписи — её же резервирует зона оплаты выше. */
const SIGNATURE_H = 34;

function drawSignature(ctx: Ctx, seller: SellerSnapshot): void {
  const { doc, fonts } = ctx;
  ensure(ctx, SIGNATURE_H);
  const title = seller.signerTitle ?? "Индивидуальный предприниматель";
  doc.font(fonts.bold).fontSize(9.5).fillColor(C.ink);
  const titleW = Math.min(doc.widthOfString(title), CONTENT_W * 0.45);
  const lineX = MARGIN.left + titleW + 10;
  const lineW = 52 * MM;
  const nameX = lineX + lineW + 8;
  doc.text(title, MARGIN.left, ctx.y, { width: titleW + 2, lineBreak: false, ellipsis: true });
  doc.save().lineWidth(0.6).strokeColor(C.ink).moveTo(lineX, ctx.y + 11).lineTo(lineX + lineW, ctx.y + 11).stroke().restore();
  const signer = seller.signerName ?? seller.name;
  doc.font(fonts.body).fontSize(9.5).fillColor(C.ink)
    .text(`(${signer})`, nameX, ctx.y, { width: RIGHT_X - nameX - 30, lineBreak: false, ellipsis: true });
  // Печать у ИП необязательна — «М.П.» мелко справа, как в бланке.
  doc.font(fonts.body).fontSize(7.5).fillColor(C.muted).text("М.П.", RIGHT_X - 26, ctx.y + 1, { width: 26, align: "right", lineBreak: false });
  ctx.y += 24;
}

/** Футер «Стр. N из M» — только при переносе на второй лист, по правилу сметы. */
function drawFooters(ctx: Ctx, bill: BillWithLines): void {
  const { doc, fonts } = ctx;
  const range = doc.bufferedPageRange();
  if (range.count <= 1) return;
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const fy = PAGE.height - MARGIN.bottom + 6;
    doc.font(fonts.body).fontSize(7.5).fillColor(C.faint);
    doc.text(`Счёт на оплату № ${bill.number} от ${shortDate(bill.date)}`, MARGIN.left, fy, { width: CONTENT_W - 100, lineBreak: false });
    doc.text(`Стр. ${i - range.start + 1} из ${range.count}`, RIGHT_X - 100, fy, { width: 100, align: "right", lineBreak: false });
  }
}

// ── Вход ────────────────────────────────────────────────────────────────────

export async function renderBillPdf(bill: BillWithLines): Promise<Buffer> {
  const seller = parseSellerSnapshot(bill.sellerSnapshot);
  const payer = parsePayerSnapshot(bill.payerSnapshot);
  const taxNote = bill.taxNote?.trim() || DEFAULT_TAX_NOTE;
  const purpose = paymentPurpose(bill, bill.taxNote);
  const qrText = buildGostPaymentQr(bill, seller, purpose);

  const doc = new PDFDocument({
    size: "A4",
    // Поля НУЛЕВЫЕ, отступы держим сами (MARGIN): при ненулевых полях pdfkit
    // добавляет страницу сам, как только текст доходит до нижнего поля, —
    // параллельно с нашей ручной пагинацией. Получались полупустые листы:
    // 36 строк разъезжались на 9 страниц вместо 4. Тот же приём, что в
    // смете (renderPdf.ts) — там это уже задокументировано.
    margins: { top: 0, right: 0, bottom: 0, left: 0 },
    bufferPages: true,
    autoFirstPage: true,
    info: {
      Title: `Счёт на оплату № ${bill.number} от ${shortDate(bill.date)}`,
      Author: seller.name,
      Subject: payer.legalName ?? payer.name,
    },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const ctx: Ctx = { doc, fonts: resolveFonts(doc), y: MARGIN.top };

  drawBankBlock(ctx, seller);
  drawTitle(ctx, bill, taxNote);
  drawMetaRow(ctx, "Поставщик (Исполнитель):", sellerTitle(seller), true);
  drawMetaRow(ctx, "Покупатель (Заказчик):", payerTitle(payer), true);
  if (bill.basis) drawMetaRow(ctx, "Основание:", bill.basis, false);
  ctx.y += 4;
  drawTable(ctx, bill);
  drawTotals(ctx, bill, taxNote);
  await drawPaymentZone(ctx, bill, purpose, taxNote, qrText);
  drawSignature(ctx, seller);
  drawFooters(ctx, bill);

  doc.end();
  return done;
}
