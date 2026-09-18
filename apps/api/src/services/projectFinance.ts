import Decimal from "decimal.js";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma";

export async function recomputeProjectFinance(
  bookingId: string,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const booking = await tx.booking.findUniqueOrThrow({
    where: { id: bookingId },
    include: {
      project: {
        include: {
          periods: { orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }] },
        },
      },
      payments: {
        where: {
          direction: "INCOME",
          voidedAt: null,
          status: { not: "CANCELLED" },
          OR: [{ status: "RECEIVED" }, { receivedAt: { not: null } }],
        },
      },
    },
  });
  const periods = booking.project?.periods ?? [];
  const refunds = await tx.refund.findMany({
    where: {
      OR: [
        { bookingId },
        { invoice: { bookingId } },
        { payment: { bookingId } },
      ],
    },
  });
  const received = booking.payments.reduce(
    (s, p) => s.add(p.amount.toString()),
    new Decimal(0),
  );
  const paid = Decimal.max(
    0,
    refunds.reduce((s, r) => s.sub(r.amount.toString()), received),
  );
  const total = periods.reduce(
    (s, p) => s.add(p.amount.toString()),
    new Decimal(0),
  );
  let credit = paid;
  const allocations: Array<{
    periodId: string;
    charged: string;
    paid: string;
    outstanding: string;
  }> = [];
  let due: Date | null = null;
  for (const p of periods.filter((p) => p.kind === "PERIOD")) {
    const charge = periods
      .filter((c) => c.correctsId === p.id)
      .reduce(
        (s, c) => s.add(c.amount.toString()),
        new Decimal(p.amount.toString()),
      );
    const used = Decimal.min(credit, Decimal.max(0, charge));
    credit = credit.sub(used);
    const remaining = Decimal.max(0, charge.sub(used));
    if (remaining.gt(0) && !due) due = p.dueDate;
    allocations.push({
      periodId: p.id,
      charged: charge.toFixed(2),
      paid: used.toFixed(2),
      outstanding: remaining.toFixed(2),
    });
    if (p.invoiceId)
      await tx.invoice.update({
        where: { id: p.invoiceId },
        data: {
          paidAmount: used.toFixed(2),
          adjustmentAmount: charge.sub(p.amount.toString()).toFixed(2),
          status: remaining.eq(0)
            ? "PAID"
            : p.dueDate.getTime() < Date.now()
              ? "OVERDUE"
              : used.gt(0)
                ? "PARTIAL_PAID"
                : "ISSUED",
        },
      });
  }
  const outstanding = Decimal.max(0, total.sub(paid));
  const status = paid.gt(total)
    ? "OVERPAID"
    : outstanding.eq(0)
      ? "PAID"
      : due && due.getTime() < Date.now()
        ? "OVERDUE"
        : paid.gt(0)
          ? "PARTIALLY_PAID"
          : "NOT_PAID";
  const result = await tx.booking.update({
    where: { id: bookingId },
    data: {
      finalAmount: total.toFixed(2),
      totalEstimateAmount: total.toFixed(2),
      amountPaid: paid.toFixed(2),
      amountOutstanding: outstanding.toFixed(2),
      expectedPaymentDate: due,
      paymentStatus: status,
      isFullyPaid: outstanding.eq(0),
    },
  });
  return {
    booking: result,
    allocations,
    advance: Decimal.max(0, paid.sub(total)).toFixed(2),
  };
}
