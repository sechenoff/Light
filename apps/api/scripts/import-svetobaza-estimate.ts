import fs from "node:fs/promises";
import path from "node:path";

import xlsx from "xlsx";
import { commitEquipmentImport } from "../src/services/equipmentImport";

function toNumber(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v).trim().replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) throw new Error("Usage: tsx scripts/import-svetobaza-estimate.ts <xlsx-path>");

  const absolute = path.resolve(filePath);
  const srcBuffer = await fs.readFile(absolute);
  const wb = xlsx.read(srcBuffer, { type: "buffer" });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error("No worksheet found");

  const rows = xlsx.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: "" }) as unknown[][];
  if (rows.length < 2) throw new Error("Sheet looks empty");

  let currentCategory = "Без категории";
  const normalized: Array<Record<string, unknown>> = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const rawName = String(row[0] ?? "").trim();
    if (!rawName) continue;

    const qty = toNumber(row[1]);
    const price = toNumber(row[2]);

    // Category separator row (e.g. "COB Light") has no qty/price.
    if (qty == null && price == null) {
      currentCategory = rawName;
      continue;
    }

    // Only import real equipment lines with both qty and price.
    if (qty == null || price == null || qty <= 0 || price < 0) continue;

    normalized.push({
      "Перечень оборудования": rawName,
      "Кол-во": Math.round(qty),
      Стоимость: price,
      Категория: currentCategory,
      Комментарий: `Imported from ${path.basename(absolute)}`,
    });
  }

  if (normalized.length === 0) {
    throw new Error("No equipment rows were parsed from the estimate.");
  }

  const tempWb = xlsx.utils.book_new();
  const tempSheet = xlsx.utils.json_to_sheet(normalized, {
    header: ["Перечень оборудования", "Кол-во", "Стоимость", "Категория", "Комментарий"],
  });
  xlsx.utils.book_append_sheet(tempWb, tempSheet, "Import");
  const importBuffer = xlsx.write(tempWb, { type: "buffer", bookType: "xlsx" }) as Buffer;

  const result = await commitEquipmentImport({
    buffer: importBuffer,
    mapping: {
      category: "Категория",
      name: "Перечень оборудования",
      quantity: "Кол-во",
      rentalRatePerShift: "Стоимость",
      comment: "Комментарий",
    },
  });

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        file: absolute,
        parsedRows: normalized.length,
        categories: [...new Set(normalized.map((r) => String(r.Категория)))].length,
        result,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

