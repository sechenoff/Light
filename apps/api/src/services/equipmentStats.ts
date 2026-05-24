import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";

export type EquipmentStatRow = {
  id: string;
  name: string;
  category: string;
  totalQuantity: number;
  bookingsCount: number;
  qtyShifts: number;
  revenueRub: string;
  revenuePerStorageUnit: string;
  repairCount: number;
  problemCount: number;
  repairCostRub: string;
  lastBookingAt: string | null;
};

export type EquipmentStatsResponse = {
  period: "30d" | "90d" | "365d";
  rangeFrom: string;
  rangeTo: string;
  kpi: {
    activeCount: number;
    dormantCount: number;
    totalCount: number;
    revenueRub: string;
    repairCostRub: string;
  };
  demand: EquipmentStatRow[];
  deadStock: EquipmentStatRow[];
  revenue: EquipmentStatRow[];
  quality: EquipmentStatRow[];
  table: EquipmentStatRow[];
};

export type PeriodDays = 30 | 90 | 365;

function periodLabel(days: PeriodDays): "30d" | "90d" | "365d" {
  return `${days}d` as "30d" | "90d" | "365d";
}

const RENTAL_BOOKING_STATUSES = ["CONFIRMED", "ISSUED", "RETURNED"] as const;

type DemandEntry = { bookingsCount: number; qtyShifts: number };

async function aggregateDemand(
  prismaClient: PrismaClient,
  rangeFrom: Date,
  rangeTo: Date,
): Promise<Map<string, DemandEntry>> {
  // Pull every BookingItem whose Booking falls in the window and has a counted status.
  // We need (equipmentId, quantity, booking.id, estimate.shifts ?? date-fallback).
  const items = await prismaClient.bookingItem.findMany({
    where: {
      equipmentId: { not: null },
      booking: {
        status: { in: [...RENTAL_BOOKING_STATUSES] },
        startDate: { gte: rangeFrom, lte: rangeTo },
      },
    },
    select: {
      bookingId: true,
      equipmentId: true,
      quantity: true,
      booking: {
        select: {
          startDate: true,
          endDate: true,
          estimates: {
            where: { kind: "MAIN" },
            select: { shifts: true },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
      },
    },
  });

  const out = new Map<string, DemandEntry>();
  // Track distinct bookings per equipment (to count each booking once even when item rows duplicate)
  const seen = new Map<string, Set<string>>(); // equipmentId -> Set<bookingId>

  for (const item of items) {
    if (!item.equipmentId) continue;
    const shifts =
      item.booking.estimates[0]?.shifts ??
      Math.max(
        1,
        Math.ceil(
          (item.booking.endDate.getTime() - item.booking.startDate.getTime()) / (24 * 60 * 60 * 1000),
        ),
      );
    const entry = out.get(item.equipmentId) ?? { bookingsCount: 0, qtyShifts: 0 };
    entry.qtyShifts += item.quantity * shifts;

    const seenSet = seen.get(item.equipmentId) ?? new Set<string>();
    if (!seenSet.has(item.bookingId)) {
      seenSet.add(item.bookingId);
      entry.bookingsCount += 1;
      seen.set(item.equipmentId, seenSet);
    }
    out.set(item.equipmentId, entry);
  }
  return out;
}

async function aggregateRevenue(
  prismaClient: PrismaClient,
  rangeFrom: Date,
  rangeTo: Date,
): Promise<Map<string, Decimal>> {
  const lines = await prismaClient.estimateLine.findMany({
    where: {
      equipmentId: { not: null },
      estimate: {
        booking: {
          status: { in: [...RENTAL_BOOKING_STATUSES] },
          startDate: { gte: rangeFrom, lte: rangeTo },
        },
      },
    },
    select: { equipmentId: true, lineSum: true },
  });

  const out = new Map<string, Decimal>();
  for (const line of lines) {
    if (!line.equipmentId) continue;
    const prev = out.get(line.equipmentId) ?? new Decimal(0);
    out.set(line.equipmentId, prev.plus(line.lineSum));
  }
  return out;
}

type IncidentEntry = { repairCount: number; problemCount: number };

async function aggregateIncidents(
  prismaClient: PrismaClient,
  rangeFrom: Date,
  rangeTo: Date,
): Promise<Map<string, IncidentEntry>> {
  const [repairs, problems] = await Promise.all([
    prismaClient.repair.findMany({
      where: { createdAt: { gte: rangeFrom, lte: rangeTo } },
      select: { unit: { select: { equipmentId: true } } },
    }),
    prismaClient.problemItem.findMany({
      where: { createdAt: { gte: rangeFrom, lte: rangeTo } },
      select: { equipmentUnit: { select: { equipmentId: true } } },
    }),
  ]);

  const out = new Map<string, IncidentEntry>();
  for (const r of repairs) {
    const eid = r.unit?.equipmentId;
    if (!eid) continue;
    const e = out.get(eid) ?? { repairCount: 0, problemCount: 0 };
    e.repairCount += 1;
    out.set(eid, e);
  }
  for (const p of problems) {
    const eid = p.equipmentUnit?.equipmentId;
    if (!eid) continue;
    const e = out.get(eid) ?? { repairCount: 0, problemCount: 0 };
    e.problemCount += 1;
    out.set(eid, e);
  }
  return out;
}

async function aggregateRepairCosts(
  prismaClient: PrismaClient,
  rangeFrom: Date,
  rangeTo: Date,
): Promise<Map<string, Decimal>> {
  const expenses = await prismaClient.expense.findMany({
    where: {
      approved: true,
      linkedRepairId: { not: null },
      expenseDate: { gte: rangeFrom, lte: rangeTo },
    },
    select: {
      amount: true,
      linkedRepair: { select: { unit: { select: { equipmentId: true } } } },
    },
  });

  const out = new Map<string, Decimal>();
  for (const ex of expenses) {
    const eid = ex.linkedRepair?.unit?.equipmentId;
    if (!eid) continue;
    const prev = out.get(eid) ?? new Decimal(0);
    out.set(eid, prev.plus(ex.amount));
  }
  return out;
}

/**
 * Computes equipment analytics over a rolling window.
 *
 * NOTE: Aggregates over both EstimateKind.MAIN and ADDON — both represent
 * realized rental revenue. Custom BookingItem (equipmentId=null) are excluded
 * (catalog-only). Booking status filter: CONFIRMED, ISSUED, RETURNED.
 */
export async function computeEquipmentStats(
  periodDays: PeriodDays,
  prismaClient: PrismaClient,
): Promise<EquipmentStatsResponse> {
  const rangeTo = new Date();
  const rangeFrom = new Date(rangeTo.getTime() - periodDays * 24 * 60 * 60 * 1000);

  const [allEquipment, demandMap, revenueMap, incidentsMap, repairCostsMap] = await Promise.all([
    prismaClient.equipment.findMany({
      select: { id: true, name: true, category: true, totalQuantity: true },
      orderBy: [{ category: "asc" }, { name: "asc" }],
    }),
    aggregateDemand(prismaClient, rangeFrom, rangeTo),
    aggregateRevenue(prismaClient, rangeFrom, rangeTo),
    aggregateIncidents(prismaClient, rangeFrom, rangeTo),
    aggregateRepairCosts(prismaClient, rangeFrom, rangeTo),
  ]);

  const rows: EquipmentStatRow[] = allEquipment.map((e) => {
    const d = demandMap.get(e.id) ?? { bookingsCount: 0, qtyShifts: 0 };
    const rev = revenueMap.get(e.id) ?? new Decimal(0);
    const inc = incidentsMap.get(e.id) ?? { repairCount: 0, problemCount: 0 };
    const repairCost = repairCostsMap.get(e.id) ?? new Decimal(0);
    const divisor = e.totalQuantity > 0 ? e.totalQuantity : 1;
    const revPerUnit = rev.div(divisor);
    return {
      id: e.id,
      name: e.name,
      category: e.category,
      totalQuantity: e.totalQuantity,
      bookingsCount: d.bookingsCount,
      qtyShifts: d.qtyShifts,
      revenueRub: rev.toString(),
      revenuePerStorageUnit: revPerUnit.toString(),
      repairCount: inc.repairCount,
      problemCount: inc.problemCount,
      repairCostRub: repairCost.toString(),
      lastBookingAt: null,
    };
  });

  const demand = rows
    .filter((r) => r.bookingsCount > 0)
    .sort((a, b) => b.bookingsCount - a.bookingsCount || b.qtyShifts - a.qtyShifts)
    .slice(0, 10);

  const revenue = rows
    .filter((r) => new Decimal(r.revenueRub).gt(0))
    .sort((a, b) => {
      const byUnit = new Decimal(b.revenuePerStorageUnit).comparedTo(new Decimal(a.revenuePerStorageUnit));
      if (byUnit !== 0) return byUnit;
      return new Decimal(b.revenueRub).comparedTo(new Decimal(a.revenueRub));
    })
    .slice(0, 10);

  const quality = rows
    .filter((r) => r.repairCount + r.problemCount > 0)
    .sort((a, b) => {
      const byIncidents = (b.repairCount + b.problemCount) - (a.repairCount + a.problemCount);
      if (byIncidents !== 0) return byIncidents;
      return new Decimal(b.repairCostRub).comparedTo(new Decimal(a.repairCostRub));
    })
    .slice(0, 10);

  const activeCount = rows.filter((r) => r.bookingsCount > 0).length;
  const totalRevenue = rows.reduce((acc, r) => acc.plus(r.revenueRub), new Decimal(0));
  const totalRepairCost = rows.reduce((acc, r) => acc.plus(r.repairCostRub), new Decimal(0));

  return {
    period: periodLabel(periodDays),
    rangeFrom: rangeFrom.toISOString(),
    rangeTo: rangeTo.toISOString(),
    kpi: {
      activeCount,
      dormantCount: rows.length - activeCount,
      totalCount: rows.length,
      revenueRub: totalRevenue.toString(),
      repairCostRub: totalRepairCost.toString(),
    },
    demand,
    deadStock: [],
    revenue,
    quality,
    table: rows,
  };
}
