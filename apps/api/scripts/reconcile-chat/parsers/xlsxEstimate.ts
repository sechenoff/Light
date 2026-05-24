import * as XLSX from "xlsx";

export interface ParsedEstimateRow {
  name: string;
  qty: number;
  unitPrice: number;
  lineSum: number;
  category?: string;
}

const TOTAL_HINTS = ["итого", "всего", "сумма сметы", "сумма заказа", "общая сумма"];
const HEADER_HINTS = ["перечень", "наименование", "кол-во", "цена"];

function isTotalRow(name: string): boolean {
  const lower = name.toLowerCase();
  return TOTAL_HINTS.some((h) => lower.startsWith(h));
}

function isHeaderRow(cells: unknown[]): boolean {
  const joined = cells.map((c) => String(c ?? "").toLowerCase()).join(" ");
  return HEADER_HINTS.some((h) => joined.includes(h));
}

function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const cleaned = v.replace(/\s/g, "").replace(",", ".");
    const n = parseFloat(cleaned);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

function nonEmpty(v: unknown): boolean {
  return v !== "" && v !== null && v !== undefined;
}

export function parseXlsxEstimate(filePath: string): ParsedEstimateRow[] {
  const wb = XLSX.readFile(filePath, { cellDates: false });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false });

  const result: ParsedEstimateRow[] = [];
  let currentCategory: string | undefined;

  for (const row of rows) {
    if (!Array.isArray(row) || row.length === 0) continue;
    if (isHeaderRow(row)) continue;
    const filledCells = row.filter(nonEmpty).length;
    const name = String(row[0] ?? "").trim();
    if (!name) continue;
    if (isTotalRow(name)) continue;
    // Single-cell row → category divider
    if (filledCells === 1) {
      currentCategory = name;
      continue;
    }
    // Item row: need at least name + qty
    const qty = toNum(row[1]);
    const unitPrice = toNum(row[2]);
    const lineSum = toNum(row[3]) || qty * unitPrice;
    if (qty <= 0 && lineSum <= 0) continue;
    result.push({ name, qty, unitPrice, lineSum, category: currentCategory });
  }
  return result;
}
