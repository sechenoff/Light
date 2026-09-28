/**
 * Сервис управления сессиями склада (киоск): выдача (ISSUE) и приёмка (RETURN).
 *
 * Сессия привязана к брони и проходит состояния ACTIVE → COMPLETED | CANCELLED.
 * Какая сессия «живая», кто её закрывает и какие коды ошибок отдаются —
 * в `scanSessionPolicy.ts` (решения плана «Выдача и приёмка», раздел 0):
 *
 *  - ISSUE-сессия живая только на CONFIRMED-брони не в архиве, RETURN — только
 *    на ISSUED. Устаревшая сессия не завершается: 409 SESSION_STALE, и она
 *    закрывается (CANCELLED, reason STALE). Раньше «Готово» на забытом
 *    планшете возвращал принятую кнопкой бронь в «Выдана».
 *  - Завершение захватывает сессию первой записью транзакции (ACTIVE →
 *    COMPLETED по условию): повтор и параллельный «Готово» получают 409
 *    SESSION_ALREADY_COMPLETED, а не 500 и не двойные потеряшки.
 *  - Смена статуса брони, аудит, потеряшки и ремонты по количеству — в одной
 *    транзакции. Автор аудита — пользователь CRM или `_system_` с именем
 *    кладовщика в `after.workerName` (вход по PIN).
 *
 * Части: warehouseScanShared (типы), warehouseScanAdjustments (степпер
 * выдачи), warehouseScanReconcile (экземпляры, ремонты, потеряшки),
 * warehouseScanDetails (просмотр без изменений).
 */

import type { Booking, Prisma, ScanSession } from "@prisma/client";

import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { writeAuditEntry } from "./audit";
import { applyIssuanceToMainEstimate } from "./mainEstimate";
import { recomputeAddonEstimate } from "./addonEstimate";
import { recomputeBookingFinance } from "./finance";
import { recordReturnMileages } from "./vehicleService";
import { parseStoredDraft } from "./checklistDraft";
import {
  SCAN_ERR,
  SCAN_MSG,
  alreadyCompletedMessage,
  assertIssueNotTooEarly,
  assertSessionWritable,
  bookingWrongStatusMessage,
  closeActiveScanSessions,
  closedSessionError,
  computeItemsVersion,
  ensureSystemAuditUser,
  isIssueTooEarly,
  isSessionLive,
  staleSessionError,
  type CLIENT_CANCEL_REASONS,
} from "./scanSessionPolicy";
import {
  checklistOutdated,
  emptySummary,
  notFoundSession,
  presentScanSession,
  type CompleteSessionOptions,
  type CompletionCtx,
  type PresentedScanSession,
  type ReconciliationSummary,
  type ScanOperation,
} from "./warehouseScanShared";
import { applyIssuanceAdjustments, countSessionAddons } from "./warehouseScanAdjustments";
import {
  autoResolveLateReturns,
  createCountRepairsAndProblems,
  createUnitProblems,
  createUnitRepairs,
  fillFinanceSnapshot,
  reconcileIssueUnits,
  reconcileReturnUnits,
} from "./warehouseScanReconcile";

export * from "./warehouseScanShared";
export { getReconciliationPreview, getSessionWithDetails } from "./warehouseScanDetails";

/** Длинная приёмка (70+ строк, аудит и ремонты внутри) не должна упираться в дефолтные 5 с. */
const COMPLETE_TX_OPTIONS = { timeout: 20_000, maxWait: 10_000 } as const;

// ──────────────────────────────────────────────
// 5.1 createSession
// ──────────────────────────────────────────────

export interface CreatedScanSession extends PresentedScanSession {
  /** true — продолжена уже открытая живая сессия (плашка «Продолжена выдача…»). */
  resumed: boolean;
  /** Устаревшие ACTIVE-сессии брони, которые закрыты при этом открытии. */
  closedStaleSessionIds: string[];
}

function assertBookingOpenable(
  booking: Pick<Booking, "status" | "deletedAt">,
  operation: ScanOperation,
): void {
  if (booking.status === "CANCELLED") {
    throw new HttpError(409, "Бронь отменена", "BOOKING_CANCELLED");
  }
  if (operation === "ISSUE" && booking.status === "CONFIRMED" && booking.deletedAt) {
    throw new HttpError(
      409,
      "Бронь в архиве — выдачу в киоске не открыть. Сначала восстановите её из архива.",
      "BOOKING_ARCHIVED",
    );
  }
  if (!isSessionLive(operation, booking)) {
    throw new HttpError(409, bookingWrongStatusMessage(operation, booking.status), SCAN_ERR.BOOKING_WRONG_STATUS, {
      status: booking.status,
    });
  }
}

/**
 * Открывает сессию склада по брони или продолжает уже открытую.
 *
 * - Выдача — только на подтверждённой брони не в архиве, приёмка — только на
 *   выданной (иначе 409 BOOKING_WRONG_STATUS с понятным текстом).
 * - Живая ACTIVE-сессия той же операции продолжается (`resumed: true`):
 *   кладовщик закрыл вкладку посередине и вернулся.
 * - Устаревшие ACTIVE-сессии брони (например, выдача, брошенная до того, как
 *   бронь выдали кнопкой) закрываются в той же транзакции — `closedStaleSessionIds`.
 */
export async function createSession(
  bookingId: string,
  workerName: string,
  operation: ScanOperation,
): Promise<CreatedScanSession> {
  const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
  if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
  if (booking.mode === "PROJECT") {
    throw new HttpError(
      409,
      "Откройте карточку проекта и выберите конкретную поставку для выдачи или частичного возврата",
      "PROJECT_ACTION_REQUIRED",
    );
  }
  assertBookingOpenable(booking, operation);

  return prisma.$transaction(async (tx) => {
    const fresh = await tx.booking.findUnique({
      where: { id: bookingId },
      select: { status: true, deletedAt: true },
    });
    if (!fresh) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
    assertBookingOpenable(fresh, operation);

    const active = await tx.scanSession.findMany({
      where: { bookingId, status: "ACTIVE" },
      select: { id: true, operation: true },
    });
    const staleIds = active.filter((s) => !isSessionLive(s.operation, fresh)).map((s) => s.id);
    const closed = await closeActiveScanSessions(tx, bookingId, { reason: "STALE", onlyIds: staleIds });

    const existing = await tx.scanSession.findFirst({
      where: { bookingId, operation, status: "ACTIVE" },
      orderBy: { startedAt: "asc" },
    });
    const row =
      existing ??
      (await tx.scanSession.create({
        data: { bookingId, workerName, operation, status: "ACTIVE" },
      }));
    return {
      ...presentScanSession(row),
      resumed: existing != null,
      closedStaleSessionIds: closed.map((c) => c.id),
    };
  });
}

// ──────────────────────────────────────────────
// 5.2 recordScan — REMOVED
//
// Складской UI переписан на чек-лист (/state, /check, /uncheck, /items,
// /complete) — путь со сканером штрихкодов мёртвый. Резолв штрихкода
// (resolveBarcode) живёт в services/barcode.ts для /api/equipment-units/lookup.
// ──────────────────────────────────────────────

// ──────────────────────────────────────────────
// 5.3 completeSession
// ──────────────────────────────────────────────

interface CompletionTxResult {
  summary: ReconciliationSummary;
  mainOriginalAfterDiscount: string;
  /** Количество хоть одной позиции изменилось — нужен пересчёт смет и финансов. */
  adjusted: boolean;
  scannedUnitIds: string[];
}

/**
 * Завершает сессию: выдача переводит бронь в ISSUED (юниты — в ISSUED),
 * приёмка — в RETURNED (принятые юниты — AVAILABLE, неотмеченные — MISSING,
 * ремонты и потеряшки по отметкам кладовщика).
 */
export async function completeSession(
  sessionId: string,
  options: CompleteSessionOptions = {},
): Promise<ReconciliationSummary> {
  // 404 / 409 для закрытой сессии; устаревшая закрывается здесь же (STALE).
  const { session, booking } = await assertSessionWritable(prisma, sessionId);
  const operation = session.operation as ScanOperation;
  const completedBy = options.createdBy?.trim() || session.workerName;

  if (operation === "ISSUE") {
    assertIssueNotTooEarly(booking.startDate, options.force === true);
  } else {
    await assertReturnSplit(session.bookingId, options);
    await assertVehicleMileages(session.bookingId, options.vehicleMileages ?? []);
  }

  const ctx: CompletionCtx = { sessionId, bookingId: session.bookingId, operation, completedBy, options };
  let result: CompletionTxResult;
  try {
    result = await prisma.$transaction((tx) => runCompletion(tx, ctx), COMPLETE_TX_OPTIONS);
  } catch (err) {
    // Бронь успели выдать/принять/отменить, пока открыт чек-лист: сессия
    // устарела — закрываем её (в транзакции завершения это откатилось бы).
    if (err instanceof HttpError && err.code === SCAN_ERR.SESSION_STALE) {
      await prisma
        .$transaction((tx) => closeActiveScanSessions(tx, session.bookingId, { reason: "STALE", onlyIds: [sessionId] }))
        .catch((closeErr: unknown) => console.error("[completeSession] stale session close failed", closeErr));
    }
    throw err;
  }

  const { summary } = result;
  if (operation === "RETURN") {
    await createUnitRepairs(ctx, summary);
    await createUnitProblems(ctx, summary);
    await autoResolveLateReturns(ctx, result.scannedUnitIds);
  }

  // Доп-смета и финансы после транзакции: обе функции открывают свои транзакции.
  if (result.adjusted) {
    await recomputeAddonEstimate(session.bookingId).catch((err: unknown) =>
      console.warn("[completeSession] recomputeAddonEstimate failed:", err),
    );
    await recomputeBookingFinance(session.bookingId).catch((err: unknown) =>
      console.warn("[completeSession] recomputeBookingFinance failed:", err),
    );
  }

  await fillFinanceSnapshot(session.bookingId, summary);
  summary.mainOriginalAfterDiscount = result.mainOriginalAfterDiscount;
  return summary;
}

/**
 * Приёмка по количеству: ремонт + потеряшка по строке не больше, чем в строке.
 * Проверка до любых мутаций — конфликт ввода, 400 INVALID_SPLIT.
 */
async function assertReturnSplit(bookingId: string, options: CompleteSessionOptions): Promise<void> {
  const byItem = new Map<string, { repair: number; problem: number }>();
  const bump = (id: string, field: "repair" | "problem", qty: number) => {
    const cur = byItem.get(id) ?? { repair: 0, problem: 0 };
    byItem.set(id, { ...cur, [field]: cur[field] + qty });
  };
  for (const r of options.repairUnits ?? []) {
    if ("bookingItemId" in r && r.bookingItemId) bump(r.bookingItemId, "repair", r.quantity);
  }
  for (const p of options.problemUnits ?? []) {
    if ("bookingItemId" in p && p.bookingItemId) bump(p.bookingItemId, "problem", p.quantity);
  }
  if (byItem.size === 0) return;

  const bis = await prisma.bookingItem.findMany({
    where: { id: { in: Array.from(byItem.keys()) }, bookingId },
    select: { id: true, quantity: true },
  });
  const unknown = Array.from(byItem.keys()).filter((id) => !bis.some((b) => b.id === id));
  if (unknown.length > 0) throw checklistOutdated(unknown);
  for (const bi of bis) {
    const { repair, problem } = byItem.get(bi.id)!;
    if (repair + problem > bi.quantity) {
      throw new HttpError(400, "Неверное распределение", "INVALID_SPLIT", {
        bookingItemId: bi.id,
        repair,
        problem,
        totalQty: bi.quantity,
      });
    }
  }
}

/**
 * Обязательный ввод пробега машин на приёмке: по каждой машине брони — ровно
 * одна запись. Проверка до транзакции, чтобы киоск открыл форму ввода.
 */
async function assertVehicleMileages(
  bookingId: string,
  entries: Array<{ vehicleId: string; mileage: number }>,
): Promise<void> {
  const bookingVehicles = await prisma.bookingVehicle.findMany({
    where: { bookingId },
    select: { vehicleId: true, vehicle: { select: { name: true } } },
  });
  if (bookingVehicles.length === 0) {
    if (entries.length > 0) {
      throw new HttpError(400, "В брони нет машин, пробеги указывать нельзя", "VEHICLE_NOT_IN_BOOKING", {
        extra: entries.map((e) => e.vehicleId),
      });
    }
    return;
  }
  const required = new Set(bookingVehicles.map((bv) => bv.vehicleId));
  const provided = new Set(entries.map((e) => e.vehicleId));
  const missing = bookingVehicles
    .filter((bv) => !provided.has(bv.vehicleId))
    .map((bv) => ({ vehicleId: bv.vehicleId, name: bv.vehicle?.name ?? "" }));
  if (missing.length > 0) {
    throw new HttpError(
      400,
      "Введите пробег для каждой машины этой брони перед завершением возврата",
      "VEHICLE_MILEAGE_REQUIRED",
      { missing },
    );
  }
  const extra = entries.filter((e) => !required.has(e.vehicleId)).map((e) => e.vehicleId);
  if (extra.length > 0) {
    throw new HttpError(400, "Указаны пробеги для машин, не привязанных к этой брони", "VEHICLE_NOT_IN_BOOKING", {
      extra,
    });
  }
  for (const e of entries) {
    if (!Number.isInteger(e.mileage) || e.mileage < 0) {
      throw new HttpError(400, "Пробег должен быть неотрицательным целым числом", "INVALID_MILEAGE", {
        vehicleId: e.vehicleId,
        attempted: e.mileage,
      });
    }
  }
}

/** Всё, что меняет данные, — одной транзакцией. Первая запись — захват сессии. */
async function runCompletion(tx: Prisma.TransactionClient, ctx: CompletionCtx): Promise<CompletionTxResult> {
  const { session, booking } = await claimSession(tx, ctx);
  const auditUserId = ctx.options.auditUserId || (await ensureSystemAuditUser(tx));

  const main = await tx.estimate.findFirst({
    where: { bookingId: ctx.bookingId, kind: "MAIN" },
    select: { totalAfterDiscount: true },
  });
  const mainOriginalAfterDiscount = main ? main.totalAfterDiscount.toString() : "0";

  const scans = await tx.scanRecord.findMany({
    where: { sessionId: ctx.sessionId },
    include: { equipmentUnit: true },
  });
  const summary = emptySummary();
  summary.scanned = new Set(scans.map((s) => s.equipmentUnitId)).size;
  summary.completedBy = ctx.completedBy;

  let adjusted = false;
  let adjustedCount = 0;
  if (ctx.operation === "ISSUE") {
    const adj = await applyIssuanceAdjustments(tx, ctx, booking, scans, auditUserId);
    adjustedCount = adj.changedItemIds.length;
    adjusted = adjustedCount > 0;
    await assertSomethingToIssue(tx, ctx.bookingId);
    await reconcileIssueUnits(tx, ctx.bookingId, scans, summary);
    await tx.booking.update({
      where: { id: ctx.bookingId },
      data: { status: "ISSUED", ...(booking.issuedAt ? {} : { issuedAt: new Date() }) },
    });
    if (adjusted) await applyIssuanceToMainEstimate(tx, ctx.bookingId);
    summary.addonsAddedInSession = await countSessionAddons(tx, ctx, adj.increasedItemIds);
  } else {
    await reconcileReturnUnits(tx, ctx, scans, summary);
    await tx.booking.update({ where: { id: ctx.bookingId }, data: { status: "RETURNED" } });
    const mileages = ctx.options.vehicleMileages ?? [];
    if (mileages.length > 0) {
      await recordReturnMileages({ tx, bookingId: ctx.bookingId, recordedBy: ctx.completedBy, entries: mileages });
    }
    await createCountRepairsAndProblems(tx, ctx, summary);
  }

  const forcedEarlyIssue =
    ctx.operation === "ISSUE" && ctx.options.force === true && isIssueTooEarly(booking.startDate);
  await writeAuditEntry({
    tx,
    userId: auditUserId,
    action: ctx.operation === "ISSUE" ? "BOOKING_ISSUED" : "BOOKING_RETURNED",
    entityType: "Booking",
    entityId: ctx.bookingId,
    before: { status: booking.status },
    after: {
      status: ctx.operation === "ISSUE" ? "ISSUED" : "RETURNED",
      via: "kiosk",
      sessionId: ctx.sessionId,
      workerName: ctx.completedBy,
      startedBy: session.workerName,
      adjustments: adjustedCount,
      ...(forcedEarlyIssue ? { forcedEarlyIssue: true } : {}),
    },
  });

  return { summary, mainOriginalAfterDiscount, adjusted, scannedUnitIds: scans.map((s) => s.equipmentUnitId) };
}

/**
 * Захват сессии внутри транзакции завершения:
 *  - сессия уже завершена/прервана → её 409;
 *  - бронь больше не ждёт этой операции → 409 SESSION_STALE (сессию закроет
 *    вызывающий — здесь закрытие откатилось бы вместе с транзакцией);
 *  - ACTIVE → COMPLETED условным updateMany: из двух параллельных «Готово»
 *    проходит один, второй получает 409 SESSION_ALREADY_COMPLETED;
 *  - состав брони или черновик поменялись с момента построения экрана → 409.
 */
async function claimSession(
  tx: Prisma.TransactionClient,
  ctx: CompletionCtx,
): Promise<{ session: ScanSession; booking: Booking }> {
  const session = await tx.scanSession.findUnique({ where: { id: ctx.sessionId } });
  if (!session) throw notFoundSession();
  const closed = closedSessionError(session);
  if (closed) throw closed;

  const booking = await tx.booking.findUnique({ where: { id: ctx.bookingId } });
  if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
  if (!isSessionLive(session.operation, booking)) throw staleSessionError(session, booking);

  const claim = await tx.scanSession.updateMany({
    where: { id: ctx.sessionId, status: "ACTIVE" },
    data: { status: "COMPLETED", completedAt: new Date(), completedBy: ctx.completedBy },
  });
  if (claim.count === 0) {
    const current = await tx.scanSession.findUnique({ where: { id: ctx.sessionId } });
    throw (
      (current && closedSessionError(current)) ??
      new HttpError(409, alreadyCompletedMessage(session.operation), SCAN_ERR.SESSION_ALREADY_COMPLETED, {
        sessionId: session.id,
        operation: session.operation,
        completedAt: null,
        completedBy: null,
      })
    );
  }

  if (ctx.options.itemsVersion) {
    const items = await tx.bookingItem.findMany({
      where: { bookingId: ctx.bookingId },
      select: { id: true, quantity: true },
    });
    if (computeItemsVersion(items) !== ctx.options.itemsVersion) throw checklistOutdated();
  }
  if (ctx.options.draftRevision != null && ctx.options.draftRevision < session.draftRevision) {
    throw new HttpError(409, SCAN_MSG.DRAFT_OUTDATED, SCAN_ERR.DRAFT_OUTDATED, {
      revision: session.draftRevision,
      draft: parseStoredDraft(session.draftJson),
      savedAt: session.draftSavedAt?.toISOString() ?? null,
      savedBy: session.draftSavedBy ?? null,
    });
  }
  return { session, booking };
}

/** Выдача, в которой все строки обнулены, — не выдача: 409, ничего не записано. */
async function assertSomethingToIssue(tx: Prisma.TransactionClient, bookingId: string): Promise<void> {
  const items = await tx.bookingItem.findMany({ where: { bookingId }, select: { quantity: true } });
  if (items.length > 0 && items.every((i) => i.quantity <= 0)) {
    throw new HttpError(409, SCAN_MSG.NOTHING_TO_ISSUE, SCAN_ERR.NOTHING_TO_ISSUE);
  }
}

// ──────────────────────────────────────────────
// 5.4 cancelSession
// ──────────────────────────────────────────────

export type ClientCancelReason = (typeof CLIENT_CANCEL_REASONS)[number];

export interface CancelSessionOptions {
  /** Зачем прерываем; без причины — «прервана в киоске». */
  reason?: ClientCancelReason;
  /** Отменить, только если в сессии не было работы (черновик, отметки, добор). */
  onlyIfEmpty?: boolean;
  /** AdminUser.id — если сессию прерывают из CRM (главная сессия). */
  actorUserId?: string | null;
  /** Имя кладовщика — если вход по PIN (автор аудита тогда `_system_`). */
  actorName?: string | null;
}

async function sessionHasWork(tx: Prisma.TransactionClient, s: ScanSession): Promise<boolean> {
  if (s.draftJson != null) return true;
  const [scans, addons] = await Promise.all([
    tx.scanRecord.count({ where: { sessionId: s.id } }),
    tx.addonRecord.count({ where: { sessionId: s.id } }),
  ]);
  return scans > 0 || addons > 0;
}

/**
 * Прерывает сессию склада. Статусы единиц не меняются, отметки и доборы
 * остаются (доборы уже в брони). Аудит SCAN_SESSION_CANCELLED — в журнале брони.
 *
 *  - завершённая или уже прерванная сессия → 409 (не 500);
 *  - `onlyIfEmpty` (кладовщик ушёл «←», ничего не сделав): сессия с работой не
 *    трогается, ответ `cancelled: false`;
 *  - устаревшая сессия закрывается всегда, с причиной STALE.
 */
export async function cancelSession(
  sessionId: string,
  opts: CancelSessionOptions = {},
): Promise<PresentedScanSession & { cancelled: boolean }> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.scanSession.findUnique({
      where: { id: sessionId },
      include: { booking: { select: { status: true, deletedAt: true } } },
    });
    if (!row) throw notFoundSession();
    const { booking, ...session } = row;
    const closedErr = closedSessionError(session);
    if (closedErr) throw closedErr;

    const stale = !isSessionLive(session.operation, booking);
    if (!stale && opts.onlyIfEmpty && (await sessionHasWork(tx, session))) {
      return { ...presentScanSession(session), cancelled: false };
    }

    const closed = await closeActiveScanSessions(tx, session.bookingId, {
      reason: stale ? "STALE" : opts.reason ?? "KIOSK_ABORT",
      actorUserId: opts.actorUserId ?? null,
      actorName: opts.actorName ?? null,
      onlyIds: [sessionId],
    });
    const fresh = await tx.scanSession.findUnique({ where: { id: sessionId } });
    if (!fresh) throw notFoundSession();
    if (closed.length === 0) {
      throw closedSessionError(fresh) ?? new HttpError(409, SCAN_MSG.SESSION_CANCELLED, SCAN_ERR.SESSION_CANCELLED);
    }
    return { ...presentScanSession(fresh), cancelled: true };
  });
}
