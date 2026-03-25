import type { Response } from "express";
import ExcelJS from "exceljs";

import type { SmetaExportDocument } from "./types";
import { buildAttachmentContentDisposition } from "../../utils/contentDisposition";

const RUB_FMT = '#,##0.00" ₽"';

function parseMoney(s: string): number {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

export async function writeSmetaXlsx(res: Response, data: SmetaExportDocument, downloadName: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Light Rental";
  const sheet = wb.addWorksheet("Смета", {
    views: [{ showGridLines: false }],
  });

  const lastCol = 6;
  let row = 1;

  const titleStyle: Partial<ExcelJS.Style> = {
    font: { bold: true, size: 18, color: { argb: "FF0F172A" } },
    alignment: { vertical: "middle" },
  };
  const labelStyle: Partial<ExcelJS.Style> = {
    font: { bold: true, size: 10, color: { argb: "FF64748B" } },
    alignment: { vertical: "middle" },
  };
  const valueStyle: Partial<ExcelJS.Style> = {
    font: { size: 10, color: { argb: "FF0F172A" } },
    alignment: { vertical: "middle" },
  };
  const sectionStyle: Partial<ExcelJS.Style> = {
    font: { bold: true, size: 11, color: { argb: "FF0F172A" } },
    alignment: { vertical: "middle" },
  };

  sheet.mergeCells(row, 1, row, lastCol);
  sheet.getCell(row, 1).value = data.documentTitleRu;
  sheet.getCell(row, 1).style = { ...titleStyle };
  row++;

  sheet.mergeCells(row, 1, row, lastCol);
  sheet.getCell(row, 1).value = data.documentTitleEn;
  sheet.getCell(row, 1).font = { size: 9, color: { argb: "FF64748B" } };
  row += 2;

  function metaLine(label: string, value: string) {
    sheet.getCell(row, 1).value = label;
    sheet.getCell(row, 1).style = { ...labelStyle };
    sheet.mergeCells(row, 2, row, lastCol);
    sheet.getCell(row, 2).value = value;
    sheet.getCell(row, 2).style = { ...valueStyle };
    row++;
  }

  metaLine("Дата выдачи", data.issueDateLabel);
  metaLine("Дата возврата", data.returnDateLabel);
  metaLine("Время погрузки (выдача)", data.loadOutTimeLabel);
  metaLine("Время погрузки (возврат)", data.returnLoadTimeLabel);
  metaLine("Клиент", data.clientName);
  metaLine("Проект", data.projectName);
  if (data.comment) metaLine("Комментарий", data.comment);
  if (data.includeOptionalInExport && data.optionalNote?.trim()) {
    metaLine("Дополнительно", data.optionalNote.trim());
  }

  row++;
  sheet.mergeCells(row, 1, row, lastCol);
  sheet.getCell(row, 1).value = "Просчёт часов сметы";
  sheet.getCell(row, 1).style = { ...sectionStyle };
  row++;
  sheet.mergeCells(row, 1, row, lastCol);
  sheet.getCell(row, 1).value = data.hourCalculationText;
  sheet.getCell(row, 1).font = { size: 10, color: { argb: "FF0F172A" } };
  sheet.getCell(row, 1).alignment = { wrapText: true, vertical: "top" };
  row += 2;

  sheet.mergeCells(row, 1, row, lastCol);
  sheet.getCell(row, 1).value = "Список аренды";
  sheet.getCell(row, 1).style = { ...sectionStyle };
  row++;

  const headerRow = row;
  const headers = ["№", "Наименование", "Категория", "Кол-во", "Цена за смену", "Сумма"];
  headers.forEach((h, i) => {
    const c = sheet.getCell(row, i + 1);
    c.value = h;
    c.font = { bold: true, size: 10, color: { argb: "FF0F172A" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };
    c.border = {
      top: { style: "thin", color: { argb: "FFCBD5E1" } },
      left: { style: "thin", color: { argb: "FFCBD5E1" } },
      bottom: { style: "thin", color: { argb: "FFCBD5E1" } },
      right: { style: "thin", color: { argb: "FFCBD5E1" } },
    };
    c.alignment = { vertical: "middle", wrapText: true };
  });
  row++;

  const thinBorder: Partial<ExcelJS.Borders> = {
    top: { style: "thin", color: { argb: "FFCBD5E1" } },
    left: { style: "thin", color: { argb: "FFCBD5E1" } },
    bottom: { style: "thin", color: { argb: "FFCBD5E1" } },
    right: { style: "thin", color: { argb: "FFCBD5E1" } },
  };

  for (const line of data.lines) {
    const r = sheet.getRow(row);
    r.getCell(1).value = line.index;
    r.getCell(2).value = line.name;
    r.getCell(3).value = line.category;
    r.getCell(4).value = line.quantity;
    r.getCell(5).value = parseMoney(line.pricePerShift);
    r.getCell(5).numFmt = RUB_FMT;
    r.getCell(6).value = parseMoney(line.lineSum);
    r.getCell(6).numFmt = RUB_FMT;
    for (let c = 1; c <= 6; c++) {
      const cell = r.getCell(c);
      cell.border = thinBorder as ExcelJS.Borders;
      cell.alignment = { vertical: "middle", wrapText: c === 2 || c === 3 };
      cell.font = { size: 10, color: { argb: "FF0F172A" } };
    }
    r.height = 18;
    row++;
  }

  sheet.columns = [
    { width: 6 },
    { width: 36 },
    { width: 22 },
    { width: 10 },
    { width: 16 },
    { width: 16 },
  ];

  row += 1;
  const totalsStart = row;
  function addTotal(label: string, amount: number, bold = false) {
    sheet.mergeCells(row, 1, row, 5);
    sheet.getCell(row, 1).value = label;
    sheet.getCell(row, 1).font = { bold, size: 11, color: { argb: "FF0F172A" } };
    sheet.getCell(row, 1).alignment = { horizontal: "right", vertical: "middle" };
    sheet.getCell(row, 6).value = amount;
    sheet.getCell(row, 6).numFmt = RUB_FMT;
    sheet.getCell(row, 6).font = { bold, size: 11, color: { argb: "FF0F172A" } };
    sheet.getCell(row, 6).alignment = { horizontal: "right", vertical: "middle" };
    row++;
  }

  addTotal("Смета итого", parseMoney(data.subtotal));
  addTotal(`Скидка (${data.discountPercent}%)`, -parseMoney(data.discountAmount));
  addTotal("Итого после скидки", parseMoney(data.totalAfterDiscount), true);

  for (let r = totalsStart; r < row; r++) {
    sheet.getCell(r, 6).border = thinBorder as ExcelJS.Borders;
  }

  sheet.getCell(headerRow, 1).border = thinBorder as ExcelJS.Borders;

  // Поток в `res` у ExcelJS на части стеков Express даёт битый/пустой файл — пишем в буфер.
  const buf = await wb.xlsx.writeBuffer();
  const nodeBuf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", buildAttachmentContentDisposition(downloadName, "estimate.xlsx"));
  res.setHeader("Content-Length", String(nodeBuf.length));
  res.end(nodeBuf);
}
