import { Router } from "express";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "../../prisma";
import { lkAuth } from "../../middleware/lkAuth";
import { lkClientId } from "../../services/clientPortal/tenant";

const router = Router();

const OUTSTANDING_STATUSES = ["ISSUED", "PARTIAL_PAID", "OVERDUE"] as const;

router.get("/", lkAuth, async (req, res, next) => {
  try {
    const clientId = lkClientId(req);

    const invoices = await prisma.invoice.findMany({
      where: {
        booking: { clientId },
        status: { in: [...OUTSTANDING_STATUSES] as any },
      },
      orderBy: [{ dueDate: "asc" }, { issuedAt: "asc" }],
      select: {
        id: true,
        bookingId: true,
        number: true,
        issuedAt: true,
        dueDate: true,
        status: true,
        total: true,
        paidAmount: true,
        booking: {
          select: { id: true },
        },
      },
    });

    const now = Date.now();
    let totalOutstanding = new Decimal(0);
    let overdueCount = 0;

    const rows = invoices.map((inv) => {
      const outstanding = inv.total.sub(inv.paidAmount);
      totalOutstanding = totalOutstanding.add(outstanding);

      const ageDays = inv.dueDate
        ? Math.floor((now - inv.dueDate.getTime()) / 86_400_000)
        : 0;

      const isOverdue =
        inv.status === "OVERDUE" ||
        (inv.dueDate != null &&
          inv.dueDate.getTime() < now &&
          outstanding.gt(0));

      if (isOverdue) overdueCount++;

      return {
        bookingId: inv.bookingId,
        bookingNo: `#${inv.booking.id.slice(-6).toUpperCase()}`,
        invoiceNumber: inv.number,
        issuedAt: inv.issuedAt ? inv.issuedAt.toISOString() : new Date(0).toISOString(),
        dueDate: inv.dueDate ? inv.dueDate.toISOString() : null,
        finalAmount: inv.total.toString(),
        amountPaid: inv.paidAmount.toString(),
        amountOutstanding: outstanding.toString(),
        ageDays,
        isOverdue,
      };
    });

    res.json({
      totalOutstanding: totalOutstanding.toString(),
      overdueCount,
      invoices: rows,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
