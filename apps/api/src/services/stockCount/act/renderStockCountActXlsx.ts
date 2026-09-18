/**
 * «Акт инвентаризации» в XLSX — те же данные, что в PDF, но для работы:
 * отфильтровать, досортировать, отдать бухгалтеру.
 *
 *  - лист «Расхождения» — шапка акта, сводка и таблица расхождений с решениями;
 *  - лист «Все позиции» — каждая строка инвентаризации: сошлось / недостача /
 *    излишек / не посчитано.
 *
 * Количества — числами (по ним считают в Excel), время — строкой по Москве:
 * Date в ячейке exceljs пишет в UTC, и «09:30» превратилось бы в «06:30».
 * Оба листа настроены на печать: A4 альбом, вписать по ширине, шапка таблицы
 * повторяется на каждой странице и закреплена при прокрутке.
 */
import ExcelJS from "exceljs";

import {
  actStatusNotes,
  type StockCountActDocument,
} from "./buildStockCountAct";
import { fmtCountingWindow, fmtDate, fmtDateTime, fmtShortDateTime } from "./format";

const X = {
  ink: "FF0F172A",
  ink2: "FF334155",
  muted: "FF64748B",
  accent: "FF1E3A8A",
  accentSoft: "FFEEF2FF",
  rose: "FF9F1239",
  emerald: "FF047857",
  amber: "FF92400E",
  amberSoft: "FFFFFBEB",
  hairline: "FFCBD5E1",
};

/** «+2» / «−3» / «0» — знак виден, а значение остаётся числом. */
const DIFF_FMT = '+0;"−"0;0';

const fill = (argb: string): ExcelJS.Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
const thin = (argb = X.hairline): Partial<ExcelJS.Borders> => ({
  top: { style: "thin", color: { argb } },
  left: { style: "thin", color: { argb } },
  bottom: { style: "thin", color: { argb } },
  right: { style: "thin", color: { argb } },
});

function addSheet(wb: ExcelJS.Workbook, name: string, widths: number[]): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(name, {
    pageSetup: {
      paperSize: 9, // A4
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    },
    headerFooter: { oddFooter: "&LАкт инвентаризации&RСтр. &P из &N" },
  });
  ws.columns = widths.map((width) => ({ width }));
  return ws;
}

function titleOf(act: StockCountActDocument): string {
  const suffix = act.status === "OPEN" ? " — ЧЕРНОВИК" : act.status === "CANCELLED" ? " — ОТМЕНЕНА" : "";
  const date = act.isDraft ? `на ${fmtDateTime(act.docDate)}` : `от ${fmtDate(act.docDate)}`;
  return `Акт инвентаризации № ${act.number} ${date}${suffix}`;
}

function metaLine(act: StockCountActDocument): string {
  const parts = [`Охват: ${act.scope.label}`];
  if (act.counters.length > 0 && act.countingFrom && act.countingTo) {
    parts.push(`Считали: ${act.counters.join(", ")} (${fmtCountingWindow(act.countingFrom, act.countingTo, act.docDate)})`);
  }
  parts.push(`Начата: ${fmtShortDateTime(act.startedAt)}, ${act.startedBy}`);
  if (act.status === "CLOSED" && act.closedAt) {
    parts.push(`Завершена: ${fmtShortDateTime(act.closedAt)}${act.closedBy ? `, ${act.closedBy}` : ""}`);
  } else if (act.status === "CANCELLED" && act.cancelledAt) {
    parts.push(`Отменена: ${fmtShortDateTime(act.cancelledAt)}`);
  }
  parts.push("время московское");
  return parts.join(" · ");
}

function summaryLine(act: StockCountActDocument): string {
  const s = act.summary;
  return (
    `Посчитано: ${s.counted} из ${s.lines} · Сошлось: ${s.matched} · ` +
    `Недостача: ${s.shortagePositions} поз. / ${s.shortageQty} шт · ` +
    `Излишек: ${s.surplusPositions} поз. / ${s.surplusQty} шт · Не посчитано: ${s.uncounted}`
  );
}

/** Шапка акта над таблицей; возвращает номер следующей свободной строки. */
function writeDocHeader(ws: ExcelJS.Worksheet, act: StockCountActDocument, lastCol: number): number {
  let row = 1;
  const merged = (text: string, font: Partial<ExcelJS.Font>, extra?: (c: ExcelJS.Cell) => void) => {
    ws.mergeCells(row, 1, row, lastCol);
    const cell = ws.getCell(row, 1);
    cell.value = text;
    cell.font = font;
    cell.alignment = { vertical: "middle", wrapText: true };
    extra?.(cell);
    row++;
  };

  merged(titleOf(act), { bold: true, size: 13, color: { argb: act.isDraft ? X.amber : X.accent } });
  ws.getRow(1).height = 20;
  const org = [act.org.name, act.org.inn ? `ИНН ${act.org.inn}` : null, act.org.address, act.org.phone, act.org.email]
    .filter(Boolean)
    .join(" · ");
  if (org) merged(org, { size: 9, color: { argb: X.muted } });
  merged(metaLine(act), { size: 9, color: { argb: X.ink2 } });
  merged(summaryLine(act), { size: 10, bold: true, color: { argb: X.ink } }, (c) => {
    c.fill = fill(X.accentSoft);
  });
  for (const note of actStatusNotes(act)) {
    merged(note, { size: 9, color: { argb: act.status === "CLOSED" ? X.ink2 : X.amber } }, (c) => {
      if (act.status !== "CLOSED") c.fill = fill(X.amberSoft);
    });
  }
  return row + 1;
}

function writeTableHeader(ws: ExcelJS.Worksheet, row: number, headers: string[], numericCols: Set<number>): void {
  headers.forEach((h, i) => {
    const cell = ws.getCell(row, i + 1);
    cell.value = h;
    cell.font = { bold: true, size: 9, color: { argb: X.ink } };
    cell.fill = fill(X.accentSoft);
    cell.alignment = { vertical: "middle", horizontal: numericCols.has(i) ? "right" : "left", wrapText: true };
    cell.border = thin();
  });
  ws.getRow(row).height = 22;
  ws.pageSetup.printTitlesRow = `${row}:${row}`;
  ws.views = [{ state: "frozen", ySplit: row }];
}

function writeRow(
  ws: ExcelJS.Worksheet,
  row: number,
  values: Array<string | number | null>,
  numericCols: Set<number>,
  diffCol: number | null,
): void {
  values.forEach((v, i) => {
    const cell = ws.getCell(row, i + 1);
    cell.value = v;
    cell.font = { size: 9, color: { argb: X.ink2 } };
    cell.alignment = { vertical: "top", horizontal: numericCols.has(i) ? "right" : "left", wrapText: !numericCols.has(i) };
    cell.border = thin();
    if (i === diffCol && typeof v === "number") {
      cell.numFmt = DIFF_FMT;
      cell.font = { size: 9, bold: true, color: { argb: v < 0 ? X.rose : X.emerald } };
    }
  });
}

// ── Лист «Расхождения» ──────────────────────────────────────────────────────

const DISC_HEADERS = [
  "№",
  "Наименование",
  "Категория",
  "По учёту",
  "Факт",
  "Разница",
  "Решение",
  "Причина / примечание",
  "Посчитал",
  "Решение принял",
];
const DISC_WIDTHS = [5, 40, 18, 10, 9, 10, 38, 36, 16, 16];
const DISC_NUMERIC = new Set([0, 3, 4, 5]);

function writeDiscrepancies(ws: ExcelJS.Worksheet, act: StockCountActDocument): void {
  let row = writeDocHeader(ws, act, DISC_HEADERS.length);
  const headerRow = row;
  writeTableHeader(ws, row, DISC_HEADERS, DISC_NUMERIC);
  row++;
  if (act.discrepancies.length === 0) {
    ws.mergeCells(row, 1, row, DISC_HEADERS.length);
    const cell = ws.getCell(row, 1);
    cell.value = act.summary.counted > 0 ? "Расхождений нет — всё посчитанное сошлось с учётом." : "Ещё ничего не посчитано.";
    cell.font = { size: 9, italic: true, color: { argb: X.muted } };
    return;
  }
  act.discrepancies.forEach((r, i) => {
    writeRow(
      ws,
      row,
      [i + 1, r.name, r.category, r.expected, r.counted, r.diff, r.decisionLabel, r.note, r.countedBy, r.decidedBy],
      DISC_NUMERIC,
      5,
    );
    if (r.decisionState === "none") {
      ws.getCell(row, 7).font = { size: 9, bold: true, color: { argb: X.amber } };
    }
    row++;
  });
  ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: row - 1, column: DISC_HEADERS.length } };
}

// ── Лист «Все позиции» ──────────────────────────────────────────────────────

const ALL_HEADERS = [
  "№",
  "Наименование",
  "Категория",
  "Итог",
  "По учёту",
  "Факт",
  "Разница",
  "Решение",
  "Причина / примечание",
  "Посчитал",
  "Когда посчитано",
];
const ALL_WIDTHS = [5, 40, 18, 14, 10, 9, 10, 34, 30, 16, 16];
const ALL_NUMERIC = new Set([0, 4, 5, 6]);

type AllRow = {
  name: string;
  category: string;
  result: string;
  expected: number | null;
  counted: number | null;
  diff: number | null;
  decision: string | null;
  note: string | null;
  countedBy: string | null;
  countedAt: Date | null;
};

/** Все строки инвентаризации одной таблицей: расхождения, сошедшиеся, непосчитанные. */
function allRows(act: StockCountActDocument): AllRow[] {
  return [
    ...act.discrepancies.map((r) => ({
      name: r.name,
      category: r.category,
      result: r.diff < 0 ? "недостача" : "излишек",
      expected: r.expected,
      counted: r.counted,
      diff: r.diff,
      decision: r.decisionLabel,
      note: r.note,
      countedBy: r.countedBy,
      countedAt: r.countedAt,
    })),
    ...act.matched.map((r) => ({
      name: r.name,
      category: r.category,
      result: "сошлось",
      expected: r.qty,
      counted: r.qty,
      diff: 0,
      decision: null,
      note: null,
      countedBy: r.countedBy,
      countedAt: r.countedAt,
    })),
    ...act.uncounted.map((r) => ({
      name: r.name,
      category: r.category,
      result: "не посчитано",
      expected: null,
      counted: null,
      diff: null,
      decision: null,
      note: null,
      countedBy: null,
      countedAt: null,
    })),
  ];
}

const RESULT_COLOR: Record<string, string> = {
  недостача: X.rose,
  излишек: X.emerald,
  сошлось: X.ink2,
  "не посчитано": X.amber,
};

function writeAllPositions(ws: ExcelJS.Worksheet, act: StockCountActDocument): void {
  ws.mergeCells(1, 1, 1, ALL_HEADERS.length);
  const title = ws.getCell(1, 1);
  title.value = `${titleOf(act)} · все позиции`;
  title.font = { bold: true, size: 12, color: { argb: act.isDraft ? X.amber : X.accent } };
  ws.getRow(1).height = 18;

  let row = 3;
  const headerRow = row;
  writeTableHeader(ws, row, ALL_HEADERS, ALL_NUMERIC);
  row++;
  allRows(act).forEach((r, i) => {
    writeRow(
      ws,
      row,
      [
        i + 1,
        r.name,
        r.category,
        r.result,
        r.expected,
        r.counted,
        r.diff,
        r.decision,
        r.note,
        r.countedBy,
        r.countedAt ? fmtDateTime(r.countedAt) : null,
      ],
      ALL_NUMERIC,
      6,
    );
    ws.getCell(row, 4).font = { size: 9, color: { argb: RESULT_COLOR[r.result] ?? X.ink2 } };
    row++;
  });
  ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: Math.max(row - 1, headerRow), column: ALL_HEADERS.length } };
}

// ── Вход ────────────────────────────────────────────────────────────────────

export async function renderStockCountActXlsx(act: StockCountActDocument): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = act.org.name ?? "Light Rental";
  wb.created = act.generatedAt;

  writeDiscrepancies(addSheet(wb, "Расхождения", DISC_WIDTHS), act);
  writeAllPositions(addSheet(wb, "Все позиции", ALL_WIDTHS), act);

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}
