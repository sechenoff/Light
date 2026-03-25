import fs from "fs";
import path from "path";
import type { Response } from "express";
import PDFDocument from "pdfkit";

import type { SmetaExportDocument } from "./types";
import { buildAttachmentContentDisposition } from "../../utils/contentDisposition";

const COLORS = {
  ink: "#0f172a",
  muted: "#64748b",
  border: "#cbd5e1",
  headerBg: "#f1f5f9",
  tableHeadBg: "#e2e8f0",
};

type FontSet = { body: string; bold: string };

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

function resolveFonts(doc: InstanceType<typeof PDFDocument>): FontSet {
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

export function writeSmetaPdf(res: Response, data: SmetaExportDocument, downloadName: string): void {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", buildAttachmentContentDisposition(downloadName, "estimate.pdf"));

  const margin = 48;
  const pageWidth = 595.28;
  const contentW = pageWidth - margin * 2;
  const doc = new PDFDocument({ size: "A4", margin, autoFirstPage: true });
  const fonts = resolveFonts(doc);
  doc.pipe(res);

  let y = margin;

  // —— Header band
  const headerH = 78;
  doc.save();
  doc.rect(margin, y, contentW, headerH).fill(COLORS.headerBg);
  doc.restore();

  doc.fillColor(COLORS.ink).font(fonts.bold).fontSize(17).text(data.documentTitleRu, margin + 14, y + 14, {
    width: contentW - 28,
  });
  doc.font(fonts.body).fontSize(9).fillColor(COLORS.muted).text(data.documentTitleEn, margin + 14, y + 36, {
    width: contentW - 28,
  });

  const metaColW = 168;
  const metaX = margin + contentW - metaColW - 14;
  let metaY = y + 14;
  doc.font(fonts.body).fontSize(8.5).fillColor(COLORS.muted);
  doc.text("Дата выдачи", metaX, metaY, { width: metaColW, align: "right" });
  metaY += 11;
  doc.fillColor(COLORS.ink).font(fonts.bold).fontSize(9).text(data.issueDateLabel, metaX, metaY, {
    width: metaColW,
    align: "right",
  });
  metaY += 18;
  doc.fillColor(COLORS.muted).font(fonts.body).fontSize(8.5).text("Дата возврата", metaX, metaY, {
    width: metaColW,
    align: "right",
  });
  metaY += 11;
  doc.fillColor(COLORS.ink).font(fonts.bold).fontSize(9).text(data.returnDateLabel, metaX, metaY, {
    width: metaColW,
    align: "right",
  });
  metaY += 18;
  doc.fillColor(COLORS.muted).font(fonts.body).fontSize(8.5).text("Погрузка / выдача", metaX, metaY, {
    width: metaColW,
    align: "right",
  });
  metaY += 11;
  doc.fillColor(COLORS.ink).font(fonts.bold).fontSize(9).text(data.loadOutTimeLabel, metaX, metaY, {
    width: metaColW,
    align: "right",
  });
  metaY += 16;
  doc.fillColor(COLORS.muted).font(fonts.body).fontSize(8.5).text("Погрузка / возврат", metaX, metaY, {
    width: metaColW,
    align: "right",
  });
  metaY += 11;
  doc.fillColor(COLORS.ink).font(fonts.bold).fontSize(9).text(data.returnLoadTimeLabel, metaX, metaY, {
    width: metaColW,
    align: "right",
  });

  y += headerH + 18;

  function sectionTitle(title: string) {
    doc.fillColor(COLORS.ink).font(fonts.bold).fontSize(10.5).text(title, margin, y, { width: contentW });
    y += 16;
  }

  function kv(label: string, value: string) {
    doc.font(fonts.body).fontSize(9).fillColor(COLORS.muted).text(`${label}:`, margin, y, { width: 110 });
    doc.fillColor(COLORS.ink).text(value, margin + 112, y, { width: contentW - 112 });
    y += 14;
  }

  // —— Info
  sectionTitle("Реквизиты");
  kv("Клиент", data.clientName);
  kv("Проект", data.projectName);
  if (data.comment) kv("Комментарий", data.comment);
  if (data.includeOptionalInExport && data.optionalNote?.trim()) {
    kv("Дополнительно", data.optionalNote.trim());
  }
  y += 6;

  sectionTitle("Просчёт часов сметы");
  doc.font(fonts.body).fontSize(9).fillColor(COLORS.ink).text(data.hourCalculationText, margin, y, {
    width: contentW,
    lineGap: 2,
  });
  y = doc.y + 14;

  // —— Table
  sectionTitle("Список аренды");
  const colWidths = [28, 158, 92, 44, 78, 78];
  const headers = ["№", "Наименование", "Категория", "Кол-во", "Цена за смену", "Сумма"];
  const rowH = 22;
  const tableX = margin;

  function ensureSpace(extra: number) {
    const bottom = doc.page.height - margin;
    if (y + extra > bottom) {
      doc.addPage();
      y = margin;
    }
  }

  // header row
  ensureSpace(rowH + 4);
  doc.save();
  doc.rect(tableX, y, contentW, rowH).fill(COLORS.tableHeadBg).stroke(COLORS.border);
  doc.restore();
  let cx = tableX;
  doc.font(fonts.bold).fontSize(8).fillColor(COLORS.ink);
  headers.forEach((h, i) => {
    doc.text(h, cx + 4, y + 7, {
      width: colWidths[i] - 8,
      height: rowH - 8,
      lineBreak: false,
      ellipsis: true,
    });
    cx += colWidths[i];
  });
  y += rowH;

  doc.font(fonts.body).fontSize(8.5);
  for (const line of data.lines) {
    ensureSpace(rowH);
    doc.rect(tableX, y, contentW, rowH).stroke(COLORS.border);
    cx = tableX;
    const cells = [
      String(line.index),
      line.name,
      line.category,
      String(line.quantity),
      rub(line.pricePerShift),
      rub(line.lineSum),
    ];
    cells.forEach((cell, i) => {
      doc.fillColor(COLORS.ink).text(cell, cx + 4, y + 6, {
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

  // —— Totals
  const totalsW = 220;
  const totalsX = margin + contentW - totalsW;
  function totalRow(label: string, value: string, bold = false) {
    ensureSpace(20);
    doc.font(bold ? fonts.bold : fonts.body).fontSize(10).fillColor(COLORS.ink);
    doc.text(label, totalsX, y, { width: totalsW - 100 });
    doc.text(value, totalsX + totalsW - 96, y, { width: 96, align: "right" });
    y += 16;
  }

  totalRow("Смета итого", rub(data.subtotal));
  totalRow(`Скидка (${data.discountPercent}%)`, `− ${rub(data.discountAmount)}`);
  totalRow("Итого после скидки", rub(data.totalAfterDiscount), true);

  doc.end();
}
