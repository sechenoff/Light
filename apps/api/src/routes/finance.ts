import express from "express";
import { z } from "zod";
import Decimal from "decimal.js";

import { prisma } from "../prisma";
import {
  computeDebts,
  computeExpensesBreakdown,
  computeFinanceDashboard,
  computePaymentsCalendar,
  csvEscape,
  paymentStatusSyncForAllBookings,
  workbookFromRows,
} from "../services/finance";
import { importLegacyBookings } from "../services/legacyBookingImport";
import { rolesGuard } from "../middleware/rolesGuard";
import { buildBookingHumanName } from "../utils/bookingName";
import {
  fromMoscowDateString,
  toMoscowDateString,
  moscowTodayStart,
} from "../utils/moscowDate";

const router = express.Router();

const superAdminOnly = rolesGuard(["SUPER_ADMIN"]);

router.get("/finance/dashboard", superAdminOnly, async (_req, res, next) => {
  try {
    await paymentStatusSyncForAllBookings();
    const data = await computeFinanceDashboard();
    res.json(data);
  } catch (err) {
    next(err);
  }
});

const debtsQuerySchema = z.object({
  overdueOnly: z.enum(["true", "false"]).optional(),
  minAmount: z.coerce.number().nonnegative().optional(),
});

router.get("/finance/debts", superAdminOnly, async (req, res, next) => {
  try {
    await paymentStatusSyncForAllBookings();
    const query = debtsQuerySchema.parse(req.query);
    const result = await computeDebts({
      overdueOnly: query.overdueOnly === "true",
      minAmount: query.minAmount,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/receivables", superAdminOnly, async (_req, res, next) => {
  try {
    await paymentStatusSyncForAllBookings();
    const bookings = await prisma.booking.findMany({
      where: { status: { not: "CANCELLED" } },
      include: { client: true },
      orderBy: { startDate: "desc" },
    });
    res.json({
      receivables: bookings.map((b) => ({
        id: b.id,
        status: b.status,
        startDate: b.startDate,
        endDate: b.endDate,
        clientName: b.client.name,
        projectName: b.projectName,
        finalAmount: b.finalAmount.toString(),
        amountPaid: b.amountPaid.toString(),
        amountOutstanding: b.amountOutstanding.toString(),
        expectedPaymentDate: b.expectedPaymentDate,
        paymentStatus: b.paymentStatus,
        paymentComment: b.paymentComment,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/profit", superAdminOnly, async (req, res, next) => {
  try {
    const from = req.query.from ? new Date(String(req.query.from)) : undefined;
    const to = req.query.to ? new Date(String(req.query.to)) : undefined;
    const whereIncome = {
      direction: "INCOME" as const,
      status: "RECEIVED" as const,
      ...(from || to ? { paymentDate: { gte: from, lte: to } } : {}),
    };
    const whereExpenses = from || to ? { expenseDate: { gte: from, lte: to } } : {};
    const [incomeRows, expenseRows, bookingRows] = await Promise.all([
      prisma.payment.findMany({ where: whereIncome, include: { booking: { include: { client: true } } } }),
      prisma.expense.findMany({ where: whereExpenses, include: { booking: { include: { client: true } } } }),
      prisma.booking.findMany({ include: { client: true } }),
    ]);
    const revenue = incomeRows.reduce((a, b) => a + Number(b.amount.toString()), 0);
    const expenses = expenseRows.reduce((a, b) => a + Number(b.amount.toString()), 0);
    const byBooking = bookingRows.map((b) => {
      const income = incomeRows
        .filter((p) => p.bookingId === b.id)
        .reduce((a, p) => a + Number(p.amount.toString()), 0);
      const expense = expenseRows
        .filter((e) => e.bookingId === b.id)
        .reduce((a, e) => a + Number(e.amount.toString()), 0);
      return {
        bookingId: b.id,
        clientName: b.client.name,
        projectName: b.projectName,
        revenue: income.toFixed(2),
        expenses: expense.toFixed(2),
        profit: (income - expense).toFixed(2),
      };
    });
    const byClientMap = new Map<string, { clientName: string; revenue: number; expenses: number }>();
    for (const row of byBooking) {
      const key = row.clientName;
      const current = byClientMap.get(key) ?? { clientName: key, revenue: 0, expenses: 0 };
      current.revenue += Number(row.revenue);
      current.expenses += Number(row.expenses);
      byClientMap.set(key, current);
    }

    res.json({
      revenue: revenue.toFixed(2),
      expenses: expenses.toFixed(2),
      grossProfit: revenue.toFixed(2),
      netProfit: (revenue - expenses).toFixed(2),
      byBooking,
      byClient: Array.from(byClientMap.values()).map((x) => ({
        ...x,
        revenue: x.revenue.toFixed(2),
        expenses: x.expenses.toFixed(2),
        profit: (x.revenue - x.expenses).toFixed(2),
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/cashflow", superAdminOnly, async (req, res, next) => {
  try {
    const [payments, expenses] = await Promise.all([
      prisma.payment.findMany({ include: { booking: { include: { client: true } } } }),
      prisma.expense.findMany({ include: { booking: { include: { client: true } } } }),
    ]);
    const paymentRows = payments.map((p) => ({
      id: p.id,
      date: p.paymentDate ?? p.plannedPaymentDate ?? p.createdAt,
      type: p.direction === "INCOME" ? "income" : "expense",
      status: p.status,
      amount: p.amount.toString(),
      bookingId: p.bookingId,
      clientName: p.booking?.client.name ?? null,
      projectName: p.booking?.projectName ?? null,
      comment: p.comment,
      source: "payment",
    }));
    const expenseRows = expenses.map((e) => ({
      id: e.id,
      date: e.expenseDate,
      type: "expense",
      status: "received",
      amount: e.amount.toString(),
      bookingId: e.bookingId,
      clientName: e.booking?.client.name ?? null,
      projectName: e.booking?.projectName ?? null,
      comment: e.comment,
      source: "expense",
    }));
    const rowsAll = [...paymentRows, ...expenseRows].sort((a, b) => b.date.getTime() - a.date.getTime());
    const page = Math.max(1, Number(req.query.page ?? 1));
    const pageSize = Math.max(1, Math.min(200, Number(req.query.pageSize ?? 50)));
    const start = (page - 1) * pageSize;
    const rows = rowsAll.slice(start, start + pageSize);
    res.json({
      rows,
      page,
      pageSize,
      total: rowsAll.length,
      totalPages: Math.max(1, Math.ceil(rowsAll.length / pageSize)),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/finance/export/payments.xlsx", superAdminOnly, async (_req, res, next) => {
  try {
    const payments = await prisma.payment.findMany({ include: { booking: { include: { client: true } } }, orderBy: { createdAt: "desc" } });
    const buf = await workbookFromRows({
      sheetName: "Payments",
      headers: ["Дата", "Клиент", "Проект", "Бронь", "Сумма", "Статус", "Способ", "Комментарий"],
      rows: payments.map((p) => [
        (p.paymentDate ?? p.plannedPaymentDate ?? p.createdAt).toISOString(),
        p.booking?.client.name ?? "",
        p.booking?.projectName ?? "",
        p.bookingId ?? "",
        Number(p.amount.toString()),
        p.status,
        p.paymentMethod,
        p.comment ?? "",
      ]),
    });
    const nodeBuf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="payments.xlsx"');
    res.end(nodeBuf);
  } catch (err) {
    next(err);
  }
});

router.get("/finance/export/payments.csv", superAdminOnly, async (_req, res, next) => {
  try {
    const payments = await prisma.payment.findMany({ include: { booking: { include: { client: true } } }, orderBy: { createdAt: "desc" } });
    const lines = [
      ["date", "client", "project", "bookingId", "amount", "status", "method", "comment"].join(","),
      ...payments.map((p) =>
        [
          (p.paymentDate ?? p.plannedPaymentDate ?? p.createdAt).toISOString(),
          p.booking?.client.name ?? "",
          p.booking?.projectName ?? "",
          p.bookingId ?? "",
          p.amount.toString(),
          p.status,
          p.paymentMethod,
          p.comment ?? "",
        ]
          .map((v) => csvEscape(String(v)))
          .join(","),
      ),
    ];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="payments.csv"');
    res.send(lines.join("\n"));
  } catch (err) {
    next(err);
  }
});

router.get("/finance/export/expenses.xlsx", superAdminOnly, async (_req, res, next) => {
  try {
    const expenses = await prisma.expense.findMany({ include: { booking: { include: { client: true } } }, orderBy: { expenseDate: "desc" } });
    const buf = await workbookFromRows({
      sheetName: "Expenses",
      headers: ["Дата", "Категория", "Название", "Сумма", "Клиент", "Проект", "Комментарий"],
      rows: expenses.map((e) => [
        e.expenseDate.toISOString(),
        e.category,
        e.name,
        Number(e.amount.toString()),
        e.booking?.client.name ?? "",
        e.booking?.projectName ?? "",
        e.comment ?? "",
      ]),
    });
    const nodeBuf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="expenses.xlsx"');
    res.end(nodeBuf);
  } catch (err) {
    next(err);
  }
});

router.get("/finance/export/profit.xlsx", superAdminOnly, async (_req, res, next) => {
  try {
    const bookings = await prisma.booking.findMany({ include: { client: true } });
    const rows = bookings.map((b) => [
      b.id,
      b.client.name,
      b.projectName,
      Number(b.amountPaid.toString()),
      Number(b.amountOutstanding.toString()),
      Number(b.finalAmount.toString()),
      b.paymentStatus,
    ]);
    const buf = await workbookFromRows({
      sheetName: "Profit",
      headers: ["Бронь", "Клиент", "Проект", "Оплачено", "Остаток", "Итог", "Статус"],
      rows,
    });
    const nodeBuf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="profit.xlsx"');
    res.end(nodeBuf);
  } catch (err) {
    next(err);
  }
});

router.get("/finance/export/profit.csv", superAdminOnly, async (_req, res, next) => {
  try {
    const bookings = await prisma.booking.findMany({ include: { client: true } });
    const lines = [
      "bookingId,client,project,amountPaid,amountOutstanding,finalAmount,paymentStatus",
      ...bookings.map((b) =>
        [
          b.id,
          b.client.name,
          b.projectName,
          b.amountPaid.toString(),
          b.amountOutstanding.toString(),
          b.finalAmount.toString(),
          b.paymentStatus,
        ]
          .map((v) => csvEscape(String(v)))
          .join(","),
      ),
    ];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="profit.csv"');
    res.send(lines.join("\n"));
  } catch (err) {
    next(err);
  }
});

const paymentsCalendarQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Формат: YYYY-MM-DD"),
});

router.get("/finance/payments-calendar", superAdminOnly, async (req, res, next) => {
  try {
    const query = paymentsCalendarQuerySchema.parse(req.query);
    const monthStart = new Date(query.month);
    const calendar = await computePaymentsCalendar(monthStart);
    res.json(calendar);
  } catch (err) {
    next(err);
  }
});

const expensesBreakdownQuerySchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
});

router.get("/finance/expenses-breakdown", superAdminOnly, async (req, res, next) => {
  try {
    const query = expensesBreakdownQuerySchema.parse(req.query);
    const breakdown = await computeExpensesBreakdown(new Date(query.from), new Date(query.to));
    res.json(breakdown);
  } catch (err) {
    next(err);
  }
});

const legacyImportRowSchema = z.object({
  filename: z.string().min(1),
  clientName: z.string().refine((s) => s.trim().length > 0, { message: "clientName не может быть пустым" }),
  date: z.string().datetime(),
  amount: z.number().positive(),
});

const legacyImportBodySchema = z.object({
  rows: z.array(legacyImportRowSchema).min(1),
});

router.post("/finance/import-legacy-bookings", superAdminOnly, async (req, res, next) => {
  try {
    const body = legacyImportBodySchema.parse(req.body);
    const userId = req.adminUser!.userId;
    const result = await importLegacyBookings(body.rows, userId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── GET /api/finance/payments-overview ───────────────────────────────────────

const bookingPaymentStatusValues = ["NOT_PAID", "PARTIALLY_PAID", "PAID", "OVERDUE"] as const;
const bookingStatusValues = ["DRAFT", "PENDING_APPROVAL", "CONFIRMED", "ISSUED", "RETURNED", "CANCELLED"] as const;

const paymentsOverviewQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "from: YYYY-MM-DD").optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "to: YYYY-MM-DD").optional(),
  clientId: z.string().optional(),
  amountMin: z.coerce.number().nonnegative().optional(),
  amountMax: z.coerce.number().positive().optional(),
  /** Comma-separated BookingPaymentStatus values */
  paymentStatus: z.string().optional(),
  /** Single BookingStatus — default: exclude CANCELLED */
  status: z.enum(bookingStatusValues).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** ID of last item on previous page */
  cursor: z.string().optional(),
});

router.get("/finance/payments-overview", superAdminOnly, async (req, res, next) => {
  try {
    const q = paymentsOverviewQuerySchema.parse(req.query);

    // Build payment status filter
    const requestedPaymentStatuses = q.paymentStatus
      ? (q.paymentStatus
          .split(",")
          .map((s) => s.trim())
          .filter((s) => bookingPaymentStatusValues.includes(s as typeof bookingPaymentStatusValues[number]))
        )
      : null;

    // Build base where clause
    const baseWhere: Record<string, unknown> = {};

    // Date range filter: startDate
    if (q.from || q.to) {
      const dateFilter: Record<string, Date> = {};
      if (q.from) dateFilter.gte = fromMoscowDateString(q.from);
      if (q.to) {
        // end of day in Moscow: add 1 day, subtract 1 ms
        const toStart = fromMoscowDateString(q.to);
        dateFilter.lte = new Date(toStart.getTime() + 24 * 60 * 60 * 1000 - 1);
      }
      baseWhere.startDate = dateFilter;
    }

    // Client filter
    if (q.clientId) baseWhere.clientId = q.clientId;

    // Amount range filter on finalAmount
    if (q.amountMin !== undefined || q.amountMax !== undefined) {
      const amtFilter: Record<string, Decimal> = {};
      if (q.amountMin !== undefined) amtFilter.gte = new Decimal(q.amountMin);
      if (q.amountMax !== undefined) amtFilter.lte = new Decimal(q.amountMax);
      baseWhere.finalAmount = amtFilter;
    }

    // Payment status filter
    if (requestedPaymentStatuses && requestedPaymentStatuses.length > 0) {
      baseWhere.paymentStatus = { in: requestedPaymentStatuses };
    }

    // Booking status filter — exclude CANCELLED by default
    if (q.status) {
      baseWhere.status = q.status;
    } else {
      baseWhere.status = { not: "CANCELLED" };
    }

    // Cursor-based pagination: stable sort by (startDate DESC, id DESC)
    const cursorWhere: Record<string, unknown> = {};
    if (q.cursor) {
      // cursor = base64-encoded JSON { startDate: ISO, id: string }
      try {
        const decoded = JSON.parse(Buffer.from(q.cursor, "base64").toString("utf8")) as {
          startDate: string;
          id: string;
        };
        cursorWhere.OR = [
          { startDate: { lt: new Date(decoded.startDate) } },
          { startDate: new Date(decoded.startDate), id: { lt: decoded.id } },
        ];
      } catch {
        // Invalid cursor — ignore, return from beginning
      }
    }

    const pageWhere = { ...baseWhere, ...cursorWhere };

    // Fetch one extra to determine if there is a next page
    const bookings = await prisma.booking.findMany({
      where: pageWhere,
      include: {
        client: { select: { id: true, name: true } },
      },
      orderBy: [{ startDate: "desc" }, { id: "desc" }],
      take: q.limit + 1,
    });

    const hasMore = bookings.length > q.limit;
    const page = hasMore ? bookings.slice(0, q.limit) : bookings;

    // Compute totals over entire filtered set (without pagination)
    const agg = await prisma.booking.aggregate({
      where: baseWhere,
      _count: { id: true },
      _sum: { finalAmount: true, amountPaid: true, amountOutstanding: true },
    });

    const totalBilled = agg._sum.finalAmount ?? new Decimal(0);
    const totalPaid = agg._sum.amountPaid ?? new Decimal(0);
    const totalOutstanding = agg._sum.amountOutstanding ?? new Decimal(0);
    const totalCount = agg._count.id;
    const averageAmount = totalCount > 0
      ? totalBilled.div(totalCount).toDecimalPlaces(0)
      : new Decimal(0);

    // Compute overdueDays per item
    const today = moscowTodayStart();
    const todayStr = toMoscowDateString(today);

    const items = page.map((b) => {
      let overdueDays = 0;
      if (b.paymentStatus !== "PAID") {
        const endStr = toMoscowDateString(b.endDate);
        if (endStr < todayStr) {
          const diffMs = today.getTime() - fromMoscowDateString(endStr).getTime();
          overdueDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
        }
      }

      return {
        id: b.id,
        startDate: b.startDate.toISOString(),
        endDate: b.endDate.toISOString(),
        client: { id: b.client.id, name: b.client.name },
        projectName: b.projectName,
        displayName: buildBookingHumanName({
          startDate: b.startDate,
          clientName: b.client.name,
          totalAfterDiscount: b.finalAmount.toString(),
        }),
        finalAmount: b.finalAmount.toString(),
        amountPaid: b.amountPaid.toString(),
        amountOutstanding: b.amountOutstanding.toString(),
        paymentStatus: b.paymentStatus,
        status: b.status,
        overdueDays,
      };
    });

    // Build next cursor
    let nextCursor: string | null = null;
    if (hasMore && page.length > 0) {
      const last = page[page.length - 1];
      nextCursor = Buffer.from(
        JSON.stringify({ startDate: last.startDate.toISOString(), id: last.id })
      ).toString("base64");
    }

    res.json({
      items,
      totals: {
        count: totalCount,
        billed: totalBilled.toString(),
        paid: totalPaid.toString(),
        outstanding: totalOutstanding.toString(),
        averageAmount: averageAmount.toString(),
      },
      nextCursor,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/finance/payments-by-client ──────────────────────────────────────

const paymentsByClientQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "from: YYYY-MM-DD").optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "to: YYYY-MM-DD").optional(),
  amountMin: z.coerce.number().nonnegative().optional(),
  amountMax: z.coerce.number().positive().optional(),
  paymentStatus: z.string().optional(),
  onlyWithDebt: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  search: z.string().optional(),
});

router.get("/finance/payments-by-client", superAdminOnly, async (req, res, next) => {
  try {
    const q = paymentsByClientQuerySchema.parse(req.query);

    const requestedPaymentStatuses = q.paymentStatus
      ? (q.paymentStatus
          .split(",")
          .map((s) => s.trim())
          .filter((s) => bookingPaymentStatusValues.includes(s as typeof bookingPaymentStatusValues[number]))
        )
      : null;

    const bookingWhere: Record<string, unknown> = {
      status: { not: "CANCELLED" },
    };

    if (q.from || q.to) {
      const dateFilter: Record<string, Date> = {};
      if (q.from) dateFilter.gte = fromMoscowDateString(q.from);
      if (q.to) {
        const toStart = fromMoscowDateString(q.to);
        dateFilter.lte = new Date(toStart.getTime() + 24 * 60 * 60 * 1000 - 1);
      }
      bookingWhere.startDate = dateFilter;
    }

    if (q.amountMin !== undefined || q.amountMax !== undefined) {
      const amtFilter: Record<string, Decimal> = {};
      if (q.amountMin !== undefined) amtFilter.gte = new Decimal(q.amountMin);
      if (q.amountMax !== undefined) amtFilter.lte = new Decimal(q.amountMax);
      bookingWhere.finalAmount = amtFilter;
    }

    if (requestedPaymentStatuses && requestedPaymentStatuses.length > 0) {
      bookingWhere.paymentStatus = { in: requestedPaymentStatuses };
    }

    // Aggregate by clientId
    const grouped = await prisma.booking.groupBy({
      by: ["clientId"],
      where: bookingWhere,
      _count: { id: true },
      _sum: { finalAmount: true, amountPaid: true, amountOutstanding: true },
      _max: { startDate: true },
    });

    // Fetch client names
    const clientIds = grouped.map((g: { clientId: string }) => g.clientId);
    const clients = clientIds.length > 0
      ? await prisma.client.findMany({
          where: {
            id: { in: clientIds },
            ...(q.search ? { name: { contains: q.search } } : {}),
          },
          select: { id: true, name: true },
        })
      : [];

    const clientMap = new Map<string, { id: string; name: string }>(
      clients.map((c: { id: string; name: string }) => [c.id, c])
    );

    type GroupRow = {
      clientId: string;
      _count: { id: number };
      _sum: { finalAmount: Decimal | null; amountPaid: Decimal | null; amountOutstanding: Decimal | null };
      _max: { startDate: Date | null };
    };

    // Build per-client rows
    let rows = grouped
      .filter((g: GroupRow) => clientMap.has(g.clientId))
      .map((g: GroupRow) => {
        const client = clientMap.get(g.clientId)!;
        const totalBilled = g._sum.finalAmount ?? new Decimal(0);
        const totalPaid = g._sum.amountPaid ?? new Decimal(0);
        const totalOutstanding = g._sum.amountOutstanding ?? new Decimal(0);

        return {
          id: client.id,
          name: client.name,
          bookingCount: g._count.id,
          lastBookingDate: g._max.startDate?.toISOString() ?? null,
          totalBilled: totalBilled.toString(),
          totalPaid: totalPaid.toString(),
          totalOutstanding: totalOutstanding.toString(),
          _outstandingNum: Number(totalOutstanding.toString()),
          _billedNum: Number(totalBilled.toString()),
          _paidNum: Number(totalPaid.toString()),
        };
      });

    // Filter onlyWithDebt
    if (q.onlyWithDebt === "true") {
      rows = rows.filter((r: typeof rows[number]) => r._outstandingNum > 0);
    }

    // Sort by totalOutstanding DESC, take limit
    rows.sort((a: typeof rows[number], b: typeof rows[number]) => b._outstandingNum - a._outstandingNum);
    const limited = rows.slice(0, q.limit);

    // Totals across all rows (not just limited)
    const totalBilledSum = rows.reduce((acc: number, r: typeof rows[number]) => acc + r._billedNum, 0);
    const totalPaidSum = rows.reduce((acc: number, r: typeof rows[number]) => acc + r._paidNum, 0);
    const totalOutstandingSum = rows.reduce((acc: number, r: typeof rows[number]) => acc + r._outstandingNum, 0);
    const clientCount = rows.length;
    const averageDebt = clientCount > 0 ? (totalOutstandingSum / clientCount) : 0;

    // Strip internal numeric helpers
    const clientsOut = limited.map(({ _outstandingNum: _, _billedNum: __, _paidNum: ___, ...rest }: typeof rows[number]) => rest);

    res.json({
      clients: clientsOut,
      totals: {
        clientCount,
        billed: new Decimal(totalBilledSum).toString(),
        paid: new Decimal(totalPaidSum).toString(),
        outstanding: new Decimal(totalOutstandingSum).toString(),
        averageDebt: new Decimal(averageDebt).toDecimalPlaces(0).toString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

export { router as financeRouter };
