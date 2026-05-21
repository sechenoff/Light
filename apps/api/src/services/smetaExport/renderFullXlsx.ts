import type { Response } from "express";
import ExcelJS from "exceljs";

import type { SmetaFullExportDocument } from "./types";
import { addSmetaSheetToWorkbook } from "./renderXlsx";
import { buildAttachmentContentDisposition } from "../../utils/contentDisposition";

const RUB_FMT = '#,##0.00" ₽"';

function parseMoney(s: string): number {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Двухlistовый workbook: «Смета» (main) + «Доб-смета» (addon).
 * Если `addon === null`, файл состоит из одного листа «Смета» (как и стандартный экспорт).
 */
export async function writeFullSmetaXlsx(
  res: Response,
  doc: SmetaFullExportDocument,
  downloadName: string,
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Light Rental";
  addSmetaSheetToWorkbook(wb, doc.main, "Смета");

  if (doc.addon) {
    addSmetaSheetToWorkbook(wb, doc.addon, "Доб-смета");
    const ws = wb.getWorksheet("Доб-смета");
    if (ws) {
      ws.addRow([]);
      const totalRow = ws.addRow([]);
      const labelCell = ws.getCell(totalRow.number, 1);
      labelCell.value = "ИТОГО к оплате (Согласовано + Доб):";
      labelCell.font = { bold: true, size: 11, color: { argb: "FF0F172A" } };
      labelCell.alignment = { horizontal: "right", vertical: "middle" };
      ws.mergeCells(totalRow.number, 1, totalRow.number, 5);

      const amountCell = ws.getCell(totalRow.number, 6);
      amountCell.value = parseMoney(doc.grandTotal);
      amountCell.numFmt = RUB_FMT;
      amountCell.font = { bold: true, size: 11, color: { argb: "FF0F172A" } };
      amountCell.alignment = { horizontal: "right", vertical: "middle" };
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  const nodeBuf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", buildAttachmentContentDisposition(downloadName, "estimate.xlsx"));
  res.setHeader("Content-Length", String(nodeBuf.length));
  res.end(nodeBuf);
}
