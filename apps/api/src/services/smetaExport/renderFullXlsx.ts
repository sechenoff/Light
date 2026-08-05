import type { Response } from "express";
import ExcelJS from "exceljs";

import type { SmetaFullExportDocument } from "./types";
import { addSmetaSheetToWorkbook, appendTransportAndGrandTotal } from "./renderXlsx";
import { buildAttachmentContentDisposition } from "../../utils/contentDisposition";

/**
 * Workbook полной сметы: лист «Смета» (main) + опционально «Доб-смета» (addon).
 * Транспорт и «ИТОГО К ОПЛАТЕ» дописываются в конец последнего листа — итог
 * всегда там, где заканчивается чтение документа.
 */
export async function writeFullSmetaXlsx(
  res: Response,
  doc: SmetaFullExportDocument,
  downloadName: string,
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = doc.main.org?.name ?? "Light Rental";

  const mainSheet = addSmetaSheetToWorkbook(wb, doc.main, "Смета");
  const last = doc.addon
    ? addSmetaSheetToWorkbook(wb, doc.addon, "Доб-смета")
    : mainSheet;

  if (doc.addon || doc.transport) {
    appendTransportAndGrandTotal(last.sheet, last.nextRow, doc);
  }

  const buf = await wb.xlsx.writeBuffer();
  const nodeBuf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", buildAttachmentContentDisposition(downloadName, "estimate.xlsx"));
  res.setHeader("Content-Length", String(nodeBuf.length));
  res.end(nodeBuf);
}
