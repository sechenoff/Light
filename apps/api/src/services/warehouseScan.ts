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
import { createRepair } from "./repairService";
import { createProblemItem, autoResolveOnReturn } from "./problemItemService";
import { moveStagedToRepair } from "./repairPhotoStorage";
import { writeAuditEntry } from "./audit";

type TxClient = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">;

// ──────────────────────────────────────────────
// Типы
// ──────────────────────────────────────────────

export type ScanOperation = "ISSUE" | "RETURN";

export interface RepairUnit {
  equipmentUnitId: string;
  comment: string;
  urgency?: RepairUrgency;
}

export interface ProblemUnit {
  equipmentUnitId: string;
  reason: ProblemReason;
  comment: string;
  expectedBackDate?: string;
}

export interface ReconciliationSummary {
  scanned: number;
  expected: number;
  missing: string[];    // equipmentUnitId[] не отсканированных
  substituted: string[]; // equipmentUnitId[] замен (отсканирован другой юнит вместо зарезервированного)
  createdRepairIds: string[];  // id карточек ремонта, успешно созданных после возврата
  failedBrokenUnits: Array<{ unitId: string; reason: string; error: string }>; // единицы, для которых ремонт не удалось создать
  createdProblemItemIds: string[]; // id карточек «Потеряшки», успешно созданных после возврата
  failedProblemUnits: Array<{ equipmentUnitId: string; reason: string }>; // проблемные единицы, которые не удалось обработать
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
 * Создаёт новую сессию сканирования для брони.
 *
 * Проверяет:
 * - Бронь существует и не отменена
 * - Для ISSUE: бронь в статусе CONFIRMED
 * - Для RETURN: бронь в статусе ISSUED
 * - Нет активной сессии для той же брони + операции
 */
export async function createSession(
  bookingId: string,
  workerName: string,
  operation: ScanOperation,
) {
  const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
  if (!booking) {
    throw new Error("Бронь не найдена");
  }
  if (booking.status === "CANCELLED") {
    throw new Error("Бронь отменена");
  }
  if (operation === "ISSUE" && booking.status !== "CONFIRMED") {
    throw new Error("Для выдачи бронь должна быть в статусе CONFIRMED");
  }
  if (operation === "RETURN" && booking.status !== "ISSUED") {
    throw new Error("Для возврата бронь должна быть в статусе ISSUED");
  }

  // Защита от конкурентных сессий (в транзакции для атомарности)
  return prisma.$transaction(async (tx: TxClient) => {
    const existing = await tx.scanSession.findFirst({
      where: { bookingId, operation, status: "ACTIVE" },
    });
    if (existing) {
      throw new Error("Уже существует активная сессия для этой брони и операции");
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
  options?: { repairUnits?: RepairUnit[]; problemUnits?: ProblemUnit[]; createdBy?: string },
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

  const summary = await prisma.$transaction(async (tx: TxClient) => {
    // Загружаем позиции заказа
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
      createdRepairIds: [],
      failedBrokenUnits: [],
      createdProblemItemIds: [],
      failedProblemUnits: [],
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

  // После завершения транзакции — создаём карточки ремонта для поломанных единиц.
  // urgency не собирается в быстром UI → дефолт NORMAL.
  const repairUnits = options?.repairUnits ?? [];
  if (repairUnits.length > 0 && session.operation === "RETURN") {
    for (const r of repairUnits) {
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
    }
  }

  // ── Обработка проблемных единиц «Потеряшки» (только для операции RETURN) ────
  // createProblemItem открывает собственную транзакцию (вызов без tx). Каждая
  // единица обрабатывается изолированно — сбой одной не валит остальные и не
  // откатывает физический возврат.
  const problemUnits = options?.problemUnits ?? [];
  if (problemUnits.length > 0 && session.operation === "RETURN") {
    for (const p of problemUnits) {
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
    const flaggedThisSession = new Set<string>([
      ...problemUnits.map((p) => p.equipmentUnitId),
      ...repairUnits.map((r) => r.equipmentUnitId),
    ]);
    for (const unitId of scannedUnitIds) {
      if (flaggedThisSession.has(unitId)) continue;
      try {
        await prisma.$transaction((tx: TxClient) => autoResolveOnReturn(tx, unitId, createdBy));
      } catch (e) {
        console.error("[completeSession] autoResolveOnReturn failed", unitId, e);
      }
    }
  }

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
  });

  const reservedUnitIds = new Set(allReservations.map((r) => r.equipmentUnitId));

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
    createdRepairIds: [],
    failedBrokenUnits: [],
    createdProblemItemIds: [],
    failedProblemUnits: [],
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
