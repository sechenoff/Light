import xlsx from "xlsx";
import { z } from "zod";
import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";

export type ExcelPreview = {
  sheetName: string;
  headers: string[];
  sampleRows: Record<string, unknown>[];
  suggestedMapping: Record<string, string>;
};

export const ImportMappingSchema = z.object({
  category: z.string().optional(),
  name: z.string().optional(),
  brand: z.string().optional(),
  model: z.string().optional(),
  quantity: z.string().optional(),
  rentalRatePerShift: z.string().optional(),
  comment: z.string().optional(),
  serialNumber: z.string().optional(),
  internalInventoryNumber: z.string().optional(),
});

function normalizeImportPart(s: unknown) {
  if (s == null) return "";
  return String(s).trim().replace(/\s+/g, " ").toUpperCase();
}

function computeImportKey(args: { category: string; name: string; brand?: string | null; model?: string | null }) {
  return [
    normalizeImportPart(args.category),
    normalizeImportPart(args.name),
    normalizeImportPart(args.brand ?? ""),
    normalizeImportPart(args.model ?? ""),
  ].join("||");
}

function toNumber(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v).trim().replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function splitSerials(value: unknown): string[] {
  if (value == null) return [];
  const s = String(value).trim();
  if (!s) return [];
  return s.split(/[,;]\s*/).map((x) => x.trim()).filter(Boolean);
}

export async function previewEquipmentImport(args: { buffer: Buffer }): Promise<ExcelPreview> {
  const workbook = xlsx.read(args.buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new HttpError(400, "Excel file has no sheets.");
  const sheet = workbook.Sheets[sheetName];

  // header:1 => array of rows.
  const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: "" }) as unknown[][];

  // Find first row that has at least one non-empty cell.
  const headerRowIndex = rows.findIndex((r) => r.some((cell) => String(cell ?? "").trim().length > 0));
  if (headerRowIndex < 0) throw new HttpError(400, "Excel appears empty.");
  const headerRow = rows[headerRowIndex].map((c) => String(c ?? "").trim()).filter((c) => c.length > 0);

  const headerSet = new Set(headerRow.map((h) => h.toLowerCase()));
  const suggestedMapping: Record<string, string> = {};

  const findHeader = (candidates: string[]) => {
    for (const c of candidates) {
      const found = headerRow.find((h) => h.toLowerCase().includes(c));
      if (found) return found;
    }
    return undefined;
  };

  // SvetoBaza смета: «Перечень оборудования», «Кол-во», «Стоимость» (без «Общая стоимость» / «Заказ…» / «Сумма аренды»).
  const nameFromSmeta = headerRow.find((h) => {
    const l = h.trim().toLowerCase();
    return l.includes("перечень") && l.includes("оборуд");
  });
  const quantityFromSmeta = headerRow.find((h) => {
    const l = h.trim().toLowerCase();
    if (l.includes("заказ")) return false;
    return l === "кол-во" || l === "количество" || /^кол-во\b/i.test(h.trim());
  });
  const priceFromSmeta = headerRow.find((h) => {
    const l = h.trim().toLowerCase();
    if (l.includes("общая")) return false;
    if (l.includes("сумма") && l.includes("аренд")) return false;
    return l === "стоимость" || (l.includes("стоим") && !l.includes("общ"));
  });

  const category = findHeader(["катег", "category"]);
  const name = nameFromSmeta ?? findHeader(["наимен", "name"]);
  const quantity = quantityFromSmeta ?? findHeader(["колич", "кол.", "quantity", "шт"]);
  const rentalRate = priceFromSmeta ?? findHeader(["цена", "price", "ставк"]);
  const comment = findHeader(["коммент", "comment", "примеч"]);
  const brand = findHeader(["бренд", "brand"]);
  const model = findHeader(["модель", "model"]);
  const serial = findHeader(["серий", "serial", "s/n", "sn", "sn#"]);
  const internal = findHeader(["инв", "инвентар", "inventory", "inv"]);

  if (category) suggestedMapping.category = category;
  if (name) suggestedMapping.name = name;
  if (quantity) suggestedMapping.quantity = quantity;
  if (rentalRate) suggestedMapping.rentalRatePerShift = rentalRate;
  if (comment) suggestedMapping.comment = comment;
  if (brand) suggestedMapping.brand = brand;
  if (model) suggestedMapping.model = model;
  if (serial) suggestedMapping.serialNumber = serial;
  if (internal) suggestedMapping.internalInventoryNumber = internal;

  // Build sample row objects keyed by header titles.
  const sampleRows: Record<string, unknown>[] = [];
  const max = Math.min(rows.length, headerRowIndex + 12);
  for (let i = headerRowIndex + 1; i < max; i++) {
    const row = rows[i] ?? [];
    const obj: Record<string, unknown> = {};
    for (let col = 0; col < headerRow.length; col++) {
      obj[headerRow[col]] = row[col] ?? "";
    }
    // Skip totally empty rows
    if (!Object.values(obj).some((v) => String(v ?? "").trim().length > 0)) continue;
    sampleRows.push(obj);
  }

  return { sheetName, headers: headerRow, sampleRows, suggestedMapping };
}

export async function commitEquipmentImport(args: {
  buffer: Buffer;
  mapping: z.infer<typeof ImportMappingSchema>;
}): Promise<{
  created: number;
  updated: number;
  unitsAdded: number;
}> {
  const parsed = ImportMappingSchema.safeParse(args.mapping);
  if (!parsed.success) throw new HttpError(400, "Invalid mapping.", parsed.error.flatten());
  const mapping = parsed.data;

  const workbook = xlsx.read(args.buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new HttpError(400, "Excel file has no sheets.");
  const sheet = workbook.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: "" }) as unknown[][];

  const headerRowIndex = rows.findIndex((r) => r.some((cell) => String(cell ?? "").trim().length > 0));
  if (headerRowIndex < 0) throw new HttpError(400, "Excel appears empty.");

  const headerRow = rows[headerRowIndex].map((c) => String(c ?? "").trim()).filter((c) => c.length > 0);
  const colIndexByHeader = new Map<string, number>();
  headerRow.forEach((h, idx) => colIndexByHeader.set(h, idx));

  const getCell = (row: unknown[], header?: string) => {
    if (!header) return "";
    const idx = colIndexByHeader.get(header);
    if (idx == null) return "";
    return row[idx] ?? "";
  };

  const requiredHeaders = [mapping.category, mapping.name].filter(Boolean) as string[];
  if (requiredHeaders.length < 2) {
    throw new HttpError(400, "Mapping must include at least `category` and `name` columns.");
  }
  if (!mapping.rentalRatePerShift) {
    throw new HttpError(400, "Mapping must include `rentalRatePerShift` column (price per shift).");
  }
  if (!mapping.quantity) {
    // For unit-based imports quantity can be inferred (quantity=1). Count-based needs it.
  }

  const equipmentRowsStart = headerRowIndex + 1;
  const maxRow = rows.length;

  let created = 0;
  let updated = 0;
  let unitsAdded = 0;

  for (let r = equipmentRowsStart; r < maxRow; r++) {
    const row = rows[r] ?? [];

    const category = String(getCell(row, mapping.category)).trim();
    const name = String(getCell(row, mapping.name)).trim();
    if (!category || !name) continue;

    const brand = String(getCell(row, mapping.brand)).trim() || null;
    const model = String(getCell(row, mapping.model)).trim() || null;
    const comment = String(getCell(row, mapping.comment)).trim() || null;
    const rate = toNumber(getCell(row, mapping.rentalRatePerShift)) ?? 0;
    const quantityNumber = toNumber(getCell(row, mapping.quantity));

    const serialValue = mapping.serialNumber ? getCell(row, mapping.serialNumber) : "";
    const internalValue = mapping.internalInventoryNumber ? getCell(row, mapping.internalInventoryNumber) : "";
    const serials = splitSerials(serialValue);
    const internalInventoryNumbers = splitSerials(internalValue);

    const hasUnitIdentifiers = serials.length > 0 || internalInventoryNumbers.length > 0;
    const stockTrackingMode: "COUNT" | "UNIT" = hasUnitIdentifiers ? "UNIT" : "COUNT";

    const qty =
      stockTrackingMode === "UNIT" ? Math.max(serials.length, internalInventoryNumbers.length, 1) : quantityNumber;

    if (stockTrackingMode === "COUNT" && (qty == null || !Number.isFinite(qty))) {
      throw new HttpError(400, `Missing/invalid quantity for count-based equipment at row ${r + 1}.`);
    }

    const importKey = computeImportKey({ category, name, brand, model });
    if (qty == null || !Number.isFinite(qty) || qty < 0) {
      throw new HttpError(400, `Invalid quantity at row ${r + 1}.`);
    }
    const safeQty: number = qty;
    const rentalRatePerShift = rate;

    // For count-based: quantity is total units. For unit-based: create units records.
    await prisma.$transaction(async (tx) => {
      const existing = await tx.equipment.findUnique({ where: { importKey } });

      if (!existing) {
        created += 1;
      } else {
        updated += 1;
        if (existing.stockTrackingMode !== stockTrackingMode) {
          const hasBlockingBookings = await tx.bookingItem.findFirst({
            where: {
              equipmentId: existing.id,
              booking: { status: { in: ["CONFIRMED", "ISSUED"] } },
            },
            select: { id: true },
          });
          if (hasBlockingBookings) {
            throw new HttpError(
              400,
              `Can't change inventory mode for equipment with active bookings. Existing: ${existing.stockTrackingMode}, import: ${stockTrackingMode}.`,
            );
          }
        }
      }

      const eq = await tx.equipment.upsert({
        where: { importKey },
        update: {
          stockTrackingMode,
          category,
          name,
          brand,
          model,
          comment,
          totalQuantity: safeQty,
          rentalRatePerShift,
        },
        create: {
          importKey,
          stockTrackingMode,
          category,
          name,
          brand,
          model,
          comment,
          totalQuantity: safeQty,
          rentalRatePerShift,
        },
      });

      if (stockTrackingMode === "UNIT") {
        const beforeCount = await tx.equipmentUnit.count({ where: { equipmentId: eq.id } });

        const serialCount = serials.length;
        const internalCount = internalInventoryNumbers.length;
        const count = Math.max(serialCount, internalCount, 1);
        const unitRecords: Array<{
          equipmentId: string;
          serialNumber?: string;
          internalInventoryNumber?: string;
          comment?: string | null;
        }> = [];

        for (let i = 0; i < count; i++) {
          const serialNumber = serials[i] ?? undefined;
          const internalInventoryNumber = internalInventoryNumbers[i] ?? undefined;
          if (!serialNumber && !internalInventoryNumber) continue;

          unitRecords.push({
            equipmentId: eq.id,
            serialNumber,
            internalInventoryNumber,
            comment: comment ?? undefined,
          });
        }

        // Filter out units already existing to avoid unique-constraint errors on SQLite.
        const existingSerials = new Set(
          (await tx.equipmentUnit.findMany({ where: { equipmentId: eq.id }, select: { serialNumber: true, internalInventoryNumber: true } }))
            .map((u) => `${u.serialNumber ?? ""}|${u.internalInventoryNumber ?? ""}`),
        );
        const newUnitRecords = unitRecords.filter(
          (u) => !existingSerials.has(`${u.serialNumber ?? ""}|${u.internalInventoryNumber ?? ""}`),
        );

        if (newUnitRecords.length > 0) {
          await tx.equipmentUnit.createMany({ data: newUnitRecords });
        }

        // Recompute totalQuantity from units to avoid mismatch due to duplicates.
        const unitCount = await tx.equipmentUnit.count({ where: { equipmentId: eq.id } });
        unitsAdded += Math.max(0, unitCount - beforeCount);

        await tx.equipment.update({
          where: { id: eq.id },
          data: { totalQuantity: unitCount },
        });
      } else {
        // Count-based mode: totalQuantity already set.
        await tx.equipment.update({
          where: { id: eq.id },
          data: { totalQuantity: safeQty },
        });
      }
    });
  }

  return { created, updated, unitsAdded };
}

