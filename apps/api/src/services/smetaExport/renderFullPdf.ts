import type { Response } from "express";

import { writeSmetaPdf, writeSmetaPdfMulti } from "./renderPdf";
import type { SmetaFullExportDocument } from "./types";

/**
 * PDF: main page(s) + опционально addon page(s). Если addon = null,
 * результат идентичен одиночному main PDF (просто вызывает writeSmetaPdf).
 */
export function writeFullSmetaPdf(
  res: Response,
  doc: SmetaFullExportDocument,
  downloadName: string,
): void {
  if (!doc.addon) {
    writeSmetaPdf(res, doc.main, downloadName);
    return;
  }
  writeSmetaPdfMulti(res, [doc.main, doc.addon], downloadName, doc.grandTotal);
}
