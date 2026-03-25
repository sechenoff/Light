import fs from "node:fs/promises";
import path from "node:path";

import xlsx from "xlsx";
import { prisma } from "../src/prisma";

function normalize(s: string) {
  return s.trim().replace(/\s+/g, " ").toUpperCase();
}

function toNumber(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v).trim().replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

type ParsedRow = {
  category: string;
  name: string;
  quantity: number;
  price: number;
};

async function main() {
  const filePath = process.argv[2];
  if (!filePath) throw new Error("Usage: tsx scripts/sync-svetobaza-full.ts <xlsx-path>");
  const absolute = path.resolve(filePath);

  const buffer = await fs.readFile(absolute);
  const workbook = xlsx.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("No sheet found.");

  const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "" }) as unknown[][];

  let currentCategory = "Без категории";
  const parsed: ParsedRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const rawName = String(row[0] ?? "").trim();
    if (!rawName) continue;

    const qty = toNumber(row[1]);
    const price = toNumber(row[2]);

    if (qty == null && price == null) {
      currentCategory = rawName;
      continue;
    }
    if (qty == null || qty <= 0 || price == null) continue;

    parsed.push({
      category: currentCategory,
      name: rawName,
      quantity: Math.round(qty),
      price,
    });
  }

  if (parsed.length === 0) throw new Error("No parsed equipment rows from file.");

  const allDb = await prisma.equipment.findMany({
    select: {
      id: true,
      category: true,
      name: true,
      brand: true,
      model: true,
    },
  });

  const byCategoryAndName = new Map<string, (typeof allDb)[number]>();
  const byName = new Map<string, (typeof allDb)[number]>();
  for (const e of allDb) {
    byCategoryAndName.set(`${normalize(e.category)}||${normalize(e.name)}`, e);
    if (!byName.has(normalize(e.name))) byName.set(normalize(e.name), e);
  }

  let updated = 0;
  let created = 0;
  let matchedByExact = 0;
  let matchedByNameOnly = 0;

  for (const p of parsed) {
    const exactKey = `${normalize(p.category)}||${normalize(p.name)}`;
    const nameKey = normalize(p.name);

    const exact = byCategoryAndName.get(exactKey);
    const fallbackByName = byName.get(nameKey);

    const target = exact ?? fallbackByName ?? null;
    if (target) {
      await prisma.equipment.update({
        where: { id: target.id },
        data: {
          category: p.category,
          name: p.name,
          totalQuantity: p.quantity,
          rentalRatePerShift: p.price,
        },
      });
      updated += 1;
      if (exact) matchedByExact += 1;
      else matchedByNameOnly += 1;
      continue;
    }

    await prisma.equipment.create({
      data: {
        importKey: `${normalize(p.category)}||${normalize(p.name)}||||`,
        stockTrackingMode: "COUNT",
        category: p.category,
        name: p.name,
        totalQuantity: p.quantity,
        rentalRatePerShift: p.price,
      },
    });
    created += 1;
  }

  const check = await prisma.equipment.findFirst({
    where: { name: { contains: "Aputure Electric storm 52XT" } },
    select: { category: true, name: true, totalQuantity: true, rentalRatePerShift: true },
  });

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        file: absolute,
        parsedRows: parsed.length,
        updated,
        created,
        matchedByExact,
        matchedByNameOnly,
        sampleCheck: check,
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

