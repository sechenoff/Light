/**
 * «Реестр задолженности» в XLSX — та же таблица, что в PDF, но пригодная для
 * работы: отфильтровать, дописать колонку, отправить бухгалтеру.
 *
 * Лист настроен на печать (альбом, вписать по ширине, шапка повторяется на
 * каждой странице) — сотрудник печатает прямо из Excel, если не хочет PDF.
 */
import ExcelJS from "exceljs";

import { OVER_AGED_DAYS, type DebtReportDocument } from "./buildDebtReport";

const RUB_FMT = '#,##0.00\\ "₽"';
const X = {
  ink: "FF0F172A",
  ink2: "FF334155",
  muted: "FF64748B",
  accent: "FF1E3A8A",
  accentSoft: "FFEEF2FF",
  group: "FFF1F5F9",
  rose: "FF9F1239",
  roseSoft: "FFFFF1F2",
  hairline: "FFCBD5E1",
};

const fill = (argb: string): ExcelJS.Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
const thin = (argb = X.hairline): Partial<ExcelJS.Borders> => ({
  top: { style: "thin", color: { argb } },
  left: { style: "thin", color: { argb } },
  bottom: { style: "thin", color: { argb } },
  right: { style: "thin", color: { argb } },
});

const num = (v: { toString(): string }): number => Number(v.toString());

function fmtDate(d: Date | null): string {
  if (!d) return "—";
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
}

const HEADERS = [
  "№",
  "Клиент",
  "Проект от",
  "Проект",
  "Выставлено",
  "Оплачено",
  "Остаток",
  "Срок оплаты",
  "Просрочка, дней",
  "Дата контакта / результат",
];
const WIDTHS = [5, 30, 12, 38, 14, 14, 14, 13, 14, 34];
const LAST_COL = HEADERS.length;

export async function renderDebtReportXlsx(report: DebtReportDocument): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = report.org.name ?? "Light Rental";
  const ws = wb.addWorksheet("Задолженность", {
    pageSetup: {
      paperSize: 9, // A4
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    },
  });
  ws.columns = WIDTHS.map((w) => ({ width: w }));

  let row = 1;

  // Шапка
  ws.mergeCells(row, 1, row, LAST_COL);
  const title = ws.getCell(row, 1);
  title.value = `${report.title} — по состоянию на ${fmtDate(report.asOf)}`;
  title.font = { bold: true, size: 13, color: { argb: X.accent } };
  ws.getRow(row).height = 20;
  row++;

  const orgBits = [report.org.name, report.org.phone, report.org.email].filter(Boolean).join(" · ");
  if (orgBits) {
    ws.mergeCells(row, 1, row, LAST_COL);
    const org = ws.getCell(row, 1);
    org.value = orgBits;
    org.font = { size: 9, color: { argb: X.muted } };
    row++;
  }

  const t = report.totals;
  ws.mergeCells(row, 1, row, LAST_COL);
  const summary = ws.getCell(row, 1);
  summary.value =
    `Клиентов: ${t.clientsCount} · Долгов: ${t.bookingsCount} · ` +
    `Всего к взысканию: ${num(t.total).toLocaleString("ru-RU", { minimumFractionDigits: 2 })} ₽ · ` +
    `Просрочено: ${num(t.overdue).toLocaleString("ru-RU", { minimumFractionDigits: 2 })} ₽ · ` +
    `Старше ${OVER_AGED_DAYS} дней: ${t.overAgedCount}`;
  summary.font = { size: 10, bold: true, color: { argb: X.ink } };
  summary.fill = fill(X.accentSoft);
  ws.getRow(row).height = 18;
  row += 1;

  if (report.note) {
    ws.mergeCells(row, 1, row, LAST_COL);
    const note = ws.getCell(row, 1);
    note.value = report.note;
    note.font = { size: 9, color: { argb: X.ink2 } };
    note.alignment = { wrapText: true, vertical: "top" };
    row++;
  }
  row++;

  // Шапка таблицы — повторяется при печати на каждой странице
  const headerRow = row;
  HEADERS.forEach((h, i) => {
    const cell = ws.getCell(row, i + 1);
    cell.value = h;
    cell.font = { bold: true, size: 9, color: { argb: X.ink } };
    cell.fill = fill(X.accentSoft);
    cell.alignment = { vertical: "middle", horizontal: i >= 4 && i <= 6 ? "right" : "left", wrapText: true };
    cell.border = thin();
  });
  ws.getRow(row).height = 24;
  ws.pageSetup.printTitlesRow = `${headerRow}:${headerRow}`;
  ws.views = [{ state: "frozen", ySplit: row }];
  row++;

  let n = 0;
  for (const client of report.clients) {
    // Строка-разделитель клиента
    ws.mergeCells(row, 1, row, LAST_COL);
    const group = ws.getCell(row, 1);
    const contacts = report.includeContacts
      ? [client.phone, client.email].filter(Boolean).join(" · ")
      : "";
    group.value =
      `${client.legalName ?? client.clientName}` +
      (contacts ? `   ${contacts}` : "") +
      `   —   долгов: ${client.rows.length}, ${num(client.total).toLocaleString("ru-RU", { minimumFractionDigits: 2 })} ₽`;
    group.font = { bold: true, size: 10, color: { argb: client.overdue.gt(0) ? X.rose : X.ink } };
    group.fill = fill(X.group);
    group.alignment = { vertical: "middle" };
    ws.getRow(row).height = 18;
    row++;

    for (const r of client.rows) {
      const aged = (r.daysOverdue ?? 0) > OVER_AGED_DAYS;
      const values: Array<string | number | null> = [
        ++n,
        client.legalName ?? client.clientName,
        fmtDate(r.startDate),
        r.docNumber ? `${r.projectName} · ${r.docNumber}` : r.projectName,
        num(r.finalAmount),
        num(r.amountPaid),
        num(r.outstanding),
        fmtDate(r.expectedPaymentDate),
        r.daysOverdue !== null && r.daysOverdue > 0 ? r.daysOverdue : null,
        null, // графа для пометок — заполняется от руки или в Excel
      ];
      values.forEach((v, i) => {
        const cell = ws.getCell(row, i + 1);
        cell.value = v;
        cell.font = {
          size: 9,
          bold: i === 6,
          color: { argb: i === 6 && r.isOverdue ? X.rose : X.ink2 },
        };
        if (i >= 4 && i <= 6) cell.numFmt = RUB_FMT;
        cell.alignment = { vertical: "middle", horizontal: i >= 4 && i <= 6 ? "right" : "left" };
        cell.border = thin();
        if (aged) cell.fill = fill(X.roseSoft);
      });
      ws.getRow(row).height = 16;
      row++;
    }

    // Подытог клиента
    ws.mergeCells(row, 1, row, 6);
    const label = ws.getCell(row, 1);
    label.value = client.overdue.gt(0)
      ? `Итого по клиенту · просрочено ${num(client.overdue).toLocaleString("ru-RU", { minimumFractionDigits: 2 })} ₽`
      : "Итого по клиенту";
    label.font = { size: 9, bold: true, color: { argb: client.overdue.gt(0) ? X.rose : X.muted } };
    label.alignment = { horizontal: "right", vertical: "middle" };
    const sub = ws.getCell(row, 7);
    sub.value = num(client.total);
    sub.numFmt = RUB_FMT;
    sub.font = { size: 10, bold: true, color: { argb: X.ink } };
    sub.alignment = { horizontal: "right", vertical: "middle" };
    sub.border = thin();
    row += 2;
  }

  // Общий итог
  ws.mergeCells(row, 1, row, 6);
  const grandLabel = ws.getCell(row, 1);
  grandLabel.value = "ВСЕГО К ВЗЫСКАНИЮ";
  grandLabel.font = { bold: true, size: 11, color: { argb: X.accent } };
  grandLabel.fill = fill(X.accentSoft);
  grandLabel.alignment = { horizontal: "right", vertical: "middle" };
  const grand = ws.getCell(row, 7);
  grand.value = num(t.total);
  grand.numFmt = RUB_FMT;
  grand.font = { bold: true, size: 12, color: { argb: X.accent } };
  grand.fill = fill(X.accentSoft);
  grand.alignment = { horizontal: "right", vertical: "middle" };
  ws.getRow(row).height = 20;

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}
