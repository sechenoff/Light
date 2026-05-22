/**
 * Сервис управления сессиями сканирования на складе.
 *
 * Поддерживает операции:
 * - ISSUE (выдача): сканирование единиц при выдаче заказа
 * - RETURN (возврат): сканирование единиц при приёмке возврата
 *
 * Каждая сессия привязана к брони и проходит состояния: ACTIVE → COMPLETED | CANCELLED.
 */

import type { RepairUrgency, ProblemReason } from "@prisma/client";
import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { createRepair } from "./repairService";
import { createProblemItem, autoResolveOnReturn } from "./problemItemService";
import { moveStagedToRepair } from "./repairPhotoStorage";
import { writeAuditEntry } from "./audit";
import { recreateMainEstimate } from "./mainEstimate";
import { recomputeAddonEstimate } from "./addonEstimate";
import { recomputeBookingFinance } from "./finance";

type TxClient = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">;

// ──────────────────────────────────────────────
// Типы
// ──────────────────────────────────────────────

export type ScanOperation = "ISSUE" | "RETURN";

/**
 * Repair input — discriminated union of UNIT-mode and COUNT-mode forms.
 *
 *  - UNIT-mode: `{ equipmentUnitId, comment, urgency? }` — one Repair card created per
 *    physically scanned unit (legacy behavior; statuses transition AVAILABLE→MAINTENANCE).
 *  - COUNT-mode: `{ bookingItemId, quantity, comment }` — one Repair row covering N
 *    untracked units of the same line. `unitId` is null in the persisted row.
 *
 * Exactly one of `equipmentUnitId` and `bookingItemId` is set per entry.
 */
export type RepairUnit =
  | { equipmentUnitId: string; comment: string; urgency?: RepairUrgency }
  | { bookingItemId: string; quantity: number; comment: string };

/**
 * ProblemItem input — same UNIT-vs-COUNT discriminator pattern as RepairUnit.
 */
export type ProblemUnit =
  | { equipmentUnitId: string; reason: ProblemReason; comment: string; expectedBackDate?: string }
  | {
      bookingItemId: string;
      quantity: number;
      reason: ProblemReason;
      comment: string;
      expectedBackDate?: string;
    };

/**
 * Корректировка фактически выданного количества для одной BookingItem-позиции
 * (Task 7 — issue-stock-cap-and-unit-removal).
 *
 * `actualQuantity` ∈ [0, bookingItem.quantity]. При `actualQuantity < quantity`:
 *  - COUNT-режим: просто уменьшаем BookingItem.quantity.
 *  - UNIT-режим: дополнительно удаляем (quantity − actualQuantity) BookingItemUnit,
 *    выбирая только НЕотсканированные резервации. Если отсканированных больше
 *    или равно actualQuantity — операция возможна; иначе HttpError 409.
 */
export interface IssuanceAdjustment {
  bookingItemId: string;
  actualQuantity: number;
}

export interface ReservedButUnavailableUnit {
  equipmentUnitId: string;
  equipmentName: string;
  /** «прибор N из M» — порядок среди ВСЕХ резерваций этой позиции (стабильный). */
  ordinalLabel: string;
  /** Статус юнита, который мешает выдаче: MAINTENANCE | MISSING | RETIRED | ISSUED | …. */
  status: string;
}

export interface ReconciliationSummary {
  scanned: number;
  expected: number;
  missing: string[];    // equipmentUnitId[] не отсканированных
  substituted: string[]; // equipmentUnitId[] замен (отсканирован другой юнит вместо зарезервированного)
  /**
   * Зарезервированные юниты, недоступные для выдачи (статус ≠ AVAILABLE).
   * Только для ISSUE-сессий; для RETURN пустой массив. Обогащён name+ordinal+status
   * чтобы фронт мог отрисовать список без второго запроса.
   */
  reservedButUnavailable: ReservedButUnavailableUnit[];
  createdRepairIds: string[];  // id карточек ремонта, успешно созданных после возврата
  failedBrokenUnits: Array<{ unitId: string; reason: string; error: string }>; // единицы, для которых ремонт не удалось создать
  createdProblemItemIds: string[]; // id карточек «Потеряшки», успешно созданных после возврата
  failedProblemUnits: Array<{ equipmentUnitId: string; reason: string }>; // проблемные единицы, которые не удалось обработать
  /** MAIN Estimate.totalAfterDiscount (0 если бронь не CONFIRMED). */
  mainAfterDiscount: string;
  /** ADDON Estimate.totalAfterDiscount (0 если доборов нет). */
  addonAfterDiscount: string;
  /** Booking.finalAmount (= main + addon + transport). */
  finalAmount: string;
  /**
   * MAIN.totalAfterDiscount, snapshot ДО применения issuanceAdjustments
   * в этой сессии. Используется UI для блока «исходно / фактически».
   * Если adjustments не применялись — равен mainAfterDiscount.
   */
  mainOriginalAfterDiscount: string;
  /**
   * Booking.paymentStatus (актуальный после recomputeBookingFinance).
   * UI рисует «К возврату» callout при `paymentStatus === "OVERPAID"`.
   * При неоплаченных/некомфирмированных бронях остаётся "NOT_PAID".
   */
  paymentStatus: string;
  /**
   * Booking.amountPaid (Decimal as string). UI вычисляет «Переплата =
   * amountPaid − finalAmount» для OVERPAID callout. "0" если оплат ещё не
   * было.
   */
  amountPaid: string;
}

export interface SessionBookingItem {
  id: string;
  equipmentId: string;
  quantity: number;
  equipment: { name: string; stockTrackingMode: string };
  trackingMode: "COUNT" | "UNIT";
  /** Ожидаемое количество (для UNIT-позиций: кол-во BookingItemUnit) */
  expected?: number;
  /** Отсканировано из этой позиции */
  scanned?: number;
  /** Зарезервированные юниты, недоступные для выдачи (статус != AVAILABLE) */
  reservedButUnavailable?: string[];
}

export interface SessionWithDetails {
  session: {
    id: string;
    bookingId: string;
    operation: string;
    status: string;
    workerName: string;
    startedAt: Date;
    completedAt: Date | null;
    scans: Array<{
      id: string;
      equipmentUnitId: string;
      scannedAt: Date;
      equipmentUnit: { id: string; equipmentId: string; equipment: { name: string } };
    }>;
  };
  bookingItems: SessionBookingItem[];
}

// ──────────────────────────────────────────────
// 5.1 createSession
// ──────────────────────────────────────────────

/**
 * Создаёт (или переиспользует) сессию сканирования для брони.
 *
 * Поведение:
 * - Бронь существует и не отменена.
 * - Для ISSUE: бронь в статусе CONFIRMED.
 * - Для RETURN: бронь в статусе ISSUED.
 * - Если для этой пары `(bookingId, operation)` УЖЕ есть ACTIVE-сессия —
 *   возвращаем её (idempotent). Это закрывает реальный сценарий: кладовщик
 *   закрыл вкладку посередине чек-листа, пришёл через час → жмёт ту же
 *   бронь → продолжает с того же места, а не получает 500.
 *
 * Бизнес-ошибки кидаются как `HttpError(409, …)` → глобальный обработчик
 * вернёт 409 с понятным русским сообщением, а не маскирует под 500.
 */
export async function createSession(
  bookingId: string,
  workerName: string,
  operation: ScanOperation,
) {
  const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
  if (!booking) {
    throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
  }
  if (booking.status === "CANCELLED") {
    throw new HttpError(409, "Бронь отменена", "BOOKING_CANCELLED");
  }
  if (operation === "ISSUE" && booking.status !== "CONFIRMED") {
    throw new HttpError(
      409,
      "Для выдачи бронь должна быть в статусе CONFIRMED",
      "BOOKING_WRONG_STATUS",
    );
  }
  if (operation === "RETURN" && booking.status !== "ISSUED") {
    throw new HttpError(
      409,
      "Для возврата бронь должна быть в статусе ISSUED",
      "BOOKING_WRONG_STATUS",
    );
  }

  // Атомарно: либо находим существующую ACTIVE-сессию и возвращаем её,
  // либо создаём новую. Транзакция нужна на случай конкурентного открытия —
  // findFirst + create под одним lock'ом.
  return prisma.$transaction(async (tx: TxClient) => {
    const existing = await tx.scanSession.findFirst({
      where: { bookingId, operation, status: "ACTIVE" },
    });
    if (existing) {
      return existing;
    }

    return tx.scanSession.create({
      data: {
        bookingId,
        workerName,
        operation,
        status: "ACTIVE",
      },
    });
  });
}

// ──────────────────────────────────────────────
// 5.2 recordScan — REMOVED
//
// Раньше здесь был recordScan() + POST /api/warehouse/sessions/:id/scan для
// штрихкод-сканирования. Складской UI (apps/web/app/warehouse/scan) переписан
// на чек-лист (/state, /check, /uncheck, /items, /complete) — путь со сканером
// мёртвый. Резолв штрихкода (resolveBarcode) живёт в services/barcode.ts и
// используется /api/equipment-units/lookup, поэтому не удалён.
// ──────────────────────────────────────────────

// ──────────────────────────────────────────────
// 5.3 completeSession
// ──────────────────────────────────────────────

/**
 * Завершает сессию сканирования и применяет изменения статусов единиц.
 *
 * ISSUE: статусы AVAILABLE → ISSUED, создаёт BookingItemUnit
 * RETURN: статусы ISSUED → AVAILABLE, устанавливает returnedAt
 *
 * @returns ReconciliationSummary с количеством отсканированных, ожидаемых, пропущенных и замен
 */
export async function completeSession(
  sessionId: string,
  options?: {
    repairUnits?: RepairUnit[];
    problemUnits?: ProblemUnit[];
    createdBy?: string;
    /** Task 7: per-position quantity adjustments at ISSUE completion. */
    issuanceAdjustments?: IssuanceAdjustment[];
  },
): Promise<ReconciliationSummary> {
  // Загружаем сессию со сканами и информацией о брони
  const session = await prisma.scanSession.findUnique({
    where: { id: sessionId },
    include: {
      booking: true,
      scans: {
        include: {
          equipmentUnit: true,
        },
      },
    },
  });

  if (!session || session.status !== "ACTIVE") {
    throw new Error("Сессия должна быть активной");
  }
  if (session.booking.status === "CANCELLED") {
    throw new Error("Бронь отменена");
  }

  const scannedUnitIds = new Set(session.scans.map((s) => s.equipmentUnitId));
  const issuanceAdjustments = options?.issuanceAdjustments ?? [];
  const hasAdjustments =
    session.operation === "ISSUE" && issuanceAdjustments.length > 0;

  // ── COUNT-mode split validation (RETURN only) ──────────────────────────────
  // На странице приёмки оператор может разнести N единиц одной BookingItem по
  // трём «корзинам»: Принято / Ремонт / Проблема. Backend получает суммы по
  // COUNT-форме repair/problem-входов. Если repair + problem > BookingItem.qty
  // — это конфликт ввода, кидаем 400 ДО любых мутаций (включая физический
  // RETURN). UNIT-форма входов не участвует в проверке — она привязана к
  // конкретному equipmentUnitId.
  if (session.operation === "RETURN") {
    const repairsList = options?.repairUnits ?? [];
    const problemsList = options?.problemUnits ?? [];
    const countRepairByBi = new Map<string, number>();
    const countProblemByBi = new Map<string, number>();
    for (const r of repairsList) {
      if ("bookingItemId" in r && r.bookingItemId) {
        countRepairByBi.set(
          r.bookingItemId,
          (countRepairByBi.get(r.bookingItemId) ?? 0) + r.quantity,
        );
      }
    }
    for (const p of problemsList) {
      if ("bookingItemId" in p && p.bookingItemId) {
        countProblemByBi.set(
          p.bookingItemId,
          (countProblemByBi.get(p.bookingItemId) ?? 0) + p.quantity,
        );
      }
    }
    const splitBiIds = new Set<string>([
      ...countRepairByBi.keys(),
      ...countProblemByBi.keys(),
    ]);
    if (splitBiIds.size > 0) {
      const bis = await prisma.bookingItem.findMany({
        where: { id: { in: Array.from(splitBiIds) }, bookingId: session.bookingId },
        select: { id: true, quantity: true },
      });
      for (const bi of bis) {
        const repair = countRepairByBi.get(bi.id) ?? 0;
        const problem = countProblemByBi.get(bi.id) ?? 0;
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
  }

  // Snapshot для возврата в summary — захватываем ВНУТРИ транзакции (см. ниже).
  let mainOriginalAfterDiscount = "0";

  const summary = await prisma.$transaction(async (tx: TxClient) => {
    // ── Task 7: snapshot MAIN.totalAfterDiscount ДО любых мутаций ────────────
    // Используется UI для блока «исходно / фактически» — даже когда
    // adjustments не применялись, snapshot отдаёт текущий MAIN.
    // try/catch — для совместимости с легаси unit-тестами, где tx-mock
    // не определяет .estimate (см. warehouseScan.test.ts).
    try {
      const mainBefore = await tx.estimate.findFirst({
        where: { bookingId: session.bookingId, kind: "MAIN" },
        select: { totalAfterDiscount: true },
      });
      mainOriginalAfterDiscount = mainBefore
        ? mainBefore.totalAfterDiscount.toString()
        : "0";
    } catch {
      mainOriginalAfterDiscount = "0";
    }

    // ── Task 7: применение issuanceAdjustments (только ISSUE) ────────────────
    if (hasAdjustments) {
      const itemIds = issuanceAdjustments.map((a) => a.bookingItemId);
      const adjItems = await tx.bookingItem.findMany({
        where: { id: { in: itemIds }, bookingId: session.bookingId },
        include: {
          equipment: { select: { id: true, name: true, stockTrackingMode: true } },
          unitReservations: true,
        },
      });
      if (adjItems.length !== itemIds.length) {
        throw new HttpError(
          400,
          "Некорректные adjustments — bookingItem не принадлежит этой брони",
          "INVALID_ADJUSTMENTS",
        );
      }

      // Множество отсканированных в этой сессии equipmentUnitId — нужно для
      // проверки UNIT-режима. session.scans уже содержит все scanRecords.
      const scannedSet = new Set(session.scans.map((s) => s.equipmentUnitId));

      for (const adj of issuanceAdjustments) {
        const bi = adjItems.find((i) => i.id === adj.bookingItemId);
        if (!bi) {
          throw new HttpError(
            400,
            "Некорректные adjustments — bookingItem не принадлежит этой брони",
            "INVALID_ADJUSTMENTS",
          );
        }
        // U2: actualQuantity ≥ 0 — нижняя граница. Верхняя граница теперь
        // динамическая: bi.quantity + addCap (см. ниже). Это позволяет
        // inline-добор через тот же endpoint без отдельного вызова /items.
        if (!Number.isInteger(adj.actualQuantity) || adj.actualQuantity < 0) {
          throw new HttpError(
            400,
            "actualQuantity вне диапазона [0, …]",
            "INVALID_ADJUSTMENTS",
          );
        }
        if (adj.actualQuantity === bi.quantity) {
          // no-op: качество не меняется, в audit писать нечего.
          continue;
        }

        const delta = adj.actualQuantity - bi.quantity;
        const stockMode = bi.equipment?.stockTrackingMode ?? "COUNT";

        // ── U2: положительная дельта — inline-добор ─────────────────────────
        // Логика addCap идентична addExtraItem(): equipment.totalQuantity −
        // occupiedByOthers − bi.quantity. Если delta > addCap → 409
        // ADDON_OVER_STOCK с теми же details, что у +Добор-эндпоинта.
        //
        // Для UNIT-mode НЕ создаём BookingItemUnit-резервации: оператор берёт
        // лишние единицы со склада прямо сейчас, физически. Если впоследствии
        // понадобится резервация — это отдельный workflow (карточки/MAIN
        // ребилд). Аудит положительной дельты — BOOKING_ITEM_QUANTITY_INCREASED
        // (по тому же шаблону, что и REDUCED).
        if (delta > 0 && bi.equipmentId) {
          const txEquipment = await tx.equipment.findUnique({
            where: { id: bi.equipmentId },
            select: { totalQuantity: true },
          });
          if (!txEquipment) {
            throw new HttpError(
              404,
              "Оборудование не найдено",
              "EQUIPMENT_NOT_FOUND",
            );
          }
          const overlappingItems = await tx.bookingItem.findMany({
            where: {
              equipmentId: bi.equipmentId,
              bookingId: { not: session.bookingId },
              booking: {
                status: { in: ["DRAFT", "CONFIRMED", "ISSUED"] },
                startDate: { lte: session.booking.endDate },
                endDate: { gte: session.booking.startDate },
              },
            },
            select: { quantity: true },
          });
          const occupiedByOthers = overlappingItems.reduce(
            (s, it) => s + it.quantity,
            0,
          );
          const addCap = txEquipment.totalQuantity - occupiedByOthers - bi.quantity;

          if (delta > addCap) {
            throw new HttpError(
              409,
              "Не хватает на складе",
              "ADDON_OVER_STOCK",
              {
                addCap: Math.max(0, addCap),
                requested: adj.actualQuantity,
                alreadyInBooking: bi.quantity,
              },
            );
          }
          // UNIT-mode положительная дельта: BookingItemUnit-резервации НЕ
          // создаём — это on-the-spot inline-добор (см. комментарий выше).
        }

        // ── Отрицательная дельта: UNIT-режим освобождает (M − N)
        //    НЕотсканированных резерваций (поведение Task 7 сохраняется). ───
        if (delta < 0 && stockMode === "UNIT") {
          const releaseCount = -delta;
          const releasable = bi.unitReservations.filter(
            (u) => !scannedSet.has(u.equipmentUnitId),
          );
          const scannedForItemCount = bi.unitReservations.length - releasable.length;

          if (releasable.length < releaseCount) {
            // КРИТИЧНО: проверка ДО любых мутаций, иначе транзакция оставила
            // бы частично применённые adjustments. Throw → откат всего блока.
            throw new HttpError(
              409,
              `Нельзя снять ${releaseCount} шт: ${scannedForItemCount} единиц уже отсканированы`,
              "ADJUSTMENT_CONFLICTS_WITH_SCANS",
              {
                bookingItemId: bi.id,
                scannedCount: scannedForItemCount,
                requestedQuantity: adj.actualQuantity,
              },
            );
          }

          const toRelease = releasable.slice(0, releaseCount);
          for (const biu of toRelease) {
            await tx.bookingItemUnit.delete({ where: { id: biu.id } });
            await writeAuditEntry({
              tx,
              userId: options?.createdBy ?? session.workerName,
              action: "BOOKING_ITEM_UNIT_RELEASED",
              entityType: "Booking",
              entityId: session.bookingId,
              before: null,
              after: {
                bookingItemUnitId: biu.id,
                equipmentUnitId: biu.equipmentUnitId,
                sessionId,
              },
            }).catch(() => {
              // userId — workerName в реальном проде → P2003. Аудит = best-effort.
            });
          }
        }

        // ── Сам апдейт BookingItem.quantity (обе ветки) ─────────────────────
        const beforeQty = bi.quantity;
        await tx.bookingItem.update({
          where: { id: bi.id },
          data: { quantity: adj.actualQuantity },
        });

        // U2: разные action-имена для +/− дельт. REDUCED сохраняется для
        // обратной совместимости с существующими интеграционными тестами
        // и дашбордами, INCREASED — новый action для inline-добор-кейса.
        await writeAuditEntry({
          tx,
          userId: options?.createdBy ?? session.workerName,
          action:
            delta > 0
              ? "BOOKING_ITEM_QUANTITY_INCREASED"
              : "BOOKING_ITEM_QUANTITY_REDUCED",
          entityType: "Booking",
          entityId: session.bookingId,
          before: { quantity: beforeQty },
          after: {
            quantity: adj.actualQuantity,
            delta,
            sessionId,
            equipmentId: bi.equipmentId,
            equipmentName: bi.equipment?.name ?? null,
          },
        }).catch(() => {
          // userId FK → AdminUser; в реальном проде workerName != AdminUser.id
          // → P2003. Аудит — best-effort, не блокирует бизнес-операцию.
        });
      }
    }

    // Загружаем позиции заказа (после adjustments — quantity уже обновлены)
    const bookingItems = await tx.bookingItem.findMany({
      where: { bookingId: session.bookingId },
    });

    // Загружаем все резервации BookingItemUnit для этой брони
    const bookingItemIds = bookingItems.map((bi) => bi.id);
    const allReservations = await tx.bookingItemUnit.findMany({
      where: {
        bookingItemId: { in: bookingItemIds },
        ...(session.operation === "RETURN" ? { returnedAt: null } : {}),
      },
      include: { equipmentUnit: true },
    });

    // Карта: equipmentId → bookingItem (произвольные позиции без equipmentId исключаются)
    const bookingItemByEquipmentId = new Map(
      bookingItems.filter((bi) => bi.equipmentId != null).map((bi) => [bi.equipmentId, bi]),
    );

    const summary: ReconciliationSummary = {
      scanned: scannedUnitIds.size,
      expected: allReservations.length,
      missing: [],
      substituted: [],
      reservedButUnavailable: [],
      createdRepairIds: [],
      failedBrokenUnits: [],
      createdProblemItemIds: [],
      failedProblemUnits: [],
      mainAfterDiscount: "0",
      addonAfterDiscount: "0",
      finalAmount: "0",
      mainOriginalAfterDiscount: "0",
      paymentStatus: "NOT_PAID",
      amountPaid: "0",
    };

    if (session.operation === "ISSUE") {
      // Для каждого отсканированного юнита: статус → ISSUED + BookingItemUnit
      for (const scan of session.scans) {
        const unit = scan.equipmentUnit;
        await tx.equipmentUnit.update({
          where: { id: unit.id },
          data: { status: "ISSUED" },
        });

        // Найти соответствующий BookingItem
        const bi = bookingItemByEquipmentId.get(unit.equipmentId);
        if (!bi) continue;

        // Проверить, есть ли уже запись резервации для этого юнита
        const existingReservation = allReservations.find(
          (r) => r.equipmentUnitId === unit.id && r.bookingItemId === bi.id,
        );

        if (!existingReservation) {
          // Новый юнит (замена): создаём BookingItemUnit
          await tx.bookingItemUnit.create({
            data: {
              bookingItemId: bi.id,
              equipmentUnitId: unit.id,
            },
          });
          summary.substituted.push(unit.id);
        }
      }

      // Удалить резервации для зарезервированных, но не отсканированных юнитов
      for (const reservation of allReservations) {
        if (!scannedUnitIds.has(reservation.equipmentUnitId)) {
          summary.missing.push(reservation.equipmentUnitId);
          await tx.bookingItemUnit.delete({ where: { id: reservation.id } });
        }
      }

      // Перевод брони в статус ISSUED — финальный физический эффект выдачи.
      // Идемпотентно при повторном вызове на ACTIVE-сессии: Prisma update
      // просто запишет ту же строку. Гонка с другой сессией исключена
      // ACTIVE-сессион-гардом из createSession.
      await tx.booking.update({
        where: { id: session.bookingId },
        data: { status: "ISSUED" },
      });
    } else {
      // RETURN: для каждого отсканированного юнита — AVAILABLE + returnedAt
      for (const scan of session.scans) {
        const unit = scan.equipmentUnit;
        await tx.equipmentUnit.update({
          where: { id: unit.id },
          data: { status: "AVAILABLE" },
        });

        // Найти BookingItemUnit и установить returnedAt
        const reservation = allReservations.find((r) => r.equipmentUnitId === unit.id);
        if (reservation) {
          await tx.bookingItemUnit.update({
            where: { id: reservation.id },
            data: { returnedAt: new Date() },
          });
        }
      }

      // Юниты НЕ отсканированные → остаются ISSUED, помечаем как пропущенные
      for (const reservation of allReservations) {
        if (!scannedUnitIds.has(reservation.equipmentUnitId)) {
          summary.missing.push(reservation.equipmentUnitId);
        }
      }
    }

    await tx.scanSession.update({
      where: { id: sessionId },
      data: { status: "COMPLETED", completedAt: new Date() },
    });

    return summary;
  });

  const createdBy = options?.createdBy ?? session.workerName;

  // BOOKING_STATUS_CHANGED — best-effort, ВНЕ транзакции.
  // AuditEntry.userId — FK на AdminUser, а workerName из WarehousePin не
  // соответствует AdminUser.id → P2003 ожидаем и логируем. Аудит здесь —
  // observability, не бизнес-инвариант: физический переход уже зафиксирован.
  if (session.operation === "ISSUE") {
    await writeAuditEntry({
      userId: createdBy,
      action: "BOOKING_STATUS_CHANGED",
      entityType: "Booking",
      entityId: session.bookingId,
      before: { status: session.booking.status },
      after: { status: "ISSUED", source: "warehouse-scan-issue", sessionId },
    }).catch((err) =>
      console.warn("[completeSession ISSUE] booking-status audit failed:", err),
    );
  }

  // После завершения транзакции — создаём карточки ремонта для поломанных единиц.
  // urgency не собирается в быстром UI → дефолт NORMAL.
  //
  // RepairUnit поддерживает две формы:
  //   - UNIT: { equipmentUnitId, comment, urgency? } → createRepair(unit) +
  //     перенос staged-фото + перевод unit в MAINTENANCE (через createRepair).
  //   - COUNT: { bookingItemId, quantity, comment } → tx.repair.create без
  //     unitId; staged-фото не переносятся (нет привязки к юниту); статусы
  //     equipmentUnit не трогаются.
  const repairUnits = options?.repairUnits ?? [];
  if (repairUnits.length > 0 && session.operation === "RETURN") {
    for (const r of repairUnits) {
      if ("equipmentUnitId" in r && r.equipmentUnitId) {
        // ── UNIT-mode (legacy) ─────────────────────────────────────────────
        try {
          const repair = await createRepair({
            unitId: r.equipmentUnitId,
            reason: r.comment,
            urgency: r.urgency ?? "NORMAL",
            sourceBookingId: session.bookingId,
            createdBy,
          });
          summary.createdRepairIds.push(repair.id);

          // Перенос staged-фото поломки этой единицы в uploads/repairs/{repairId}/
          // и создание RepairPhoto-записей. Только success-путь (после успешного
          // создания Repair). Не блокирует завершение при отсутствии фото.
          const moved = moveStagedToRepair(sessionId, r.equipmentUnitId, repair.id);
          if (moved.length > 0) {
            await prisma.repairPhoto.createMany({
              data: moved.map((fp) => ({ repairId: repair.id, filePath: fp, createdBy })),
            });
          }
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error("createRepair failed during scan completion", {
            unitId: r.equipmentUnitId,
            bookingId: session.bookingId,
            error: errMsg,
          });

          // Безопасность: возвращаем unit в MAINTENANCE, чтобы не сдать сломанный в аренду
          try {
            await prisma.equipmentUnit.update({
              where: { id: r.equipmentUnitId },
              data: { status: "MAINTENANCE" },
            });
            console.error("unit restored to MAINTENANCE after createRepair failure", { unitId: r.equipmentUnitId });
          } catch (fallbackErr: unknown) {
            console.error("CRITICAL: failed to restore unit to MAINTENANCE", {
              unitId: r.equipmentUnitId,
              fallbackError: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
            });
          }

          // Аудит провала (без транзакции)
          try {
            await writeAuditEntry({
              userId: createdBy,
              action: "REPAIR_CREATE_FAILED",
              entityType: "EquipmentUnit",
              entityId: r.equipmentUnitId,
              before: null,
              after: { reason: r.comment, urgency: r.urgency ?? "NORMAL", error: errMsg },
            });
          } catch { /* аудит не должен блокировать */ }

          summary.failedBrokenUnits.push({
            unitId: r.equipmentUnitId,
            reason: r.comment,
            error: errMsg,
          });
        }
      } else if ("bookingItemId" in r && r.bookingItemId) {
        // ── COUNT-mode (Task 2 — return COUNT-split) ───────────────────────
        // Один Repair-row на N единиц одной BookingItem. Никакого unit-id,
        // никаких staged-фото, никаких MAINTENANCE-переходов: позиция COUNT —
        // вне UNIT-трекинга.
        try {
          const repair = await prisma.repair.create({
            data: {
              bookingItemId: r.bookingItemId,
              quantity: r.quantity,
              reason: r.comment,
              urgency: "NORMAL",
              status: "WAITING_REPAIR",
              sourceBookingId: session.bookingId,
              createdBy,
              partsCost: 0,
              totalTimeHours: 0,
            },
          });
          summary.createdRepairIds.push(repair.id);
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error("[completeSession] COUNT repair create failed", {
            bookingItemId: r.bookingItemId,
            quantity: r.quantity,
            bookingId: session.bookingId,
            error: errMsg,
          });
          summary.failedBrokenUnits.push({
            unitId: r.bookingItemId,
            reason: r.comment,
            error: errMsg,
          });
        }
      }
    }
  }

  // ── Обработка проблемных единиц «Потеряшки» (только для операции RETURN) ────
  // createProblemItem (UNIT-форма) открывает собственную транзакцию. Каждая
  // единица обрабатывается изолированно — сбой одной не валит остальные и не
  // откатывает физический возврат.
  //
  // ProblemUnit поддерживает две формы:
  //   - UNIT: { equipmentUnitId, reason, comment, expectedBackDate? } →
  //     createProblemItem(unit) с трансформацией статуса equipmentUnit и
  //     reason-зависимой логикой (DESTROYED → RETIRED + WROTE_OFF, и т.д.).
  //   - COUNT: { bookingItemId, quantity, reason, comment, expectedBackDate? } →
  //     tx.problemItem.create без equipmentUnitId; статусы юнитов не трогаются,
  //     reason используется только как enum-метка в строке (без авто-WROTE_OFF).
  const problemUnits = options?.problemUnits ?? [];
  if (problemUnits.length > 0 && session.operation === "RETURN") {
    for (const p of problemUnits) {
      if ("equipmentUnitId" in p && p.equipmentUnitId) {
        // ── UNIT-mode (legacy) ─────────────────────────────────────────────
        try {
          const pi = await createProblemItem({
            equipmentUnitId: p.equipmentUnitId,
            reason: p.reason,
            comment: p.comment,
            expectedBackDate: p.expectedBackDate ? new Date(p.expectedBackDate) : null,
            sourceBookingId: session.bookingId,
            createdBy,
          });
          summary.createdProblemItemIds.push(pi.id);
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[completeSession] problem unit ${p.equipmentUnitId} failed:`, err);
          summary.failedProblemUnits.push({
            equipmentUnitId: p.equipmentUnitId,
            reason: errMsg,
          });
        }
      } else if ("bookingItemId" in p && p.bookingItemId) {
        // ── COUNT-mode (Task 2 — return COUNT-split) ───────────────────────
        // Простой insert ProblemItem-row с bookingItemId + quantity. Без
        // equipmentUnit-side-эффектов: COUNT-позиция вне UNIT-трекинга.
        // DESTROYED-кейс через COUNT-форму намеренно НЕ обрабатывается
        // (нечего «списать» — нет конкретного юнита). UI-валидация не должна
        // допускать reason=DESTROYED в COUNT-форме, но фронт-валидатор не
        // имеет обязательной силы → попадание сюда фиксирует строку без
        // WROTE_OFF-логики (status по умолчанию = SEARCHING).
        try {
          const pi = await prisma.problemItem.create({
            data: {
              bookingItemId: p.bookingItemId,
              quantity: p.quantity,
              sourceBookingId: session.bookingId,
              reason: p.reason,
              comment: p.comment,
              expectedBackDate: p.expectedBackDate ? new Date(p.expectedBackDate) : null,
              status: p.reason === "LEFT_ON_SITE" ? "EXPECTED" : "SEARCHING",
              createdBy,
            },
          });
          summary.createdProblemItemIds.push(pi.id);
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error("[completeSession] COUNT problem create failed", {
            bookingItemId: p.bookingItemId,
            quantity: p.quantity,
            bookingId: session.bookingId,
            error: errMsg,
          });
          summary.failedProblemUnits.push({
            equipmentUnitId: p.bookingItemId,
            reason: errMsg,
          });
        }
      }
    }
  }

  // ── Авто-резолв открытых карточек «Потеряшки» при повторной приёмке ─────────
  // Best-effort, ПОСЛЕ основной транзакции: autoResolveOnReturn пишет аудит-
  // запись, а createdBy в проде — имя кладовщика (не AdminUser.id), поэтому
  // insert FK-падает. Внутри основной транзакции это откатило бы весь
  // физический возврат — недопустимая регрессия. Аудит здесь = коррекция
  // статуса + observability, не бизнес-инвариант (документированный trade-off).
  //
  // Единицы, по которым в ЭТОЙ же приёмке заведена проблема/ремонт, исключаются:
  // их новый статус (MISSING/RETIRED/MAINTENANCE) — авторитетный итог сессии,
  // авто-резолв не должен «вернуть» только что заведённую карточку в FOUND.
  // Сценарий авто-резолва — поздний возврат единицы, помеченной В ПРОШЛОЙ сессии.
  if (session.operation === "RETURN") {
    // COUNT-форма не имеет equipmentUnitId — она не помечает конкретные юниты,
    // а значит и не должна влиять на авто-резолв. Фильтруем только UNIT-форму.
    const flaggedThisSession = new Set<string>();
    for (const p of problemUnits) {
      if ("equipmentUnitId" in p && p.equipmentUnitId) {
        flaggedThisSession.add(p.equipmentUnitId);
      }
    }
    for (const r of repairUnits) {
      if ("equipmentUnitId" in r && r.equipmentUnitId) {
        flaggedThisSession.add(r.equipmentUnitId);
      }
    }
    for (const unitId of scannedUnitIds) {
      if (flaggedThisSession.has(unitId)) continue;
      try {
        await prisma.$transaction((tx: TxClient) => autoResolveOnReturn(tx, unitId, createdBy));
      } catch (e) {
        console.error("[completeSession] autoResolveOnReturn failed", unitId, e);
      }
    }
  }

  // ── Task 7: после ISSUE-adjustments — пересчёт MAIN/ADDON/Finance ──────────
  // recreateMainEstimate владеет собственной внутренней транзакцией, поэтому
  // ВЫЗЫВАЕТСЯ ПОСЛЕ commit'а основной (не внутри неё).
  // Порядок:
  //   1. recreateMainEstimate — MAIN снапшот из текущих BookingItem.quantity.
  //   2. recomputeAddonEstimate — ADDON = max(0, BookingItem.qty − MAIN.line.qty).
  //   3. recomputeBookingFinance — finalAmount, outstanding, paymentStatus
  //      (включая OVERPAID — Task 5).
  if (hasAdjustments) {
    try {
      await recreateMainEstimate(session.bookingId);
    } catch (err) {
      console.warn("[completeSession] recreateMainEstimate failed:", err);
    }
    try {
      await recomputeAddonEstimate(session.bookingId);
    } catch (err) {
      console.warn("[completeSession] recomputeAddonEstimate failed:", err);
    }
    try {
      await recomputeBookingFinance(session.bookingId);
    } catch (err) {
      console.warn("[completeSession] recomputeBookingFinance failed:", err);
    }
  }

  // НОВОЕ: финансовая разбивка для result-screen фронта.
  // recomputeBookingFinance уже учёл ADDON Estimate в выше вызванной цепочке,
  // здесь только читаем актуальные значения.
  // Task 13: также читаем paymentStatus + amountPaid, чтобы UI мог нарисовать
  // OVERPAID-callout и сумму «К возврату» без отдельного запроса.
  try {
    const fresh = await prisma.booking.findUnique({
      where: { id: session.bookingId },
      include: { estimates: true },
    });
    if (fresh) {
      const main = fresh.estimates.find((e) => e.kind === "MAIN");
      const addon = fresh.estimates.find((e) => e.kind === "ADDON");
      summary.mainAfterDiscount = main ? main.totalAfterDiscount.toString() : "0";
      summary.addonAfterDiscount = addon ? addon.totalAfterDiscount.toString() : "0";
      summary.finalAmount = fresh.finalAmount.toString();
      summary.paymentStatus = fresh.paymentStatus;
      summary.amountPaid = fresh.amountPaid.toString();
    }
  } catch (err) {
    console.warn("[completeSession] finance snapshot read failed:", err);
  }

  // Task 7: snapshot ДО adjustments (захвачен внутри транзакции). Кладём в
  // summary в самом конце, чтобы UI получил «исходно/фактически» одной парой.
  summary.mainOriginalAfterDiscount = mainOriginalAfterDiscount;

  return summary;
}

// ──────────────────────────────────────────────
// 5.4 cancelSession
// ──────────────────────────────────────────────

/**
 * Отменяет активную сессию сканирования.
 * Статусы единиц не изменяются. ScanRecord'ы сохраняются для аудита.
 */
export async function cancelSession(sessionId: string) {
  const session = await prisma.scanSession.findUnique({ where: { id: sessionId } });
  if (!session || session.status !== "ACTIVE") {
    throw new Error("Отмена возможна только для активной сессии");
  }
  return prisma.scanSession.update({
    where: { id: sessionId },
    data: { status: "CANCELLED" },
  });
}

// ──────────────────────────────────────────────
// 5.4b getReconciliationPreview
// ──────────────────────────────────────────────

/**
 * Предварительный просмотр сверки (без изменения данных).
 * Позволяет складскому работнику увидеть, что отсканировано, а что нет,
 * прежде чем завершать сессию.
 */
export async function getReconciliationPreview(sessionId: string): Promise<ReconciliationSummary> {
  const session = await prisma.scanSession.findUnique({
    where: { id: sessionId },
    include: {
      booking: true,
      scans: {
        include: { equipmentUnit: true },
      },
    },
  });

  if (!session) {
    throw new Error("Сессия не найдена");
  }

  const scannedUnitIds = new Set(session.scans.map((s) => s.equipmentUnitId));

  const bookingItems = await prisma.bookingItem.findMany({
    where: { bookingId: session.bookingId },
  });
  const bookingItemIds = bookingItems.map((bi) => bi.id);
  const allReservations = await prisma.bookingItemUnit.findMany({
    where: {
      bookingItemId: { in: bookingItemIds },
      ...(session.operation === "RETURN" ? { returnedAt: null } : {}),
    },
    include: {
      equipmentUnit: { select: { id: true, status: true } },
      bookingItem: { include: { equipment: { select: { name: true } } } },
    },
    orderBy: { id: "asc" }, // stable ordinal across calls
  });

  const reservedUnitIds = new Set(allReservations.map((r) => r.equipmentUnitId));

  // ── Enriched «зарезервирован, но недоступен» (только для ISSUE) ─────────────
  // Группируем по bookingItemId и нумеруем единицы внутри группы — это даёт
  // стабильный ordinal вида «прибор N из M», совпадающий с тем, что увидит
  // оператор в чек-листе для AVAILABLE-единиц (см. checklistService.ts).
  const reservedButUnavailable: ReservedButUnavailableUnit[] = [];
  if (session.operation === "ISSUE") {
    const byBookingItem = new Map<string, typeof allReservations>();
    for (const r of allReservations) {
      const arr = byBookingItem.get(r.bookingItemId) ?? [];
      arr.push(r);
      byBookingItem.set(r.bookingItemId, arr);
    }
    for (const [, group] of byBookingItem) {
      group.forEach((r, idx) => {
        const unitStatus = r.equipmentUnit?.status;
        if (unitStatus && unitStatus !== "AVAILABLE") {
          reservedButUnavailable.push({
            equipmentUnitId: r.equipmentUnitId,
            equipmentName: r.bookingItem?.equipment?.name ?? "—",
            ordinalLabel: `прибор ${idx + 1} из ${group.length}`,
            status: unitStatus,
          });
        }
      });
    }
  }

  const missing: string[] = [];
  const substituted: string[] = [];

  // Зарезервированные, но не отсканированные
  for (const reservation of allReservations) {
    if (!scannedUnitIds.has(reservation.equipmentUnitId)) {
      missing.push(reservation.equipmentUnitId);
    }
  }

  // Отсканированные, но не зарезервированные (замены)
  for (const scan of session.scans) {
    if (!reservedUnitIds.has(scan.equipmentUnitId)) {
      substituted.push(scan.equipmentUnitId);
    }
  }

  return {
    scanned: scannedUnitIds.size,
    expected: allReservations.length,
    missing,
    substituted,
    reservedButUnavailable,
    createdRepairIds: [],
    failedBrokenUnits: [],
    createdProblemItemIds: [],
    failedProblemUnits: [],
    mainAfterDiscount: "0",
    addonAfterDiscount: "0",
    finalAmount: "0",
    mainOriginalAfterDiscount: "0",
    paymentStatus: "NOT_PAID",
    amountPaid: "0",
  };
}

// ──────────────────────────────────────────────
// 5.5 getSessionWithDetails
// ──────────────────────────────────────────────

/**
 * Загружает сессию сканирования с детальной информацией.
 *
 * Для каждой UNIT-позиции заказа вычисляет:
 * - expected: количество зарезервированных BookingItemUnit
 * - scanned: количество отсканированных юнитов из этой позиции
 * - reservedButUnavailable: зарезервированные юниты со статусом != AVAILABLE (для ISSUE)
 *
 * COUNT-позиции помечаются trackingMode: "COUNT" и не требуют сканирования.
 */
export async function getSessionWithDetails(sessionId: string): Promise<SessionWithDetails> {
  const session = await prisma.scanSession.findUnique({
    where: { id: sessionId },
    include: {
      scans: {
        include: {
          equipmentUnit: {
            include: {
              equipment: { select: { name: true } },
            },
          },
        },
      },
    },
  });
  if (!session) {
    throw new Error("Сессия не найдена");
  }

  // Загружаем позиции заказа с зарезервированными юнитами
  const bookingItems = await prisma.bookingItem.findMany({
    where: { bookingId: session.bookingId },
    include: {
      equipment: { select: { id: true, name: true, stockTrackingMode: true } },
      unitReservations: {
        include: {
          equipmentUnit: { select: { id: true, status: true } },
        },
      },
    },
  });

  // Множество отсканированных equipmentUnitId для быстрого поиска
  const scannedUnitIdsByEquipmentId = new Map<string, Set<string>>();
  for (const scan of session.scans) {
    const eqId = scan.equipmentUnit.equipmentId;
    if (!scannedUnitIdsByEquipmentId.has(eqId)) {
      scannedUnitIdsByEquipmentId.set(eqId, new Set());
    }
    scannedUnitIdsByEquipmentId.get(eqId)!.add(scan.equipmentUnitId);
  }

  const enrichedItems: SessionBookingItem[] = bookingItems
    .filter((bi) => bi.equipmentId != null && bi.equipment != null)
    .map((bi) => {
      const mode = bi.equipment!.stockTrackingMode as "COUNT" | "UNIT";

      if (mode === "COUNT") {
        return {
          id: bi.id,
          equipmentId: bi.equipmentId!,
          quantity: bi.quantity,
          equipment: { name: bi.equipment!.name, stockTrackingMode: mode },
          trackingMode: "COUNT" as const,
        };
      }

      // UNIT-позиция
      const expected = bi.unitReservations.length;
      const scannedForThisItem = scannedUnitIdsByEquipmentId.get(bi.equipmentId!)?.size ?? 0;

      // Зарезервированные юниты с недоступным статусом (только для ISSUE)
      const reservedButUnavailable: string[] =
        session.operation === "ISSUE"
          ? bi.unitReservations
              .filter((r) => r.equipmentUnit?.status !== "AVAILABLE")
              .map((r) => r.equipmentUnitId)
          : [];

      return {
        id: bi.id,
        equipmentId: bi.equipmentId!,
        quantity: bi.quantity,
        equipment: { name: bi.equipment!.name, stockTrackingMode: mode },
        trackingMode: "UNIT" as const,
        expected,
        scanned: scannedForThisItem,
        reservedButUnavailable,
      };
    });

  return {
    session: {
      id: session.id,
      bookingId: session.bookingId,
      operation: session.operation,
      status: session.status,
      workerName: session.workerName,
      startedAt: session.startedAt,
      completedAt: session.completedAt,
      scans: session.scans.map((s) => ({
        id: s.id,
        equipmentUnitId: s.equipmentUnitId,
        scannedAt: s.scannedAt,
        equipmentUnit: {
          id: s.equipmentUnit.id,
          equipmentId: s.equipmentUnit.equipmentId,
          equipment: { name: s.equipmentUnit.equipment.name },
        },
      })),
    },
    bookingItems: enrichedItems,
  };
}
