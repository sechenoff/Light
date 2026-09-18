/**
 * Сервис реестра «Потеряшки» — проблемные позиции и единицы.
 *
 * Ключевые операции:
 * - createProblemItem — заводит карточку на единицу штучного учёта (приёмка
 *   или ручной ввод). Реакция зависит от причины (reason):
 *     • LEFT_ON_SITE → status EXPECTED, unit MISSING (ждём досдачи)
 *     • LOST / STOLEN / NOT_ON_SHELF → status SEARCHING, unit MISSING (ищем)
 *     • DESTROYED → status WROTE_OFF (сразу закрыто), unit RETIRED (списано)
 * - createManualProblemItem — «Завести потеряшку» из реестра (спека
 *   инвентаризации §6): позиция без штучного учёта — количеством, не больше,
 *   чем по учёту должно лежать на полке; штучная — конкретной единицей. Только
 *   для того, что по учёту уже на складе: бронь на съёмке, единица на съёмке
 *   или в мастерской отклоняются (409) — их пропажу оформляют приёмка и ремонт.
 * - resolveProblemItem — ручной разбор открытой карточки (FOUND / NOT_FOUND).
 * - autoResolveOnReturn — авто-закрытие открытой карточки при повторной приёмке.
 *
 * Сторож двойного счёта. Безъюнитная потеряшка уменьшает «на полке должно быть»
 * (getLostCountByEquipmentMap). Если позицию уже посчитали в идущей
 * инвентаризации, её ожидание зафиксировано снапшотом, а недостача уже видна
 * расхождением строки. Ручная потеряшка поверх этого записала бы ту же пропажу
 * второй раз (строка «Пропало» заведёт свою потеряшку при завершении), а
 * «Найдено» вернуло бы в оборот то, что инвентаризация сочтёт излишком. «Не
 * найдено» доступности не меняет, но выводит карточку из того, что может
 * закрыть «Нашлось» строки: решение «Нашлось» осталось бы без потеряшек, а
 * вещь на полке — навсегда вычтенной. Поэтому ручная потеряшка и ЛЮБОЙ разбор
 * безъюнитной карточки по посчитанной позиции отправляются в инвентаризацию:
 * 409 STOCK_COUNT_LINE_COUNTED (снимается отменой или завершением).
 * Непосчитанные строки не мешают — их ожидание берётся живым и новую
 * потеряшку увидит.
 */

import type { ProblemReason, ProblemSource } from "@prisma/client";
import { prisma } from "../prisma";
import { writeAuditEntry } from "./audit";
import { HttpError } from "../utils/errors";
import { computeExpectedOnShelf } from "./stockCount/expected";

type TxClient = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">;

/** Кто действует с десктопа: id — для аудита (FK на AdminUser), username — для подписей. */
export interface ProblemActor {
  userId: string;
  username: string;
}

/** Минимальная длина комментария к ручной потеряшке (после trim). */
export const MANUAL_COMMENT_MIN = 3;

export interface CreateProblemArgs {
  equipmentUnitId: string;
  reason: ProblemReason;
  comment: string;
  expectedBackDate?: Date | null;
  sourceBookingId?: string | null;
  createdBy: string;
  /** Откуда карточка. По умолчанию — приёмка (схема: `@default(RETURN)`). */
  source?: ProblemSource;
}

type PlannedStatus = "EXPECTED" | "SEARCHING" | "WROTE_OFF";

function plannedStatus(reason: ProblemReason): PlannedStatus {
  if (reason === "LEFT_ON_SITE") return "EXPECTED";
  if (reason === "DESTROYED") return "WROTE_OFF";
  return "SEARCHING"; // LOST, STOLEN, NOT_ON_SHELF
}
function unitStatusFor(reason: ProblemReason): "MISSING" | "RETIRED" {
  return reason === "DESTROYED" ? "RETIRED" : "MISSING";
}

/** Пометка разбора, когда «уничтожено» сразу закрывает карточку списанием. */
const WRITE_OFF_NOTE: Record<ProblemSource, string> = {
  RETURN: "Списано при приёмке (уничтожено)",
  MANUAL: "Списано вручную (уничтожено)",
  STOCK_COUNT: "Списано при инвентаризации (уничтожено)",
};

/** Поля закрытия для карточки, которая рождается уже списанной. */
function writeOffFields(status: PlannedStatus, source: ProblemSource, by: string) {
  const closed = status === "WROTE_OFF";
  return {
    resolvedAt: closed ? new Date() : null,
    resolvedBy: closed ? by : null,
    resolutionNote: closed ? WRITE_OFF_NOTE[source] : null,
  };
}

/**
 * Карточка на единицу + смена статуса единицы — общая часть приёмки и ручного
 * ввода. Вызывается внутри транзакции вызывающего.
 */
async function insertUnitProblem(db: TxClient, args: CreateProblemArgs) {
  const unit = await db.equipmentUnit.findUnique({ where: { id: args.equipmentUnitId } });
  if (!unit) throw new HttpError(404, "Единица не найдена", "UNIT_NOT_FOUND");

  const source = args.source ?? "RETURN";
  const status = plannedStatus(args.reason);
  const newUnitStatus = unitStatusFor(args.reason);
  const pi = await db.problemItem.create({
    data: {
      equipmentUnitId: args.equipmentUnitId,
      // Позиция каталога — прямой ссылкой, как у потеряшек из инвентаризации:
      // реестр и «Как пропало» находят карточку по позиции одним условием.
      equipmentId: unit.equipmentId,
      sourceBookingId: args.sourceBookingId ?? null,
      reason: args.reason,
      comment: args.comment,
      expectedBackDate: args.expectedBackDate ?? null,
      status,
      source,
      createdBy: args.createdBy,
      ...writeOffFields(status, source, args.createdBy),
    },
  });
  await db.equipmentUnit.update({
    where: { id: args.equipmentUnitId },
    data: { status: newUnitStatus },
  });
  return { pi, unitStatusBefore: unit.status, newUnitStatus, status };
}

export async function createProblemItem(args: CreateProblemArgs, tx?: TxClient) {
  // Данные — в одной транзакции (ProblemItem + EquipmentUnit). Audit
  // пишется ПОСЛЕ commit как best-effort: `AuditEntry.userId` — FK на
  // `AdminUser.id`, а `createdBy` в warehouse-flow приходит как имя
  // кладовщика/username (не id). Audit-insert внутри tx даёт P2003 и
  // откатывает создание ProblemItem — это была причина «потеряшки нигде не
  // появлялись» при стандартной приёмке. См. createRepair и
  // completeSession.BOOKING_STATUS_CHANGED для того же паттерна.
  const run = (db: TxClient) => insertUnitProblem(db, args);

  const { pi, unitStatusBefore, newUnitStatus, status } = tx
    ? await run(tx)
    : await prisma.$transaction(run);

  // Audit — best-effort, ВНЕ tx (см. комментарий выше). Если caller передал
  // свой tx, аудит всё равно пишется отдельно через global prisma — это
  // намеренно: атомарность audit с бизнес-операцией не критична, а
  // выживаемость бизнес-объекта при сбое audit — критична.
  await writeAuditEntry({
    userId: args.createdBy,
    action: "PROBLEM_ITEM_CREATE",
    entityType: "ProblemItem",
    entityId: args.equipmentUnitId,
    before: { status: unitStatusBefore },
    after: { reason: args.reason, problemStatus: status, unitStatus: newUnitStatus, problemItemId: pi.id },
  }).catch((err) => {
    console.warn(
      "[createProblemItem] audit failed:",
      err instanceof Error ? err.message : String(err),
    );
  });

  return pi;
}

// ── Сторож двойного счёта ────────────────────────────────────────────────────

/**
 * Идущая инвентаризация, в которой позиция уже посчитана, — или null.
 * Посчитанной считается строка с `countedQty`; непосчитанная берёт ожидание
 * живым и ручную потеряшку увидит сама.
 */
export async function findCountingStockCount(
  db: TxClient,
  equipmentId: string,
): Promise<{ id: string; number: number } | null> {
  const line = await db.stockCountLine.findFirst({
    where: { equipmentId, countedQty: { not: null }, stockCount: { status: "OPEN" } },
    select: { stockCount: { select: { id: true, number: true } } },
  });
  return line?.stockCount ?? null;
}

async function assertNotCountedInOpenStockCount(
  db: TxClient,
  equipmentId: string,
  whatToDo: string,
): Promise<void> {
  const sc = await findCountingStockCount(db, equipmentId);
  if (!sc) return;
  throw new HttpError(
    409,
    `Позиция уже посчитана в идущей инвентаризации № ${sc.number} — ${whatToDo}`,
    "STOCK_COUNT_LINE_COUNTED",
    { stockCountId: sc.id, stockCountNumber: sc.number },
  );
}

// ── Ручной ввод ──────────────────────────────────────────────────────────────

/**
 * Держит ли бронь позицию вне склада в момент `at` — ровно слагаемые «issued» и
 * «calendar» формулы «на полке должно быть» (stockCount/expected.ts,
 * computeExpectedOnShelf): бронь не в архиве, позиция в составе, и бронь либо
 * ISSUED (независимо от дат), либо CONFIRMED с `at` внутри [startDate; endDate].
 * Правишь условие там — поправь и здесь, иначе сторож и полка разойдутся.
 *
 * Локальная копия, а не импорт: expected.ts отдаёт суммы по позициям, а здесь
 * нужен ответ про одну конкретную бронь.
 */
function bookingHoldsPosition(
  booking: { status: string; startDate: Date; endDate: Date; deletedAt: Date | null; items: unknown[] },
  at: Date,
): boolean {
  if (booking.deletedAt !== null || booking.items.length === 0) return false;
  if (booking.status === "ISSUED") return true;
  return (
    booking.status === "CONFIRMED" &&
    booking.startDate.getTime() <= at.getTime() &&
    booking.endDate.getTime() >= at.getTime()
  );
}

export interface ManualProblemInput {
  equipmentId: string;
  equipmentUnitId?: string | null;
  quantity?: number | null;
  reason: ProblemReason;
  comment: string;
  expectedBackDate?: Date | null;
  sourceBookingId?: string | null;
}

/**
 * «Завести потеряшку» вручную (source MANUAL).
 *
 *  - Позиция без штучного учёта: `quantity` 1…«на полке должно быть» (та же
 *    формула, что у календаря и инвентаризации) — завести пропажу того, чего
 *    по учёту на полке и так нет, значило бы вычесть одну вещь дважды.
 *  - Штучная позиция: обязательна единица ЭТОЙ позиции; путь — общий с приёмкой
 *    (`insertUnitProblem`), единица уходит в «не найдена» / «списана».
 *
 * Аудит — в той же транзакции: действует сотрудник с сессией, его id валиден
 * для FK, и карточка без записи в журнале не остаётся.
 */
export async function createManualProblemItem(input: ManualProblemInput, actor: ProblemActor) {
  const comment = input.comment.trim();
  if (comment.length < MANUAL_COMMENT_MIN) {
    throw new HttpError(400, "Опишите, что случилось, — не короче 3 символов", "COMMENT_REQUIRED");
  }
  if (input.expectedBackDate && input.reason !== "LEFT_ON_SITE") {
    throw new HttpError(
      400,
      "Срок возврата указывают только для «Остался на площадке»",
      "EXPECTED_BACK_DATE_NOT_APPLICABLE",
    );
  }

  return prisma.$transaction(async (tx: TxClient) => {
    // Один момент на сторож брони и на «на полке должно быть» — иначе на стыке
    // окна брони они могли бы посчитать по-разному.
    const now = new Date();
    const equipment = await tx.equipment.findUnique({
      where: { id: input.equipmentId },
      select: { id: true, stockTrackingMode: true },
    });
    if (!equipment) throw new HttpError(404, "Позиция не найдена", "EQUIPMENT_NOT_FOUND");

    let sourceBookingId: string | null = null;
    if (input.sourceBookingId) {
      const booking = await tx.booking.findUnique({
        where: { id: input.sourceBookingId },
        select: {
          id: true,
          status: true,
          startDate: true,
          endDate: true,
          deletedAt: true,
          items: { where: { equipmentId: equipment.id }, select: { id: true }, take: 1 },
        },
      });
      if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
      // Бронь на съёмке уже вычтена из полки, а её приёмка сама спросит про
      // недостающее. Ручная карточка по ней вычла бы вещь второй раз и дала бы
      // на приёмке вторую карточку на ту же пропажу.
      if (bookingHoldsPosition(booking, now)) {
        throw new HttpError(
          409,
          "Бронь ещё на съёмке — пропажу по ней отметят на приёмке",
          "BOOKING_STILL_OUT",
          { bookingId: booking.id },
        );
      }
      sourceBookingId = booking.id;
    }

    const base = {
      reason: input.reason,
      comment,
      expectedBackDate: input.expectedBackDate ?? null,
      sourceBookingId,
    };

    if (equipment.stockTrackingMode === "UNIT") {
      return createManualUnitProblem(tx, equipment.id, input, base, actor);
    }
    return createManualCountProblem(tx, equipment.id, input, base, actor, now);
  });
}

type ManualBase = {
  reason: ProblemReason;
  comment: string;
  expectedBackDate: Date | null;
  sourceBookingId: string | null;
};

async function createManualUnitProblem(
  tx: TxClient,
  equipmentId: string,
  input: ManualProblemInput,
  base: ManualBase,
  actor: ProblemActor,
) {
  if (!input.equipmentUnitId) {
    throw new HttpError(400, "Позиция со штучным учётом — выберите единицу", "UNIT_REQUIRED");
  }
  if (input.quantity != null && input.quantity !== 1) {
    throw new HttpError(400, "Для штучного учёта заводится одна единица", "INVALID_QUANTITY");
  }
  const unit = await tx.equipmentUnit.findUnique({
    where: { id: input.equipmentUnitId },
    select: { id: true, equipmentId: true, status: true },
  });
  if (!unit || unit.equipmentId !== equipmentId) {
    throw new HttpError(400, "Единица не относится к выбранной позиции", "UNIT_NOT_OF_EQUIPMENT");
  }
  // Вторая карточка на пропавшую или списанную единицу ничего не добавит,
  // а при разборе одной из них единица «вернулась бы» дважды.
  if (unit.status === "MISSING" || unit.status === "RETIRED") {
    throw new HttpError(409, "Единица уже числится пропавшей или списанной", "UNIT_ALREADY_MISSING");
  }
  // На съёмке: пропажу отметит приёмка — ручная карточка здесь дала бы вторую
  // карточку на ту же единицу при возврате.
  if (unit.status === "ISSUED") {
    throw new HttpError(409, "Единица на съёмке — пропажу отметят на приёмке", "UNIT_ISSUED");
  }
  // В мастерской: закрытие ремонта безусловно возвращает единицу в «доступна»
  // (repairService.closeRepair), и списанное или пропавшее снова ушло бы в
  // прокат при живой карточке в реестре. Судьбу такой единицы решает ремонт.
  const activeRepair = await tx.repair.findFirst({
    where: { unitId: unit.id, status: { notIn: ["CLOSED", "WROTE_OFF"] } },
    select: { id: true },
  });
  if (unit.status === "MAINTENANCE" || activeRepair) {
    throw new HttpError(
      409,
      "Единица в мастерской — спишите её через ремонт или сначала закройте ремонт",
      "UNIT_IN_REPAIR",
      activeRepair ? { repairId: activeRepair.id } : undefined,
    );
  }

  const { pi, unitStatusBefore, newUnitStatus, status } = await insertUnitProblem(tx, {
    ...base,
    equipmentUnitId: unit.id,
    createdBy: actor.username,
    source: "MANUAL",
  });
  await writeAuditEntry({
    tx,
    userId: actor.userId,
    action: "PROBLEM_ITEM_CREATE",
    entityType: "ProblemItem",
    entityId: pi.id,
    before: { unitStatus: unitStatusBefore },
    after: {
      source: "MANUAL",
      reason: base.reason,
      problemStatus: status,
      unitStatus: newUnitStatus,
      equipmentId,
      equipmentUnitId: unit.id,
      quantity: 1,
      sourceBookingId: base.sourceBookingId,
    },
  });
  return pi;
}

async function createManualCountProblem(
  tx: TxClient,
  equipmentId: string,
  input: ManualProblemInput,
  base: ManualBase,
  actor: ProblemActor,
  now: Date,
) {
  if (input.equipmentUnitId) {
    throw new HttpError(400, "У позиции нет штучного учёта — единицу выбрать нельзя", "UNIT_NOT_APPLICABLE");
  }
  const quantity = input.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new HttpError(400, "Количество — целое число от 1", "INVALID_QUANTITY");
  }
  await assertNotCountedInOpenStockCount(tx, equipmentId, "отметьте недостачу там");

  const shelf = (await computeExpectedOnShelf([equipmentId], now, tx)).get(equipmentId);
  const expected = shelf?.expected ?? 0;
  if (quantity > expected) {
    throw new HttpError(
      400,
      expected === 0
        ? "По учёту на полке этой позиции сейчас нет — заводить пропажу не из чего"
        : `Больше, чем должно лежать на полке: по учёту там ${expected}`,
      "QUANTITY_EXCEEDS_SHELF",
      { expected },
    );
  }

  const status = plannedStatus(base.reason);
  const pi = await tx.problemItem.create({
    data: {
      equipmentId,
      quantity,
      reason: base.reason,
      comment: base.comment,
      expectedBackDate: base.expectedBackDate,
      sourceBookingId: base.sourceBookingId,
      status,
      source: "MANUAL",
      createdBy: actor.username,
      ...writeOffFields(status, "MANUAL", actor.username),
    },
  });
  await writeAuditEntry({
    tx,
    userId: actor.userId,
    action: "PROBLEM_ITEM_CREATE",
    entityType: "ProblemItem",
    entityId: pi.id,
    before: { expectedOnShelf: expected },
    after: {
      source: "MANUAL",
      reason: base.reason,
      problemStatus: status,
      equipmentId,
      quantity,
      sourceBookingId: base.sourceBookingId,
    },
  });
  return pi;
}

// ── Разбор ───────────────────────────────────────────────────────────────────

/**
 * Ручной разбор открытой карточки.
 *
 * `by` — сотрудник с десктопа ({ userId, username }): в карточку пишется
 * username (его показывает реестр), в журнал — id. Строка принимается для
 * обратной совместимости и идёт в оба поля.
 */
export async function resolveProblemItem(
  id: string,
  outcome: "FOUND" | "NOT_FOUND",
  note: string,
  by: string | ProblemActor,
) {
  const auditUserId = typeof by === "string" ? by : by.userId;
  const resolvedBy = typeof by === "string" ? by : by.username;
  return prisma.$transaction(async (tx: TxClient) => {
    const pi = await tx.problemItem.findUnique({
      where: { id },
      include: { bookingItem: { select: { equipmentId: true } } },
    });
    if (!pi) throw new HttpError(404, "Запись не найдена", "PROBLEM_ITEM_NOT_FOUND");
    if (pi.status === "FOUND" || pi.status === "NOT_FOUND" || pi.status === "WROTE_OFF") {
      throw new HttpError(409, "Запись уже закрыта", "PROBLEM_ITEM_CLOSED");
    }
    // Разбор безъюнитной карточки посчитанной позиции решает инвентаризация.
    // «Найдено» вернуло бы количество в «на полке должно быть» — излишек закрыл
    // бы потеряшку дважды. «Не найдено» доступность не меняет (карточка и так
    // вычитается), но выводит её из того, что может закрыть «Нашлось» строки:
    // вещь, которая лежит на полке, осталась бы вычтенной навсегда.
    const equipmentId = pi.equipmentId ?? pi.bookingItem?.equipmentId ?? null;
    if (!pi.equipmentUnitId && equipmentId) {
      await assertNotCountedInOpenStockCount(
        tx,
        equipmentId,
        outcome === "FOUND"
          ? "решите там («Нашлось»)"
          : "разберите карточку после её завершения — если вещь на полке, это «Нашлось» там",
      );
    }
    const updated = await tx.problemItem.update({
      where: { id },
      data: { status: outcome, resolutionNote: note, resolvedAt: new Date(), resolvedBy },
    });
    if (outcome === "FOUND" && pi.equipmentUnitId) {
      await tx.equipmentUnit.update({
        where: { id: pi.equipmentUnitId },
        data: { status: "AVAILABLE" },
      });
    }
    // F-LOST-3 (осознанный SKIP): outcome === "NOT_FOUND" должен породить «долг
    // клиента» за невозврат. Честной привязки к деньгам без новой схемы нет:
    //   1. «Долг» в системе = booking.amountOutstanding (см. computeDebts). Expense —
    //      это РАСХОД компании, а не дебиторка клиента, и в /finance/debts не попадает;
    //      писать сюда Expense перевернуло бы смысл (компания платит за свою потерю).
    //   2. Сумма компенсации нигде не хранится: у ProblemItem/EquipmentUnit/Equipment
    //      нет закупочной/оценочной стоимости, а выводить её из rentalRatePerShift —
    //      выдуманное бизнес-правило.
    // Нужно продуктовое решение (как оценивается компенсация) + новое поле под сумму,
    // после чего — ADDON-строка/инвойс-коррекция на sourceBooking. Схема заморожена → не тут.
    await writeAuditEntry({
      tx, userId: auditUserId, action: "PROBLEM_ITEM_RESOLVE",
      entityType: "ProblemItem", entityId: pi.equipmentUnitId ?? pi.id,
      before: { status: pi.status },
      after: { status: outcome, note },
    });
    return updated;
  });
}

/** Авто-резолв при позднем возврате: вызывается из completeSession (RETURN). */
export async function autoResolveOnReturn(
  tx: TxClient,
  equipmentUnitId: string,
  resolvedBy: string,
): Promise<void> {
  const open = await tx.problemItem.findFirst({
    where: { equipmentUnitId, status: { in: ["EXPECTED", "SEARCHING"] } },
    orderBy: { createdAt: "desc" },
  });
  if (!open) return;
  await tx.problemItem.update({
    where: { id: open.id },
    data: { status: "FOUND", resolvedAt: new Date(), resolvedBy,
             resolutionNote: "возвращён повторной приёмкой" },
  });
  await writeAuditEntry({
    tx, userId: resolvedBy, action: "PROBLEM_ITEM_RESOLVE",
    entityType: "ProblemItem", entityId: equipmentUnitId,
    before: { status: open.status }, after: { status: "FOUND", note: "возвращён повторной приёмкой" },
  });
}
