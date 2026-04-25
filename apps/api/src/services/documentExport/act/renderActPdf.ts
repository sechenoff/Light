/**
 * PDF Акт оказанных услуг — Phase 1.
 * Доступен только при booking.status === "RETURNED" И amountOutstanding === 0.
 */

import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";
import type { OrgDetails } from "../invoice/renderInvoicePdf";

// ── Типы ──────────────────────────────────────────────────────────────────────

export interface ActLine {
  index: number;
  name: string;
  quantity: number;
  unitPrice: string;
  lineSum: string;
}

export interface ActDocument {
  actNumber: string;
  actDate: string;
  clientName: string;
  lines: ActLine[];
  totalAmount: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const COLORS = {
  ink: "#0f172a",
  muted: "#64748b",
  border: "#cbd5e1",
  headerBg: "#f1f5f9",
  tableHeadBg: "#e2e8f0",
};

type FontSet = { body: string; bold: string };

function apiPackageRoot(): string {
  return path.resolve(__dirname, "..", "..", "..", "..", "..");
}

function bundledDejaVuPaths(): { regular: string; bold: string } | null {
  const root = apiPackageRoot();
  const regular = path.join(root, "assets", "fonts", "DejaVuSans.ttf");
  const bold = path.join(root, "assets", "fonts", "DejaVuSans-Bold.ttf");
  if (fs.existsSync(regular) && fs.existsSync(bold)) return { regular, bold };
  if (fs.existsSync(regular)) return { regular, bold: regular };
  return null;
}

function resolveFonts(pdfDoc: InstanceType<typeof PDFDocument>): FontSet {
  const ttf = process.env.SMETA_PDF_FONT_TTF?.trim();
  const boldTtf = process.env.SMETA_PDF_FONT_BOLD_TTF?.trim();
  if (ttf && fs.existsSync(ttf)) {
    pdfDoc.registerFont("ActBody", ttf);
    const boldPath = boldTtf && fs.existsSync(boldTtf) ? boldTtf : ttf;
    pdfDoc.registerFont("ActBold", boldPath);
    return { body: "ActBody", bold: "ActBold" };
  }
  const bundled = bundledDejaVuPaths();
  if (bundled) {
    pdfDoc.registerFont("ActBody", bundled.regular);
    pdfDoc.registerFont("ActBold", bundled.bold);
    return { body: "ActBody", bold: "ActBold" };
  }
  return { body: "Helvetica", bold: "Helvetica-Bold" };
}

function rub(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return `${value} ₽`;
  return `${n.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}

// ── Рендер ────────────────────────────────────────────────────────────────────

/**
 * Генерирует PDF Акт оказанных услуг.
 * @returns Buffer с PDF-файлом.
 */
export function renderActPdf(doc: ActDocument, org: OrgDetails): Buffer {
  const chunks: Buffer[] = [];
  const pdfDoc = new PDFDocument({ size: "A4", margin: 48, autoFirstPage: true });
  const fonts = resolveFonts(pdfDoc);

  pdfDoc.on("data", (chunk: Buffer) => chunks.push(chunk));

  const margin = 48;
  const pageWidth = 595.28;
  const contentW = pageWidth - margin * 2;

  let y = margin;

  // ── Заголовок ─────────────────────────────────────────────────────────────
  pdfDoc.save();
  pdfDoc.rect(margin, y, contentW, 80).fill(COLORS.headerBg);
  pdfDoc.restore();

  pdfDoc.fillColor(COLORS.ink).font(fonts.bold).fontSize(16)
    .text(`Акт оказанных услуг № ${doc.actNumber}`, margin + 14, y + 14, { width: contentW - 28 });
  pdfDoc.font(fonts.body).fontSize(9).fillColor(COLORS.muted)
    .text(`от ${doc.actDate}`, margin + 14, y + 40, { width: contentW - 28 });

  y += 90;

  // ── Стороны ───────────────────────────────────────────────────────────────
  function kv(label: string, value: string) {
    pdfDoc.font(fonts.body).fontSize(8.5).fillColor(COLORS.muted)
      .text(`${label}:`, margin, y, { width: 130 });
    pdfDoc.fillColor(COLORS.ink)
      .text(value, margin + 134, y, { width: contentW - 134 });
    y += 14;
  }

  function sectionTitle(title: string) {
    pdfDoc.font(fonts.bold).fontSize(10).fillColor(COLORS.ink)
      .text(title, margin, y, { width: contentW });
    y += 16;
  }

  sectionTitle("Исполнитель");
  kv("Наименование", org.name);
  kv("ИНН / КПП", `${org.inn} / ${org.kpp}`);
  kv("Адрес", org.address);
  y += 8;

  sectionTitle("Заказчик");
  kv("Наименование", doc.clientName);
  y += 12;

  // ── Основной текст ────────────────────────────────────────────────────────
  pdfDoc.font(fonts.body).fontSize(9).fillColor(COLORS.ink);
  const introText = `Исполнитель оказал, а Заказчик принял следующие услуги по аренде осветительного оборудования:`;
  pdfDoc.text(introText, margin, y, { width: contentW, lineGap: 2 });
  y = pdfDoc.y + 12;

  // ── Таблица ───────────────────────────────────────────────────────────────
  const colWidths = [28, 220, 50, 90, 90];
  const headers = ["№", "Наименование", "Кол-во", "Цена", "Сумма"];
  const rowH = 22;
  const tableX = margin;

  function ensureSpace(extra: number) {
    const bottom = pdfDoc.page.height - margin;
    if (y + extra > bottom) {
      pdfDoc.addPage();
      y = margin;
    }
  }

  // Шапка таблицы
  ensureSpace(rowH + 4);
  pdfDoc.save();
  pdfDoc.rect(tableX, y, contentW, rowH).fill(COLORS.tableHeadBg).stroke(COLORS.border);
  pdfDoc.restore();
  let cx = tableX;
  pdfDoc.font(fonts.bold).fontSize(8).fillColor(COLORS.ink);
  headers.forEach((h, i) => {
    pdfDoc.text(h, cx + 4, y + 7, {
      width: colWidths[i] - 8,
      height: rowH - 8,
      lineBreak: false,
      ellipsis: true,
    });
    cx += colWidths[i];
  });
  y += rowH;

  // Строки
  pdfDoc.font(fonts.body).fontSize(8.5);
  for (const line of doc.lines) {
    ensureSpace(rowH);
    pdfDoc.rect(tableX, y, contentW, rowH).stroke(COLORS.border);
    cx = tableX;
    const cells = [
      String(line.index),
      line.name,
      String(line.quantity),
      rub(line.unitPrice),
      rub(line.lineSum),
    ];
    cells.forEach((cell, i) => {
      pdfDoc.fillColor(COLORS.ink).text(cell, cx + 4, y + 6, {
        width: colWidths[i] - 8,
        height: rowH - 8,
        lineBreak: false,
        ellipsis: true,
      });
      cx += colWidths[i];
    });
    y += rowH;
  }

  y += 12;

  // ── Итого ─────────────────────────────────────────────────────────────────
  const totalsW = 220;
  const totalsX = margin + contentW - totalsW;

  ensureSpace(20);
  pdfDoc.font(fonts.bold).fontSize(11).fillColor(COLORS.ink);
  pdfDoc.text("Итого:", totalsX, y, { width: totalsW - 100 });
  pdfDoc.text(rub(doc.totalAmount), totalsX + totalsW - 96, y, { width: 96, align: "right" });
  y += 20;

  // ── Заключение ────────────────────────────────────────────────────────────
  y += 8;
  ensureSpace(30);
  pdfDoc.font(fonts.body).fontSize(9).fillColor(COLORS.ink);
  pdfDoc.text(
    `Услуги оказаны в полном объёме. Стороны претензий друг к другу не имеют.`,
    margin,
    y,
    { width: contentW },
  );
  y = pdfDoc.y + 20;

  // ── Подписи ───────────────────────────────────────────────────────────────
  ensureSpace(80);
  const sigColW = (contentW - 20) / 2;

  pdfDoc.font(fonts.bold).fontSize(9).fillColor(COLORS.ink);
  pdfDoc.text("Исполнитель:", margin, y, { width: sigColW });
  pdfDoc.text("Заказчик:", margin + sigColW + 20, y, { width: sigColW });
  y += 14;

  pdfDoc.font(fonts.body).fontSize(9).fillColor(COLORS.muted);
  pdfDoc.text(org.name, margin, y, { width: sigColW });
  pdfDoc.text(doc.clientName, margin + sigColW + 20, y, { width: sigColW });
  y += 22;

  pdfDoc.font(fonts.body).fontSize(9).fillColor(COLORS.muted);
  pdfDoc.text("Подпись: __________________________  /____________/", margin, y, { width: sigColW });
  pdfDoc.text("Подпись: __________________________  /____________/", margin + sigColW + 20, y, { width: sigColW });
  y += 18;
  pdfDoc.text("М.П.", margin, y, { width: 40 });
  pdfDoc.text("М.П.", margin + sigColW + 20, y, { width: 40 });

  pdfDoc.end();

  return Buffer.concat(chunks);
}
