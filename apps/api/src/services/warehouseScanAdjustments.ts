/**
 * Корректировки количества на выдаче в киоске (степпер чек-листа).
 *
 * Меньше заказанного — позиция уменьшается (у штучной снимаются неотмеченные
 * резервы). Больше — добор на месте в пределах общей формулы склада
 * (`stockCap.computeAddCaps`): сверх свободного — только «под ответственность»
 * и только если позицию держит чужая бронь; сверх физического склада — нельзя.
 * Все проверки — до записей, всё — в транзакции завершения выдачи.
 */

import type { Booking, Prisma } from "@prisma/client";

import { HttpError } from "../utils/errors";
import { writeAuditEntry } from "./audit";
import { addonWindow, computeAddCaps, overStockError, reserveUnits, type AddCapInfo, type StockWindow } from "./stockCap";
import { findHoldersBatch, type AddonConflict } from "./addonAvailability";
import { SCAN_ERR } from "./scanSessionPolicy";
import { checklistOutdated, type CompletionCtx, type IssuanceAdjustment } from "./warehouseScanShared";

type AdjustItem = Prisma.BookingItemGetPayload<{
  include: {
    equipment: { select: { id: true; name: true; stockTrackingMode: true } };
    unitReservations: true;
  };
}>;

interface PlannedAdjustment {
  adj: IssuanceAdjustment;
  bi: AdjustItem;
  delta: number;
  /** Держатель, у которого берём «под ответственность» (только при подтверждении). */
  holder: AddonConflict | null;
}

/**
 * Применяет корректировки степпера. Сначала проверяются все строки (id,
 * потолки), потом пишется: любая ошибка откатывает транзакцию целиком.
 */
export async function applyIssuanceAdjustments(
  tx: Prisma.TransactionClient,
  ctx: CompletionCtx,
  booking: Booking,
  scans: Array<{ equipmentUnitId: string }>,
  auditUserId: string,
): Promise<{ changedItemIds: string[]; increasedItemIds: string[] }> {
  const latest = new Map<string, IssuanceAdjustment>();
  for (const a of ctx.options.issuanceAdjustments ?? []) latest.set(a.bookingItemId, a);
  if (latest.size === 0) return { changedItemIds: [], increasedItemIds: [] };

  const ids = Array.from(latest.keys());
  const items = await tx.bookingItem.findMany({
    where: { id: { in: ids }, bookingId: ctx.bookingId },
    include: {
      equipment: { select: { id: true, name: true, stockTrackingMode: true } },
      unitReservations: true,
    },
  });
  // Строки нет в брони — состав поменяли, пока был открыт чек-лист.
  const unknown = ids.filter((id) => !items.some((i) => i.id === id));
  if (unknown.length > 0) throw checklistOutdated(unknown);

  const planned: PlannedAdjustment[] = [];
  for (const bi of items) {
    const adj = latest.get(bi.id)!;
    if (!Number.isInteger(adj.actualQuantity) || adj.actualQuantity < 0) {
      throw new HttpError(400, "Количество должно быть целым числом не меньше нуля", "INVALID_ADJUSTMENTS", {
        bookingItemId: bi.id,
      });
    }
    const delta = adj.actualQuantity - bi.quantity;
    if (delta !== 0) planned.push({ adj, bi, delta, holder: null });
  }

  const window = addonWindow(booking, { issuingNow: true });
  await checkPositiveDeltas(tx, ctx.bookingId, window, planned);

  const scannedSet = new Set(scans.map((s) => s.equipmentUnitId));
  for (const p of planned) {
    await applyOneAdjustment(tx, ctx, p, { window, scannedSet, auditUserId });
  }
  return {
    changedItemIds: planned.map((p) => p.bi.id),
    increasedItemIds: planned.filter((p) => p.delta > 0).map((p) => p.bi.id),
  };
}

/**
 * Потолок добора степпером — та же формула, что у поиска и «+» (computeAddCaps
 * поверх витрины): сверх свободного — только «под ответственность» и только
 * если позицию держит чужая бронь; сверх физического склада — нельзя вовсе.
 */
async function checkPositiveDeltas(
  tx: Prisma.TransactionClient,
  bookingId: string,
  window: StockWindow,
  planned: PlannedAdjustment[],
): Promise<void> {
  const positive = planned.filter((p) => p.delta > 0 && p.bi.equipmentId);
  if (positive.length === 0) return;
  const caps = await computeAddCaps(tx, {
    bookingId,
    equipmentIds: positive.map((p) => p.bi.equipmentId!),
    window,
  });

  const needHolder: Array<{ p: PlannedAdjustment; cap: AddCapInfo }> = [];
  for (const p of positive) {
    const cap = caps.get(p.bi.equipmentId!);
    if (!cap) {
      throw new HttpError(404, "Оборудование не найдено", "EQUIPMENT_NOT_FOUND", { equipmentId: p.bi.equipmentId });
    }
    if (p.delta <= cap.addCap) continue;
    if (p.delta <= cap.ackCap) {
      needHolder.push({ p, cap });
      continue;
    }
    throw overStockError({
      bookingItemId: p.bi.id,
      equipmentId: cap.equipmentId,
      name: cap.name,
      addCap: p.adj.acknowledgedConflict ? cap.ackCap : cap.addCap,
      requested: p.adj.actualQuantity,
      alreadyInBooking: p.bi.quantity,
    });
  }
  if (needHolder.length === 0) return;

  const holders = await findHoldersBatch(tx, {
    equipmentIds: needHolder.map((x) => x.cap.equipmentId),
    start: window.start,
    end: window.end,
    excludeBookingId: bookingId,
  });
  for (const { p, cap } of needHolder) {
    const holder = holders.get(cap.equipmentId) ?? null;
    if (!holder) {
      // Не хватает не из-за чужой брони (мастерская, потери) — подвинуть некого.
      throw overStockError({
        bookingItemId: p.bi.id,
        equipmentId: cap.equipmentId,
        name: cap.name,
        addCap: cap.addCap,
        requested: p.adj.actualQuantity,
        alreadyInBooking: p.bi.quantity,
      });
    }
    if (!p.adj.acknowledgedConflict) {
      throw new HttpError(409, `«${cap.name}» занят на даты брони`, SCAN_ERR.ADDON_CONFLICT, {
        ...holder,
        bookingItemId: p.bi.id,
        equipmentId: cap.equipmentId,
        name: cap.name,
        requested: p.adj.actualQuantity,
        alreadyInBooking: p.bi.quantity,
      });
    }
    p.holder = holder;
  }
}

async function applyOneAdjustment(
  tx: Prisma.TransactionClient,
  ctx: CompletionCtx,
  p: PlannedAdjustment,
  env: { window: StockWindow; scannedSet: Set<string>; auditUserId: string },
): Promise<void> {
  const { bi, adj, delta } = p;
  const isUnit = bi.equipment?.stockTrackingMode === "UNIT";
  const auditBase = {
    tx,
    userId: env.auditUserId,
    entityType: "Booking" as const,
    entityId: ctx.bookingId,
  };

  if (delta < 0 && isUnit) {
    // Снимаем только неотмеченные резервы: отмеченный прибор уже в руках.
    const releasable = bi.unitReservations.filter((u) => !env.scannedSet.has(u.equipmentUnitId));
    const scannedCount = bi.unitReservations.length - releasable.length;
    if (releasable.length < -delta) {
      throw new HttpError(
        409,
        `Нельзя снять ${-delta} шт.: ${scannedCount} шт. уже отмечены на выдаче`,
        "ADJUSTMENT_CONFLICTS_WITH_SCANS",
        { bookingItemId: bi.id, scannedCount, requestedQuantity: adj.actualQuantity },
      );
    }
    for (const biu of releasable.slice(0, -delta)) {
      await tx.bookingItemUnit.delete({ where: { id: biu.id } });
      await writeAuditEntry({
        ...auditBase,
        action: "BOOKING_ITEM_UNIT_RELEASED",
        before: null,
        after: {
          bookingItemUnitId: biu.id,
          equipmentUnitId: biu.equipmentUnitId,
          sessionId: ctx.sessionId,
          workerName: ctx.completedBy,
        },
      });
    }
  }

  if (delta > 0 && isUnit && bi.equipmentId) {
    // Штучный добор — конкретные свободные экземпляры; в ISSUED их переведёт
    // сверка выдачи ниже (позиция без отметок выдаётся по резервам).
    await reserveUnits(tx, {
      bookingId: ctx.bookingId,
      bookingItemId: bi.id,
      equipmentId: bi.equipmentId,
      equipmentName: bi.equipment?.name ?? "Позиция",
      quantity: delta,
      start: env.window.start,
      end: env.window.end,
      issueNow: false,
    });
  }

  await tx.bookingItem.update({ where: { id: bi.id }, data: { quantity: adj.actualQuantity } });
  await writeAuditEntry({
    ...auditBase,
    action: delta > 0 ? "BOOKING_ITEM_QUANTITY_INCREASED" : "BOOKING_ITEM_QUANTITY_REDUCED",
    before: { quantity: bi.quantity },
    after: {
      quantity: adj.actualQuantity,
      delta,
      sessionId: ctx.sessionId,
      workerName: ctx.completedBy,
      equipmentId: bi.equipmentId,
      equipmentName: bi.equipment?.name ?? bi.customName ?? null,
    },
  });
  if (p.holder) {
    await writeAuditEntry({
      ...auditBase,
      action: "BOOKING_ITEM_ADDED_WITH_CONFLICT",
      before: null,
      after: {
        sessionId: ctx.sessionId,
        workerName: ctx.completedBy,
        equipmentId: bi.equipmentId,
        equipmentName: bi.equipment?.name ?? null,
        quantity: delta,
        via: "kiosk-stepper",
        conflictBookingId: p.holder.bookingId,
        conflictBookingNo: p.holder.bookingNo,
        conflictProjectName: p.holder.projectName,
        conflictHolderStatus: p.holder.holderStatus,
      },
    });
  }
}

/** Сколько строк получили добор в этой сессии: «+» в поиске и степпер сверх сметы. */
export async function countSessionAddons(
  tx: Prisma.TransactionClient,
  ctx: CompletionCtx,
  increasedItemIds: string[],
): Promise<number> {
  const records = await tx.addonRecord.findMany({
    where: { sessionId: ctx.sessionId },
    select: { bookingItemId: true },
  });
  const ids = new Set<string>([...records.map((r) => r.bookingItemId), ...increasedItemIds]);
  if (ids.size === 0) return 0;
  return tx.bookingItem.count({ where: { id: { in: Array.from(ids) }, quantity: { gt: 0 } } });
}
