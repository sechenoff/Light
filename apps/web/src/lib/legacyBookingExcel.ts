import * as XLSX from "xlsx";

export type ExcelAmountResult = {
  amount: number | null;
  source: "Сумма сметы со скидкой" | "ИТОГО" | "unknown";
  /** Полная строка найденной метки для диагностики */
  rawLabel?: string;
};

/**
 * Парсит Excel-файл сметы и извлекает итоговую сумму.
 *
 * Стратегия (по приоритету):
 * 1. Ищет строку, где ячейка A матчится `/сумм.*скидк/i` → возвращает ячейку B как amount
 * 2. Ищет любую ячейку с `/итого/i` → возвращает соседнюю числовую ячейку
 * 3. Возвращает amount=null, source="unknown"
 *
 * Итерация строк — снизу вверх.
 */
export async function parseLegacyExcelAmount(file: File): Promise<ExcelAmountResult> {
  const arrayBuffer = await file.arrayBuffer();
  const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: "array" });

  // Берём первый лист
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return { amount: null, source: "unknown" };
  }
  const sheet = workbook.Sheets[sheetName];

  // Конвертируем в массив строк (двумерный массив)
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null }) as unknown[][];

  // ─── Стратегия 1: ищем снизу "сумм.*скидк" в первой ячейке ─────────────
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    const cell0 = String(row[0] ?? "").trim();
    if (/сумм.*скидк/i.test(cell0)) {
      const val = row[1];
      const num = parseNumericCell(val);
      if (num !== null) {
        return { amount: num, source: "Сумма сметы со скидкой", rawLabel: cell0 };
      }
    }
  }

  // ─── Стратегия 2: ищем снизу "итого" в любой ячейке ────────────────────
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    for (let j = 0; j < row.length; j++) {
      const cellStr = String(row[j] ?? "").trim();
      if (/итого/i.test(cellStr)) {
        // Ищем ближайшую числовую ячейку справа или слева
        const rightVal = row[j + 1];
        const leftVal = j > 0 ? row[j - 1] : null;
        const num = parseNumericCell(rightVal) ?? parseNumericCell(leftVal);
        if (num !== null) {
          return { amount: num, source: "ИТОГО", rawLabel: cellStr };
        }
      }
    }
  }

  return { amount: null, source: "unknown" };
}

function parseNumericCell(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  if (typeof val === "number" && isFinite(val) && val > 0) return val;
  if (typeof val === "string") {
    const cleaned = val.replace(/\s/g, "").replace(",", ".");
    const n = parseFloat(cleaned);
    if (!isNaN(n) && n > 0) return n;
  }
  return null;
}
