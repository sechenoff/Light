/**
 * PDF Счёт на оплату — Phase 1.
 * Номер счёта: LR-DRAFT-<bookingId> (Phase 2 заменит на реальный Invoice.number).
 * Реквизиты организации берутся из ENV-переменных ORG_*.
 */

import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";
import Decimal from "decimal.js";

// ── Типы ──────────────────────────────────────────────────────────────────────

export interface OrgDetails {
  name: string;
  inn: string;
  kpp: string;
  address: string;
  phone: string;
  bank: string;
  bik: string;
  rschet: string;
  kschet: string;
}

export interface InvoiceLine {
  index: number;
  name: string;
  quantity: number;
  unitPrice: string;
  lineSum: string;
}

export interface InvoiceDocument {
  invoiceNumber: string;
  invoiceDate: string;
  clientName: string;
  lines: InvoiceLine[];
  subtotal: string;
  discountPercent: string | null;
  discountAmount: string | null;
  totalAfterDiscount: string;
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
  // __dirname = .../apps/api/src/services/documentExport/invoice
  // apps/api root is 4 levels up: invoice → documentExport → services → src → api
  return path.resolve(__dirname, "..", "..", "..", "..");
}

function bundledDejaVuPaths(): { regular: string; bold: string } | null {
  const root = apiPackageRoot();
  const regular = path.join(root, "assets", "fonts", "DejaVuSans.ttf");
  const bold = path.join(root, "assets", "fonts", "DejaVuSans-Bold.ttf");
  if (fs.existsSync(regular) && fs.existsSync(bold)) return { regular, bold };
  if (fs.existsSync(regular)) return { regular, bold: regular };
  return null;
}

function resolveFonts(doc: InstanceType<typeof PDFDocument>): FontSet {
  const ttf = process.env.SMETA_PDF_FONT_TTF?.trim();
  const boldTtf = process.env.SMETA_PDF_FONT_BOLD_TTF?.trim();
  if (ttf && fs.existsSync(ttf)) {
    doc.registerFont("InvoiceBody", ttf);
    const boldPath = boldTtf && fs.existsSync(boldTtf) ? boldTtf : ttf;
    doc.registerFont("InvoiceBold", boldPath);
    return { body: "InvoiceBody", bold: "InvoiceBold" };
  }
  const bundled = bundledDejaVuPaths();
  if (bundled) {
    doc.registerFont("InvoiceBody", bundled.regular);
    doc.registerFont("InvoiceBold", bundled.bold);
    return { body: "InvoiceBody", bold: "InvoiceBold" };
  }
  return { body: "Helvetica", bold: "Helvetica-Bold" };
}

function rub(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return `${value} ₽`;
  return `${n.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}

/** Читает реквизиты организации из ENV */
export function readOrgFromEnv(): OrgDetails {
  return {
    name: process.env.ORG_NAME ?? "ООО «Световое оборудование»",
    inn: process.env.ORG_INN ?? "7700000000",
    kpp: process.env.ORG_KPP ?? "770001001",
    address: process.env.ORG_ADDRESS ?? "г. Москва, ул. Примерная, д. 1",
    phone: process.env.ORG_PHONE ?? "+7 (495) 000-00-00",
    bank: process.env.ORG_BANK ?? "АО «Банк Примерный»",
    bik: process.env.ORG_BIK ?? "044525000",
    rschet: process.env.ORG_RSCHET ?? "40702810000000000000",
    kschet: process.env.ORG_KSCHET ?? "30101810000000000000",
  };
}

// ── Рендер ────────────────────────────────────────────────────────────────────

/**
 * Генерирует PDF Счёт на оплату.
 * @returns Promise<Buffer> с PDF-файлом.
 */
export function renderInvoicePdf(doc: InvoiceDocument, org: OrgDetails): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
  const chunks: Buffer[] = [];
  const pdfDoc = new PDFDocument({ size: "A4", margin: 48, autoFirstPage: true });
  const fonts = resolveFonts(pdfDoc);

  pdfDoc.on("data", (chunk: Buffer) => chunks.push(chunk));
  pdfDoc.on("end", () => resolve(Buffer.concat(chunks)));
  pdfDoc.on("error", reject);

  const margin = 48;
  const pageWidth = 595.28;
  const contentW = pageWidth - margin * 2;

  let y = margin;

  // ── Заголовок ─────────────────────────────────────────────────────────────
  pdfDoc.save();
  pdfDoc.rect(margin, y, contentW, 80).fill(COLORS.headerBg);
  pdfDoc.restore();

  pdfDoc.fillColor(COLORS.ink).font(fonts.bold).fontSize(18)
    .text(`Счёт № ${doc.invoiceNumber}`, margin + 14, y + 14, { width: contentW - 28 });
  pdfDoc.font(fonts.body).fontSize(9).fillColor(COLORS.muted)
    .text(`от ${doc.invoiceDate}`, margin + 14, y + 38, { width: contentW - 28 });

  y += 90;

  // ── Реквизиты ─────────────────────────────────────────────────────────────
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

  sectionTitle("Продавец");
  kv("Наименование", org.name);
  kv("ИНН / КПП", `${org.inn} / ${org.kpp}`);
  kv("Адрес", org.address);
  kv("Телефон", org.phone);
  kv("Банк", org.bank);
  kv("БИК", org.bik);
  kv("Р/с", org.rschet);
  kv("К/с", org.kschet);
  y += 8;

  sectionTitle("Покупатель");
  kv("Наименование", doc.clientName);
  y += 12;

  // ── Таблица ───────────────────────────────────────────────────────────────
  sectionTitle("Перечень услуг");

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

  function totalRow(label: string, value: string, bold = false) {
    ensureSpace(20);
    pdfDoc.font(bold ? fonts.bold : fonts.body).fontSize(10).fillColor(COLORS.ink);
    pdfDoc.text(label, totalsX, y, { width: totalsW - 100 });
    pdfDoc.text(value, totalsX + totalsW - 96, y, { width: 96, align: "right" });
    y += 16;
  }

  totalRow("Итого без скидки", rub(doc.subtotal));
  if (doc.discountPercent && doc.discountAmount) {
    totalRow(`Скидка (${doc.discountPercent}%)`, `− ${rub(doc.discountAmount)}`);
  }
  totalRow("К оплате", rub(doc.totalAfterDiscount), true);

  // ── Подпись/печать ────────────────────────────────────────────────────────
  y += 24;
  ensureSpace(60);
  pdfDoc.font(fonts.body).fontSize(9).fillColor(COLORS.muted);
  pdfDoc.text("Руководитель: _________________________  /_______________/", margin, y, { width: contentW });
  y += 16;
  pdfDoc.text("Главный бухгалтер: _____________________  /_______________/", margin, y, { width: contentW });
  y += 16;
  pdfDoc.font(fonts.body).fontSize(8).fillColor(COLORS.muted)
    .text("М.П.", margin, y, { width: 40 });

  pdfDoc.end();
  }); // end Promise
}
