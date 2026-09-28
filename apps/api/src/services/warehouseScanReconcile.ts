/**
 * Физические последствия завершения сессии склада: сверка экземпляров
 * (штучный учёт), ремонты и потеряшки с приёмки, поздние возвраты потеряшек,
 * финансовая разбивка для экрана итога.
 *
 * То, что пишется внутри транзакции завершения, принимает её клиент; штучные
 * ремонты и потеряшки — после неё, каждая единица изолированно (у
 * createRepair / createProblemItem свои транзакции).
 */

import type { Prisma } from "@prisma/client";

import { prisma } from "../prisma";
import { writeAuditEntry } from "./audit";
import { assertProjectStockForBooking } from "./projectStockGuard";
import { createRepair } from "./repairService";
import { autoResolveOnReturn, createProblemItem, plannedStatus, writeOffFields } from "./problemItemService";
import { moveStagedToRepair } from "./repairPhotoStorage";
import { ensureSystemAuditUser } from "./scanSessionPolicy";
import {
  checklistOutdated,
  type CompletionCtx,
  type ProblemUnit,
  type ReconciliationSummary,
  type RepairUnit,
} from "./warehouseScanShared";

/** Клиент интерактивной транзакции (как у legacy-сервисов с тем же приёмом). */
type TxClient = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">;

// ── Сверка экземпляров (UNIT) ────────────────────────────────────────────────

/**
 * Выдача: позиция, по которой в сессии отмечены экземпляры, выдаётся по
 * отметкам (неотмеченные резервы снимаются, отмеченный чужой экземпляр —
 * замена). Позиция без отметок выдаётся по живым резервам, как ручная выдача
 * кнопкой: чек-лист выдачи отмечает строки, а не экземпляры, и раньше «Готово»
 * снимал все резервы, оставляя приборы «свободными» у клиента.
 */
export async function reconcileIssueUnits(
  tx: Prisma.TransactionClient,
  bookingId: string,
  scans: Array<{ equipmentUnitId: string; equipmentUnit: { id: string; equipmentId: string } }>,
  summary: ReconciliationSummary,
): Promise<void> {
  await assertProjectStockForBooking(tx, bookingId, [], scans.map((s) => s.equipmentUnitId));
  const bookingItems = await tx.bookingItem.findMany({ where: { bookingId } });
  const reservations = await tx.bookingItemUnit.findMany({
    where: { bookingItemId: { in: bookingItems.map((bi) => bi.id) } },
  });
  summary.expected = reservations.length;

  const byEquipment = new Map(
    bookingItems.filter((bi) => bi.equipmentId != null).map((bi) => [bi.equipmentId!, bi]),
  );
  const scannedUnitIds = new Set(scans.map((s) => s.equipmentUnitId));
  const scannedItemIds = new Set<string>();

  for (const scan of scans) {
    const unit = scan.equipmentUnit;
    await tx.equipmentUnit.update({ where: { id: unit.id }, data: { status: "ISSUED" } });
    const bi = byEquipment.get(unit.equipmentId);
    if (!bi) continue;
    scannedItemIds.add(bi.id);
    const reserved = reservations.some((r) => r.equipmentUnitId === unit.id && r.bookingItemId === bi.id);
    if (!reserved) {
      await tx.bookingItemUnit.create({ data: { bookingItemId: bi.id, equipmentUnitId: unit.id } });
      summary.substituted.push(unit.id);
    }
  }

  const issueByReservation: string[] = [];
  for (const r of reservations) {
    if (scannedItemIds.has(r.bookingItemId)) {
      if (scannedUnitIds.has(r.equipmentUnitId)) continue;
      summary.missing.push(r.equipmentUnitId);
      await tx.bookingItemUnit.delete({ where: { id: r.id } });
    } else if (r.returnedAt == null) {
      issueByReservation.push(r.equipmentUnitId);
    }
  }
  if (issueByReservation.length > 0) {
    // Как ручная выдача: только свободные → ISSUED; сломанные и пропавшие
    // остаются в своём статусе (они видны в «резерв недоступен»).
    await tx.equipmentUnit.updateMany({
      where: { id: { in: issueByReservation }, status: "AVAILABLE" },
      data: { status: "ISSUED" },
    });
  }
}

/**
 * Приёмка: отмеченные экземпляры — на полку. Переводятся только выданные и
 * числящиеся пропавшими (поздний возврат потеряшки): прибор в открытом ремонте
 * остаётся MAINTENANCE, списанный — RETIRED. Неотмеченные и не помеченные
 * ремонтом/проблемой — MISSING («не принято»).
 */
export async function reconcileReturnUnits(
  tx: Prisma.TransactionClient,
  ctx: CompletionCtx,
  scans: Array<{ equipmentUnitId: string }>,
  summary: ReconciliationSummary,
): Promise<void> {
  const bookingItems = await tx.bookingItem.findMany({ where: { bookingId: ctx.bookingId }, select: { id: true } });
  const reservations = await tx.bookingItemUnit.findMany({
    where: { bookingItemId: { in: bookingItems.map((bi) => bi.id) }, returnedAt: null },
  });
  summary.expected = reservations.length;
  const scannedUnitIds = new Set(scans.map((s) => s.equipmentUnitId));
  const returnedAt = new Date();

  for (const unitId of scannedUnitIds) {
    await tx.equipmentUnit.updateMany({
      where: { id: unitId, status: { in: ["ISSUED", "MISSING"] } },
      data: { status: "AVAILABLE" },
    });
    const reservation = reservations.find((r) => r.equipmentUnitId === unitId);
    if (reservation) {
      await tx.bookingItemUnit.update({ where: { id: reservation.id }, data: { returnedAt } });
    }
  }

  const flagged = new Set<string>();
  for (const r of ctx.options.repairUnits ?? []) if ("equipmentUnitId" in r) flagged.add(r.equipmentUnitId);
  for (const p of ctx.options.problemUnits ?? []) if ("equipmentUnitId" in p) flagged.add(p.equipmentUnitId);
  const missing = reservations
    .map((r) => r.equipmentUnitId)
    .filter((id) => !scannedUnitIds.has(id) && !flagged.has(id));
  summary.missing.push(...missing);
  if (missing.length > 0) {
    await tx.equipmentUnit.updateMany({
      where: { id: { in: missing }, status: "ISSUED" },
      data: { status: "MISSING" },
    });
  }
}

// ── Ремонты и потеряшки ──────────────────────────────────────────────────────

/**
 * Ремонты и потеряшки по количеству — внутри транзакции приёмки: повтор
 * «Готово» не заведёт их второй раз. Позиция каталога пишется прямой ссылкой:
 * правка состава брони задним числом пересоздаёт BookingItem, и без неё
 * сломанное вернулось бы в доступность. «Сломан безвозвратно» сразу
 * закрывается списанием (WROTE_OFF), а не уходит в «ищем».
 */
export async function createCountRepairsAndProblems(
  tx: Prisma.TransactionClient,
  ctx: CompletionCtx,
  summary: ReconciliationSummary,
): Promise<void> {
  const repairs = (ctx.options.repairUnits ?? []).filter(
    (r): r is Extract<RepairUnit, { bookingItemId: string }> => "bookingItemId" in r && !!r.bookingItemId,
  );
  const problems = (ctx.options.problemUnits ?? []).filter(
    (p): p is Extract<ProblemUnit, { bookingItemId: string }> => "bookingItemId" in p && !!p.bookingItemId,
  );
  if (repairs.length === 0 && problems.length === 0) return;

  const ids = Array.from(new Set([...repairs, ...problems].map((x) => x.bookingItemId)));
  const rows = await tx.bookingItem.findMany({
    where: { id: { in: ids }, bookingId: ctx.bookingId },
    select: { id: true, equipmentId: true },
  });
  const unknown = ids.filter((id) => !rows.some((r) => r.id === id));
  if (unknown.length > 0) throw checklistOutdated(unknown);
  const equipmentOf = new Map(rows.map((r) => [r.id, r.equipmentId]));

  for (const r of repairs) {
    const repair = await tx.repair.create({
      data: {
        bookingItemId: r.bookingItemId,
        equipmentId: equipmentOf.get(r.bookingItemId) ?? null,
        quantity: r.quantity,
        reason: r.comment,
        urgency: "NORMAL",
        status: "WAITING_REPAIR",
        sourceBookingId: ctx.bookingId,
        createdBy: ctx.completedBy,
        partsCost: 0,
        totalTimeHours: 0,
      },
    });
    summary.createdRepairIds.push(repair.id);
  }
  for (const p of problems) {
    const status = plannedStatus(p.reason);
    const pi = await tx.problemItem.create({
      data: {
        bookingItemId: p.bookingItemId,
        equipmentId: equipmentOf.get(p.bookingItemId) ?? null,
        quantity: p.quantity,
        sourceBookingId: ctx.bookingId,
        reason: p.reason,
        comment: p.comment,
        expectedBackDate: p.expectedBackDate ? new Date(p.expectedBackDate) : null,
        status,
        createdBy: ctx.completedBy,
        ...writeOffFields(status, "RETURN", ctx.completedBy),
      },
    });
    summary.createdProblemItemIds.push(pi.id);
  }
}

/**
 * Штучные ремонты — после транзакции, каждая единица изолированно: у
 * createRepair своя транзакция, и сбой одной единицы не должен откатить
 * физический возврат. Staged-фото поломки переносятся в карточку.
 */
export async function createUnitRepairs(ctx: CompletionCtx, summary: ReconciliationSummary): Promise<void> {
  for (const r of ctx.options.repairUnits ?? []) {
    if (!("equipmentUnitId" in r) || !r.equipmentUnitId) continue;
    try {
      const repair = await createRepair({
        unitId: r.equipmentUnitId,
        reason: r.comment,
        urgency: r.urgency ?? "NORMAL",
        sourceBookingId: ctx.bookingId,
        createdBy: ctx.completedBy,
      });
      summary.createdRepairIds.push(repair.id);
      const moved = moveStagedToRepair(ctx.sessionId, r.equipmentUnitId, repair.id);
      if (moved.length > 0) {
        await prisma.repairPhoto.createMany({
          data: moved.map((fp) => ({ repairId: repair.id, filePath: fp, createdBy: ctx.completedBy })),
        });
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("createRepair failed during scan completion", {
        unitId: r.equipmentUnitId,
        bookingId: ctx.bookingId,
        error: errMsg,
      });
      // Безопасность: сломанный прибор не должен уйти в аренду.
      await prisma.equipmentUnit
        .update({ where: { id: r.equipmentUnitId }, data: { status: "MAINTENANCE" } })
        .catch((fallbackErr: unknown) =>
          console.error("CRITICAL: failed to restore unit to MAINTENANCE", {
            unitId: r.equipmentUnitId,
            fallbackError: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
          }),
        );
      await auditRepairFailure(ctx, r, errMsg);
      summary.failedBrokenUnits.push({ unitId: r.equipmentUnitId, reason: r.comment, error: errMsg });
    }
  }
}

/**
 * Провал заведения ремонта — в журнал единицы (best-effort: журнал не должен
 * ронять уже состоявшуюся приёмку). Автор — как у аудита приёмки.
 */
async function auditRepairFailure(
  ctx: CompletionCtx,
  r: Extract<RepairUnit, { equipmentUnitId: string }>,
  error: string,
): Promise<void> {
  try {
    await writeAuditEntry({
      userId: ctx.options.auditUserId || (await ensureSystemAuditUser(prisma)),
      action: "REPAIR_CREATE_FAILED",
      entityType: "EquipmentUnit",
      entityId: r.equipmentUnitId,
      before: null,
      after: {
        reason: r.comment,
        urgency: r.urgency ?? "NORMAL",
        error,
        sessionId: ctx.sessionId,
        workerName: ctx.completedBy,
      },
    });
  } catch (auditErr: unknown) {
    console.error("[completeSession] REPAIR_CREATE_FAILED audit failed", auditErr);
  }
}

/** Штучные потеряшки — после транзакции, изолированно (у createProblemItem своя транзакция). */
export async function createUnitProblems(ctx: CompletionCtx, summary: ReconciliationSummary): Promise<void> {
  for (const p of ctx.options.problemUnits ?? []) {
    if (!("equipmentUnitId" in p) || !p.equipmentUnitId) continue;
    try {
      const pi = await createProblemItem({
        equipmentUnitId: p.equipmentUnitId,
        reason: p.reason,
        comment: p.comment,
        expectedBackDate: p.expectedBackDate ? new Date(p.expectedBackDate) : null,
        sourceBookingId: ctx.bookingId,
        createdBy: ctx.completedBy,
      });
      summary.createdProblemItemIds.push(pi.id);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[completeSession] problem unit ${p.equipmentUnitId} failed:`, err);
      summary.failedProblemUnits.push({ equipmentUnitId: p.equipmentUnitId, reason: errMsg });
    }
  }
}

/**
 * Поздний возврат единицы, помеченной потеряшкой В ПРОШЛОЙ приёмке, закрывает
 * её карточку. Единицы, помеченные в этой же приёмке, пропускаются — их новый
 * статус авторитетен. Best-effort после основной транзакции.
 */
export async function autoResolveLateReturns(ctx: CompletionCtx, scannedUnitIds: string[]): Promise<void> {
  const flaggedThisSession = new Set<string>();
  for (const p of ctx.options.problemUnits ?? []) if ("equipmentUnitId" in p) flaggedThisSession.add(p.equipmentUnitId);
  for (const r of ctx.options.repairUnits ?? []) if ("equipmentUnitId" in r) flaggedThisSession.add(r.equipmentUnitId);
  for (const unitId of new Set(scannedUnitIds)) {
    if (flaggedThisSession.has(unitId)) continue;
    try {
      await prisma.$transaction((tx: TxClient) => autoResolveOnReturn(tx, unitId, ctx.completedBy));
    } catch (e) {
      console.error("[completeSession] autoResolveOnReturn failed", unitId, e);
    }
  }
}

/** Финансовая разбивка для экрана итога — читаем после всех пересчётов. */
export async function fillFinanceSnapshot(bookingId: string, summary: ReconciliationSummary): Promise<void> {
  try {
    const fresh = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { estimates: { select: { kind: true, totalAfterDiscount: true } } },
    });
    if (!fresh) return;
    const main = fresh.estimates.find((e) => e.kind === "MAIN");
    const addon = fresh.estimates.find((e) => e.kind === "ADDON");
    summary.mainAfterDiscount = main ? main.totalAfterDiscount.toString() : "0";
    summary.addonAfterDiscount = addon ? addon.totalAfterDiscount.toString() : "0";
    summary.finalAmount = fresh.finalAmount.toString();
    summary.paymentStatus = fresh.paymentStatus;
    summary.amountPaid = fresh.amountPaid.toString();
    summary.bookingStatus = fresh.status;
    summary.manualFinalAmount = fresh.manualFinalAmount != null ? fresh.manualFinalAmount.toString() : null;
  } catch (err) {
    console.warn("[completeSession] finance snapshot read failed:", err);
  }
}
