/**
 * Пересоздаёт MAIN Estimate брони из текущих BookingItem (quantity > 0).
 * Зеркало recomputeAddonEstimate. delete-then-create snapshot в транзакции.
 *
 * Сохраняет discountPercent и shifts существующей MAIN-сметы (если она была);
 * иначе — discountPercent=0, shifts=1.
 *
 * No-op если бронь не существует. Если у брони нет BookingItem с quantity > 0 —
 * существующая MAIN удаляется (пустая смета не создаётся).
 *
 * Поддерживаются:
 *   - каталожные позиции (equipmentId != null) — цена из Equipment.rentalRatePerShift
 *   - произвольные позиции (customName + customUnitPrice) — цена фиксированная,
 *     не умножается на shifts (зеркало bookings.ts → ensureEstimateForBooking)
 */
import Decimal from "decimal.js";

import { prisma } from "../prisma";

const CUSTOM_LINE_CATEGORY = "Прочее";

export async function recreateMainEstimate(bookingId: string): Promise<void> {
  const [booking, existingMain, items] = await Promise.all([
    prisma.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, comment: true, estimateOptionalNote: true, estimateIncludeOptionalInExport: true },
    }),
    prisma.estimate.findFirst({
      where: { bookingId, kind: "MAIN" },
      select: {
        discountPercent: true,
        shifts: true,
        hoursSummaryText: true,
        commentSnapshot: true,
        optionalNote: true,
        includeOptionalInExport: true,
      },
    }),
    prisma.bookingItem.findMany({
      where: { bookingId, quantity: { gt: 0 } },
      include: { equipment: true },
    }),
  ]);

  if (!booking) return;

  const discountPercent = existingMain?.discountPercent
    ? new Decimal(existingMain.discountPercent.toString())
    : new Decimal(0);
  const shifts = existingMain && existingMain.shifts > 0 ? existingMain.shifts : 1;

  type LineInput = {
    equipmentId: string | null;
    categorySnapshot: string;
    nameSnapshot: string;
    brandSnapshot: string | null;
    modelSnapshot: string | null;
    quantity: number;
    unitPrice: Decimal;
    lineSum: Decimal;
  };

  const lines: LineInput[] = items
    .map((bi: any): LineInput | null => {
      if (bi.equipmentId != null && bi.equipment != null) {
        const unitPrice = new Decimal(bi.equipment.rentalRatePerShift.toString());
        const lineSum = unitPrice.mul(bi.quantity).mul(shifts);
        return {
          equipmentId: bi.equipmentId,
          categorySnapshot: bi.equipment.category,
          nameSnapshot: bi.equipment.name,
          brandSnapshot: bi.equipment.brand ?? null,
          modelSnapshot: bi.equipment.model ?? null,
          quantity: bi.quantity,
          unitPrice,
          lineSum,
        };
      }
      // Произвольная позиция — цена фиксированная, без умножения на shifts.
      if (bi.customUnitPrice == null || bi.customName == null) return null;
      const unitPrice = new Decimal(bi.customUnitPrice.toString());
      return {
        equipmentId: null,
        categorySnapshot: bi.customCategory ?? CUSTOM_LINE_CATEGORY,
        nameSnapshot: bi.customName,
        brandSnapshot: null,
        modelSnapshot: null,
        quantity: bi.quantity,
        unitPrice,
        lineSum: unitPrice.mul(bi.quantity),
      };
    })
    .filter((l): l is LineInput => l !== null);

  const subtotal = lines.reduce((acc, l) => acc.add(l.lineSum), new Decimal(0));
  const discountAmount = subtotal.mul(discountPercent).div(100);
  const totalAfterDiscount = subtotal.sub(discountAmount);

  await prisma.$transaction(async (tx) => {
    await tx.estimate.deleteMany({ where: { bookingId, kind: "MAIN" } });
    if (lines.length === 0) return;
    await tx.estimate.create({
      data: {
        bookingId,
        kind: "MAIN",
        shifts,
        subtotal: subtotal.toDecimalPlaces(2).toString(),
        discountPercent: discountPercent.isZero()
          ? null
          : discountPercent.toDecimalPlaces(2).toString(),
        discountAmount: discountAmount.toDecimalPlaces(2).toString(),
        totalAfterDiscount: totalAfterDiscount.toDecimalPlaces(2).toString(),
        commentSnapshot: existingMain?.commentSnapshot ?? booking.comment ?? null,
        optionalNote: existingMain?.optionalNote ?? booking.estimateOptionalNote ?? null,
        includeOptionalInExport:
          existingMain?.includeOptionalInExport ?? booking.estimateIncludeOptionalInExport ?? false,
        hoursSummaryText: existingMain?.hoursSummaryText ?? null,
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
      },
    });
  });
}
