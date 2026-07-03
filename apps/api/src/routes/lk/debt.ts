import { Router } from "express";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "../../prisma";
import { lkAuth } from "../../middleware/lkAuth";
import { lkClientId } from "../../services/clientPortal/tenant";
import { isBookingOverdue } from "../../services/finance";

const router = Router();

/**
 * Долг клиента в ЛК.
 *
 * Единый источник истины с админским /api/finance/debts (computeDebts в
 * services/finance.ts): агрегируем Booking.amountOutstanding > 0 по броням,
 * а НЕ по счетам. Раньше эндпоинт считал долг только по инвойсам
 * (ISSUED/PARTIAL_PAID/OVERDUE) — бронь с остатком без выставленного счёта
 * была невидима клиенту, хотя менеджер видел её в /finance/debts, а сам ЛК
 * показывал «долг N ₽» на карточке заказа.
 *
 * ЛК-правила поверх computeDebts: не CANCELLED (как в админке), плюс не DRAFT
 * (черновики клиенту не видны) и deletedAt: null (архив скрыт).
 * Невоидный счёт, если он есть, возвращается как детализация строки.
 */

// Статусы счетов, пригодных для детализации строки долга (не VOID, не DRAFT, не PAID).
const DETAIL_INVOICE_STATUSES = ["ISSUED", "PARTIAL_PAID", "OVERDUE"] as const;

router.get("/", lkAuth, async (req, res, next) => {
  try {
    const clientId = lkClientId(req);

    const bookingsWithDebt = await prisma.booking.findMany({
      where: {
        clientId,
        deletedAt: null,
        status: { notIn: ["CANCELLED", "DRAFT"] as any },
        amountOutstanding: { gt: 0 },
      },
      orderBy: [{ endDate: "asc" }, { id: "asc" }],
      select: {
        id: true,
        projectName: true,
        startDate: true,
        endDate: true,
        finalAmount: true,
        amountPaid: true,
        amountOutstanding: true,
        expectedPaymentDate: true,
        paymentStatus: true,
        invoices: {
          where: {
            voidedAt: null,
            status: { in: [...DETAIL_INVOICE_STATUSES] as any },
          },
          orderBy: [{ issuedAt: "desc" }],
          take: 1,
          select: { number: true, dueDate: true },
        },
      },
    });

    const now = new Date();
    let totalOutstanding = new Decimal(0);
    let overdueCount = 0;

    const rows = bookingsWithDebt.map((b) => {
      totalOutstanding = totalOutstanding.add(b.amountOutstanding);

      // Просрочка — тот же хелпер, что и в админском /finance/debts
      // (expectedPaymentDate/paymentStatus): клиент и менеджер видят один
      // и тот же флаг. Согласованная отсрочка платежа не подсвечивается
      // клиенту как просрочка.
      const isOverdue = isBookingOverdue(b, now);
      if (isOverdue) overdueCount++;

      const invoice = b.invoices[0] ?? null;

      return {
        bookingId: b.id,
        bookingNo: `#${b.id.slice(-6).toUpperCase()}`,
        projectName: b.projectName ?? null,
        startDate: b.startDate.toISOString(),
        endDate: b.endDate.toISOString(),
        finalAmount: b.finalAmount.toString(),
        amountPaid: b.amountPaid.toString(),
        amountOutstanding: b.amountOutstanding.toString(),
        isOverdue,
        invoice: invoice
          ? {
              number: invoice.number,
              dueDate: invoice.dueDate ? invoice.dueDate.toISOString() : null,
            }
          : null,
      };
    });

    res.json({
      totalOutstanding: totalOutstanding.toString(),
      overdueCount,
      bookings: rows,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
