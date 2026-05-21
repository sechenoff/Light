/**
 * Полная пересборка ADDON Estimate брони из AddonRecord'ов.
 * Идемпотентна: delete старый ADDON + create новый (или просто delete если
 * AddonRecord'ов больше нет).
 *
 * Алгоритм:
 *  1. Загружает MAIN Estimate (для shifts + discountPercent).
 *     Без MAIN бронь не CONFIRMED → доборов быть не должно → no-op.
 *  2. Фильтрует AddonRecord'ы: только из сессий в статусе ACTIVE/COMPLETED
 *     (CANCELLED сессии исключены — оператор отменил, оплачивать не надо).
 *  3. Сворачивает по equipmentId, суммирует quantity.
 *  4. Считает lineSum = unitPrice × totalQty × main.shifts.
 *  5. Применяет MAIN.discountPercent к subtotal.
 *  6. Delete-then-create по [bookingId, kind: ADDON].
 *     Если lines пустой — ADDON Estimate не создаётся вовсе (старый удаляется).
 */
import Decimal from "decimal.js";

import { prisma } from "../prisma";

export async function recomputeAddonEstimate(bookingId: string): Promise<void> {
  const main = await prisma.estimate.findFirst({
    where: { bookingId, kind: "MAIN" },
  });
  if (!main) return;

  const records = await prisma.addonRecord.findMany({
    where: {
      bookingId,
      OR: [
        { sessionId: null },
        { session: { status: { in: ["ACTIVE", "COMPLETED"] } } },
      ],
    },
    include: { equipment: true },
  });

  type Group = { eq: NonNullable<(typeof records)[number]["equipment"]>; totalQty: number };
  const byEq = new Map<string, Group>();
  for (const r of records) {
    if (!r.equipmentId || !r.equipment) continue;
    const cur = byEq.get(r.equipmentId);
    if (cur) cur.totalQty += r.quantity;
    else byEq.set(r.equipmentId, { eq: r.equipment, totalQty: r.quantity });
  }

  const shifts = main.shifts;
  const discountPct = main.discountPercent
    ? new Decimal(main.discountPercent.toString())
    : new Decimal(0);

  const lines = Array.from(byEq.values()).map(({ eq, totalQty }) => {
    const unitPrice = new Decimal(eq.rentalRatePerShift.toString());
    const lineSum = unitPrice.mul(totalQty).mul(shifts);
    return {
      equipmentId: eq.id,
      categorySnapshot: eq.category,
      nameSnapshot: eq.name,
      brandSnapshot: eq.brand ?? null,
      modelSnapshot: eq.model ?? null,
      quantity: totalQty,
      unitPrice: unitPrice.toDecimalPlaces(2).toString(),
      lineSum: lineSum.toDecimalPlaces(2).toString(),
    };
  });

  const subtotal = lines.reduce(
    (s, l) => s.add(new Decimal(l.lineSum)),
    new Decimal(0),
  );
  const discountAmount = subtotal.mul(discountPct).div(100);
  const totalAfterDiscount = subtotal.sub(discountAmount);

  await prisma.$transaction(async (tx) => {
    await tx.estimate.deleteMany({ where: { bookingId, kind: "ADDON" } });
    if (lines.length === 0) return;
    await tx.estimate.create({
      data: {
        bookingId,
        kind: "ADDON",
        shifts,
        subtotal: subtotal.toDecimalPlaces(2).toString(),
        discountPercent: discountPct.isZero() ? null : discountPct.toString(),
        discountAmount: discountAmount.toDecimalPlaces(2).toString(),
        totalAfterDiscount: totalAfterDiscount.toDecimalPlaces(2).toString(),
        commentSnapshot: null,
        optionalNote: null,
        includeOptionalInExport: false,
        hoursSummaryText: main.hoursSummaryText,
        lines: { create: lines },
      },
    });
  });
}
