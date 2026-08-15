import type { Response } from "express";

import { writeSmetaPdf, writeSmetaPdfMulti } from "./renderPdf";
import type { SmetaFullExportDocument } from "./types";

/**
 * PDF полной сметы: main (+ addon с новой страницы) + транспорт + «ИТОГО К
 * ОПЛАТЕ». Без addon и транспорта результат идентичен одиночному main PDF.
 */
export function writeFullSmetaPdf(
  res: Response,
  doc: SmetaFullExportDocument,
  downloadName: string,
): void {
  // Договорной итог обязан попасть в документ даже когда нет ни добора, ни
  // транспорта: иначе одиночная смета напечатает расчётную сумму вместо той,
  // о которой договорились.
  if (!doc.addon && !doc.transport && doc.agreedTotal == null) {
    writeSmetaPdf(res, doc.main, downloadName);
    return;
  }
  const sections = doc.addon ? [doc.main, doc.addon] : [doc.main];
  writeSmetaPdfMulti(res, sections, downloadName, doc.grandTotal, doc.transport, doc.agreedTotal ?? null);
}
