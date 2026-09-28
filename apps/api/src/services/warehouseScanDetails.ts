/**
 * Просмотр сессии склада без изменений: предварительная сверка и детали по
 * позициям (сколько зарезервировано, отмечено, недоступно).
 */

import { prisma } from "../prisma";
import {
  emptySummary,
  notFoundSession,
  type ReconciliationSummary,
  type ReservedButUnavailableUnit,
  type SessionBookingItem,
  type SessionWithDetails,
} from "./warehouseScanShared";

// ──────────────────────────────────────────────
// 5.4b getReconciliationPreview
// ──────────────────────────────────────────────

/**
 * Предварительный просмотр сверки (без изменения данных): что отмечено, а что
 * нет, прежде чем завершать сессию.
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
  if (!session) throw notFoundSession();

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

  // «Зарезервирован, но недоступен» (только ISSUE): нумерация внутри позиции
  // даёт стабильное «прибор N из M», как в чек-листе.
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

  const missing = allReservations
    .filter((r) => !scannedUnitIds.has(r.equipmentUnitId))
    .map((r) => r.equipmentUnitId);
  const substituted = session.scans
    .filter((s) => !reservedUnitIds.has(s.equipmentUnitId))
    .map((s) => s.equipmentUnitId);

  return {
    ...emptySummary(),
    scanned: scannedUnitIds.size,
    expected: allReservations.length,
    missing,
    substituted,
    reservedButUnavailable,
  };
}

// ──────────────────────────────────────────────
// 5.5 getSessionWithDetails
// ──────────────────────────────────────────────

/**
 * Сессия с деталями по позициям: для UNIT — сколько зарезервировано,
 * отсканировано и недоступно; COUNT-позиции помечены trackingMode: "COUNT".
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
  if (!session) throw notFoundSession();

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
        expected: bi.unitReservations.length,
        scanned: scannedUnitIdsByEquipmentId.get(bi.equipmentId!)?.size ?? 0,
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
