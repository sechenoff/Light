/**
 * Импорт сметы SvetoBaza (формат с category-header rows).
 *
 * Формат сметы:
 *   Header row: "Перечень оборудования | Кол-во | Стоимость | Общая стоимость | ..."
 *   Body:       строки-категории (только col A) перемежаются с позициями (A=name, B=qty, C=price).
 *   Tail:       totals (Общая сумма / Сумма сметы / ...) — пропускаются.
 *
 * Использование:
 *   tsx scripts/import-smeta-may-2026.ts <path-to-xlsx>            # dry-run (по умолчанию)
 *   tsx scripts/import-smeta-may-2026.ts <path-to-xlsx> --apply    # реальная запись в БД
 *
 * Идемпотентен: upsert по importKey (category + name).
 * Не трогает существующие EquipmentUnit, сериалы, заказы.
 */
import * as path from "path";
import xlsx from "xlsx";
import { prisma } from "../src/prisma";
import { computeImportKey } from "../src/services/equipmentImport";

type ParsedRow = {
  category: string;
  name: string;
  qty: number;
  price: number;
  rowIndex: number; // 1-based for diagnostics
};

const CATEGORY_HEADER_RE = /^[А-ЯA-Z][а-яa-zА-ЯA-Z0-9\s/\-«»()«»"',.]+$/u;
const TOTALS_KEYWORDS = ["общая сумма", "сумма сметы", "сумма с"];

function toNumber(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v).trim().replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function isCategoryHeader(cells: unknown[]): boolean {
  const a = String(cells[0] ?? "").trim();
  if (!a) return false;
  // Категория = только col A заполнен (или col B,C пусты), и не содержит ключевых слов тоталов
  const low = a.toLowerCase();
  if (TOTALS_KEYWORDS.some((kw) => low.includes(kw))) return false;
  const bEmpty = String(cells[1] ?? "").trim() === "";
  const cEmpty = String(cells[2] ?? "").trim() === "";
  return bEmpty && cEmpty;
}

function isTotalsRow(cells: unknown[]): boolean {
  const a = String(cells[0] ?? "").trim();
  const d = String(cells[3] ?? "").trim();
  const low = (a + " " + d).toLowerCase();
  return TOTALS_KEYWORDS.some((kw) => low.includes(kw));
}

function parseSmeta(filePath: string): ParsedRow[] {
  const wb = xlsx.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" });

  // Найти header row («Перечень оборудования»)
  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const a = String((rows[i] ?? [])[0] ?? "").toLowerCase();
    if (a.includes("перечень") && a.includes("оборуд")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) throw new Error("Header row 'Перечень оборудования' not found");

  const parsed: ParsedRow[] = [];
  let currentCategory = "";

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const cells = rows[i] ?? [];
    const a = String(cells[0] ?? "").trim();
    if (!a) continue;
    if (isTotalsRow(cells)) continue;

    if (isCategoryHeader(cells)) {
      currentCategory = a;
      continue;
    }

    // Это equipment-строка
    const qty = toNumber(cells[1]);
    const price = toNumber(cells[2]);
    if (qty == null || price == null) {
      // мусорная строка — пропускаем
      continue;
    }
    if (!currentCategory) {
      // строка без категории — кладём в «Прочее»
      currentCategory = "Прочее";
    }
    parsed.push({
      category: currentCategory,
      name: a,
      qty,
      price,
      rowIndex: i + 1,
    });
  }

  return parsed;
}

type DiffEntry =
  | { kind: "create"; row: ParsedRow }
  | { kind: "price"; row: ParsedRow; oldPrice: number; newPrice: number; eqId: string }
  | { kind: "qty"; row: ParsedRow; oldQty: number; newQty: number; eqId: string }
  | { kind: "both"; row: ParsedRow; oldPrice: number; newPrice: number; oldQty: number; newQty: number; eqId: string }
  | { kind: "noop"; row: ParsedRow };

async function computeDiff(rows: ParsedRow[]): Promise<DiffEntry[]> {
  const diff: DiffEntry[] = [];
  for (const row of rows) {
    const importKey = computeImportKey({
      category: row.category,
      name: row.name,
      brand: "",
      model: "",
    });
    const existing = await prisma.equipment.findUnique({
      where: { importKey },
      select: { id: true, rentalRatePerShift: true, totalQuantity: true },
    });
    if (!existing) {
      diff.push({ kind: "create", row });
      continue;
    }
    const oldPrice = Number(existing.rentalRatePerShift);
    const oldQty = existing.totalQuantity;
    const priceChanged = oldPrice !== row.price;
    const qtyChanged = oldQty !== row.qty;
    if (priceChanged && qtyChanged) {
      diff.push({ kind: "both", row, oldPrice, newPrice: row.price, oldQty, newQty: row.qty, eqId: existing.id });
    } else if (priceChanged) {
      diff.push({ kind: "price", row, oldPrice, newPrice: row.price, eqId: existing.id });
    } else if (qtyChanged) {
      diff.push({ kind: "qty", row, oldQty, newQty: row.qty, eqId: existing.id });
    } else {
      diff.push({ kind: "noop", row });
    }
  }
  return diff;
}

function printDiff(diff: DiffEntry[]) {
  const created = diff.filter((d) => d.kind === "create").length;
  const priceUp = diff.filter((d) => d.kind === "price" || d.kind === "both").length;
  const qtyUp = diff.filter((d) => d.kind === "qty" || d.kind === "both").length;
  const noop = diff.filter((d) => d.kind === "noop").length;

  // eslint-disable-next-line no-console
  console.log("");
  // eslint-disable-next-line no-console
  console.log("═══ DIFF SUMMARY ═══");
  // eslint-disable-next-line no-console
  console.log(`  Новых позиций:      ${created}`);
  // eslint-disable-next-line no-console
  console.log(`  Изменение цены:     ${priceUp}`);
  // eslint-disable-next-line no-console
  console.log(`  Изменение кол-ва:   ${qtyUp}`);
  // eslint-disable-next-line no-console
  console.log(`  Без изменений:      ${noop}`);
  // eslint-disable-next-line no-console
  console.log(`  ───────────────────────`);
  // eslint-disable-next-line no-console
  console.log(`  Всего строк сметы:  ${diff.length}`);
  // eslint-disable-next-line no-console
  console.log("");

  // eslint-disable-next-line no-console
  console.log("═══ НОВЫЕ ПОЗИЦИИ ═══");
  for (const d of diff) {
    if (d.kind === "create") {
      // eslint-disable-next-line no-console
      console.log(`  + [${d.row.category}] ${d.row.name} · ${d.row.qty} шт · ${d.row.price} ₽/смена`);
    }
  }

  // eslint-disable-next-line no-console
  console.log("");
  // eslint-disable-next-line no-console
  console.log("═══ ИЗМЕНЕНИЯ ЦЕН ═══");
  for (const d of diff) {
    if (d.kind === "price") {
      const arrow = d.newPrice > d.oldPrice ? "↑" : "↓";
      // eslint-disable-next-line no-console
      console.log(`  ${arrow} [${d.row.category}] ${d.row.name}: ${d.oldPrice} → ${d.newPrice} ₽`);
    }
    if (d.kind === "both") {
      const arrow = d.newPrice > d.oldPrice ? "↑" : "↓";
      // eslint-disable-next-line no-console
      console.log(`  ${arrow} [${d.row.category}] ${d.row.name}: ${d.oldPrice} → ${d.newPrice} ₽ (+ кол-во ${d.oldQty}→${d.newQty})`);
    }
  }

  // eslint-disable-next-line no-console
  console.log("");
  // eslint-disable-next-line no-console
  console.log("═══ ИЗМЕНЕНИЯ КОЛ-ВА (без правки цены) ═══");
  for (const d of diff) {
    if (d.kind === "qty") {
      // eslint-disable-next-line no-console
      console.log(`  [${d.row.category}] ${d.row.name}: ${d.oldQty} → ${d.newQty} шт`);
    }
  }
}

async function apply(diff: DiffEntry[]) {
  let created = 0;
  let updated = 0;
  for (const d of diff) {
    if (d.kind === "noop") continue;
    const importKey = computeImportKey({
      category: d.row.category,
      name: d.row.name,
      brand: "",
      model: "",
    });
    await prisma.equipment.upsert({
      where: { importKey },
      update: {
        category: d.row.category,
        name: d.row.name,
        totalQuantity: d.row.qty,
        rentalRatePerShift: d.row.price,
      },
      create: {
        importKey,
        category: d.row.category,
        name: d.row.name,
        totalQuantity: d.row.qty,
        rentalRatePerShift: d.row.price,
        stockTrackingMode: "COUNT",
      },
    });
    if (d.kind === "create") created++;
    else updated++;
  }
  // eslint-disable-next-line no-console
  console.log(`\n✓ APPLIED: created=${created} updated=${updated}`);
}

async function main() {
  const filePathArg = process.argv[2];
  const applyFlag = process.argv.includes("--apply");
  if (!filePathArg) {
    // eslint-disable-next-line no-console
    console.error("Usage: tsx scripts/import-smeta-may-2026.ts <path-to-xlsx> [--apply]");
    process.exit(1);
  }
  const absPath = path.resolve(filePathArg);
  // eslint-disable-next-line no-console
  console.log(`▶ Reading: ${absPath}`);
  const parsed = parseSmeta(absPath);
  // eslint-disable-next-line no-console
  console.log(`  Распарсено строк оборудования: ${parsed.length}`);

  const diff = await computeDiff(parsed);
  printDiff(diff);

  if (applyFlag) {
    // eslint-disable-next-line no-console
    console.log("\n▶ Применяем изменения…");
    await apply(diff);
  } else {
    // eslint-disable-next-line no-console
    console.log("\n(dry-run — для записи добавьте флаг --apply)");
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
