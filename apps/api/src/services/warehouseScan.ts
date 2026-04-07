/**
 * Сервис управления сессиями сканирования на складе.
 *
 * Поддерживает операции:
 * - ISSUE (выдача): сканирование единиц при выдаче заказа
 * - RETURN (возврат): сканирование единиц при приёмке возврата
 *
 * Каждая сессия привязана к брони и проходит состояния: ACTIVE → COMPLETED | CANCELLED.
 */

import { prisma } from "../prisma";
import { verifyBarcodePayload } from "./barcode";

// ──────────────────────────────────────────────
// Типы
// ──────────────────────────────────────────────

export type ScanOperation = "ISSUE" | "RETURN";

export interface ReconciliationSummary {
  scanned: number;
  expected: number;
  missing: string[];    // equipmentUnitId[] не отсканированных
  substituted: string[]; // equipmentUnitId[] замен (отсканирован другой юнит вместо зарезервированного)
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

  // Защита от конкурентных сессий
  const existing = await prisma.scanSession.findFirst({
    where: { bookingId, operation, status: "ACTIVE" },
  });
  if (existing) {
    throw new Error("Уже существует активная сессия для этой брони и операции");
  }

  return prisma.scanSession.create({
    data: {
      bookingId,
      workerName,
      operation,
      status: "ACTIVE",
    },
  });
}

// ──────────────────────────────────────────────
// 5.2 recordScan
// ──────────────────────────────────────────────

/**
 * Регистрирует сканирование единицы оборудования в рамках сессии.
 *
 * @returns { error: string } при ошибке валидации
 * @returns { scanRecord, bookingItem, unit } при успехе
 */
export async function recordScan(
  sessionId: string,
  barcodePayload: string,
): Promise<
  | { error: string }
  | {
      scanRecord: { id: string; sessionId: string; equipmentUnitId: string; scannedAt: Date };
      bookingItem: { id: string; equipmentId: string };
      unit: { id: string; barcode: string | null };
    }
> {
  // Загружаем сессию с информацией о брони
  const session = await prisma.scanSession.findUnique({
    where: { id: sessionId },
    include: { booking: true },
  });
  if (!session || session.status !== "ACTIVE") {
    return { error: "Сессия не активна" };
  }

  // Верифицируем HMAC-подпись штрихкода
  const unitId = verifyBarcodePayload(barcodePayload);
  if (!unitId) {
    return { error: "Неверный штрихкод" };
  }

  // Находим единицу оборудования
  const unit = await prisma.equipmentUnit.findUnique({
    where: { id: unitId },
  });
  if (!unit || !unit.barcode) {
    return { error: "Неверный штрихкод" };
  }

  // Ищем позицию в заказе по equipmentId
  const bookingItem = await prisma.bookingItem.findFirst({
    where: { bookingId: session.bookingId, equipmentId: unit.equipmentId },
  });
  if (!bookingItem) {
    return { error: "Оборудование не найдено в заказе" };
  }

  // Проверяем статус единицы в зависимости от операции
  if (session.operation === "ISSUE") {
    if (unit.status !== "AVAILABLE") {
      return { error: "Единица недоступна для выдачи" };
    }
  } else {
    // RETURN: юнит должен быть выдан и иметь запись BookingItemUnit
    if (unit.status !== "ISSUED") {
      return { error: "Единица не была выдана" };
    }
    const biu = await prisma.bookingItemUnit.findFirst({
      where: { equipmentUnitId: unitId },
    });
    if (!biu) {
      return { error: "Единица не была выдана" };
    }
  }

  // Создаём запись сканирования (unique constraint защищает от дублей)
  try {
    const scanRecord = await prisma.scanRecord.create({
      data: {
        sessionId,
        equipmentUnitId: unitId,
      },
    });
    return { scanRecord, bookingItem, unit };
  } catch (err: any) {
    // P2002 = Unique constraint failed
    if (err?.code === "P2002") {
      return { error: "Единица уже отсканирована в этой сессии" };
    }
    throw err;
  }
}

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
export async function completeSession(sessionId: string): Promise<ReconciliationSummary> {
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

  return prisma.$transaction(async (tx: typeof prisma) => {
    // Загружаем позиции заказа
    const bookingItems = await tx.bookingItem.findMany({
      where: { bookingId: session.bookingId },
    });

    // Загружаем все резервации BookingItemUnit для этой брони
    const bookingItemIds = bookingItems.map((bi) => bi.id);
    const allReservations = await tx.bookingItemUnit.findMany({
      where: { bookingItemId: { in: bookingItemIds } },
      include: { equipmentUnit: true },
    });

    // Карта: equipmentId → bookingItem
    const bookingItemByEquipmentId = new Map(bookingItems.map((bi) => [bi.equipmentId, bi]));

    const summary: ReconciliationSummary = {
      scanned: scannedUnitIds.size,
      expected: allReservations.length,
      missing: [],
      substituted: [],
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

  const enrichedItems: SessionBookingItem[] = bookingItems.map((bi) => {
    const mode = bi.equipment.stockTrackingMode as "COUNT" | "UNIT";

    if (mode === "COUNT") {
      return {
        id: bi.id,
        equipmentId: bi.equipmentId,
        quantity: bi.quantity,
        equipment: { name: bi.equipment.name, stockTrackingMode: mode },
        trackingMode: "COUNT" as const,
      };
    }

    // UNIT-позиция
    const expected = bi.unitReservations.length;
    const scannedForThisItem = scannedUnitIdsByEquipmentId.get(bi.equipmentId)?.size ?? 0;

    // Зарезервированные юниты с недоступным статусом (только для ISSUE)
    const reservedButUnavailable: string[] =
      session.operation === "ISSUE"
        ? bi.unitReservations
            .filter((r) => r.equipmentUnit?.status !== "AVAILABLE")
            .map((r) => r.equipmentUnitId)
        : [];

    return {
      id: bi.id,
      equipmentId: bi.equipmentId,
      quantity: bi.quantity,
      equipment: { name: bi.equipment.name, stockTrackingMode: mode },
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
