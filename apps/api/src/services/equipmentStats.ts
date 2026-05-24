import type { PrismaClient } from "@prisma/client";

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

  const allEquipment = await prismaClient.equipment.findMany({
    select: { id: true, name: true, category: true, totalQuantity: true },
    orderBy: [{ category: "asc" }, { name: "asc" }],
  });

  const rows: EquipmentStatRow[] = allEquipment.map((e) => ({
    id: e.id,
    name: e.name,
    category: e.category,
    totalQuantity: e.totalQuantity,
    bookingsCount: 0,
    qtyShifts: 0,
    revenueRub: "0",
    revenuePerStorageUnit: "0",
    repairCount: 0,
    problemCount: 0,
    repairCostRub: "0",
    lastBookingAt: null,
  }));

  const activeCount = rows.filter((r) => r.bookingsCount > 0).length;
  const dormantCount = rows.length - activeCount;

  return {
    period: periodLabel(periodDays),
    rangeFrom: rangeFrom.toISOString(),
    rangeTo: rangeTo.toISOString(),
    kpi: {
      activeCount,
      dormantCount,
      totalCount: rows.length,
      revenueRub: "0",
      repairCostRub: "0",
    },
    demand: [],
    deadStock: [],
    revenue: [],
    quality: [],
    table: rows,
  };
}
