import type { PrismaClient, BookingStatus } from "@prisma/client";

const QUALIFYING_STATUSES = ["CONFIRMED", "ISSUED", "RETURNED"] as const;
const TYPICAL_KIT_SAMPLE = 10;
const TYPICAL_KIT_THRESHOLD = 0.4;
const TOP_LIMIT = 20;

export type StatsPeriod = "180d" | "365d" | "all";

function periodToFrom(period: StatsPeriod): Date | null {
  if (period === "all") return null;
  const days = period === "180d" ? 180 : 365;
  return new Date(Date.now() - days * 86_400_000);
}

export async function computeLkStats(
  prisma: PrismaClient,
  clientId: string,
  period: StatsPeriod
) {
  const from = periodToFrom(period);

  const bookingWhere = {
    clientId,
    status: { in: [...QUALIFYING_STATUSES] as BookingStatus[] },
    ...(from ? { startDate: { gte: from } } : {}),
  };

  // ── top equipment ────────────────────────────────────────────────────────────
  // EstimateLine carries nameSnapshot + categorySnapshot (snapshots at estimate-time).
  // equipmentId is optional — lines without it are custom/free-form and skipped.
  const lines = await prisma.estimateLine.findMany({
    where: {
      equipmentId: { not: null },
      estimate: { kind: "MAIN", booking: bookingWhere },
    },
    select: {
      equipmentId: true,
      nameSnapshot: true,
      categorySnapshot: true,
      quantity: true,
      lineSum: true,
      estimateId: true,
      estimate: { select: { bookingId: true } },
    },
  });

  const agg = new Map<
    string,
    {
      name: string;
      category: string;
      bookingIds: Set<string>;
      totalQty: number;
      totalSpent: number;
    }
  >();

  for (const ln of lines) {
    if (!ln.equipmentId) continue;
    const cur = agg.get(ln.equipmentId) ?? {
      name: ln.nameSnapshot,
      category: ln.categorySnapshot,
      bookingIds: new Set<string>(),
      totalQty: 0,
      totalSpent: 0,
    };
    cur.bookingIds.add(ln.estimate.bookingId);
    cur.totalQty += ln.quantity;
    cur.totalSpent += Number(ln.lineSum);
    agg.set(ln.equipmentId, cur);
  }

  const topEquipment = [...agg.entries()]
    .map(([equipmentId, v]) => ({
      equipmentId,
      name: v.name,
      category: v.category,
      bookingsCount: v.bookingIds.size,
      totalQuantityRented: v.totalQty,
      totalSpentRub: v.totalSpent.toFixed(2),
    }))
    .sort(
      (a, b) =>
        b.bookingsCount - a.bookingsCount ||
        Number(b.totalSpentRub) - Number(a.totalSpentRub)
    )
    .slice(0, TOP_LIMIT);

  // ── typical kit ─────────────────────────────────────────────────────────────
  // Uses last ≤10 qualifying bookings (regardless of period filter).
  const recentBookingIds = await prisma.booking.findMany({
    where: { clientId, status: { in: [...QUALIFYING_STATUSES] as BookingStatus[] } },
    orderBy: { startDate: "desc" },
    take: TYPICAL_KIT_SAMPLE,
    select: { id: true },
  });

  const sampleSize = recentBookingIds.length;
  let typicalKit: Array<{
    equipmentId: string;
    name: string;
    category: string;
    frequency: number;
  }> = [];

  if (sampleSize >= 3) {
    const bookingIdList = recentBookingIds.map((b) => b.id);

    // Load estimate lines for these bookings (MAIN only, catalogued items only)
    const kitLines = await prisma.estimateLine.findMany({
      where: {
        equipmentId: { not: null },
        estimate: {
          kind: "MAIN",
          bookingId: { in: bookingIdList },
        },
      },
      select: {
        equipmentId: true,
        nameSnapshot: true,
        categorySnapshot: true,
        estimate: { select: { bookingId: true } },
      },
    });

    // Count distinct bookings per equipmentId
    const freq = new Map<string, number>();
    const nameMap = new Map<string, string>();
    const categoryMap = new Map<string, string>();
    const bookingSets = new Map<string, Set<string>>();

    for (const ln of kitLines) {
      if (!ln.equipmentId) continue;
      const bId = ln.estimate.bookingId;
      if (!bookingSets.has(ln.equipmentId)) {
        bookingSets.set(ln.equipmentId, new Set());
      }
      bookingSets.get(ln.equipmentId)!.add(bId);
      if (!nameMap.has(ln.equipmentId)) {
        nameMap.set(ln.equipmentId, ln.nameSnapshot);
        categoryMap.set(ln.equipmentId, ln.categorySnapshot);
      }
    }

    for (const [eqId, bSet] of bookingSets.entries()) {
      freq.set(eqId, bSet.size);
    }

    typicalKit = [...freq.entries()]
      .filter(([, count]) => count / sampleSize >= TYPICAL_KIT_THRESHOLD)
      .map(([equipmentId, count]) => ({
        equipmentId,
        name: nameMap.get(equipmentId) ?? "",
        category: categoryMap.get(equipmentId) ?? "",
        frequency: count / sampleSize,
      }))
      .sort((a, b) => b.frequency - a.frequency || a.name.localeCompare(b.name));
  }

  return {
    period,
    rangeFrom: from ? from.toISOString() : null,
    rangeTo: new Date().toISOString(),
    topEquipment,
    typicalKit,
    typicalKitSampleSize: sampleSize,

  };
}
