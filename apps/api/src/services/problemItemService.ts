/**
 * Сервис реестра «Потеряшки» — проблемные единицы с приёмки.
 *
 * Ключевые операции:
 * - createProblemItem — заводит проблемную карточку при возврате (или вручную).
 *   Реакция зависит от причины (reason):
 *     • LEFT_ON_SITE → status EXPECTED, unit MISSING (ждём досдачи)
 *     • LOST / STOLEN → status SEARCHING, unit MISSING (ищем / разбираемся)
 *     • DESTROYED → status WROTE_OFF (сразу закрыто), unit RETIRED (списано)
 * - resolveProblemItem — ручной разбор открытой карточки (FOUND / NOT_FOUND).
 * - autoResolveOnReturn — авто-закрытие открытой карточки при повторной приёмке.
 */

import type { ProblemReason } from "@prisma/client";
import { prisma } from "../prisma";
import { writeAuditEntry } from "./audit";
import { HttpError } from "../utils/errors";

type TxClient = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">;

export interface CreateProblemArgs {
  equipmentUnitId: string;
  reason: ProblemReason;
  comment: string;
  expectedBackDate?: Date | null;
  sourceBookingId?: string | null;
  createdBy: string;
}

function plannedStatus(reason: ProblemReason): "EXPECTED" | "SEARCHING" | "WROTE_OFF" {
  if (reason === "LEFT_ON_SITE") return "EXPECTED";
  if (reason === "DESTROYED") return "WROTE_OFF";
  return "SEARCHING"; // LOST, STOLEN
}
function unitStatusFor(reason: ProblemReason): "MISSING" | "RETIRED" {
  return reason === "DESTROYED" ? "RETIRED" : "MISSING";
}

export async function createProblemItem(args: CreateProblemArgs, tx?: TxClient) {
  // Данные — в одной транзакции (ProblemItem + EquipmentUnit). Audit
  // пишется ПОСЛЕ commit как best-effort: `AuditEntry.userId` — FK на
  // `AdminUser.id`, а `createdBy` в warehouse-flow приходит как имя
  // кладовщика/username (не id). Audit-insert внутри tx даёт P2003 и
  // откатывает создание ProblemItem — это была причина «потеряшки нигде не
  // появлялись» при стандартной приёмке. См. createRepair и
  // completeSession.BOOKING_STATUS_CHANGED для того же паттерна.
  const run = async (db: TxClient) => {
    const unit = await db.equipmentUnit.findUnique({ where: { id: args.equipmentUnitId } });
    if (!unit) throw new HttpError(404, "Единица не найдена", "UNIT_NOT_FOUND");

    const status = plannedStatus(args.reason);
    const newUnitStatus = unitStatusFor(args.reason);
    const pi = await db.problemItem.create({
      data: {
        equipmentUnitId: args.equipmentUnitId,
        sourceBookingId: args.sourceBookingId ?? null,
        reason: args.reason,
        comment: args.comment,
        expectedBackDate: args.expectedBackDate ?? null,
        status,
        createdBy: args.createdBy,
        resolvedAt: status === "WROTE_OFF" ? new Date() : null,
        resolvedBy: status === "WROTE_OFF" ? args.createdBy : null,
        resolutionNote: status === "WROTE_OFF" ? "Списано при приёмке (уничтожено)" : null,
      },
    });
    await db.equipmentUnit.update({
      where: { id: args.equipmentUnitId },
      data: { status: newUnitStatus },
    });
    return { pi, unitStatusBefore: unit.status, newUnitStatus, status };
  };

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

export async function resolveProblemItem(
  id: string,
  outcome: "FOUND" | "NOT_FOUND",
  note: string,
  resolvedBy: string,
) {
  return prisma.$transaction(async (tx: TxClient) => {
    const pi = await tx.problemItem.findUnique({ where: { id } });
    if (!pi) throw new HttpError(404, "Запись не найдена", "PROBLEM_ITEM_NOT_FOUND");
    if (pi.status === "FOUND" || pi.status === "NOT_FOUND" || pi.status === "WROTE_OFF") {
      throw new HttpError(409, "Запись уже закрыта", "PROBLEM_ITEM_CLOSED");
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
      tx, userId: resolvedBy, action: "PROBLEM_ITEM_RESOLVE",
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
