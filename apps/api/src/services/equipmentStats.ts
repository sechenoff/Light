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

  // Phase 1 placeholder: return an empty payload. Aggregations are added in later tasks.
  return {
    period: periodLabel(periodDays),
    rangeFrom: rangeFrom.toISOString(),
    rangeTo: rangeTo.toISOString(),
    kpi: {
      activeCount: 0,
      dormantCount: 0,
      totalCount: 0,
      revenueRub: "0",
      repairCostRub: "0",
    },
    demand: [],
    deadStock: [],
    revenue: [],
    quality: [],
    table: [],
  };
}
