import fs from "fs";
import path from "path";
import type { Response } from "express";
import PDFDocument from "pdfkit";

import type {
  SmetaExportDocument,
  SmetaExportLine,
  SmetaOrgInfo,
  SmetaTransportSection,
} from "./types";
import { buildAttachmentContentDisposition } from "../../utils/contentDisposition";

// ── A4-геометрия ──────────────────────────────────────────────────────────────
// Пагинация полностью ручная: документ создаётся с нулевыми полями pdfkit,
// иначе его авто-разбивка на страницы конфликтует с нашей (footer у нижнего
// края «уезжал» бы на новую страницу).

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MARGIN = 44;
const FOOTER_ZONE = 30;
const CONTENT_W = A4_WIDTH - MARGIN * 2;
const BOTTOM_LIMIT = A4_HEIGHT - MARGIN - FOOTER_ZONE;
const RIGHT_X = MARGIN + CONTENT_W;

// Канон design-system.md: business blue + спокойная slate-шкала.
const C = {
  ink: "#0f172a",
  ink2: "#334155",
  muted: "#64748b",
  faint: "#94a3b8",
  border: "#cbd5e1",
  hairline: "#e2e8f0",
  zebra: "#f8fafc",
  headBg: "#f1f5f9",
  accent: "#1e3a8a",
  accentBright: "#1d4ed8",
  accentSoft: "#eff6ff",
  accentBorder: "#bfdbfe",
};

// Колонки таблицы позиций (сумма = CONTENT_W).
const COL_IDX = 26;
const COL_QTY = 54;
const COL_PRICE = 84;
const COL_SUM = 94;
const COL_NAME = CONTENT_W - COL_IDX - COL_QTY - COL_PRICE - COL_SUM;
const CELL_PAD = 6;

type FontSet = { body: string; bold: string };
type Pdf = InstanceType<typeof PDFDocument>;

/** Корень пакета apps/api (и для `src/…`, и для `dist/…` после сборки). */
function apiPackageRoot(): string {
  return path.resolve(__dirname, "..", "..", "..");
}

function bundledDejaVuPaths(): { regular: string; bold: string } | null {
  const root = apiPackageRoot();
  const regular = path.join(root, "assets", "fonts", "DejaVuSans.ttf");
  const bold = path.join(root, "assets", "fonts", "DejaVuSans-Bold.ttf");
  if (fs.existsSync(regular) && fs.existsSync(bold)) {
    return { regular, bold };
  }
  if (fs.existsSync(regular)) {
    return { regular, bold: regular };
  }
  return null;
}

function resolveFonts(doc: Pdf): FontSet {
  const ttf = process.env.SMETA_PDF_FONT_TTF?.trim();
  const boldTtf = process.env.SMETA_PDF_FONT_BOLD_TTF?.trim();
  if (ttf && fs.existsSync(ttf)) {
    doc.registerFont("SmetaBody", ttf);
    const boldPath = boldTtf && fs.existsSync(boldTtf) ? boldTtf : ttf;
    doc.registerFont("SmetaBold", boldPath);
    return { body: "SmetaBody", bold: "SmetaBold" };
  }
  const bundled = bundledDejaVuPaths();
  if (bundled) {
    doc.registerFont("SmetaBody", bundled.regular);
    doc.registerFont("SmetaBold", bundled.bold);
    return { body: "SmetaBody", bold: "SmetaBold" };
  }
  return { body: "Helvetica", bold: "Helvetica-Bold" };
}

function rub(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return `${value} ₽`;
  return `${n.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}

function todayRuLabel(): string {
  return new Date().toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}

type CategoryGroup = { category: string; items: SmetaExportLine[] };

/** Группировка строк по категории с сохранением порядка появления. */
function groupByCategory(lines: SmetaExportLine[]): CategoryGroup[] {
  const order: string[] = [];
  const map = new Map<string, SmetaExportLine[]>();
  for (const line of lines) {
    const key = line.category?.trim() || "Прочее";
    if (!map.has(key)) {
      map.set(key, []);
      order.push(key);
    }
    map.get(key)!.push(line);
  }
  return order.map((category) => ({ category, items: map.get(category)! }));
}

type RenderOptions = {
  transport?: SmetaTransportSection | null;
  grandTotal?: string | null;
};

/**
 * Пишущий движок сметы: держит текущий y, разбивает на страницы, повторяет
 * шапку таблицы и категорию на переносе, в конце проставляет футер «Стр. N из M»
 * на все страницы (через bufferPages).
 */
class SmetaPdfWriter {
  private readonly doc: Pdf;
  private readonly fonts: FontSet;
  private y = MARGIN;
  /** Активная категория таблицы — для повтора банда после переноса страницы. */
  private tableContext: { category: string } | null = null;

  constructor(doc: Pdf) {
    this.doc = doc;
    this.fonts = resolveFonts(doc);
  }

  // ── низкоуровневые помощники ────────────────────────────────────────────────

  private hline(y: number, color = C.hairline, weight = 0.7, x1 = MARGIN, x2 = RIGHT_X): void {
    this.doc.save();
    this.doc.moveTo(x1, y).lineTo(x2, y).lineWidth(weight).strokeColor(color).stroke();
    this.doc.restore();
  }

  private fillRect(x: number, y: number, w: number, h: number, color: string): void {
    this.doc.save();
    this.doc.rect(x, y, w, h).fill(color);
    this.doc.restore();
  }

  private newPage(): void {
    this.doc.addPage();
    this.y = MARGIN;
    if (this.tableContext) {
      this.drawTableHeader();
      this.drawCategoryBand(this.tableContext.category, true);
    }
  }

  private ensure(height: number): void {
    if (this.y + height > BOTTOM_LIMIT) this.newPage();
  }

  // ── блоки документа ────────────────────────────────────────────────────────

  private drawOrgBar(org: SmetaOrgInfo | null): void {
    const d = this.doc;
    if (!org || (!org.name && !org.phone && !org.address && !org.email)) {
      // Реквизиты не настроены — оставляем только фирменную линию.
      this.fillRect(MARGIN, this.y, CONTENT_W, 2.5, C.accent);
      this.y += 16;
      return;
    }

    if (org.name) {
      d.font(this.fonts.bold).fontSize(11.5).fillColor(C.accent);
      d.text(org.name, MARGIN, this.y, { width: CONTENT_W - 150, lineBreak: false, ellipsis: true });
    }
    if (org.inn) {
      d.font(this.fonts.body).fontSize(8).fillColor(C.faint);
      d.text(`ИНН ${org.inn}`, MARGIN + CONTENT_W - 150, this.y + 2, { width: 150, align: "right", lineBreak: false });
    }
    this.y += org.name ? 15 : 0;

    const contactBits = [org.phone, org.email, org.address].filter(Boolean) as string[];
    if (contactBits.length > 0) {
      d.font(this.fonts.body).fontSize(8).fillColor(C.muted);
      d.text(contactBits.join("  ·  "), MARGIN, this.y, { width: CONTENT_W, lineBreak: false, ellipsis: true });
      this.y += 12;
    }

    this.y += 4;
    this.fillRect(MARGIN, this.y, CONTENT_W, 2.5, C.accent);
    this.y += 16;
  }

  private drawTitle(data: SmetaExportDocument): void {
    const d = this.doc;
    d.font(this.fonts.bold).fontSize(19).fillColor(C.ink);
    d.text(data.documentTitleRu, MARGIN, this.y, { width: CONTENT_W - 140, lineBreak: false, ellipsis: true });

    d.font(this.fonts.body).fontSize(8).fillColor(C.faint);
    d.text(`Сформирована ${todayRuLabel()}`, MARGIN + CONTENT_W - 140, this.y + 8, {
      width: 140,
      align: "right",
      lineBreak: false,
    });
    this.y += 24;

    d.font(this.fonts.body).fontSize(9).fillColor(C.muted);
    d.text(data.documentTitleEn, MARGIN, this.y, { width: CONTENT_W, lineBreak: false });
    this.y += 20;
  }

  /** Ячейка «подпись сверху, значение снизу». Возвращает высоту. */
  private metaCell(x: number, y: number, w: number, label: string, value: string, boldValue: boolean): number {
    const d = this.doc;
    d.font(this.fonts.bold).fontSize(6.8).fillColor(C.faint);
    d.text(label.toUpperCase(), x, y, { width: w, lineBreak: false, characterSpacing: 0.6 });

    d.font(boldValue ? this.fonts.bold : this.fonts.body).fontSize(9.5).fillColor(C.ink);
    const vh = d.heightOfString(value, { width: w, lineGap: 1 });
    d.text(value, x, y + 10, { width: w, lineGap: 1 });
    return 10 + vh;
  }

  private drawMetaGrid(data: SmetaExportDocument): void {
    const gap = 18;
    const colW = (CONTENT_W - gap) / 2;
    const rows: Array<Array<{ label: string; value: string; bold?: boolean }>> = [
      [
        { label: "Клиент", value: data.clientName, bold: true },
        { label: "Проект", value: data.projectName, bold: true },
      ],
      [
        { label: "Выдача", value: `${data.issueDateLabel}, ${data.loadOutTimeLabel}` },
        { label: "Возврат", value: `${data.returnDateLabel}, ${data.returnLoadTimeLabel}` },
      ],
    ];

    for (const row of rows) {
      this.ensure(30);
      const heights = row.map((cell, i) =>
        this.metaCell(MARGIN + i * (colW + gap), this.y, colW, cell.label, cell.value, cell.bold ?? false),
      );
      this.y += Math.max(...heights) + 9;
    }
  }

  private drawNotes(data: SmetaExportDocument): void {
    const d = this.doc;

    // Просчёт часов — приглушённая плашка с акцентной кромкой.
    const boxText = data.hourCalculationText?.trim();
    if (boxText) {
      d.font(this.fonts.body).fontSize(8.5);
      const textW = CONTENT_W - 20;
      const th = d.heightOfString(boxText, { width: textW, lineGap: 1.5 });
      const boxH = th + 22;
      this.ensure(boxH + 8);
      this.fillRect(MARGIN, this.y, CONTENT_W, boxH, C.zebra);
      this.fillRect(MARGIN, this.y, 2.5, boxH, C.accentBorder);
      d.font(this.fonts.bold).fontSize(6.8).fillColor(C.faint);
      d.text("ПРОСЧЁТ ЧАСОВ", MARGIN + 12, this.y + 6, { characterSpacing: 0.6, lineBreak: false });
      d.font(this.fonts.body).fontSize(8.5).fillColor(C.ink2);
      d.text(boxText, MARGIN + 12, this.y + 16, { width: textW, lineGap: 1.5 });
      this.y += boxH + 10;
    }

    const noteLine = (label: string, text: string) => {
      const d2 = this.doc;
      d2.font(this.fonts.body).fontSize(8.5);
      const th = d2.heightOfString(`${label}: ${text}`, { width: CONTENT_W, lineGap: 1.5 });
      this.ensure(th + 6);
      d2.font(this.fonts.bold).fontSize(8.5).fillColor(C.ink2);
      d2.text(`${label}: `, MARGIN, this.y, { continued: true, lineGap: 1.5 });
      d2.font(this.fonts.body).fillColor(C.ink2);
      d2.text(text, { width: CONTENT_W, lineGap: 1.5 });
      this.y += th + 6;
    };

    if (data.comment?.trim()) noteLine("Комментарий", data.comment.trim());
    if (data.includeOptionalInExport && data.optionalNote?.trim()) {
      noteLine("Дополнительно", data.optionalNote.trim());
    }
    this.y += 4;
  }

  private drawTableHeader(): void {
    const d = this.doc;
    const h = 20;
    this.fillRect(MARGIN, this.y, CONTENT_W, h, C.headBg);
    this.hline(this.y, C.border, 0.8);
    this.hline(this.y + h, C.border, 0.8);

    d.font(this.fonts.bold).fontSize(7).fillColor(C.ink2);
    const ty = this.y + 6.5;
    let x = MARGIN;
    const head = (text: string, w: number, align: "left" | "center" | "right") => {
      d.text(text, x + CELL_PAD, ty, {
        width: w - CELL_PAD * 2,
        align,
        lineBreak: false,
        characterSpacing: 0.5,
      });
      x += w;
    };
    head("№", COL_IDX, "center");
    head("НАИМЕНОВАНИЕ", COL_NAME, "left");
    head("КОЛ-ВО", COL_QTY, "center");
    head("ЦЕНА / СМЕНА", COL_PRICE, "right");
    head("СУММА", COL_SUM, "right");
    this.y += h;
  }

  private drawCategoryBand(category: string, isContinuation = false): void {
    const d = this.doc;
    const h = 16;
    this.fillRect(MARGIN, this.y, CONTENT_W, h, C.accentSoft);
    d.font(this.fonts.bold).fontSize(7.5).fillColor(C.accent);
    const label = isContinuation ? `${category} — продолжение` : category;
    d.text(label.toUpperCase(), MARGIN + CELL_PAD, this.y + 4.5, {
      width: CONTENT_W - CELL_PAD * 2,
      lineBreak: false,
      ellipsis: true,
      characterSpacing: 0.6,
    });
    this.y += h;
  }

  private drawItemRow(line: SmetaExportLine, zebra: boolean): void {
    const d = this.doc;
    d.font(this.fonts.body).fontSize(8.5);
    const nameW = COL_NAME - CELL_PAD * 2;
    const nameH = d.heightOfString(line.name, { width: nameW, lineGap: 1 });
    // Подпись о персональной цене живёт под названием: так уступка видна
    // заказчику, а колонка цены остаётся одной цифрой.
    const noteText = line.listPricePerShift
      ? `персональная скидка · цена до скидки ${rub(line.listPricePerShift)}`
      : null;
    const noteH = noteText ? d.fontSize(7).heightOfString(noteText, { width: nameW }) + 1.5 : 0;
    d.fontSize(8.5);
    const rowH = Math.max(19, nameH + noteH + 9);

    if (this.y + rowH > BOTTOM_LIMIT) this.newPage();

    if (zebra) this.fillRect(MARGIN, this.y, CONTENT_W, rowH, C.zebra);
    const ty = this.y + 4.5;

    d.font(this.fonts.body).fontSize(8).fillColor(C.faint);
    d.text(String(line.index), MARGIN + CELL_PAD, ty + 0.5, {
      width: COL_IDX - CELL_PAD * 2,
      align: "center",
      lineBreak: false,
    });

    d.font(this.fonts.body).fontSize(8.5).fillColor(C.ink);
    d.text(line.name, MARGIN + COL_IDX + CELL_PAD, ty, { width: nameW, lineGap: 1 });
    if (noteText) {
      d.fontSize(7).fillColor(C.faint);
      d.text(noteText, MARGIN + COL_IDX + CELL_PAD, ty + nameH + 1, { width: nameW, lineBreak: true });
      d.fontSize(8.5).fillColor(C.ink);
    }

    d.text(String(line.quantity), MARGIN + COL_IDX + COL_NAME + CELL_PAD, ty, {
      width: COL_QTY - CELL_PAD * 2,
      align: "center",
      lineBreak: false,
    });
    d.fillColor(C.ink2);
    d.text(rub(line.pricePerShift), MARGIN + COL_IDX + COL_NAME + COL_QTY + CELL_PAD, ty, {
      width: COL_PRICE - CELL_PAD * 2,
      align: "right",
      lineBreak: false,
    });
    d.fillColor(C.ink);
    d.text(rub(line.lineSum), MARGIN + COL_IDX + COL_NAME + COL_QTY + COL_PRICE + CELL_PAD, ty, {
      width: COL_SUM - CELL_PAD * 2,
      align: "right",
      lineBreak: false,
    });

    this.hline(this.y + rowH);
    this.y += rowH;
  }

  private drawTable(data: SmetaExportDocument): void {
    const groups = groupByCategory(data.lines);
    this.ensure(60);
    this.drawTableHeader();
    for (const group of groups) {
      this.ensure(16 + 19); // банд категории + минимум одна строка вместе
      this.drawCategoryBand(group.category);
      this.tableContext = { category: group.category };
      group.items.forEach((line, i) => this.drawItemRow(line, i % 2 === 1));
    }
    this.tableContext = null;
    this.y += 12;
  }

  /**
   * Итоги секции. `emphasizeFinal` — финальная строка оформляется акцентной
   * плашкой (для одиночной сметы, где это и есть сумма к оплате).
   */
  private drawSectionTotals(data: SmetaExportDocument, emphasizeFinal: boolean): void {
    const blockW = 252;
    const x = RIGHT_X - blockW;
    const d = this.doc;

    const row = (label: string, value: string, opts?: { bold?: boolean; muted?: boolean }) => {
      this.ensure(18);
      d.font(opts?.bold ? this.fonts.bold : this.fonts.body)
        .fontSize(9.5)
        .fillColor(opts?.muted ? C.muted : C.ink);
      d.text(label, x, this.y, { width: blockW - 110, lineBreak: false, ellipsis: true });
      d.text(value, x + blockW - 108, this.y, { width: 108, align: "right", lineBreak: false });
      this.y += 16;
    };

    row("Оборудование итого", rub(data.subtotal), { muted: true });
    if (Number(data.discountPercent) > 0) {
      row(`Скидка ${data.discountPercent}%`, `− ${rub(data.discountAmount)}`, { muted: true });
    }

    const finalLabel = data.documentTitleRu === "Смета-добор" ? "Итого по доб-смете" : "Итого по смете";
    if (emphasizeFinal) {
      const h = 27;
      this.ensure(h + 4);
      this.fillRect(x, this.y, blockW, h, C.accentSoft);
      this.hline(this.y, C.accentBorder, 0.9, x, x + blockW);
      this.hline(this.y + h, C.accentBorder, 0.9, x, x + blockW);
      d.font(this.fonts.bold).fontSize(9).fillColor(C.accent);
      d.text("ИТОГО К ОПЛАТЕ", x + 10, this.y + 9, { lineBreak: false, characterSpacing: 0.5 });
      d.font(this.fonts.bold).fontSize(11.5).fillColor(C.accent);
      d.text(rub(data.totalAfterDiscount), x, this.y + 7.5, { width: blockW - 10, align: "right", lineBreak: false });
      this.y += h + 4;
    } else {
      this.hline(this.y + 1, C.border, 0.8, x, x + blockW);
      this.y += 6;
      row(finalLabel, rub(data.totalAfterDiscount), { bold: true });
    }
  }

  private drawTransport(section: SmetaTransportSection): void {
    const d = this.doc;
    this.ensure(70);
    this.y += 6;
    this.drawTableHeaderlessBand("ТРАНСПОРТ");

    for (const line of section.lines) {
      d.font(this.fonts.body).fontSize(8.5);
      const nameW = CONTENT_W - COL_SUM - CELL_PAD * 2;
      const detailsH = line.details ? 11 : 0;
      const rowH = 19 + detailsH;
      this.ensure(rowH);

      const ty = this.y + 4.5;
      d.font(this.fonts.body).fontSize(8.5).fillColor(C.ink);
      d.text(line.name, MARGIN + CELL_PAD, ty, { width: nameW, lineBreak: false, ellipsis: true });
      if (line.details) {
        d.font(this.fonts.body).fontSize(7.5).fillColor(C.muted);
        d.text(line.details, MARGIN + CELL_PAD, ty + 11.5, { width: nameW, lineBreak: false, ellipsis: true });
      }
      d.font(this.fonts.body).fontSize(8.5).fillColor(C.ink);
      d.text(rub(line.sum), RIGHT_X - COL_SUM + CELL_PAD, ty, {
        width: COL_SUM - CELL_PAD * 2,
        align: "right",
        lineBreak: false,
      });
      this.hline(this.y + rowH);
      this.y += rowH;
    }

    this.ensure(20);
    this.y += 4;
    d.font(this.fonts.bold).fontSize(9.5).fillColor(C.ink);
    d.text("Транспорт итого", RIGHT_X - 252, this.y, { width: 140, lineBreak: false });
    d.text(rub(section.subtotal), RIGHT_X - 108, this.y, { width: 108, align: "right", lineBreak: false });
    this.y += 20;
  }

  private drawTableHeaderlessBand(label: string): void {
    const h = 16;
    this.fillRect(MARGIN, this.y, CONTENT_W, h, C.accentSoft);
    this.doc.font(this.fonts.bold).fontSize(7.5).fillColor(C.accent);
    this.doc.text(label, MARGIN + CELL_PAD, this.y + 4.5, {
      width: CONTENT_W - CELL_PAD * 2,
      lineBreak: false,
      characterSpacing: 0.6,
    });
    this.y += h;
  }

  private drawGrandTotal(
    sections: SmetaExportDocument[],
    transport: SmetaTransportSection | null,
    grandTotal: string,
  ): void {
    const blockW = 276;
    const x = RIGHT_X - blockW;
    const d = this.doc;

    const composition: Array<{ label: string; value: string }> = [];
    const main = sections[0];
    if (main) composition.push({ label: "Оборудование (после скидки)", value: rub(main.totalAfterDiscount) });
    const addon = sections[1];
    if (addon) composition.push({ label: "Доб-смета (после скидки)", value: rub(addon.totalAfterDiscount) });
    if (transport) composition.push({ label: "Транспорт", value: rub(transport.subtotal) });

    const bandH = 30;
    const compH = composition.length * 15;
    this.ensure(compH + bandH + 18);
    this.y += 6;

    d.font(this.fonts.body).fontSize(8.5);
    for (const c of composition) {
      d.fillColor(C.muted);
      d.text(c.label, x, this.y, { width: blockW - 112, lineBreak: false, ellipsis: true });
      d.fillColor(C.ink2);
      d.text(c.value, x + blockW - 110, this.y, { width: 110, align: "right", lineBreak: false });
      this.y += 15;
    }

    this.y += 3;
    this.fillRect(x, this.y, blockW, bandH, C.accentSoft);
    this.hline(this.y, C.accentBorder, 1, x, x + blockW);
    this.hline(this.y + bandH, C.accentBorder, 1, x, x + blockW);
    d.font(this.fonts.bold).fontSize(9.5).fillColor(C.accent);
    d.text("ИТОГО К ОПЛАТЕ", x + 10, this.y + 10.5, { lineBreak: false, characterSpacing: 0.5 });
    d.font(this.fonts.bold).fontSize(13).fillColor(C.accent);
    d.text(rub(grandTotal), x, this.y + 8.5, { width: blockW - 10, align: "right", lineBreak: false });
    this.y += bandH;
  }

  private drawSection(data: SmetaExportDocument, emphasizeFinal: boolean): void {
    this.drawOrgBar(data.org);
    this.drawTitle(data);
    this.drawMetaGrid(data);
    this.drawNotes(data);
    this.drawTable(data);
    this.drawSectionTotals(data, emphasizeFinal);
  }

  /** Футер на всех страницах — вызывать строго перед doc.end(). */
  private finalizeFooters(org: SmetaOrgInfo | null): void {
    const d = this.doc;
    const range = d.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      d.switchToPage(i);
      const fy = A4_HEIGHT - MARGIN - 10;
      this.hline(fy - 7, C.hairline, 0.7);
      d.font(this.fonts.body).fontSize(7.5).fillColor(C.faint);
      const left = [org?.name, org?.phone].filter(Boolean).join("  ·  ");
      if (left) {
        d.text(left, MARGIN, fy, { width: CONTENT_W - 100, lineBreak: false, ellipsis: true });
      }
      d.text(`Стр. ${i - range.start + 1} из ${range.count}`, RIGHT_X - 100, fy, {
        width: 100,
        align: "right",
        lineBreak: false,
      });
    }
  }

  /** Полный проход: секции → транспорт → общий итог → футеры. */
  render(sections: SmetaExportDocument[], opts: RenderOptions): void {
    const transport = opts.transport ?? null;
    const showGrand = sections.length > 1 || Boolean(transport);

    sections.forEach((section, idx) => {
      if (idx > 0) {
        this.doc.addPage();
        this.y = MARGIN;
      }
      this.drawSection(section, !showGrand);
    });

    if (transport) this.drawTransport(transport);
    if (showGrand && opts.grandTotal) {
      this.drawGrandTotal(sections, transport, opts.grandTotal);
    }

    this.finalizeFooters(sections[0]?.org ?? null);
  }
}

function createSmetaDoc(data: SmetaExportDocument): Pdf {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    bufferPages: true,
    autoFirstPage: true,
    info: {
      Title: `${data.documentTitleRu} — ${data.clientName}`,
      Author: data.org?.name ?? "Light Rental",
      Subject: data.projectName,
    },
  });
  return doc;
}

// ── Публичное API (сигнатуры совместимы с роутами) ────────────────────────────

/** Одиночная смета (equipment-only / доб-смета / превью quote). */
export function writeSmetaPdf(res: Response, data: SmetaExportDocument, downloadName: string): void {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", buildAttachmentContentDisposition(downloadName, "estimate.pdf"));

  const doc = createSmetaDoc(data);
  doc.pipe(res);
  new SmetaPdfWriter(doc).render([data], {});
  doc.end();
}

/**
 * Multi-section PDF: main (+ addon с новой страницы) + транспорт + общий итог.
 * С одной секцией и без транспорта поведение эквивалентно `writeSmetaPdf`.
 */
export function writeSmetaPdfMulti(
  res: Response,
  sections: SmetaExportDocument[],
  downloadName: string,
  grandTotal: string,
  transport: SmetaTransportSection | null = null,
): void {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", buildAttachmentContentDisposition(downloadName, "estimate.pdf"));

  const doc = createSmetaDoc(sections[0]);
  doc.pipe(res);
  new SmetaPdfWriter(doc).render(sections, { transport, grandTotal });
  doc.end();
}

/** Буферный вариант для не-Express потребителей (ЛК клиента). */
export function renderSmetaPdfToBuffer(
  sections: SmetaExportDocument[],
  grandTotal: string | null = null,
  transport: SmetaTransportSection | null = null,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = createSmetaDoc(sections[0]);
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    new SmetaPdfWriter(doc).render(sections, { transport, grandTotal });
    doc.end();
  });
}
