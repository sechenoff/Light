import express from "express";
import { z } from "zod";

import { prisma } from "../prisma";
import {
  computeDebts,
  computeExpensesBreakdown,
  computeFinanceDashboard,
  computePaymentsCalendar,
  createFinanceEvent,
  csvEscape,
  dashboardMetrics,
  paymentStatusSyncForAllBookings,
  recomputeBookingFinance,
  workbookFromRows,
} from "../services/finance";
import { HttpError } from "../utils/errors";

const router = express.Router();

const optionalDateSchema = z.string().datetime().optional().nullable();

const paymentCreateSchema = z.object({
  bookingId: z.string().optional().nullable(),
  amount: z.number().positive(),
  currency: z.string().default("RUB").optional(),
  paymentDate: optionalDateSchema,
  plannedPaymentDate: optionalDateSchema,
  paymentMethod: z.enum(["CASH", "BANK_TRANSFER", "CARD", "OTHER"]).optional(),
  direction: z.enum(["INCOME", "EXPENSE"]).optional(),
  status: z.enum(["PLANNED", "RECEIVED", "CANCELLED"]).optional(),
  payerName: z.string().optional().nullable(),
  comment: z.string().optional().nullable(),
});

const paymentPatchSchema = paymentCreateSchema.partial();

const expenseCreateSchema = z.object({
  bookingId: z.string().optional().nullable(),
  category: z.enum(["TRANSPORT", "EQUIPMENT", "CONTRACTORS", "STAFF", "RENT", "REPAIR", "OTHER"]),
  name: z.string().min(1),
  amount: z.number().positive(),
  currency: z.string().default("RUB").optional(),
  expenseDate: z.string().datetime(),
  comment: z.string().optional().nullable(),
});

const expensePatchSchema = expenseCreateSchema.partial();

router.get("/finance/dashboard", async (_req, res, next) => {
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

router.get("/finance/debts", async (req, res, next) => {
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

router.get("/payments", async (req, res, next) => {
  try {
    const status = req.query.status ? String(req.query.status) : undefined;
    const client = req.query.client ? String(req.query.client) : undefined;
    const project = req.query.project ? String(req.query.project) : undefined;
    const from = req.query.from ? new Date(String(req.query.from)) : undefined;
    const to = req.query.to ? new Date(String(req.query.to)) : undefined;
    const page = Math.max(1, Number(req.query.page ?? 1));
    const pageSize = Math.max(1, Math.min(200, Number(req.query.pageSize ?? 50)));
    const skip = (page - 1) * pageSize;
    const where = {
      ...(status ? { status: status as any } : {}),
      ...(from || to
        ? {
            OR: [
              { paymentDate: { gte: from, lte: to } },
              { plannedPaymentDate: { gte: from, lte: to } },
            ],
          }
        : {}),
      ...(client || project
        ? {
            booking: {
              ...(project ? { projectName: { contains: project } } : {}),
              ...(client ? { client: { name: { contains: client } } } : {}),
            },
          }
        : {}),
    };
    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        include: { booking: { include: { client: true } } },
        orderBy: [{ paymentDate: "desc" }, { plannedPaymentDate: "desc" }, { createdAt: "desc" }],
        skip,
        take: pageSize,
      }),
      prisma.payment.count({ where }),
    ]);
    res.json({
      payments: payments.map((p) => ({
        ...p,
        amount: p.amount.toString(),
      })),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/payments", async (req, res, next) => {
  try {
    const body = paymentCreateSchema.parse(req.body);
    const created = await prisma.payment.create({
      data: {
        bookingId: body.bookingId ?? null,
        amount: body.amount.toFixed(2),
        currency: body.currency ?? "RUB",
        paymentDate: body.paymentDate ? new Date(body.paymentDate) : null,
        plannedPaymentDate: body.plannedPaymentDate ? new Date(body.plannedPaymentDate) : null,
        paymentMethod: body.paymentMethod ?? "OTHER",
        direction: body.direction ?? "INCOME",
        status: body.status ?? "PLANNED",
        payerName: body.payerName ?? null,
        comment: body.comment ?? null,
      },
      include: { booking: true },
    });
    if (created.bookingId) {
      await recomputeBookingFinance(created.bookingId);
      await createFinanceEvent({
        bookingId: created.bookingId,
        eventType: "PAYMENT_CREATED",
        amountDelta: created.amount.toString(),
        payload: { paymentId: created.id, status: created.status, direction: created.direction },
      });
    }
    res.json({ payment: { ...created, amount: created.amount.toString() } });
  } catch (err) {
    next(err);
  }
});

router.patch("/payments/:id", async (req, res, next) => {
  try {
    const body = paymentPatchSchema.parse(req.body);
    const existing = await prisma.payment.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new HttpError(404, "Payment not found");
    const updated = await prisma.payment.update({
      where: { id: req.params.id },
      data: {
        bookingId: body.bookingId === undefined ? undefined : body.bookingId ?? null,
        amount: body.amount === undefined ? undefined : body.amount.toFixed(2),
        currency: body.currency ?? undefined,
        paymentDate: body.paymentDate === undefined ? undefined : body.paymentDate ? new Date(body.paymentDate) : null,
        plannedPaymentDate:
          body.plannedPaymentDate === undefined ? undefined : body.plannedPaymentDate ? new Date(body.plannedPaymentDate) : null,
        paymentMethod: body.paymentMethod ?? undefined,
        direction: body.direction ?? undefined,
        status: body.status ?? undefined,
        payerName: body.payerName === undefined ? undefined : body.payerName ?? null,
        comment: body.comment === undefined ? undefined : body.comment ?? null,
      },
    });
    const bookingIds = [existing.bookingId, updated.bookingId].filter(Boolean) as string[];
    for (const bookingId of new Set(bookingIds)) await recomputeBookingFinance(bookingId);
    if (updated.bookingId) {
      await createFinanceEvent({
        bookingId: updated.bookingId,
        eventType: "PAYMENT_UPDATED",
        amountDelta: updated.amount.toString(),
        payload: { paymentId: updated.id },
      });
    }
    res.json({ payment: { ...updated, amount: updated.amount.toString() } });
  } catch (err) {
    next(err);
  }
});

router.delete("/payments/:id", async (req, res, next) => {
  try {
    const existing = await prisma.payment.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new HttpError(404, "Payment not found");
    await prisma.payment.delete({ where: { id: req.params.id } });
    if (existing.bookingId) {
      await recomputeBookingFinance(existing.bookingId);
      await createFinanceEvent({
        bookingId: existing.bookingId,
        eventType: "PAYMENT_DELETED",
        amountDelta: `-${existing.amount.toString()}`,
        payload: { paymentId: existing.id },
      });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get("/receivables", async (_req, res, next) => {
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

router.get("/expenses", async (req, res, next) => {
  try {
    const from = req.query.from ? new Date(String(req.query.from)) : undefined;
    const to = req.query.to ? new Date(String(req.query.to)) : undefined;
    const expenses = await prisma.expense.findMany({
      where: from || to ? { expenseDate: { gte: from, lte: to } } : undefined,
      include: { booking: { include: { client: true } } },
      orderBy: { expenseDate: "desc" },
    });
    res.json({
      expenses: expenses.map((e) => ({ ...e, amount: e.amount.toString() })),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/expenses", async (req, res, next) => {
  try {
    const body = expenseCreateSchema.parse(req.body);
    const created = await prisma.expense.create({
      data: {
        bookingId: body.bookingId ?? null,
        category: body.category,
        name: body.name,
        amount: body.amount.toFixed(2),
        currency: body.currency ?? "RUB",
        expenseDate: new Date(body.expenseDate),
        comment: body.comment ?? null,
      },
    });
    if (created.bookingId) {
      await createFinanceEvent({
        bookingId: created.bookingId,
        eventType: "EXPENSE_CREATED",
        amountDelta: `-${created.amount.toString()}`,
        payload: { expenseId: created.id, category: created.category },
      });
    }
    res.json({ expense: { ...created, amount: created.amount.toString() } });
  } catch (err) {
    next(err);
  }
});

router.patch("/expenses/:id", async (req, res, next) => {
  try {
    const body = expensePatchSchema.parse(req.body);
    const existing = await prisma.expense.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new HttpError(404, "Expense not found");
    const updated = await prisma.expense.update({
      where: { id: req.params.id },
      data: {
        bookingId: body.bookingId === undefined ? undefined : body.bookingId ?? null,
        category: body.category ?? undefined,
        name: body.name ?? undefined,
        amount: body.amount === undefined ? undefined : body.amount.toFixed(2),
        currency: body.currency ?? undefined,
        expenseDate: body.expenseDate ? new Date(body.expenseDate) : undefined,
        comment: body.comment === undefined ? undefined : body.comment ?? null,
      },
    });
    if (updated.bookingId) {
      await createFinanceEvent({
        bookingId: updated.bookingId,
        eventType: "EXPENSE_UPDATED",
        amountDelta: `-${updated.amount.toString()}`,
        payload: { expenseId: updated.id },
      });
    }
    res.json({ expense: { ...updated, amount: updated.amount.toString() } });
  } catch (err) {
    next(err);
  }
});

router.get("/profit", async (req, res, next) => {
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

router.get("/cashflow", async (req, res, next) => {
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

router.get("/finance/export/payments.xlsx", async (_req, res, next) => {
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

router.get("/finance/export/payments.csv", async (_req, res, next) => {
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

router.get("/finance/export/expenses.xlsx", async (_req, res, next) => {
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

router.get("/finance/export/profit.xlsx", async (_req, res, next) => {
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

router.get("/finance/export/profit.csv", async (_req, res, next) => {
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

router.get("/finance/payments-calendar", async (req, res, next) => {
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

router.get("/finance/expenses-breakdown", async (req, res, next) => {
  try {
    const query = expensesBreakdownQuerySchema.parse(req.query);
    const breakdown = await computeExpensesBreakdown(new Date(query.from), new Date(query.to));
    res.json(breakdown);
  } catch (err) {
    next(err);
  }
});

export { router as financeRouter };
