import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { parseLegacyExcelAmount } from "../legacyBookingExcel";

/**
 * Создаёт File из двумерного массива данных (имитация Excel-файла).
 */
function makeXlsxFile(rows: unknown[][], filename = "test.xlsx"): File {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Лист1");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return new File([buf], filename, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

describe("parseLegacyExcelAmount", () => {
  it("finds 'Сумма сметы с 50% скидкой' pattern → returns amount", async () => {
    const file = makeXlsxFile([
      ["Оборудование", "Количество", "Сумма"],
      ["Прожектор", 2, 10000],
      ["Стойка", 4, 2000],
      ["Сумма сметы со скидкой 30%", 22137],
    ]);
    const result = await parseLegacyExcelAmount(file);
    expect(result.amount).toBe(22137);
    expect(result.source).toBe("Сумма сметы со скидкой");
  });

  it("regex matches case-insensitive 'СУММА СМЕТЫ СО СКИДКОЙ'", async () => {
    const file = makeXlsxFile([
      ["Товар", "Цена"],
      ["Прожектор", 5000],
      ["СУММА СМЕТЫ СО СКИДКОЙ 10%", 4500],
    ]);
    const result = await parseLegacyExcelAmount(file);
    expect(result.amount).toBe(4500);
    expect(result.source).toBe("Сумма сметы со скидкой");
  });

  it("falls back to ИТОГО row when no сумм/скидк found", async () => {
    const file = makeXlsxFile([
      ["Оборудование", "Цена"],
      ["Прожектор", 15000],
      ["ИТОГО", 15000],
    ]);
    const result = await parseLegacyExcelAmount(file);
    expect(result.amount).toBe(15000);
    expect(result.source).toBe("ИТОГО");
  });

  it("returns unknown when no markers found", async () => {
    const file = makeXlsxFile([
      ["Оборудование", "Цена"],
      ["Прожектор", 15000],
      ["Стойка", 5000],
    ]);
    const result = await parseLegacyExcelAmount(file);
    expect(result.amount).toBeNull();
    expect(result.source).toBe("unknown");
  });

  it("iterates bottom-up: picks last matching row", async () => {
    const file = makeXlsxFile([
      ["Сумма сметы со скидкой 10%", 90000],
      ["Доп услуги", 5000],
      ["Сумма сметы со скидкой 20%", 80000],
    ]);
    const result = await parseLegacyExcelAmount(file);
    // Bottom-up → last row (index 2) is found first
    expect(result.amount).toBe(80000);
  });

  it("returns unknown for empty sheet", async () => {
    const file = makeXlsxFile([]);
    const result = await parseLegacyExcelAmount(file);
    expect(result.amount).toBeNull();
    expect(result.source).toBe("unknown");
  });
});
