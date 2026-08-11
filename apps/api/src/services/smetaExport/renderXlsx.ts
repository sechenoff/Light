import type { Response } from "express";
import ExcelJS from "exceljs";

import type { SmetaExportDocument, SmetaFullExportDocument, SmetaOrgInfo } from "./types";
import { buildAttachmentContentDisposition } from "../../utils/contentDisposition";

export const RUB_FMT = '#,##0.00" ₽"';

// Канон design-system.md в ARGB.
export const XC = {
  ink: "FF0F172A",
  ink2: "FF334155",
  muted: "FF64748B",
  faint: "FF94A3B8",
  border: "FFCBD5E1",
  hairline: "FFE2E8F0",
  zebra: "FFF8FAFC",
  headBg: "FFF1F5F9",
  accent: "FF1E3A8A",
  accentSoft: "FFEFF6FF",
  accentBorder: "FFBFDBFE",
} as const;

const LAST_COL = 5;

function parseMoney(s: string): number {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function todayRuLabel(): string {
  return new Date().toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}

function fill(color: string): ExcelJS.Fill {
  return { type: "pattern", pattern: "solid", fgColor: { argb: color } };
}

function borderAll(color: string): Partial<ExcelJS.Borders> {
  const b: Partial<ExcelJS.Border> = { style: "thin", color: { argb: color } };
  return { top: b, left: b, bottom: b, right: b } as Partial<ExcelJS.Borders>;
}

/** Полоса-«банд» на всю ширину таблицы (категория, ТРАНСПОРТ). */
function bandRow(sheet: ExcelJS.Worksheet, rowNo: number, text: string): void {
  sheet.mergeCells(rowNo, 1, rowNo, LAST_COL);
  const cell = sheet.getCell(rowNo, 1);
  cell.value = text.toUpperCase();
  cell.font = { bold: true, size: 9, color: { argb: XC.accent } };
  cell.fill = fill(XC.accentSoft);
  cell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  sheet.getRow(rowNo).height = 17;
}

/**
 * Добавляет один лист сметы в workbook и настраивает его под печать A4:
 * портрет, вписывание по ширине, поля, повтор шапки таблицы на каждой
 * странице, колонтитул «Стр. N из M».
 *
 * Возвращает номер следующей свободной строки (для транспорта/общего итога
 * в multi-sheet экспорте).
 */
export function addSmetaSheetToWorkbook(
  wb: ExcelJS.Workbook,
  data: SmetaExportDocument,
  sheetName: string,
): { sheet: ExcelJS.Worksheet; nextRow: number } {
  const sheet = wb.addWorksheet(sheetName, {
    views: [{ showGridLines: false }],
  });

  sheet.columns = [
    { width: 5 },
    { width: 52 },
    { width: 8 },
    { width: 15 },
    { width: 16 },
  ];

  let row = 1;

  // ── Реквизиты организации ───────────────────────────────────────────────────
  const org = data.org;
  if (org && (org.name || org.phone || org.address || org.email || org.inn)) {
    // Идентификаторы пишем независимо от юр. имени: раньше они лежали внутри
    // ветки `if (org.name)` и без имени пропадали из Excel совсем.
    const idBits = [org.inn ? `ИНН ${org.inn}` : null, org.kpp ? `КПП ${org.kpp}` : null]
      .filter(Boolean)
      .join("  ·  ");
    if (org.name || idBits) {
      if (org.name) {
        sheet.mergeCells(row, 1, row, 4);
        const c = sheet.getCell(row, 1);
        c.value = org.name;
        c.font = { bold: true, size: 13, color: { argb: XC.accent } };
        c.alignment = { vertical: "middle" };
      }
      if (idBits) {
        const innCell = sheet.getCell(row, LAST_COL);
        innCell.value = idBits;
        innCell.font = { size: 8, color: { argb: XC.faint } };
        innCell.alignment = { vertical: "middle", horizontal: "right" };
      }
      sheet.getRow(row).height = 20;
      row++;
    }
    const contactBits = [org.phone, org.email, org.address].filter(Boolean) as string[];
    if (contactBits.length > 0) {
      sheet.mergeCells(row, 1, row, LAST_COL);
      const c = sheet.getCell(row, 1);
      c.value = contactBits.join("  ·  ");
      c.font = { size: 8.5, color: { argb: XC.muted } };
      row++;
    }
    // Фирменная линия-отбивка — нижняя граница строки (заливка тонкой строки
    // в части просмотрщиков рендерится толстой полосой).
    for (let c = 1; c <= LAST_COL; c++) {
      sheet.getCell(row - 1, c).border = {
        bottom: { style: "medium", color: { argb: XC.accent } },
      };
    }
    row++;
  }

  // ── Заголовок документа ─────────────────────────────────────────────────────
  sheet.mergeCells(row, 1, row, 4);
  const titleCell = sheet.getCell(row, 1);
  titleCell.value = data.documentTitleRu;
  titleCell.font = { bold: true, size: 16, color: { argb: XC.ink } };
  titleCell.alignment = { vertical: "middle" };
  const genCell = sheet.getCell(row, LAST_COL);
  // Дата документа, а не «сегодня»: тот же лист, скачанный в другой день,
  // обязан выглядеть так же — иначе он не платёжный документ. В PDF это уже
  // исправлено, Excel оставался со штампом текущей даты.
  genCell.value = data.docNumber
    ? `№ ${data.docNumber} от ${data.issuedAtLabel}`
    : `от ${data.issuedAtLabel}`;
  genCell.font = { size: 8, color: { argb: XC.faint } };
  genCell.alignment = { vertical: "middle", horizontal: "right", wrapText: true };
  sheet.getRow(row).height = 24;
  row++;

  sheet.mergeCells(row, 1, row, LAST_COL);
  sheet.getCell(row, 1).value = data.documentTitleEn;
  sheet.getCell(row, 1).font = { size: 9, color: { argb: XC.muted } };
  row += 2;

  // ── Реквизиты сметы ────────────────────────────────────────────────────────
  const metaLine = (label: string, value: string, opts?: { boldValue?: boolean; wrap?: boolean }) => {
    const labelCell = sheet.getCell(row, 1);
    sheet.mergeCells(row, 1, row, 2);
    labelCell.value = label;
    labelCell.font = { bold: true, size: 8, color: { argb: XC.faint } };
    labelCell.alignment = { vertical: "top" };
    sheet.mergeCells(row, 3, row, LAST_COL);
    const valueCell = sheet.getCell(row, 3);
    valueCell.value = value;
    valueCell.font = { size: 10, bold: opts?.boldValue ?? false, color: { argb: XC.ink } };
    valueCell.alignment = { vertical: "top", wrapText: opts?.wrap ?? false };
    row++;
  };

  if (data.docNumber) metaLine("НОМЕР", data.docNumber, { boldValue: true });
  metaLine("ДАТА СОСТАВЛЕНИЯ", data.issuedAtLabel);
  metaLine("КЛИЕНТ", data.clientName, { boldValue: true });
  metaLine("ПРОЕКТ", data.projectName, { boldValue: true });
  metaLine("ВЫДАЧА", `${data.issueDateLabel}, ${data.loadOutTimeLabel}`);
  metaLine("ВОЗВРАТ", `${data.returnDateLabel}, ${data.returnLoadTimeLabel}`);
  metaLine("СМЕН В ПЕРИОДЕ", `${data.shiftsCount} (по 24 ч)`);
  metaLine("СРОК ОПЛАТЫ", data.paymentDueLabel ? `до ${data.paymentDueLabel}` : "по договорённости");
  if (data.hourCalculationText?.trim()) {
    metaLine("ПРОСЧЁТ ЧАСОВ", data.hourCalculationText.trim(), { wrap: true });
  }
  if (data.comment?.trim()) metaLine("КОММЕНТАРИЙ", data.comment.trim(), { wrap: true });
  if (data.includeOptionalInExport && data.optionalNote?.trim()) {
    metaLine("ДОПОЛНИТЕЛЬНО", data.optionalNote.trim(), { wrap: true });
  }
  row++;

  // ── Таблица позиций ────────────────────────────────────────────────────────
  const headerRow = row;
  const headers = ["№", "Наименование", "Кол-во", "Цена за смену", "Сумма"];
  headers.forEach((h, i) => {
    const c = sheet.getCell(row, i + 1);
    c.value = h;
    c.font = { bold: true, size: 9, color: { argb: XC.ink2 } };
    c.fill = fill(XC.headBg);
    c.border = borderAll(XC.border);
    c.alignment = {
      vertical: "middle",
      horizontal: i === 0 || i === 2 ? "center" : i >= 3 ? "right" : "left",
    };
  });
  sheet.getRow(row).height = 18;
  row++;

  // Группировка по категориям с сохранением порядка появления.
  const order: string[] = [];
  const grouped = new Map<string, typeof data.lines>();
  for (const line of data.lines) {
    const key = line.category?.trim() || "Прочее";
    if (!grouped.has(key)) {
      grouped.set(key, []);
      order.push(key);
    }
    grouped.get(key)!.push(line);
  }

  for (const category of order) {
    bandRow(sheet, row, category);
    row++;
    const items = grouped.get(category)!;
    items.forEach((line, i) => {
      const r = sheet.getRow(row);
      r.getCell(1).value = line.index;
      r.getCell(1).font = { size: 9, color: { argb: XC.faint } };
      r.getCell(1).alignment = { vertical: "middle", horizontal: "center" };

      // Персональная цена подписывается второй строкой в той же ячейке —
      // отдельная колонка ради редкого случая раздула бы таблицу на печати.
      r.getCell(2).value = line.listPricePerShift
        ? `${line.name}\nперсональная скидка · цена до скидки ${line.listPricePerShift} ₽`
        : line.name;
      r.getCell(2).font = { size: 10, color: { argb: XC.ink } };
      r.getCell(2).alignment = { vertical: "middle", wrapText: true };

      r.getCell(3).value = line.quantity;
      r.getCell(3).font = { size: 10, color: { argb: XC.ink } };
      r.getCell(3).alignment = { vertical: "middle", horizontal: "center" };

      r.getCell(4).value = parseMoney(line.pricePerShift);
      r.getCell(4).numFmt = RUB_FMT;
      r.getCell(4).font = { size: 10, color: { argb: XC.ink2 } };
      r.getCell(4).alignment = { vertical: "middle", horizontal: "right" };

      r.getCell(5).value = parseMoney(line.lineSum);
      r.getCell(5).numFmt = RUB_FMT;
      r.getCell(5).font = { size: 10, color: { argb: XC.ink } };
      r.getCell(5).alignment = { vertical: "middle", horizontal: "right" };

      for (let c = 1; c <= LAST_COL; c++) {
        const cell = r.getCell(c);
        cell.border = borderAll(XC.hairline);
        if (i % 2 === 1) cell.fill = fill(XC.zebra);
      }
      r.height = 18;
      row++;
    });
  }

  // ── Итоги листа ────────────────────────────────────────────────────────────
  row++;
  const addTotal = (label: string, amount: number, opts?: { bold?: boolean; muted?: boolean }) => {
    sheet.mergeCells(row, 1, row, 4);
    const l = sheet.getCell(row, 1);
    l.value = label;
    l.font = { bold: opts?.bold ?? false, size: 10, color: { argb: opts?.muted ? XC.muted : XC.ink } };
    l.alignment = { horizontal: "right", vertical: "middle" };
    const v = sheet.getCell(row, LAST_COL);
    v.value = amount;
    v.numFmt = RUB_FMT;
    v.font = { bold: opts?.bold ?? false, size: 10, color: { argb: opts?.muted ? XC.muted : XC.ink } };
    v.alignment = { horizontal: "right", vertical: "middle" };
    row++;
  };

  // База скидки печатается отдельно, когда в смете есть договорные позиции:
  // процент считается только от прайсовой части (см. renderPdf).
  if (data.listedSubtotal != null && data.negotiatedSubtotal != null) {
    addTotal("Оборудование по прайсу", parseMoney(data.listedSubtotal), { muted: true });
    if (Number(data.discountPercent) > 0) {
      addTotal(`Скидка ${data.discountPercent}%`, -parseMoney(data.discountAmount), { muted: true });
    }
    addTotal("Позиции по договорённости", parseMoney(data.negotiatedSubtotal), { muted: true });
  } else {
    addTotal("Оборудование итого", parseMoney(data.subtotal), { muted: true });
    if (Number(data.discountPercent) > 0) {
      addTotal(`Скидка ${data.discountPercent}%`, -parseMoney(data.discountAmount), { muted: true });
    }
  }
  const finalLabel = data.documentTitleRu === "Смета-добор" ? "Итого по доб-смете" : "Итого по смете";
  addTotal(finalLabel, parseMoney(data.totalAfterDiscount), { bold: true });

  // ── Печать: A4, портрет, по ширине листа, повтор шапки, колонтитулы ────────
  sheet.pageSetup = {
    paperSize: 9, // A4
    orientation: "portrait",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    horizontalCentered: true,
    margins: { left: 0.39, right: 0.39, top: 0.55, bottom: 0.55, header: 0.2, footer: 0.28 },
    printTitlesRow: `${headerRow}:${headerRow}`,
  };
  const footerLeft = [org?.name, org?.phone].filter(Boolean).join(" · ");
  sheet.headerFooter = {
    differentFirst: false,
    oddFooter: `${footerLeft ? `&L&8&K${XC.faint.slice(2)}${footerLeft}` : ""}&R&8&K${XC.faint.slice(2)}Стр. &P из &N`,
  };
  // Заморозка до шапки таблицы — удобство экранной работы, на печать не влияет.
  sheet.views = [{ state: "frozen", ySplit: headerRow, showGridLines: false }];

  return { sheet, nextRow: row };
}

/**
 * Транспорт + общий итог «К ОПЛАТЕ» в конец листа (последний лист multi-экспорта).
 * Возвращает следующую свободную строку.
 */
export function appendTransportAndGrandTotal(
  sheet: ExcelJS.Worksheet,
  startRow: number,
  full: SmetaFullExportDocument,
): number {
  let row = startRow + 1;

  if (full.transport) {
    bandRow(sheet, row, "Транспорт");
    row++;
    for (const line of full.transport.lines) {
      sheet.mergeCells(row, 1, row, 4);
      const nameCell = sheet.getCell(row, 1);
      nameCell.value = line.details ? `${line.name} — ${line.details}` : line.name;
      nameCell.font = { size: 10, color: { argb: XC.ink } };
      nameCell.alignment = { vertical: "middle", indent: 1 };
      const sumCell = sheet.getCell(row, LAST_COL);
      sumCell.value = parseMoney(line.sum);
      sumCell.numFmt = RUB_FMT;
      sumCell.font = { size: 10, color: { argb: XC.ink } };
      sumCell.alignment = { vertical: "middle", horizontal: "right" };
      for (let c = 1; c <= LAST_COL; c++) sheet.getCell(row, c).border = borderAll(XC.hairline);
      sheet.getRow(row).height = 18;
      row++;
    }
    sheet.mergeCells(row, 1, row, 4);
    const tl = sheet.getCell(row, 1);
    tl.value = "Транспорт итого";
    tl.font = { bold: true, size: 10, color: { argb: XC.ink } };
    tl.alignment = { horizontal: "right", vertical: "middle" };
    const tv = sheet.getCell(row, LAST_COL);
    tv.value = parseMoney(full.transport.subtotal);
    tv.numFmt = RUB_FMT;
    tv.font = { bold: true, size: 10, color: { argb: XC.ink } };
    tv.alignment = { horizontal: "right", vertical: "middle" };
    row += 2;
  }

  // Договорной итог: расчёт остаётся на листе отдельной строкой, платить — по
  // согласованной сумме. Молчаливая подмена цифры спорила бы со счётом.
  const hasAgreed = full.agreedTotal != null && full.agreedTotal !== full.grandTotal;
  if (hasAgreed) {
    sheet.mergeCells(row, 1, row, 4);
    const cl = sheet.getCell(row, 1);
    cl.value = "Итого по расчёту";
    cl.font = { size: 10, color: { argb: XC.muted } };
    cl.alignment = { horizontal: "right", vertical: "middle" };
    const cv = sheet.getCell(row, LAST_COL);
    cv.value = parseMoney(full.grandTotal);
    cv.numFmt = RUB_FMT;
    cv.font = { size: 10, color: { argb: XC.ink2 } };
    cv.alignment = { horizontal: "right", vertical: "middle" };
    row++;
  }
  const payable = hasAgreed ? (full.agreedTotal as string) : full.grandTotal;

  // Общий итог — акцентная плашка.
  sheet.mergeCells(row, 1, row, 4);
  const gl = sheet.getCell(row, 1);
  gl.value = "ИТОГО К ОПЛАТЕ";
  gl.font = { bold: true, size: 11, color: { argb: XC.accent } };
  gl.fill = fill(XC.accentSoft);
  gl.alignment = { horizontal: "right", vertical: "middle" };
  const gv = sheet.getCell(row, LAST_COL);
  gv.value = parseMoney(payable);
  gv.numFmt = RUB_FMT;
  gv.font = { bold: true, size: 12, color: { argb: XC.accent } };
  gv.fill = fill(XC.accentSoft);
  gv.alignment = { horizontal: "right", vertical: "middle" };
  for (let c = 1; c <= LAST_COL; c++) {
    sheet.getCell(row, c).border = borderAll(XC.accentBorder);
  }
  sheet.getRow(row).height = 22;
  return row + 1;
}

/**
 * Реквизиты для оплаты в конце листа — зеркало PDF-блока.
 *
 * Отдельной функцией, а не внутри общего итога: итог печатается не всегда
 * (у сметы без добора, транспорта и договорной суммы его нет), а сказать,
 * куда платить, платёжный документ обязан в любом случае.
 */
export function appendPaymentDetails(
  sheet: ExcelJS.Worksheet,
  startRow: number,
  org: SmetaOrgInfo | null | undefined,
): number {
  if (!org) return startRow;
  const details: Array<[string, string]> = [];
  if (org.name) details.push(["Получатель", org.name]);
  const idBits = [org.inn ? `ИНН ${org.inn}` : null, org.kpp ? `КПП ${org.kpp}` : null]
    .filter(Boolean)
    .join("  ·  ");
  if (idBits) details.push(["", idBits]);
  if (org.rschet) details.push(["Расчётный счёт", org.rschet]);
  if (org.bankName) details.push(["Банк", org.bankName]);
  if (org.bankBik) details.push(["БИК", org.bankBik]);
  if (org.kschet) details.push(["Корр. счёт", org.kschet]);
  if (details.length === 0) return startRow;

  let row = startRow + 1;
  bandRow(sheet, row, "Реквизиты для оплаты");
  row++;
  for (const [label, value] of details) {
    // Раскладка та же, что у реквизитов документа выше: подпись занимает A:B,
    // значение C:LAST_COL. В одной колонке A подписи не помещались — она
    // шириной 5 символов, и «Расчётный счёт» обрезался соседней ячейкой.
    sheet.mergeCells(row, 1, row, 2);
    const lc = sheet.getCell(row, 1);
    lc.value = label;
    lc.font = { size: 9, color: { argb: XC.muted } };
    lc.alignment = { vertical: "middle", indent: 1 };
    sheet.mergeCells(row, 3, row, LAST_COL);
    const vc = sheet.getCell(row, 3);
    vc.value = value;
    vc.font = { size: 10, color: { argb: XC.ink2 } };
    vc.alignment = { vertical: "middle" };
    row++;
  }
  return row;
}

export async function writeSmetaXlsx(res: Response, data: SmetaExportDocument, downloadName: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = data.org?.name ?? "Light Rental";
  addSmetaSheetToWorkbook(wb, data, "Смета");

  // Поток в `res` у ExcelJS на части стеков Express даёт битый/пустой файл — пишем в буфер.
  const buf = await wb.xlsx.writeBuffer();
  const nodeBuf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", buildAttachmentContentDisposition(downloadName, "estimate.xlsx"));
  res.setHeader("Content-Length", String(nodeBuf.length));
  res.end(nodeBuf);
}
