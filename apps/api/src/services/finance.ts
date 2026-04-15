import type { BookingPaymentStatus, PaymentDirection, PaymentRecordStatus, Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import ExcelJS from "exceljs";

import { prisma } from "../prisma";

type TxLike = Omit<
  Prisma.TransactionClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends" | "$use"
>;

function toDec(value: string | number | Decimal): Decimal {
  return value instanceof Decimal ? value : new Decimal(value);
}

function sumDec(values: Array<string | number | Decimal>): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.add(toDec(v)), new Decimal(0));
}

export function calcBookingPaymentStatus(args: {
  finalAmount: Decimal;
  amountPaid: Decimal;
  expectedPaymentDate: Date | null;
  now?: Date;
}): BookingPaymentStatus {
  const now = args.now ?? new Date();
  const final = args.finalAmount;
  const paid = args.amountPaid;
  const fullyPaid = paid.greaterThanOrEqualTo(final) || final.lessThanOrEqualTo(0);
  if (fullyPaid) return "PAID";
  const isOverdue = !!args.expectedPaymentDate && args.expectedPaymentDate.getTime() < now.getTime();
  if (isOverdue) return "OVERDUE";
  if (paid.greaterThan(0)) return "PARTIALLY_PAID";
  return "NOT_PAID";
}

export async function recomputeBookingFinance(bookingId: string, txArg?: TxLike) {
  const tx = txArg ?? prisma;
  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
    include: {
      estimate: true,
      payments: {
        where: {
          direction: "INCOME",
          OR: [{ status: "RECEIVED" }, { receivedAt: { not: null } }],
        },
        select: { amount: true, paymentDate: true, createdAt: true },
      },
    },
  });
  if (!booking) return null;

  const previousStatus = booking.paymentStatus;
  const totalEstimateAmount = booking.estimate ? new Decimal(booking.estimate.subtotal.toString()) : new Decimal(booking.totalEstimateAmount.toString());
  const discountAmount = booking.estimate ? new Decimal(booking.estimate.discountAmount.toString()) : new Decimal(booking.discountAmount.toString());
  const finalAmount = booking.estimate ? new Decimal(booking.estimate.totalAfterDiscount.toString()) : new Decimal(booking.finalAmount.toString());
  const amountPaid = sumDec(booking.payments.map((p) => p.amount.toString()));
  const amountOutstanding = Decimal.max(finalAmount.sub(amountPaid), new Decimal(0));
  const status = calcBookingPaymentStatus({
    finalAmount,
    amountPaid,
    expectedPaymentDate: booking.expectedPaymentDate,
  });
  const isFullyPaid = status === "PAID";
  const actualPaymentDate = isFullyPaid
    ? booking.payments
        .map((p) => p.paymentDate ?? p.createdAt)
        .sort((a, b) => b.getTime() - a.getTime())[0] ?? null
    : null;

  const updated = await tx.booking.update({
    where: { id: bookingId },
    data: {
      totalEstimateAmount: totalEstimateAmount.toDecimalPlaces(2).toString(),
      discountAmount: discountAmount.toDecimalPlaces(2).toString(),
      finalAmount: finalAmount.toDecimalPlaces(2).toString(),
      amountPaid: amountPaid.toDecimalPlaces(2).toString(),
      amountOutstanding: amountOutstanding.toDecimalPlaces(2).toString(),
      paymentStatus: status,
      isFullyPaid,
      actualPaymentDate,
    },
  });

  if (previousStatus !== status) {
    await tx.bookingFinanceEvent.create({
      data: {
        bookingId,
        eventType: "PAYMENT_STATUS_CHANGED",
        statusFrom: previousStatus,
        statusTo: status,
        amountDelta: amountPaid.toDecimalPlaces(2).toString(),
      },
    });
  }

  return updated;
}

export async function createFinanceEvent(args: {
  bookingId: string;
  eventType: string;
  payload?: Record<string, unknown>;
  amountDelta?: Decimal | string | number;
  tx?: TxLike;
}) {
  const tx = args.tx ?? prisma;
  await tx.bookingFinanceEvent.create({
    data: {
      bookingId: args.bookingId,
      eventType: args.eventType,
      amountDelta: args.amountDelta != null ? toDec(args.amountDelta).toDecimalPlaces(2).toString() : null,
      payloadJson: args.payload ? JSON.stringify(args.payload) : null,
    },
  });
}

export async function dashboardMetrics() {
  const now = new Date();
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - 7);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [todayIncome, weekIncome, monthIncome, expectedPayments, overdueBookings, allBookings, expensesMonth, allExpenses, allIncome] = await Promise.all([
    prisma.payment.findMany({ where: { direction: "INCOME", status: "RECEIVED", paymentDate: { gte: dayStart } }, select: { amount: true } }),
    prisma.payment.findMany({ where: { direction: "INCOME", status: "RECEIVED", paymentDate: { gte: weekStart } }, select: { amount: true } }),
    prisma.payment.findMany({ where: { direction: "INCOME", status: "RECEIVED", paymentDate: { gte: monthStart } }, select: { amount: true } }),
    prisma.payment.findMany({
      where: { direction: "INCOME", status: "PLANNED", plannedPaymentDate: { not: null } },
      include: { booking: { include: { client: true } } },
      orderBy: { plannedPaymentDate: "asc" },
      take: 20,
    }),
    prisma.booking.findMany({
      where: { paymentStatus: "OVERDUE", status: { not: "CANCELLED" } },
      include: { client: true },
      orderBy: { expectedPaymentDate: "asc" },
      take: 20,
    }),
    prisma.booking.findMany({ where: { status: { not: "CANCELLED" } }, select: { amountOutstanding: true, paymentStatus: true } }),
    prisma.expense.findMany({ where: { expenseDate: { gte: monthStart } }, select: { amount: true } }),
    prisma.expense.findMany({ select: { amount: true } }),
    prisma.payment.findMany({ where: { direction: "INCOME", status: "RECEIVED" }, select: { amount: true } }),
  ]);

  const incomeToday = sumDec(todayIncome.map((x) => x.amount.toString()));
  const incomeWeek = sumDec(weekIncome.map((x) => x.amount.toString()));
  const incomeMonth = sumDec(monthIncome.map((x) => x.amount.toString()));
  const monthExpenses = sumDec(expensesMonth.map((x) => x.amount.toString()));
  const allExpenseSum = sumDec(allExpenses.map((x) => x.amount.toString()));
  const allIncomeSum = sumDec(allIncome.map((x) => x.amount.toString()));
  const totalReceivables = sumDec(allBookings.map((b) => b.amountOutstanding.toString()));
  const overdueReceivables = sumDec(
    allBookings.filter((b) => b.paymentStatus === "OVERDUE").map((b) => b.amountOutstanding.toString()),
  );
  const unpaidCount = allBookings.filter((b) => b.paymentStatus === "NOT_PAID").length;
  const partialCount = allBookings.filter((b) => b.paymentStatus === "PARTIALLY_PAID").length;

  return {
    incomeToday: incomeToday.toDecimalPlaces(2).toString(),
    incomeWeek: incomeWeek.toDecimalPlaces(2).toString(),
    incomeMonth: incomeMonth.toDecimalPlaces(2).toString(),
    expectedPayments: expectedPayments.map((p) => ({
      id: p.id,
      amount: p.amount.toString(),
      plannedPaymentDate: p.plannedPaymentDate,
      payerName: p.payerName,
      booking: p.booking
        ? {
            id: p.booking.id,
            projectName: p.booking.projectName,
            clientName: p.booking.client.name,
          }
        : null,
    })),
    overdueBookings: overdueBookings.map((b) => ({
      id: b.id,
      clientName: b.client.name,
      projectName: b.projectName,
      expectedPaymentDate: b.expectedPaymentDate,
      amountOutstanding: b.amountOutstanding.toString(),
    })),
    monthProfit: incomeMonth.sub(monthExpenses).toDecimalPlaces(2).toString(),
    summary: {
      totalIncome: allIncomeSum.toDecimalPlaces(2).toString(),
      totalReceivables: totalReceivables.toDecimalPlaces(2).toString(),
      overdueReceivables: overdueReceivables.toDecimalPlaces(2).toString(),
      grossProfit: allIncomeSum.toDecimalPlaces(2).toString(),
      expenses: allExpenseSum.toDecimalPlaces(2).toString(),
      netProfit: allIncomeSum.sub(allExpenseSum).toDecimalPlaces(2).toString(),
      unpaidCount,
      partialCount,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Finance Dashboard (Sprint 3)
// ──────────────────────────────────────────────────────────────────────────────

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}

function toYYYYMM(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${d.getFullYear()}-${m}`;
}

function toYYYYMMDD(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

async function computeMonthlyTrend(asOf: Date) {
  const months: Array<{ start: Date; nextStart: Date; label: string }> = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(asOf.getFullYear(), asOf.getMonth() - i, 1);
    const start = startOfMonth(d);
    const nextStart = new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0, 0);
    months.push({ start, nextStart, label: toYYYYMM(d) });
  }

  const results = await Promise.all(
    months.map(async ({ start, nextStart, label }) => {
      const [earnedAgg, spentAgg] = await Promise.all([
        prisma.payment.aggregate({
          where: {
            direction: "INCOME",
            AND: [
              { OR: [{ status: "RECEIVED" }, { receivedAt: { not: null } }] },
              { OR: [{ receivedAt: { gte: start, lt: nextStart } }, { paymentDate: { gte: start, lt: nextStart } }] },
            ],
          },
          _sum: { amount: true },
        }),
        prisma.expense.aggregate({
          where: {
            approved: true,
            expenseDate: { gte: start, lt: nextStart },
          },
          _sum: { amount: true },
        }),
      ]);
      const earned = new Decimal(earnedAgg._sum.amount?.toString() ?? "0");
      const spent = new Decimal(spentAgg._sum.amount?.toString() ?? "0");
      return {
        month: label,
        earned: earned.toFixed(2),
        spent: spent.toFixed(2),
        net: earned.sub(spent).toFixed(2),
      };
    }),
  );

  return results;
}

export async function computeFinanceDashboard(asOf: Date = new Date()) {
  const monthS = startOfMonth(asOf);
  const monthNextS = new Date(asOf.getFullYear(), asOf.getMonth() + 1, 1, 0, 0, 0, 0);
  const weekEnd = new Date(asOf.getTime() + 7 * 24 * 60 * 60 * 1000);

  const [totalOutstandingAgg, earnedAgg, spentAgg, upcomingWeek, trend, debtorsData] = await Promise.all([
    prisma.booking.aggregate({
      where: { status: { not: "CANCELLED" }, amountOutstanding: { gt: 0 } },
      _sum: { amountOutstanding: true },
    }),
    prisma.payment.aggregate({
      where: {
        direction: "INCOME",
        OR: [
          { receivedAt: { gte: monthS, lt: monthNextS } },
          { AND: [{ receivedAt: null }, { paymentDate: { gte: monthS, lt: monthNextS } }, { status: "RECEIVED" }] },
        ],
      },
      _sum: { amount: true },
    }),
    prisma.expense.aggregate({
      where: { approved: true, expenseDate: { gte: monthS, lt: monthNextS } },
      _sum: { amount: true },
    }),
    prisma.booking.findMany({
      where: {
        status: { not: "CANCELLED" },
        amountOutstanding: { gt: 0 },
        expectedPaymentDate: { gte: asOf, lte: weekEnd },
      },
      include: { client: true },
      orderBy: { expectedPaymentDate: "asc" },
    }),
    computeMonthlyTrend(asOf),
    // Top-5 debtors: aggregate per client, top 5 by outstanding desc
    prisma.booking.findMany({
      where: { status: { not: "CANCELLED" }, amountOutstanding: { gt: 0 } },
      include: { client: true },
      orderBy: { amountOutstanding: "desc" },
    }),
  ]);

  const totalOutstanding = new Decimal(totalOutstandingAgg._sum.amountOutstanding?.toString() ?? "0");
  const earnedThisMonth = new Decimal(earnedAgg._sum.amount?.toString() ?? "0");
  const spentThisMonth = new Decimal(spentAgg._sum.amount?.toString() ?? "0");
  const netThisMonth = earnedThisMonth.sub(spentThisMonth);

  // Compute top-5 debtors: aggregate per client
  const now = asOf;
  const clientMap = new Map<string, { clientId: string; clientName: string; outstanding: Decimal; maxDaysOverdue: number }>();
  for (const b of debtorsData) {
    const amt = new Decimal(b.amountOutstanding.toString());
    const daysOverdue = b.expectedPaymentDate
      ? Math.floor((now.getTime() - b.expectedPaymentDate.getTime()) / 86400000)
      : 0;
    const acc = clientMap.get(b.clientId) ?? {
      clientId: b.clientId,
      clientName: b.client.name,
      outstanding: new Decimal(0),
      maxDaysOverdue: 0,
    };
    acc.outstanding = acc.outstanding.add(amt);
    if (daysOverdue > acc.maxDaysOverdue) acc.maxDaysOverdue = daysOverdue;
    clientMap.set(b.clientId, acc);
  }
  const topDebtors = Array.from(clientMap.values())
    .sort((a, b) => b.outstanding.cmp(a.outstanding))
    .slice(0, 5)
    .map((c) => ({
      clientId: c.clientId,
      clientName: c.clientName,
      outstanding: c.outstanding.toFixed(2),
      overdueDays: c.maxDaysOverdue > 0 ? c.maxDaysOverdue : null,
    }));

  // Legacy dashboardMetrics keys needed by existing consumers
  const legacyData = await dashboardMetrics();

  return {
    // New keys
    asOf: asOf.toISOString(),
    totalOutstanding: totalOutstanding.toFixed(2),
    earnedThisMonth: earnedThisMonth.toFixed(2),
    spentThisMonth: spentThisMonth.toFixed(2),
    netThisMonth: netThisMonth.toFixed(2),
    upcomingWeek: upcomingWeek.map((b) => ({
      bookingId: b.id,
      projectName: b.projectName,
      clientId: b.clientId,
      clientName: b.client.name,
      amountOutstanding: b.amountOutstanding.toString(),
      expectedPaymentDate: b.expectedPaymentDate,
    })),
    trend,
    topDebtors,
    // Legacy keys (superset — keep for existing consumers)
    ...legacyData,
  };
}

export async function computePaymentsCalendar(monthStart: Date): Promise<Record<string, { expected: string; received: string }>> {
  const monthNextStart = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1, 0, 0, 0, 0);

  const [expectedBookings, receivedPayments] = await Promise.all([
    prisma.booking.findMany({
      where: {
        status: { not: "CANCELLED" },
        expectedPaymentDate: { gte: monthStart, lt: monthNextStart },
      },
      select: { expectedPaymentDate: true, amountOutstanding: true },
    }),
    prisma.payment.findMany({
      where: {
        direction: "INCOME",
        AND: [
          { OR: [{ status: "RECEIVED" }, { receivedAt: { not: null } }] },
          { OR: [{ receivedAt: { gte: monthStart, lt: monthNextStart } }, { paymentDate: { gte: monthStart, lt: monthNextStart } }] },
        ],
      },
      select: { receivedAt: true, paymentDate: true, amount: true },
    }),
  ]);

  const result: Record<string, { expected: string; received: string }> = {};

  for (const b of expectedBookings) {
    if (!b.expectedPaymentDate) continue;
    const key = toYYYYMMDD(b.expectedPaymentDate);
    const cur = result[key] ?? { expected: "0", received: "0" };
    cur.expected = new Decimal(cur.expected).add(b.amountOutstanding.toString()).toFixed(2);
    result[key] = cur;
  }

  for (const p of receivedPayments) {
    const date = p.receivedAt ?? p.paymentDate;
    if (!date) continue;
    const key = toYYYYMMDD(date);
    const cur = result[key] ?? { expected: "0", received: "0" };
    cur.received = new Decimal(cur.received).add(p.amount.toString()).toFixed(2);
    result[key] = cur;
  }

  return result;
}

export async function computeExpensesBreakdown(from: Date, to: Date) {
  // Use exclusive upper bound to avoid month-boundary double-count
  const toExclusive = new Date(to.getTime() + 1);
  const rows = await prisma.expense.groupBy({
    by: ["category"],
    where: { expenseDate: { gte: from, lt: toExclusive }, approved: true },
    _sum: { amount: true },
    _count: true,
  });

  return rows
    .map((r: any) => ({
      category: r.category as string,
      total: new Decimal(r._sum.amount?.toString() ?? "0").toFixed(2),
      count: r._count,
    }))
    .sort((a: any, b: any) => new Decimal(b.total).cmp(new Decimal(a.total)));
}

export function csvEscape(v: string): string {
  return `"${v.replace(/"/g, "\"\"")}"`;
}

export async function workbookFromRows(args: { sheetName: string; headers: string[]; rows: Array<Array<string | number>> }) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(args.sheetName);
  ws.addRow(args.headers);
  ws.getRow(1).font = { bold: true };
  args.rows.forEach((r) => ws.addRow(r));
  ws.columns = args.headers.map((h) => ({ width: Math.max(14, h.length + 4) }));
  return wb.xlsx.writeBuffer();
}

export async function paymentStatusSyncForAllBookings() {
  const bookings = await prisma.booking.findMany({ select: { id: true } });
  for (const b of bookings) {
    await recomputeBookingFinance(b.id);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Агрегация долгов по клиентам
// ──────────────────────────────────────────────────────────────────────────────

interface ClientDebtProject {
  bookingId: string;
  projectName: string;
  amountOutstanding: string;
  expectedPaymentDate: Date | null;
  daysOverdue: number | null;
  paymentStatus: string;
  bookingStatus: string;
}

interface ClientDebtAccumulator {
  clientId: string;
  clientName: string;
  totalOutstanding: Decimal;
  overdueAmount: Decimal;
  maxDaysOverdue: number;
  projects: ClientDebtProject[];
}

/**
 * Возвращает агрегированные долги клиентов по броням.
 * Игнорирует: CANCELLED брони, брони с amountOutstanding = 0.
 */
export async function computeDebts(
  options: { overdueOnly?: boolean; minAmount?: number } = {},
): Promise<{
  debts: Array<{
    clientId: string;
    clientName: string;
    totalOutstanding: string;
    overdueAmount: string;
    maxDaysOverdue: number;
    bookingsCount: number;
    projects: ClientDebtProject[];
  }>;
  summary: {
    totalClients: number;
    totalOutstanding: string;
    totalOverdue: string;
    asOf: string;
  };
}> {
  const now = new Date();

  const bookings = await prisma.booking.findMany({
    where: {
      status: { not: "CANCELLED" },
      amountOutstanding: { gt: 0 },
    },
    include: { client: true },
    orderBy: { expectedPaymentDate: "asc" },
  });

  const byClient = new Map<string, ClientDebtAccumulator>();

  for (const b of bookings) {
    const amt = new Decimal(b.amountOutstanding.toString());
    const daysOverdue = b.expectedPaymentDate
      ? Math.floor((now.getTime() - b.expectedPaymentDate.getTime()) / 86400000)
      : null;
    const isOverdue =
      (daysOverdue !== null && daysOverdue > 0) || b.paymentStatus === "OVERDUE";

    const acc = byClient.get(b.clientId) ?? {
      clientId: b.clientId,
      clientName: b.client.name,
      totalOutstanding: new Decimal(0),
      overdueAmount: new Decimal(0),
      maxDaysOverdue: 0,
      projects: [],
    };

    acc.totalOutstanding = acc.totalOutstanding.add(amt);
    if (isOverdue) {
      acc.overdueAmount = acc.overdueAmount.add(amt);
      if (daysOverdue !== null && daysOverdue > acc.maxDaysOverdue) {
        acc.maxDaysOverdue = daysOverdue;
      }
    }
    acc.projects.push({
      bookingId: b.id,
      projectName: b.projectName,
      amountOutstanding: amt.toFixed(2),
      expectedPaymentDate: b.expectedPaymentDate,
      daysOverdue: isOverdue ? daysOverdue : null,
      paymentStatus: b.paymentStatus,
      bookingStatus: b.status,
    });

    byClient.set(b.clientId, acc);
  }

  let debts = Array.from(byClient.values()).map((c) => ({
    clientId: c.clientId,
    clientName: c.clientName,
    totalOutstanding: c.totalOutstanding.toFixed(2),
    overdueAmount: c.overdueAmount.toFixed(2),
    maxDaysOverdue: c.maxDaysOverdue,
    bookingsCount: c.projects.length,
    projects: c.projects,
  }));

  if (options.overdueOnly) {
    debts = debts.filter((d) => new Decimal(d.overdueAmount).gt(0));
  }
  if (options.minAmount != null) {
    debts = debts.filter((d) =>
      new Decimal(d.totalOutstanding).gte(options.minAmount!),
    );
  }

  // Сортировка по totalOutstanding desc
  debts.sort(
    (a, b) =>
      new Decimal(b.totalOutstanding).cmp(new Decimal(a.totalOutstanding)),
  );

  const totalOutstanding = debts
    .reduce((acc, d) => acc.add(d.totalOutstanding), new Decimal(0))
    .toFixed(2);
  const totalOverdue = debts
    .reduce((acc, d) => acc.add(d.overdueAmount), new Decimal(0))
    .toFixed(2);

  return {
    debts,
    summary: {
      totalClients: debts.length,
      totalOutstanding,
      totalOverdue,
      asOf: now.toISOString(),
    },
  };
}

