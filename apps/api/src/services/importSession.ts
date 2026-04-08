import xlsx from "xlsx";
import ExcelJS from "exceljs";
import stringSimilarity from "string-similarity";
import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { computeImportKey, normalizeImportPart } from "./equipmentImport";
import { Prisma, DiffAction, DiffRowStatus, ImportSessionStatus, ImportSessionType } from "@prisma/client";

// ──────────────────────────────────────────────────────────────────
// Типы
// ──────────────────────────────────────────────────────────────────

export interface ColumnMapping {
  category?: string;
  name?: string;
  brand?: string;
  model?: string;
  quantity?: string;
  rentalRatePerShift?: string;
  rentalRateTwoShifts?: string;
  rentalRatePerProject?: string;
}

export interface MatchRowInput {
  sourceName: string;
  sourceCategory: string | null;
  sourceBrand: string | null;
  sourceModel: string | null;
}

export interface MatchRowResult {
  equipmentId: string | null;
  matchConfidence: number | null;
  matchMethod: string | null;
}

type CatalogItem = {
  id: string;
  importKey: string;
  category: string;
  name: string;
  brand: string | null;
  model: string | null;
  totalQuantity: number;
  rentalRatePerShift: Prisma.Decimal;
  rentalRateTwoShifts: Prisma.Decimal | null;
  rentalRatePerProject: Prisma.Decimal | null;
};

// ──────────────────────────────────────────────────────────────────
// Вспомогательные функции
// ──────────────────────────────────────────────────────────────────

function toNumber(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v).trim().replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Флагирует подозрительные значения цены:
 * - ≤ 0
 * - > 10x текущей цены
 * - в диапазоне Excel-дат (40000-50000)
 */
function isSuspiciousPrice(newPrice: number | null, currentPrice: number | null): boolean {
  if (newPrice === null) return false;
  if (newPrice <= 0) return true;
  if (newPrice >= 40000 && newPrice <= 50000) return true;
  if (currentPrice !== null && currentPrice > 0 && newPrice > currentPrice * 10) return true;
  return false;
}

function readXlsxBuffer(buffer: Buffer): { headers: string[]; dataRows: unknown[][]; headerRowIndex: number } {
  const workbook = xlsx.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new HttpError(400, "Excel-файл не содержит листов.");
  const sheet = workbook.Sheets[sheetName];

  const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: "" }) as unknown[][];

  const headerRowIndex = rows.findIndex((r) => r.some((cell) => String(cell ?? "").trim().length > 0));
  if (headerRowIndex < 0) throw new HttpError(400, "Excel-файл пустой.");

  const headers = rows[headerRowIndex].map((c) => String(c ?? "").trim()).filter((c) => c.length > 0);
  const dataRows = rows.slice(headerRowIndex + 1);

  return { headers, dataRows, headerRowIndex };
}

function suggestColumnMapping(headers: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};

  const findHeader = (candidates: string[]) => {
    for (const c of candidates) {
      const found = headers.find((h) => h.toLowerCase().includes(c));
      if (found) return found;
    }
    return undefined;
  };

  // Основные поля
  const category = findHeader(["катег", "category"]);
  const name = (() => {
    const nameFromSmeta = headers.find((h) => {
      const l = h.trim().toLowerCase();
      return l.includes("перечень") && l.includes("оборуд");
    });
    return nameFromSmeta ?? findHeader(["наимен", "name"]);
  })();
  const quantity = (() => {
    const quantityFromSmeta = headers.find((h) => {
      const l = h.trim().toLowerCase();
      if (l.includes("заказ")) return false;
      return l === "кол-во" || l === "количество" || /^кол-во\b/i.test(h.trim());
    });
    return quantityFromSmeta ?? findHeader(["колич", "кол.", "quantity", "шт"]);
  })();
  const brand = findHeader(["бренд", "brand"]);
  const model = findHeader(["модель", "model"]);

  // Прайс-поля с multi-price эвристикой
  const rentalRatePerShift = (() => {
    // Ищем поле «за смену», исключая «2 смены» и «проект»
    const found = headers.find((h) => {
      const l = h.toLowerCase();
      if (l.includes("2") || l.includes("две") || l.includes("проект") || l.includes("project")) return false;
      return l.includes("цена") || l.includes("стоимость") || l.includes("смена") || l.includes("rate") || l.includes("price");
    });
    return found;
  })();

  const rentalRateTwoShifts = findHeader(["2 смен", "две смены", "2-day", "two shift"]);
  const rentalRatePerProject = findHeader(["проект", "project", "неделя", "week"]);

  if (category) mapping.category = category;
  if (name) mapping.name = name;
  if (quantity) mapping.quantity = quantity;
  if (brand) mapping.brand = brand;
  if (model) mapping.model = model;
  if (rentalRatePerShift) mapping.rentalRatePerShift = rentalRatePerShift;
  if (rentalRateTwoShifts) mapping.rentalRateTwoShifts = rentalRateTwoShifts;
  if (rentalRatePerProject) mapping.rentalRatePerProject = rentalRatePerProject;

  return mapping;
}

// ──────────────────────────────────────────────────────────────────
// createSession
// ──────────────────────────────────────────────────────────────────

export async function createSession(file: {
  buffer: Buffer;
  originalname: string;
  size: number;
}): Promise<{
  session: { id: string; status: string; fileName: string; fileSize: number; expiresAt: Date };
  preview: {
    headers: string[];
    sampleRows: Record<string, unknown>[];
    suggestedMapping: Record<string, string>;
  };
}> {
  // Валидация расширения
  const ext = file.originalname.split(".").pop()?.toLowerCase();
  if (ext !== "xlsx" && ext !== "xls") {
    throw new HttpError(400, "Допустимые форматы файла: .xlsx, .xls");
  }

  // Валидация размера (5 MB)
  const MAX_SIZE = 5 * 1024 * 1024;
  if (file.size > MAX_SIZE) {
    throw new HttpError(400, "Размер файла превышает 5 МБ");
  }

  // Валидация magic bytes
  if (ext === "xlsx") {
    // XLSX: PK header (50 4B 03 04)
    if (
      file.buffer[0] !== 0x50 ||
      file.buffer[1] !== 0x4b ||
      file.buffer[2] !== 0x03 ||
      file.buffer[3] !== 0x04
    ) {
      throw new HttpError(400, "Недопустимый формат файла XLSX");
    }
  } else if (ext === "xls") {
    // XLS: D0 CF 11 E0
    if (
      file.buffer[0] !== 0xd0 ||
      file.buffer[1] !== 0xcf ||
      file.buffer[2] !== 0x11 ||
      file.buffer[3] !== 0xe0
    ) {
      throw new HttpError(400, "Недопустимый формат файла XLS");
    }
  }

  // Парсим Excel
  const { headers, dataRows } = readXlsxBuffer(file.buffer);

  // Проверяем количество строк
  const nonEmptyRows = dataRows.filter((r) =>
    r.some((cell) => String(cell ?? "").trim().length > 0),
  );
  if (nonEmptyRows.length > 5000) {
    throw new HttpError(400, "Файл содержит более 5000 строк данных");
  }

  // Удаляем существующую активную OWN-сессию
  const existingSession = await prisma.importSession.findFirst({
    where: {
      type: ImportSessionType.OWN_PRICE_UPDATE,
      status: { notIn: [ImportSessionStatus.COMPLETED, ImportSessionStatus.EXPIRED] },
    },
  });
  if (existingSession) {
    await prisma.importSession.delete({ where: { id: existingSession.id } });
  }

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const session = await prisma.importSession.create({
    data: {
      type: ImportSessionType.OWN_PRICE_UPDATE,
      status: ImportSessionStatus.PARSING,
      fileName: file.originalname,
      fileSize: file.size,
      fileBuffer: file.buffer,
      expiresAt,
    },
  });

  // Генерируем preview
  const suggestedMapping = suggestColumnMapping(headers);
  const headerRowFull = headers;
  const sampleRows: Record<string, unknown>[] = [];
  const max = Math.min(nonEmptyRows.length, 10);
  for (let i = 0; i < max; i++) {
    const row = nonEmptyRows[i] ?? [];
    const obj: Record<string, unknown> = {};
    for (let col = 0; col < headerRowFull.length; col++) {
      obj[headerRowFull[col]] = row[col] ?? "";
    }
    sampleRows.push(obj);
  }

  return {
    session: {
      id: session.id,
      status: session.status,
      fileName: session.fileName,
      fileSize: session.fileSize,
      expiresAt: session.expiresAt,
    },
    preview: {
      headers,
      sampleRows,
      suggestedMapping,
    },
  };
}

// ──────────────────────────────────────────────────────────────────
// matchRow
// ──────────────────────────────────────────────────────────────────

export async function matchRow(
  row: MatchRowInput,
  catalog: CatalogItem[],
  competitorName?: string,
): Promise<MatchRowResult> {
  // Tier 1: exact match by importKey
  const importKey = computeImportKey({
    category: row.sourceCategory ?? "",
    name: row.sourceName,
    brand: row.sourceBrand,
    model: row.sourceModel,
  });

  const exactMatch = catalog.find((eq) => eq.importKey === importKey);
  if (exactMatch) {
    return {
      equipmentId: exactMatch.id,
      matchConfidence: 1.0,
      matchMethod: "exact",
    };
  }

  // Tier 2: dice similarity
  const names = catalog.map((eq) => eq.name);
  if (names.length === 0) {
    return { equipmentId: null, matchConfidence: null, matchMethod: null };
  }

  const bestMatch = stringSimilarity.findBestMatch(row.sourceName, names);
  if (bestMatch.bestMatch.rating >= 0.7) {
    const matched = catalog[bestMatch.bestMatchIndex];
    return {
      equipmentId: matched.id,
      matchConfidence: bestMatch.bestMatch.rating,
      matchMethod: "dice",
    };
  }

  return { equipmentId: null, matchConfidence: null, matchMethod: null };
}

// ──────────────────────────────────────────────────────────────────
// computeDiff (внутренний)
// ──────────────────────────────────────────────────────────────────

async function computeDiffForSession(sessionId: string): Promise<void> {
  const rows = await prisma.importSessionRow.findMany({
    where: { sessionId },
    include: { equipment: true },
  });

  for (const row of rows) {
    const update: Prisma.ImportSessionRowUpdateInput = {};

    if (!row.equipmentId || !row.equipment) {
      // Несопоставленная строка — NEW_ITEM
      update.action = DiffAction.NEW_ITEM;
      await prisma.importSessionRow.update({ where: { id: row.id }, data: update });
      continue;
    }

    if (row.action === DiffAction.REMOVED_ITEM) {
      // Already marked as removed in mapAndMatch
      continue;
    }

    const eq = row.equipment;

    const oldPrice = eq.rentalRatePerShift ? parseFloat(eq.rentalRatePerShift.toString()) : null;
    const oldPrice2 = eq.rentalRateTwoShifts ? parseFloat(eq.rentalRateTwoShifts.toString()) : null;
    const oldPriceProject = eq.rentalRatePerProject ? parseFloat(eq.rentalRatePerProject.toString()) : null;
    const oldQty = eq.totalQuantity;

    const newPrice = row.sourcePrice ? parseFloat(row.sourcePrice.toString()) : null;
    const newPrice2 = row.sourcePrice2 ? parseFloat(row.sourcePrice2.toString()) : null;
    const newPriceProject = row.sourcePriceProject ? parseFloat(row.sourcePriceProject.toString()) : null;
    const newQty = row.sourceQty;

    update.oldPrice = oldPrice !== null ? new Prisma.Decimal(oldPrice) : null;
    update.oldPrice2 = oldPrice2 !== null ? new Prisma.Decimal(oldPrice2) : null;
    update.oldPriceProject = oldPriceProject !== null ? new Prisma.Decimal(oldPriceProject) : null;
    update.oldQty = oldQty;

    // Detect suspicious price and mark in matchMethod
    let isFlagged = false;
    if (newPrice !== null && isSuspiciousPrice(newPrice, oldPrice)) {
      isFlagged = true;
    }
    if (newPrice2 !== null && isSuspiciousPrice(newPrice2, oldPrice2)) {
      isFlagged = true;
    }
    if (newPriceProject !== null && isSuspiciousPrice(newPriceProject, oldPriceProject)) {
      isFlagged = true;
    }

    if (isFlagged) {
      // Append FLAGGED marker to matchMethod
      update.matchMethod = (row.matchMethod ? row.matchMethod + ":FLAGGED" : "FLAGGED");
    }

    // Compute action
    const priceChanged =
      (newPrice !== null && oldPrice !== null && newPrice !== oldPrice) ||
      (newPrice2 !== null && oldPrice2 !== null && newPrice2 !== oldPrice2) ||
      (newPriceProject !== null && oldPriceProject !== null && newPriceProject !== oldPriceProject);

    const qtyChanged = newQty !== null && newQty !== oldQty;

    if (priceChanged) {
      update.action = DiffAction.PRICE_CHANGE;
      // Compute priceDelta from primary field
      if (newPrice !== null && oldPrice !== null && oldPrice > 0) {
        const delta = ((newPrice - oldPrice) / oldPrice) * 100;
        update.priceDelta = new Prisma.Decimal(delta.toFixed(2));
      } else if (newPrice2 !== null && oldPrice2 !== null && oldPrice2 > 0) {
        const delta = ((newPrice2 - oldPrice2) / oldPrice2) * 100;
        update.priceDelta = new Prisma.Decimal(delta.toFixed(2));
      } else if (newPriceProject !== null && oldPriceProject !== null && oldPriceProject > 0) {
        const delta = ((newPriceProject - oldPriceProject) / oldPriceProject) * 100;
        update.priceDelta = new Prisma.Decimal(delta.toFixed(2));
      }
    } else if (qtyChanged) {
      update.action = DiffAction.QTY_CHANGE;
    } else {
      update.action = DiffAction.NO_CHANGE;
    }

    await prisma.importSessionRow.update({ where: { id: row.id }, data: update });
  }
}

// ──────────────────────────────────────────────────────────────────
// mapAndMatch
// ──────────────────────────────────────────────────────────────────

export async function mapAndMatch(
  sessionId: string,
  type: "OWN_PRICE_UPDATE" | "COMPETITOR_IMPORT",
  mapping: ColumnMapping,
  competitorName?: string,
): Promise<void> {
  const session = await prisma.importSession.findUnique({ where: { id: sessionId } });
  if (!session) throw new HttpError(404, "Сессия не найдена");
  if (!session.fileBuffer) throw new HttpError(400, "Файл сессии не найден");

  const buffer = Buffer.from(session.fileBuffer);
  const { headers, dataRows } = readXlsxBuffer(buffer);

  // Build column index map
  const colIndex = new Map<string, number>();
  headers.forEach((h, idx) => colIndex.set(h, idx));

  const getCell = (row: unknown[], header?: string): unknown => {
    if (!header) return "";
    const idx = colIndex.get(header);
    if (idx == null) return "";
    return row[idx] ?? "";
  };

  // Load catalog
  const catalog = await prisma.equipment.findMany({
    select: {
      id: true,
      importKey: true,
      category: true,
      name: true,
      brand: true,
      model: true,
      totalQuantity: true,
      rentalRatePerShift: true,
      rentalRateTwoShifts: true,
      rentalRatePerProject: true,
    },
  }) as CatalogItem[];

  const matchedEquipmentIds = new Set<string>();
  const rowsToCreate: Prisma.ImportSessionRowCreateManyInput[] = [];

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i] ?? [];

    // Skip empty rows
    if (!row.some((cell) => String(cell ?? "").trim().length > 0)) continue;

    const sourceName = String(getCell(row, mapping.name) ?? "").trim();
    const sourceCategory = String(getCell(row, mapping.category) ?? "").trim() || null;
    const sourceBrand = String(getCell(row, mapping.brand) ?? "").trim() || null;
    const sourceModel = String(getCell(row, mapping.model) ?? "").trim() || null;
    const sourceQty = toNumber(getCell(row, mapping.quantity));
    const sourcePriceRaw = toNumber(getCell(row, mapping.rentalRatePerShift));
    const sourcePrice2Raw = toNumber(getCell(row, mapping.rentalRateTwoShifts));
    const sourcePriceProjectRaw = toNumber(getCell(row, mapping.rentalRatePerProject));

    if (!sourceName) continue;

    // Match row against catalog
    const matchResult = await matchRow(
      { sourceName, sourceCategory, sourceBrand, sourceModel },
      catalog,
      competitorName,
    );

    if (matchResult.equipmentId) {
      matchedEquipmentIds.add(matchResult.equipmentId);
    }

    rowsToCreate.push({
      sessionId,
      sourceIndex: i,
      sourceName,
      sourceCategory,
      sourceBrand,
      sourceModel,
      sourcePrice: sourcePriceRaw !== null ? new Prisma.Decimal(sourcePriceRaw) : null,
      sourcePrice2: sourcePrice2Raw !== null ? new Prisma.Decimal(sourcePrice2Raw) : null,
      sourcePriceProject: sourcePriceProjectRaw !== null ? new Prisma.Decimal(sourcePriceProjectRaw) : null,
      sourceQty: sourceQty !== null ? Math.round(sourceQty) : null,
      equipmentId: matchResult.equipmentId,
      matchConfidence: matchResult.matchConfidence,
      matchMethod: matchResult.matchMethod,
      action: DiffAction.NO_CHANGE,
      status: DiffRowStatus.PENDING,
    });
  }

  // For OWN_PRICE_UPDATE: reverse-scan catalog for REMOVED_ITEM
  if (type === "OWN_PRICE_UPDATE") {
    for (const eq of catalog) {
      if (!matchedEquipmentIds.has(eq.id)) {
        rowsToCreate.push({
          sessionId,
          sourceIndex: -1,
          sourceName: eq.name,
          sourceCategory: eq.category,
          sourceBrand: eq.brand,
          sourceModel: eq.model,
          sourcePrice: null,
          sourcePrice2: null,
          sourcePriceProject: null,
          sourceQty: null,
          equipmentId: eq.id,
          matchConfidence: 1.0,
          matchMethod: "catalog_reverse",
          action: DiffAction.REMOVED_ITEM,
          oldPrice: eq.rentalRatePerShift,
          oldPrice2: eq.rentalRateTwoShifts,
          oldPriceProject: eq.rentalRatePerProject,
          oldQty: eq.totalQuantity,
          status: DiffRowStatus.PENDING,
        });
      }
    }
  }

  // Batch insert rows
  if (rowsToCreate.length > 0) {
    await prisma.importSessionRow.createMany({ data: rowsToCreate });
  }

  // Compute diffs
  await computeDiffForSession(sessionId);

  // Clear fileBuffer and update session stats
  const totalRows = rowsToCreate.length;
  const matchedRows = rowsToCreate.filter((r) => r.equipmentId && r.action !== DiffAction.REMOVED_ITEM).length;
  const unmatchedRows = rowsToCreate.filter((r) => !r.equipmentId).length;

  await prisma.importSession.update({
    where: { id: sessionId },
    data: {
      fileBuffer: null,
      columnMapping: JSON.stringify(mapping),
      competitorName: competitorName ?? null,
      totalRows,
      matchedRows,
      unmatchedRows,
      status: ImportSessionStatus.REVIEW,
    },
  });
}

// ──────────────────────────────────────────────────────────────────
// applyChanges
// ──────────────────────────────────────────────────────────────────

export async function applyChanges(sessionId: string): Promise<{
  applied: { priceChanges: number; newItems: number; removedItems: number; qtyChanges: number };
  skipped: Array<{ rowId: string; sourceName: string; reason: string }>;
}> {
  const session = await prisma.importSession.findUnique({ where: { id: sessionId } });
  if (!session) throw new HttpError(404, "Сессия не найдена");
  if (session.type !== ImportSessionType.OWN_PRICE_UPDATE) {
    throw new HttpError(400, "Применение изменений доступно только для OWN_PRICE_UPDATE сессий");
  }

  // Optimistic lock: update only if status=REVIEW
  const updated = await prisma.importSession.updateMany({
    where: { id: sessionId, status: ImportSessionStatus.REVIEW },
    data: { status: ImportSessionStatus.APPLYING },
  });

  if (updated.count !== 1) {
    throw new HttpError(409, "Сессия уже применяется или завершена");
  }

  const acceptedRows = await prisma.importSessionRow.findMany({
    where: { sessionId, status: DiffRowStatus.ACCEPTED },
    include: { equipment: true },
  });

  const applied = { priceChanges: 0, newItems: 0, removedItems: 0, qtyChanges: 0 };
  const skipped: Array<{ rowId: string; sourceName: string; reason: string }> = [];

  // Process in chunks of 25 with 50ms delay
  const CHUNK_SIZE = 25;
  for (let i = 0; i < acceptedRows.length; i += CHUNK_SIZE) {
    const chunk = acceptedRows.slice(i, i + CHUNK_SIZE);

    for (const row of chunk) {
      try {
        if (row.action === DiffAction.PRICE_CHANGE) {
          const updateData: Prisma.EquipmentUpdateInput = {};
          if (row.sourcePrice !== null) updateData.rentalRatePerShift = row.sourcePrice;
          if (row.sourcePrice2 !== null) updateData.rentalRateTwoShifts = row.sourcePrice2;
          if (row.sourcePriceProject !== null) updateData.rentalRatePerProject = row.sourcePriceProject;

          await prisma.equipment.update({
            where: { id: row.equipmentId! },
            data: updateData,
          });
          applied.priceChanges++;

        } else if (row.action === DiffAction.NEW_ITEM) {
          const importKey = computeImportKey({
            category: row.sourceCategory ?? "",
            name: row.sourceName,
            brand: row.sourceBrand,
            model: row.sourceModel,
          });
          await prisma.equipment.create({
            data: {
              importKey,
              category: row.sourceCategory ?? "Прочее",
              name: row.sourceName,
              brand: row.sourceBrand,
              model: row.sourceModel,
              totalQuantity: row.sourceQty ?? 0,
              rentalRatePerShift: row.sourcePrice ?? new Prisma.Decimal(0),
              rentalRateTwoShifts: row.sourcePrice2,
              rentalRatePerProject: row.sourcePriceProject,
            },
          });
          applied.newItems++;

        } else if (row.action === DiffAction.REMOVED_ITEM) {
          // Check for active bookings
          const activeBooking = await prisma.bookingItem.findFirst({
            where: {
              equipmentId: row.equipmentId!,
              booking: { status: { in: ["CONFIRMED", "ISSUED"] } },
            },
          });

          if (activeBooking) {
            skipped.push({
              rowId: row.id,
              sourceName: row.sourceName,
              reason: "Невозможно удалить: есть активная бронь",
            });
            continue;
          }

          await prisma.equipment.delete({ where: { id: row.equipmentId! } });
          applied.removedItems++;

        } else if (row.action === DiffAction.QTY_CHANGE) {
          await prisma.equipment.update({
            where: { id: row.equipmentId! },
            data: { totalQuantity: row.sourceQty ?? 0 },
          });
          applied.qtyChanges++;
        }

        // Mark row as applied by leaving it ACCEPTED (no separate status needed)
      } catch (err) {
        skipped.push({
          rowId: row.id,
          sourceName: row.sourceName,
          reason: err instanceof Error ? err.message : "Неизвестная ошибка",
        });
      }
    }

    if (i + CHUNK_SIZE < acceptedRows.length) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  const appliedCount = applied.priceChanges + applied.newItems + applied.removedItems + applied.qtyChanges;

  await prisma.importSession.update({
    where: { id: sessionId },
    data: {
      status: ImportSessionStatus.COMPLETED,
      appliedCount,
    },
  });

  return { applied, skipped };
}

// ──────────────────────────────────────────────────────────────────
// exportComparison
// ──────────────────────────────────────────────────────────────────

export async function exportComparison(sessionId: string): Promise<Buffer> {
  const session = await prisma.importSession.findUnique({
    where: { id: sessionId },
    include: { rows: { include: { equipment: true } } },
  });

  if (!session) throw new HttpError(404, "Сессия не найдена");

  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Сравнение");

  if (session.type === ImportSessionType.OWN_PRICE_UPDATE) {
    sheet.addRow(["Позиция", "Категория", "Текущая цена", "Новая цена", "Δ%", "Действие", "Статус"]);
    for (const row of session.rows) {
      sheet.addRow([
        row.sourceName,
        row.sourceCategory ?? "",
        row.oldPrice?.toString() ?? "",
        row.sourcePrice?.toString() ?? "",
        row.priceDelta?.toString() ?? "",
        row.action,
        row.status,
      ]);
    }
  } else {
    sheet.addRow(["Позиция", "Категория", "Наша цена", "Цена конкурента", "Δ%", "Уверенность матча", "Метод матча"]);
    for (const row of session.rows) {
      sheet.addRow([
        row.sourceName,
        row.sourceCategory ?? "",
        row.oldPrice?.toString() ?? "",
        row.sourcePrice?.toString() ?? "",
        row.priceDelta?.toString() ?? "",
        row.matchConfidence?.toString() ?? "",
        row.matchMethod ?? "",
      ]);
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

// ──────────────────────────────────────────────────────────────────
// cleanExpired
// ──────────────────────────────────────────────────────────────────

export async function cleanExpired(): Promise<{ deleted: number }> {
  const result = await prisma.importSession.deleteMany({
    where: {
      type: ImportSessionType.OWN_PRICE_UPDATE,
      expiresAt: { lt: new Date() },
    },
  });
  return { deleted: result.count };
}

// ──────────────────────────────────────────────────────────────────
// updateRowStatus
// ──────────────────────────────────────────────────────────────────

export async function updateRowStatus(
  rowId: string,
  status: "ACCEPTED" | "REJECTED",
  equipmentId?: string,
): Promise<void> {
  const updateData: Prisma.ImportSessionRowUpdateInput = {
    status: status as DiffRowStatus,
  };
  if (equipmentId !== undefined) {
    updateData.equipmentId = equipmentId;
  }
  await prisma.importSessionRow.update({
    where: { id: rowId },
    data: updateData,
  });
}

// ──────────────────────────────────────────────────────────────────
// bulkAction
// ──────────────────────────────────────────────────────────────────

export async function bulkAction(
  sessionId: string,
  action: "ACCEPTED" | "REJECTED",
  filter: { action?: string },
): Promise<{ updated: number }> {
  // Build where clause
  const where: Prisma.ImportSessionRowWhereInput = { sessionId };

  if (filter.action) {
    where.action = filter.action as DiffAction;
  }

  if (action === "ACCEPTED") {
    // Exclude flagged rows (matchMethod contains "FLAGGED")
    // Also exclude rows with suspicious prices (sourcePrice <= 0)
    // We fetch them and filter manually
    const rows = await prisma.importSessionRow.findMany({ where });

    const rowsToAccept = rows.filter((row: any) => {
      // Exclude flagged
      if (row.matchMethod?.includes("FLAGGED")) return false;
      // Exclude if sourcePrice <= 0
      if (row.sourcePrice !== null) {
        const price = parseFloat(row.sourcePrice.toString());
        if (price <= 0) return false;
      }
      return true;
    });

    if (rowsToAccept.length === 0) return { updated: 0 };

    await prisma.importSessionRow.updateMany({
      where: { id: { in: rowsToAccept.map((r: any) => r.id) } },
      data: { status: DiffRowStatus.ACCEPTED },
    });

    return { updated: rowsToAccept.length };
  } else {
    const result = await prisma.importSessionRow.updateMany({
      where,
      data: { status: DiffRowStatus.REJECTED },
    });
    return { updated: result.count };
  }
}
