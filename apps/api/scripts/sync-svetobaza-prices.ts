import fs from "node:fs/promises";
import path from "node:path";

import xlsx from "xlsx";
import { prisma } from "../src/prisma";

function normalize(s: string) {
  return s.trim().replace(/\s+/g, " ").toUpperCase();
}

function buildImportKey(category: string, name: string, brand?: string | null, model?: string | null) {
  return [normalize(category), normalize(name), normalize(brand ?? ""), normalize(model ?? "")].join("||");
}

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
  if (!filePath) {
    throw new Error("Usage: tsx scripts/sync-svetobaza-prices.ts <xlsx-path>");
  }
  const absolute = path.resolve(filePath);
  const buffer = await fs.readFile(absolute);
  const workbook = xlsx.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("No sheet found.");

  const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "" }) as unknown[][];
  let currentCategory = "Без категории";
  const priceByImportKey = new Map<string, number>();

  // Expected columns:
  // [0] Перечень оборудования
  // [1] Кол-во
  // [2] Стоимость
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const rawName = String(row[0] ?? "").trim();
    if (!rawName) continue;
    const qty = toNumber(row[1]);
    const price = toNumber(row[2]);

    // Section/category row.
    if (qty == null && price == null) {
      currentCategory = rawName;
      continue;
    }
    if (price == null) continue;

    const importKey = buildImportKey(currentCategory, rawName, null, null);
    priceByImportKey.set(importKey, price);
  }

  const existing = await prisma.equipment.findMany({
    where: { importKey: { in: [...priceByImportKey.keys()] } },
    select: { id: true, importKey: true, rentalRatePerShift: true, name: true, category: true },
  });

  const existingByKey = new Map(existing.map((e) => [e.importKey, e]));
  let matched = 0;
  let updated = 0;
  let unchanged = 0;
  const unmatched: Array<{ category: string; name: string; price: number }> = [];

  for (const [importKey, newPrice] of priceByImportKey.entries()) {
    const item = existingByKey.get(importKey);
    if (!item) {
      const [cat, name] = importKey.split("||");
      unmatched.push({ category: cat, name, price: newPrice });
      continue;
    }
    matched += 1;
    const oldPrice = Number(item.rentalRatePerShift.toString());
    if (Math.abs(oldPrice - newPrice) < 0.0001) {
      unchanged += 1;
      continue;
    }
    await prisma.equipment.update({
      where: { id: item.id },
      data: { rentalRatePerShift: newPrice },
    });
    updated += 1;
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        file: absolute,
        parsedRows: priceByImportKey.size,
        matched,
        updated,
        unchanged,
        unmatched: unmatched.length,
        unmatchedSample: unmatched.slice(0, 15),
      },
      null,
      2,
    ),
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });

