import Decimal from "decimal.js";
import type { Booking, Equipment, BookingItem } from "@prisma/client";

import { prisma } from "../prisma";
import { billableShifts24h, formatExportHourCalculationLine } from "../utils/dates";
import { HttpError } from "../utils/errors";
import { computeUnitPriceForBookingPeriod } from "./pricing";
import { getAvailability } from "./availability";
import { computeTransportPrice } from "./transportCalculator";
import type { TransportBreakdown } from "./transportCalculator";

const BLOCKING_STATUSES = ["CONFIRMED", "ISSUED"] as const;

function sumDec(values: Decimal[]) {
  return values.reduce((acc, v) => acc.add(v), new Decimal(0));
}

export type QuoteLine = {
  equipmentId: string;
  categorySnapshot: string;
  nameSnapshot: string;
  brandSnapshot: string | null;
  modelSnapshot: string | null;
  quantity: number;
  unitPrice: Decimal;
  lineSum: Decimal;
  pricingMode: "SHIFT" | "TWO_SHIFTS" | "PROJECT";
};

export type QuoteTransportInput = {
  vehicleId: string;
  withGenerator: boolean;
  shiftHours: number;
  skipOvertime: boolean;
  kmOutsideMkad: number;
  ttkEntry: boolean;
};

export type QuoteTransportResult = TransportBreakdown & {
  vehicleId: string;
  vehicleName: string;
};

export async function quoteEstimate(args: {
  startDate: Date;
  endDate: Date;
  clientId: string;
  discountPercent?: number | null;
  items: Array<{ equipmentId: string; quantity: number }>;
  transport?: QuoteTransportInput | null;
}) {
  const shifts = billableShifts24h(args.startDate, args.endDate);
  const equipment = await prisma.equipment.findMany({
    where: { id: { in: args.items.map((i) => i.equipmentId) } },
  });
  const equipmentById = new Map(equipment.map((e) => [e.id, e]));

  const lines: QuoteLine[] = args.items.map((item) => {
    const eq = equipmentById.get(item.equipmentId);
    if (!eq) throw new HttpError(400, `Equipment not found: ${item.equipmentId}`);
    const { unitPrice, mode } = computeUnitPriceForBookingPeriod({ equipment: eq, shifts });
    const quantity = item.quantity;
    const lineSum = unitPrice.mul(quantity);
    return {
      equipmentId: eq.id,
      categorySnapshot: eq.category,
      nameSnapshot: eq.name,
      brandSnapshot: eq.brand,
      modelSnapshot: eq.model,
      quantity,
      unitPrice,
      lineSum,
      pricingMode: mode,
    };
  });

  const equipmentSubtotal = sumDec(lines.map((l) => l.lineSum));
  // Legacy aliases for backward compat (existing callers use .subtotal / .totalAfterDiscount)
  const subtotal = equipmentSubtotal;
  const discountPercent = args.discountPercent ? new Decimal(args.discountPercent) : new Decimal(0);
  const discountAmount = equipmentSubtotal.mul(discountPercent).div(100);
  const equipmentTotal = equipmentSubtotal.sub(discountAmount);
  // Legacy alias
  const totalAfterDiscount = equipmentTotal;

  // Transport — isolated from discount
  let transport: QuoteTransportResult | null = null;
  if (args.transport) {
    const vehicle = await prisma.vehicle.findUnique({ where: { id: args.transport.vehicleId } });
    if (!vehicle) throw new HttpError(400, `Vehicle not found: ${args.transport.vehicleId}`);
    const breakdown = computeTransportPrice({
      vehicle: {
        shiftPriceRub: vehicle.shiftPriceRub.toString(),
        hasGeneratorOption: vehicle.hasGeneratorOption,
        generatorPriceRub: vehicle.generatorPriceRub?.toString() ?? null,
        shiftHours: vehicle.shiftHours,
        overtimePercent: vehicle.overtimePercent.toString(),
      },
      withGenerator: args.transport.withGenerator,
      shiftHours: args.transport.shiftHours,
      skipOvertime: args.transport.skipOvertime,
      kmOutsideMkad: args.transport.kmOutsideMkad,
      ttkEntry: args.transport.ttkEntry,
    });
    transport = { vehicleId: vehicle.id, vehicleName: vehicle.name, ...breakdown };
  }

  const transportTotal = transport ? new Decimal(transport.total) : new Decimal(0);
  const grandTotal = equipmentTotal.add(transportTotal);

  return {
    shifts,
    lines,
    subtotal,              // legacy alias = equipmentSubtotal
    equipmentSubtotal,
    discountPercent,
    discountAmount,
    equipmentDiscount: discountAmount,
    totalAfterDiscount,    // legacy alias = equipmentTotal
    equipmentTotal,
    transport,
    grandTotal,
  };
}

export type BookingTransportSnapshot = {
  vehicleId: string;
  withGenerator: boolean;
  shiftHours: number;
  skipOvertime: boolean;
  kmOutsideMkad: number;
  ttkEntry: boolean;
  transportSubtotalRub: string;
};

export async function createBookingDraft(args: {
  clientId: string;
  projectName: string;
  startDate: Date;
  endDate: Date;
  comment?: string | null;
  discountPercent?: number | null;
  expectedPaymentDate?: Date | null;
  estimateOptionalNote?: string | null;
  estimateIncludeOptionalInExport?: boolean;
  items: Array<{ equipmentId: string; quantity: number }>;
  transport?: BookingTransportSnapshot | null;
}) {
  if (args.items.length === 0) throw new HttpError(400, "At least one equipment item is required.");

  const booking = await prisma.booking.create({
    data: {
      clientId: args.clientId,
      projectName: args.projectName.trim(),
      startDate: args.startDate,
      endDate: args.endDate,
      status: "DRAFT",
      comment: args.comment ?? null,
      discountPercent: args.discountPercent != null ? new Decimal(args.discountPercent) : null,
      expectedPaymentDate: args.expectedPaymentDate ?? null,
      estimateOptionalNote: args.estimateOptionalNote?.trim() || null,
      estimateIncludeOptionalInExport: args.estimateIncludeOptionalInExport ?? false,
      // Transport snapshot
      vehicleId: args.transport?.vehicleId ?? null,
      vehicleWithGenerator: args.transport?.withGenerator ?? false,
      vehicleShiftHours: args.transport?.shiftHours != null ? new Decimal(args.transport.shiftHours) : null,
      vehicleSkipOvertime: args.transport?.skipOvertime ?? false,
      vehicleKmOutsideMkad: args.transport?.kmOutsideMkad ?? null,
      vehicleTtkEntry: args.transport?.ttkEntry ?? false,
      transportSubtotalRub: args.transport?.transportSubtotalRub != null
        ? new Decimal(args.transport.transportSubtotalRub)
        : null,
      items: {
        create: args.items.map((it) => ({
          equipmentId: it.equipmentId,
          quantity: it.quantity,
        })),
      },
    },
    include: { items: true },
  });

  return booking;
}

/**
 * Пересчитывает смету для уже подтверждённой (или выданной) брони.
 * Если у брони ещё нет сметы — создаёт её.
 * Вызывается после PATCH-редактирования, чтобы цены и суммы обновились.
 */
export async function rebuildBookingEstimate(bookingId: string) {
  return prisma.$transaction(async (tx) => {
    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      include: {
        items: { include: { equipment: true } },
        estimate: true,
      },
    });
    if (!booking) throw new HttpError(404, "Booking not found.");
    if (booking.items.length === 0) return null;

    const shifts = billableShifts24h(booking.startDate, booking.endDate);

    const lines: Array<{
      equipmentId: string;
      categorySnapshot: string;
      nameSnapshot: string;
      brandSnapshot: string | null;
      modelSnapshot: string | null;
      quantity: number;
      unitPrice: Decimal;
      lineSum: Decimal;
    }> = booking.items.map((it) => {
      const { unitPrice } = computeUnitPriceForBookingPeriod({ equipment: it.equipment, shifts });
      return {
        equipmentId: it.equipmentId,
        categorySnapshot: it.equipment.category,
        nameSnapshot: it.equipment.name,
        brandSnapshot: it.equipment.brand,
        modelSnapshot: it.equipment.model,
        quantity: it.quantity,
        unitPrice,
        lineSum: unitPrice.mul(it.quantity),
      };
    });

    const subtotal = sumDec(lines.map((l) => l.lineSum));
    const discountPercent = booking.discountPercent ? new Decimal(booking.discountPercent.toString()) : new Decimal(0);
    const discountAmount = subtotal.mul(discountPercent).div(100);
    const totalAfterDiscount = subtotal.sub(discountAmount);

    const estimateData = {
      currency: "RUB",
      shifts,
      subtotal: subtotal.toDecimalPlaces(2).toString(),
      discountPercent: discountPercent.equals(0) ? null : discountPercent.toDecimalPlaces(2).toString(),
      discountAmount: discountAmount.toDecimalPlaces(2).toString(),
      totalAfterDiscount: totalAfterDiscount.toDecimalPlaces(2).toString(),
      commentSnapshot: booking.comment,
      optionalNote: booking.estimateOptionalNote ?? null,
      includeOptionalInExport: booking.estimateIncludeOptionalInExport,
      hoursSummaryText: formatExportHourCalculationLine(booking.startDate, booking.endDate),
    };

    const linesData = lines.map((l) => ({
      equipmentId: l.equipmentId,
      categorySnapshot: l.categorySnapshot,
      nameSnapshot: l.nameSnapshot,
      brandSnapshot: l.brandSnapshot,
      modelSnapshot: l.modelSnapshot,
      quantity: l.quantity,
      unitPrice: l.unitPrice.toDecimalPlaces(2).toString(),
      lineSum: l.lineSum.toDecimalPlaces(2).toString(),
    }));

    if (booking.estimate) {
      // Удаляем старую смету (EstimateLine удалятся каскадом) и создаём новую.
      await tx.estimate.delete({ where: { id: booking.estimate.id } });
    }

    await tx.estimate.create({
      data: {
        ...estimateData,
        bookingId,
        lines: { create: linesData },
      },
    });
  });
}

export async function confirmBooking(bookingId: string) {
  return prisma.$transaction(async (tx) => {
    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      include: {
        client: true,
        items: {
          include: {
            equipment: true,
          },
        },
        estimate: true,
      },
    });
    if (!booking) throw new HttpError(404, "Booking not found.");
    if (booking.status === "CONFIRMED" || booking.status === "ISSUED") return booking;
    if (booking.items.length === 0) throw new HttpError(400, "Booking items are empty.");

    const requestedItems = booking.items.map((it) => ({
      equipmentId: it.equipmentId,
      quantity: it.quantity,
    }));

    // Acquire per-equipment locks to prevent concurrent confirms from overbooking.
    // (Row-level lock in Postgres; write lock in SQLite inside a transaction.)
    const requestedItemsSorted = [...requestedItems].sort((a, b) => a.equipmentId.localeCompare(b.equipmentId));
    for (const it of requestedItemsSorted) {
      await tx.$executeRaw`UPDATE "Equipment" SET "totalQuantity" = "totalQuantity" WHERE "id" = ${it.equipmentId};`;
    }

    const availability = await getAvailability({
      startDate: booking.startDate,
      endDate: booking.endDate,
      equipmentIds: requestedItemsSorted.map((i) => i.equipmentId),
      tx,
    });
    const availabilityById = new Map(availability.map((a) => [a.equipment.id, a]));

    const conflicts: Array<{
      equipmentId: string;
      totalQuantity: number;
      occupiedQuantity: number;
      availableQuantity: number;
      requestedQuantity: number;
    }> = [];

    for (const item of requestedItems) {
      const a = availabilityById.get(item.equipmentId);
      if (!a) {
        conflicts.push({
          equipmentId: item.equipmentId,
          totalQuantity: 0,
          occupiedQuantity: 0,
          availableQuantity: 0,
          requestedQuantity: item.quantity,
        });
        continue;
      }
      const requested = item.quantity;
      if (a.availableQuantity < requested) {
        conflicts.push({
          equipmentId: item.equipmentId,
          totalQuantity: a.equipment.totalQuantity,
          occupiedQuantity: a.occupiedQuantity,
          availableQuantity: a.availableQuantity,
          requestedQuantity: requested,
        });
      }
    }

    if (conflicts.length > 0) {
      throw new HttpError(409, "Booking conflicts with already occupied inventory.", { conflicts });
    }

    const shifts = billableShifts24h(booking.startDate, booking.endDate);
    // Create estimate snapshot (stored together with booking).
    const lines: Array<{
      equipmentId: string | null;
      categorySnapshot: string;
      nameSnapshot: string;
      brandSnapshot: string | null;
      modelSnapshot: string | null;
      quantity: number;
      unitPrice: Decimal;
      lineSum: Decimal;
      estimateLineCreate: any;
    }> = [];

    for (const it of booking.items) {
      const { unitPrice } = computeUnitPriceForBookingPeriod({ equipment: it.equipment, shifts });
      const lineSum = unitPrice.mul(it.quantity);
      lines.push({
        equipmentId: it.equipmentId,
        categorySnapshot: it.equipment.category,
        nameSnapshot: it.equipment.name,
        brandSnapshot: it.equipment.brand,
        modelSnapshot: it.equipment.model,
        quantity: it.quantity,
        unitPrice,
        lineSum,
        estimateLineCreate: null,
      });
    }

    const subtotal = sumDec(lines.map((l) => l.lineSum));
    const discountPercent = booking.discountPercent ? new Decimal(booking.discountPercent.toString()) : new Decimal(0);
    const discountAmount = subtotal.mul(discountPercent).div(100);
    const totalAfterDiscount = subtotal.sub(discountAmount);

    // Reserve units for UNIT-tracked equipment (count-only needs no per-unit rows).
    const overlappingBlockingBookings = await tx.booking.findMany({
      where: {
        status: { in: [...BLOCKING_STATUSES] },
        startDate: { lte: booking.endDate },
        endDate: { gte: booking.startDate },
      },
      select: { id: true },
    });
    const overlappingBookingIds = overlappingBlockingBookings.map((b) => b.id);
    const bookingItemIds = booking.items.map((it) => it.id);

    // Map bookingItemId -> equipmentId already present; we need booked unit sets by equipmentId.
    const bookedReservedUnitsByEquipmentId = new Map<string, Set<string>>();
    if (overlappingBookingIds.length > 0) {
      const overlappingBookingItems = await tx.bookingItem.findMany({
        where: {
          bookingId: { in: overlappingBookingIds },
          equipmentId: { in: requestedItems.map((i) => i.equipmentId) },
        },
        select: { id: true, equipmentId: true },
      });

      const bookingItemIdToEquipmentId = new Map(overlappingBookingItems.map((bi) => [bi.id, bi.equipmentId]));
      const reservedUnits = await tx.bookingItemUnit.findMany({
        where: {
          bookingItemId: { in: overlappingBookingItems.map((bi) => bi.id) },
        },
        select: { bookingItemId: true, equipmentUnitId: true },
      });

      for (const r of reservedUnits) {
        const equipmentId = bookingItemIdToEquipmentId.get(r.bookingItemId);
        if (!equipmentId) continue;
        if (!bookedReservedUnitsByEquipmentId.has(equipmentId)) bookedReservedUnitsByEquipmentId.set(equipmentId, new Set());
        bookedReservedUnitsByEquipmentId.get(equipmentId)!.add(r.equipmentUnitId);
      }
    }

    // Prepare create payloads.
    const estimateCreate = {
      currency: "RUB",
      shifts,
      subtotal: subtotal.toDecimalPlaces(2).toString(),
      discountPercent: discountPercent.equals(0) ? null : discountPercent.toDecimalPlaces(2).toString(),
      discountAmount: discountAmount.toDecimalPlaces(2).toString(),
      totalAfterDiscount: totalAfterDiscount.toDecimalPlaces(2).toString(),
      commentSnapshot: booking.comment,
      optionalNote: booking.estimateOptionalNote ?? null,
      includeOptionalInExport: booking.estimateIncludeOptionalInExport,
      hoursSummaryText: formatExportHourCalculationLine(booking.startDate, booking.endDate),
      lines: {
        create: lines.map((l) => ({
          equipmentId: l.equipmentId,
          categorySnapshot: l.categorySnapshot,
          nameSnapshot: l.nameSnapshot,
          brandSnapshot: l.brandSnapshot,
          modelSnapshot: l.modelSnapshot,
          quantity: l.quantity,
          unitPrice: l.unitPrice.toDecimalPlaces(2).toString(),
          lineSum: l.lineSum.toDecimalPlaces(2).toString(),
        })),
      },
    };

    // Reserve units per booking item (for UNIT tracking).
    // We lock by updating equipment rows would be ideal, but Prisma/SQLite doesn't support fine locks.
    // Transaction scope is enough since we validate conflicts with fresh availability before reserving.
    for (const it of booking.items) {
      if (it.equipment.stockTrackingMode !== "UNIT") continue;
      const alreadyReserved = bookedReservedUnitsByEquipmentId.get(it.equipmentId) ?? new Set<string>();
      const availableUnits = await tx.equipmentUnit.findMany({
        where: { equipmentId: it.equipmentId, status: "AVAILABLE" },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      const freeUnitIds = availableUnits
        .map((u) => u.id)
        .filter((id) => !alreadyReserved.has(id))
        .slice(0, it.quantity);
      if (freeUnitIds.length < it.quantity) {
        // Should not happen due to availability validation, but guard anyway.
        throw new HttpError(409, "Not enough free units during reservation.");
      }

      await tx.bookingItemUnit.createMany({
        data: freeUnitIds.map((unitId) => ({
          bookingItemId: it.id,
          equipmentUnitId: unitId,
        })),
      });
    }

    const updated = await tx.booking.update({
      where: { id: bookingId },
      data: {
        status: "CONFIRMED",
        confirmedAt: new Date(),
        estimate: {
          create: estimateCreate,
        },
      },
      include: {
        client: true,
        items: { include: { equipment: true } },
        estimate: { include: { lines: true } },
      },
    });

    return updated;
  });
}

