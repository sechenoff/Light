import type { BookingPaymentStatus, PaymentDirection, PaymentRecordStatus, Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import ExcelJS from "exceljs";

import { prisma } from "../prisma";
import { toMoscowDateString, fromMoscowDateString } from "../utils/moscowDate";
import { HttpError } from "../utils/errors";
import type { DebtReportBooking } from "./documentExport/clientDebtReport/renderClientDebtReportPdf";

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
          voidedAt: null, // Исключаем аннулированные платежи (Finance Phase 2)
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
  // Equipment total after discount — from estimate snapshot if present, else from booking's stored values.
  const equipmentAfterDiscount = booking.estimate
    ? new Decimal(booking.estimate.totalAfterDiscount.toString())
    : new Decimal(booking.finalAmount.toString());
  // Transport is a flat add-on that doesn't participate in the equipment discount.
  const transportSubtotal = booking.transportSubtotalRub
    ? new Decimal(booking.transportSubtotalRub.toString())
    : new Decimal(0);
  // Final amount = what the client actually pays = equipment-after-discount + transport.
  const finalAmount = equipmentAfterDiscount.add(transportSubtotal);
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
    prisma.payment.findMany({ where: { direction: "INCOME", status: "RECEIVED", voidedAt: null, paymentDate: { gte: dayStart } }, select: { amount: true } }),
    prisma.payment.findMany({ where: { direction: "INCOME", status: "RECEIVED", voidedAt: null, paymentDate: { gte: weekStart } }, select: { amount: true } }),
    prisma.payment.findMany({ where: { direction: "INCOME", status: "RECEIVED", voidedAt: null, paymentDate: { gte: monthStart } }, select: { amount: true } }),
    prisma.payment.findMany({
      where: { direction: "INCOME", status: "PLANNED", voidedAt: null, plannedPaymentDate: { not: null } },
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
    prisma.payment.findMany({ where: { direction: "INCOME", status: "RECEIVED", voidedAt: null }, select: { amount: true } }),
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
            voidedAt: null,
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
        voidedAt: null,
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
        voidedAt: null,
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
  /** PAR F1: сумма уже полученных платежей по этой брони */
  amountPaid: string;
  /** PAR F1: итоговая сумма по брони (до вычета outstanding) */
  finalAmount: string;
  /** PAR F4: количество платежей по брони */
  paymentCount: number;
  expectedPaymentDate: Date | null;
  daysOverdue: number | null;
  paymentStatus: string;
  bookingStatus: string;
  /** B1: дата начала брони (booking.startDate) — для сортировки по дате проекта */
  startDate: Date | null;
  /** B1: дата окончания брони (booking.endDate) */
  endDate: Date | null;
  /** B1: имя клиента (денормализовано для плоского списка) */
  clientName: string;
  /** B1: id клиента (денормализовано для плоского списка) */
  clientId: string;
}

interface ClientDebtAccumulator {
  clientId: string;
  clientName: string;
  clientPhone: string | null;
  clientEmail: string | null;
  lastReminderAt: Date | null;
  totalOutstanding: Decimal;
  overdueAmount: Decimal;
  maxDaysOverdue: number;
  projects: ClientDebtProject[];
}

// Russian-locale collator для сортировки по имени клиента
const ruCollator = new Intl.Collator("ru");

/**
 * Возвращает агрегированные долги клиентов по броням.
 * Игнорирует: CANCELLED брони, брони с amountOutstanding = 0.
 */
export async function computeDebts(
  options: {
    overdueOnly?: boolean;
    minAmount?: number;
    /** B2: accepted enum; actual per-row sort done on frontend for flat list */
    sort?: "name" | "amount" | "date" | "startDate" | "status";
    order?: "asc" | "desc";
  } = {},
): Promise<{
  debts: Array<{
    clientId: string;
    clientName: string;
    clientPhone: string | null;
    clientEmail: string | null;
    lastReminderAt: string | null;
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
    include: {
      client: {
        select: { id: true, name: true, phone: true, email: true, lastReminderAt: true },
      },
      // D2: count only active INCOME payments (exclude voided + refunds)
      _count: { select: { payments: { where: { voidedAt: null, direction: "INCOME" } } } },
    },
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
      clientPhone: b.client.phone ?? null,
      clientEmail: b.client.email ?? null,
      lastReminderAt: b.client.lastReminderAt ?? null,
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
      amountPaid: new Decimal(b.amountPaid.toString()).toFixed(2),
      finalAmount: new Decimal(b.finalAmount.toString()).toFixed(2),
      paymentCount: b._count.payments,
      expectedPaymentDate: b.expectedPaymentDate,
      daysOverdue: isOverdue ? daysOverdue : null,
      paymentStatus: b.paymentStatus,
      bookingStatus: b.status,
      startDate: b.startDate ?? null,
      endDate: b.endDate ?? null,
      clientName: b.client.name,
      clientId: b.clientId,
    });

    byClient.set(b.clientId, acc);
  }

  let debts = Array.from(byClient.values()).map((c) => ({
    clientId: c.clientId,
    clientName: c.clientName,
    clientPhone: c.clientPhone,
    clientEmail: c.clientEmail,
    lastReminderAt: c.lastReminderAt ? c.lastReminderAt.toISOString() : null,
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

  // Сортировка: sort + order с поддержкой russian-locale collation для имён
  const sort = options.sort ?? "amount";
  const order = options.order ?? "desc";
  const sign = order === "asc" ? 1 : -1;

  if (sort === "name") {
    debts.sort((a, b) => sign * ruCollator.compare(a.clientName, b.clientName));
  } else if (sort === "date") {
    // Сортировка по самой ранней дате ожидаемой оплаты среди проектов клиента
    // null-значения идут последними при asc, первыми при desc
    const getMinDate = (d: typeof debts[number]): number => {
      const dates = d.projects
        .map((p) => p.expectedPaymentDate)
        .filter((dt): dt is Date => dt !== null && dt !== undefined)
        .map((dt) => dt instanceof Date ? dt.getTime() : new Date(dt).getTime());
      return dates.length > 0 ? Math.min(...dates) : (order === "asc" ? Infinity : -Infinity);
    };
    debts.sort((a, b) => sign * (getMinDate(a) - getMinDate(b)));
  } else {
    // default: sort by amount
    debts.sort(
      (a, b) =>
        sign * new Decimal(a.totalOutstanding).cmp(new Decimal(b.totalOutstanding)),
    );
  }

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

// ──────────────────────────────────────────────────────────────────────────────
// Finance Phase 2: Aging buckets
// ──────────────────────────────────────────────────────────────────────────────

export interface AgingBucket {
  label: string;
  minDays: number;
  maxDays: number | null;
  total: string;
  invoiceCount: number;
}

/**
 * Возвращает aging-buckets по Invoice.dueDate только для post-cutoff броней.
 * Buckets: текущие (≤0), 1-30, 31-60, 61-90, >90 дней просрочки.
 */
export async function computeAging(asOf: Date = new Date()): Promise<AgingBucket[]> {
  const invoices = await prisma.invoice.findMany({
    where: {
      status: { in: ["ISSUED", "PARTIAL_PAID", "OVERDUE"] },
      dueDate: { not: null },
      booking: { legacyFinance: false },
    },
    select: {
      dueDate: true,
      total: true,
      paidAmount: true,
    },
  });

  const buckets: AgingBucket[] = [
    { label: "Текущие", minDays: Number.NEGATIVE_INFINITY, maxDays: 0, total: "0", invoiceCount: 0 },
    { label: "1–30 дней", minDays: 1, maxDays: 30, total: "0", invoiceCount: 0 },
    { label: "31–60 дней", minDays: 31, maxDays: 60, total: "0", invoiceCount: 0 },
    { label: "61–90 дней", minDays: 61, maxDays: 90, total: "0", invoiceCount: 0 },
    { label: "Свыше 90 дней", minDays: 91, maxDays: null, total: "0", invoiceCount: 0 },
  ];

  for (const inv of invoices) {
    if (!inv.dueDate) continue;
    const outstanding = new Decimal(inv.total.toString()).sub(new Decimal(inv.paidAmount.toString()));
    if (outstanding.lessThanOrEqualTo(0)) continue;

    const daysOverdue = Math.floor((asOf.getTime() - inv.dueDate.getTime()) / 86400000);

    const bucket = buckets.find((b) => {
      if (b.maxDays === null) return daysOverdue >= b.minDays;
      if (b.minDays === Number.NEGATIVE_INFINITY) return daysOverdue <= b.maxDays;
      return daysOverdue >= b.minDays && daysOverdue <= b.maxDays;
    });

    if (bucket) {
      bucket.total = new Decimal(bucket.total).add(outstanding).toFixed(2);
      bucket.invoiceCount++;
    }
  }

  return buckets;
}

// ──────────────────────────────────────────────────────────────────────────────
// B5 — Finance Phase 3: Related Expenses for a Booking
// ──────────────────────────────────────────────────────────────────────────────

export interface RelatedExpenseItem {
  id: string;
  category: string;
  amount: string;
  description: string | null;
  documentUrl: string | null;
  approved: boolean;
  createdAt: string;
  source: "DIRECT" | "REPAIR_LINKED";
  linkedRepairId: string | null; // D4: included so frontend can link to /repair/<id>
}

export interface RelatedExpensesResult {
  items: RelatedExpenseItem[];
  total: string;
}

/**
 * Возвращает прямые и косвенно связанные расходы по броне.
 * - DIRECT: Expense.bookingId == bookingId
 * - REPAIR_LINKED: Expense.linkedRepairId => Repair на unit, который был в этой броне
 *   (с ограничением по дате: createdAt в пределах booking.startDate — booking.endDate + 14 дней)
 */
export async function computeRelatedExpenses(bookingId: string): Promise<RelatedExpensesResult> {
  // Get booking for date range
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { startDate: true, endDate: true },
  });
  if (!booking) return { items: [], total: "0.00" };

  const windowEnd = new Date(booking.endDate.getTime() + 14 * 24 * 60 * 60 * 1000);

  // Direct expenses
  const directExpenses = await prisma.expense.findMany({
    where: { bookingId },
    select: { id: true, category: true, amount: true, description: true, documentUrl: true, approved: true, createdAt: true, linkedRepairId: true },
  });

  // Repair-linked expenses:
  // Find repairs on units that were in this booking AND created within date window
  const repairsOnBookingUnits = await prisma.repair.findMany({
    where: {
      unit: {
        bookingItemUnits: {
          some: {
            bookingItem: { bookingId },
          },
        },
      },
      createdAt: { gte: booking.startDate, lte: windowEnd },
    },
    select: { id: true },
  });
  const repairIds = repairsOnBookingUnits.map((r: { id: string }) => r.id);

  // Get direct expense IDs to avoid duplicates (expense could have both bookingId and linkedRepairId)
  const directIds = new Set(directExpenses.map((e) => e.id));

  const repairExpenses =
    repairIds.length > 0
      ? await prisma.expense.findMany({
          where: {
            linkedRepairId: { in: repairIds },
            id: { notIn: Array.from(directIds) },
          },
          select: { id: true, category: true, amount: true, description: true, documentUrl: true, approved: true, createdAt: true, linkedRepairId: true },
        })
      : [];

  const directItems: RelatedExpenseItem[] = directExpenses.map((e) => ({
    id: e.id,
    category: e.category,
    amount: e.amount.toString(),
    description: e.description ?? null,
    documentUrl: e.documentUrl ?? null,
    approved: e.approved,
    createdAt: e.createdAt.toISOString(),
    source: "DIRECT" as const,
    linkedRepairId: e.linkedRepairId ?? null,
  }));

  const repairItems: RelatedExpenseItem[] = repairExpenses.map((e) => ({
    id: e.id,
    category: e.category,
    amount: e.amount.toString(),
    description: e.description ?? null,
    documentUrl: e.documentUrl ?? null,
    approved: e.approved,
    createdAt: e.createdAt.toISOString(),
    source: "REPAIR_LINKED" as const,
    linkedRepairId: e.linkedRepairId ?? null,
  }));

  const items = [...directItems, ...repairItems];
  const total = items.reduce((acc, e) => acc.add(new Decimal(e.amount)), new Decimal(0)).toFixed(2);

  return { items, total };
}

// ──────────────────────────────────────────────────────────────────────────────
// B4 — Finance Phase 3: Booking Finance Timeline
// ──────────────────────────────────────────────────────────────────────────────

export type TimelineEvent =
  | { type: "INVOICE_ISSUED"; at: string; invoiceId: string; number: string; total: string; kind: string }
  | { type: "INVOICE_VOIDED"; at: string; invoiceId: string; number: string; reason: string | null }
  | { type: "PAYMENT_RECEIVED"; at: string; paymentId: string; amount: string; method: string; invoiceId: string | null }
  | { type: "PAYMENT_VOIDED"; at: string; paymentId: string; amount: string; reason: string | null }
  | { type: "REFUND_ISSUED"; at: string; refundId: string; amount: string; method: string; reason: string }
  | { type: "EXPENSE_LOGGED"; at: string; expenseId: string; category: string; amount: string; description: string | null }
  | { type: "CREDIT_NOTE_APPLIED"; at: string; creditNoteId: string; amount: string };

/**
 * Возвращает хронологию финансовых событий по броне.
 * Сортировка: ascending by at (ISO timestamp).
 */
export async function computeBookingTimeline(bookingId: string): Promise<TimelineEvent[]> {
  const [invoices, payments, refunds, expenses, creditNotes] = await Promise.all([
    prisma.invoice.findMany({
      where: { bookingId },
      select: { id: true, number: true, total: true, kind: true, issuedAt: true, voidedAt: true, voidReason: true, createdAt: true },
    }),
    prisma.payment.findMany({
      where: { bookingId, direction: "INCOME" },
      select: { id: true, amount: true, paymentMethod: true, receivedAt: true, paymentDate: true, voidedAt: true, voidReason: true, invoiceId: true, createdAt: true },
    }),
    prisma.refund.findMany({
      where: { bookingId },
      select: { id: true, amount: true, method: true, reason: true, refundedAt: true, createdAt: true },
    }),
    prisma.expense.findMany({
      where: { bookingId },
      select: { id: true, category: true, amount: true, description: true, expenseDate: true, createdAt: true },
    }),
    prisma.creditNote.findMany({
      where: { appliedToBookingId: bookingId, appliedAt: { not: null } },
      select: { id: true, amount: true, appliedAt: true },
    }),
  ]);

  const events: TimelineEvent[] = [];

  for (const inv of invoices) {
    if (inv.issuedAt) {
      events.push({
        type: "INVOICE_ISSUED",
        at: inv.issuedAt.toISOString(),
        invoiceId: inv.id,
        number: inv.number,
        total: inv.total.toString(),
        kind: inv.kind,
      });
    }
    if (inv.voidedAt) {
      events.push({
        type: "INVOICE_VOIDED",
        at: inv.voidedAt.toISOString(),
        invoiceId: inv.id,
        number: inv.number,
        reason: inv.voidReason ?? null,
      });
    }
  }

  for (const p of payments) {
    const at = (p.receivedAt ?? p.paymentDate ?? p.createdAt).toISOString();
    if (!p.voidedAt) {
      // Non-voided payment: emit PAYMENT_RECEIVED
      events.push({
        type: "PAYMENT_RECEIVED",
        at,
        paymentId: p.id,
        amount: p.amount.toString(),
        method: p.paymentMethod,
        invoiceId: p.invoiceId ?? null,
      });
    } else {
      // T6: Voided payment — do NOT emit PAYMENT_RECEIVED; only emit PAYMENT_VOIDED.
      // Emitting both would show income that was immediately cancelled, confusing the timeline.
      events.push({
        type: "PAYMENT_VOIDED",
        at: p.voidedAt.toISOString(),
        paymentId: p.id,
        amount: p.amount.toString(),
        reason: p.voidReason ?? null,
      });
    }
  }

  for (const r of refunds) {
    events.push({
      type: "REFUND_ISSUED",
      at: r.refundedAt.toISOString(),
      refundId: r.id,
      amount: r.amount.toString(),
      method: r.method,
      reason: r.reason,
    });
  }

  for (const e of expenses) {
    events.push({
      type: "EXPENSE_LOGGED",
      at: e.expenseDate.toISOString(),
      expenseId: e.id,
      category: e.category,
      amount: e.amount.toString(),
      description: e.description ?? null,
    });
  }

  for (const cn of creditNotes) {
    if (cn.appliedAt) {
      events.push({
        type: "CREDIT_NOTE_APPLIED",
        at: cn.appliedAt.toISOString(),
        creditNoteId: cn.id,
        amount: cn.amount.toString(),
      });
    }
  }

  // Sort ascending by at
  events.sort((a, b) => a.at.localeCompare(b.at));

  return events;
}

// ──────────────────────────────────────────────────────────────────────────────
// B1 — Finance Phase 3: Forecast (стек-бар прогноза)
// ──────────────────────────────────────────────────────────────────────────────

export interface ForecastMonth {
  /** YYYY-MM */
  month: string;
  /** Сумма остатков ISSUED/PARTIAL_PAID/OVERDUE инвойсов с dueDate в этом месяце */
  confirmed: string;
  /** Сумма остатков DRAFT инвойсов с dueDate в этом месяце */
  potential: string;
  /** Сумма amountOutstanding броней без инвойсов (CONFIRMED/ISSUED/RETURNED) */
  bookingsPipeline: string;
}

export interface ForecastResult {
  months: ForecastMonth[];
  totals: {
    confirmed: string;
    potential: string;
    bookingsPipeline: string;
  };
  horizon: { from: string; to: string };
}

/**
 * Возвращает прогноз доходов на horizonMonths месяцев вперёд начиная с текущего.
 * Максимальный горизонт: 12 месяцев.
 */
export async function computeForecast(horizonMonths = 6): Promise<ForecastResult> {
  const clampedMonths = Math.min(Math.max(1, horizonMonths), 12);
  const now = new Date();

  // T5: Build month slots in Moscow TZ (Europe/Moscow, UTC+3).
  // Using toMoscowDateString to get the current date in Moscow, then computing
  // month boundaries as Moscow-midnight UTC via fromMoscowDateString.
  const nowMoscowStr = toMoscowDateString(now); // "YYYY-MM-DD" in Moscow
  const [nowYear, nowMonth] = nowMoscowStr.split("-").map(Number);

  const monthSlots: Array<{ label: string; start: Date; end: Date }> = [];
  for (let i = 0; i < clampedMonths; i++) {
    // Compute target year/month (1-based) in Moscow TZ
    const totalMonths = (nowYear - 1) * 12 + (nowMonth - 1) + i;
    const year = Math.floor(totalMonths / 12) + 1;
    const month = (totalMonths % 12) + 1; // 1-based

    const mm = String(month).padStart(2, "0");
    const label = `${year}-${mm}`;

    // Start of month: first day in Moscow = Moscow midnight UTC
    const start = fromMoscowDateString(`${year}-${mm}-01`);

    // End of month: last day in Moscow (compute last day properly)
    // Next month's first day - 1 ms
    const nextMonthYear = month === 12 ? year + 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextMonthStart = fromMoscowDateString(`${nextMonthYear}-${String(nextMonth).padStart(2, "0")}-01`);
    const end = new Date(nextMonthStart.getTime() - 1);

    monthSlots.push({ label, start, end });
  }

  const horizonStart = monthSlots[0].start;
  const horizonEnd = monthSlots[monthSlots.length - 1].end;

  // Fetch ISSUED/PARTIAL_PAID/OVERDUE invoices with dueDate in horizon
  const confirmedInvoices = await prisma.invoice.findMany({
    where: {
      status: { in: ["ISSUED", "PARTIAL_PAID", "OVERDUE"] },
      dueDate: { gte: horizonStart, lte: horizonEnd },
      voidedAt: null,
    },
    select: { dueDate: true, total: true, paidAmount: true },
  });

  // Fetch DRAFT invoices with dueDate in horizon
  const potentialInvoices = await prisma.invoice.findMany({
    where: {
      status: "DRAFT",
      dueDate: { gte: horizonStart, lte: horizonEnd },
      voidedAt: null,
    },
    select: { dueDate: true, total: true, paidAmount: true },
  });

  // Fetch CONFIRMED/ISSUED/RETURNED/PENDING_APPROVAL bookings without any invoice, startDate in horizon.
  // "without invoice" = no related Invoice records.
  // T4: Exclude legacyFinance bookings — they have outstanding from pre-finance era
  // and should not appear in the forward-looking forecast.
  // M2: также включаем PENDING_APPROVAL (реальный pipeline), и убираем ограничение на amountOutstanding
  //     т.к. брони без инвойсов могут ещё не иметь финансового состояния.
  const pipelineBookings = await prisma.booking.findMany({
    where: {
      status: { in: ["CONFIRMED", "ISSUED", "RETURNED", "PENDING_APPROVAL"] },
      startDate: { gte: horizonStart, lte: horizonEnd },
      legacyFinance: false,
      invoices: { none: {} },
    },
    select: { startDate: true, amountOutstanding: true, finalAmount: true },
  });

  // Helper: which month slot does a date fall in?
  // T5: Use Moscow TZ for bucketing — convert date to Moscow "YYYY-MM-DD", take YYYY-MM prefix
  function monthSlotLabel(d: Date): string | null {
    const moscowDateStr = toMoscowDateString(d); // "YYYY-MM-DD" in Moscow
    const label = moscowDateStr.slice(0, 7); // "YYYY-MM"
    const slot = monthSlots.find((s) => s.label === label);
    return slot ? label : null;
  }

  // Accumulate per slot
  const slotData = new Map<string, { confirmed: Decimal; potential: Decimal; bookingsPipeline: Decimal }>(
    monthSlots.map((s) => [s.label, { confirmed: new Decimal(0), potential: new Decimal(0), bookingsPipeline: new Decimal(0) }]),
  );

  for (const inv of confirmedInvoices) {
    if (!inv.dueDate) continue;
    const label = monthSlotLabel(inv.dueDate);
    if (!label) continue;
    const outstanding = Decimal.max(
      new Decimal(inv.total.toString()).sub(new Decimal(inv.paidAmount.toString())),
      new Decimal(0),
    );
    slotData.get(label)!.confirmed = slotData.get(label)!.confirmed.add(outstanding);
  }

  for (const inv of potentialInvoices) {
    if (!inv.dueDate) continue;
    const label = monthSlotLabel(inv.dueDate);
    if (!label) continue;
    const outstanding = Decimal.max(
      new Decimal(inv.total.toString()).sub(new Decimal(inv.paidAmount.toString())),
      new Decimal(0),
    );
    slotData.get(label)!.potential = slotData.get(label)!.potential.add(outstanding);
  }

  for (const b of pipelineBookings) {
    const label = monthSlotLabel(b.startDate);
    if (!label) continue;
    // M2: используем amountOutstanding если > 0, иначе finalAmount (бронь без платежей)
    const outstanding = new Decimal(b.amountOutstanding.toString());
    const amount = outstanding.gt(0) ? outstanding : new Decimal(b.finalAmount.toString());
    if (amount.lte(0)) continue;
    slotData.get(label)!.bookingsPipeline = slotData.get(label)!.bookingsPipeline.add(amount);
  }

  // Build output months array in order
  const months: ForecastMonth[] = monthSlots.map((s) => {
    const d = slotData.get(s.label)!;
    return {
      month: s.label,
      confirmed: d.confirmed.toFixed(2),
      potential: d.potential.toFixed(2),
      bookingsPipeline: d.bookingsPipeline.toFixed(2),
    };
  });

  const totals = {
    confirmed: months.reduce((acc, m) => acc.add(m.confirmed), new Decimal(0)).toFixed(2),
    potential: months.reduce((acc, m) => acc.add(m.potential), new Decimal(0)).toFixed(2),
    bookingsPipeline: months.reduce((acc, m) => acc.add(m.bookingsPipeline), new Decimal(0)).toFixed(2),
  };

  return {
    months,
    totals,
    horizon: { from: horizonStart.toISOString(), to: horizonEnd.toISOString() },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Finance Phase 2 (D6): Per-client aging matrix (5 buckets × clients)
// ──────────────────────────────────────────────────────────────────────────────

export interface ClientAgingRow {
  clientId: string;
  clientName: string;
  current: string;     // ≤0 days overdue
  days1to30: string;   // 1–30 days
  days31to60: string;  // 31–60 days
  days61to90: string;  // 61–90 days
  over90: string;      // >90 days
  total: string;
}

export interface AgingPerClientResult {
  summary: AgingBucket[];
  perClient: ClientAgingRow[];
}

/**
 * D6: Per-client × 5-bucket aging matrix from Invoice.dueDate.
 * Only includes post-cutoff bookings (legacyFinance: false).
 */
export async function computeAgingPerClient(asOf: Date = new Date()): Promise<AgingPerClientResult> {
  const invoices = await prisma.invoice.findMany({
    where: {
      status: { in: ["ISSUED", "PARTIAL_PAID", "OVERDUE"] },
      dueDate: { not: null },
      booking: { legacyFinance: false },
    },
    select: {
      dueDate: true,
      total: true,
      paidAmount: true,
      booking: {
        select: {
          clientId: true,
          client: { select: { id: true, name: true } },
        },
      },
    },
  });

  // Summary buckets (same as computeAging)
  const summaryBuckets: AgingBucket[] = [
    { label: "Текущие", minDays: Number.NEGATIVE_INFINITY, maxDays: 0, total: "0", invoiceCount: 0 },
    { label: "1–30 дней", minDays: 1, maxDays: 30, total: "0", invoiceCount: 0 },
    { label: "31–60 дней", minDays: 31, maxDays: 60, total: "0", invoiceCount: 0 },
    { label: "61–90 дней", minDays: 61, maxDays: 90, total: "0", invoiceCount: 0 },
    { label: "Свыше 90 дней", minDays: 91, maxDays: null, total: "0", invoiceCount: 0 },
  ];

  // Per-client accumulation
  const perClientMap = new Map<string, { name: string; current: Decimal; d1to30: Decimal; d31to60: Decimal; d61to90: Decimal; over90: Decimal }>();

  for (const inv of invoices) {
    if (!inv.dueDate) continue;
    const outstanding = new Decimal(inv.total.toString()).sub(new Decimal(inv.paidAmount.toString()));
    if (outstanding.lessThanOrEqualTo(0)) continue;

    const daysOverdue = Math.floor((asOf.getTime() - inv.dueDate.getTime()) / 86400000);
    const clientId = inv.booking.clientId;
    const clientName = inv.booking.client.name;

    // Update summary buckets
    const summaryBucket = summaryBuckets.find((b) => {
      if (b.maxDays === null) return daysOverdue >= b.minDays;
      if (b.minDays === Number.NEGATIVE_INFINITY) return daysOverdue <= b.maxDays;
      return daysOverdue >= b.minDays && daysOverdue <= b.maxDays;
    });
    if (summaryBucket) {
      summaryBucket.total = new Decimal(summaryBucket.total).add(outstanding).toFixed(2);
      summaryBucket.invoiceCount++;
    }

    // Update per-client row
    if (!perClientMap.has(clientId)) {
      perClientMap.set(clientId, {
        name: clientName,
        current: new Decimal(0),
        d1to30: new Decimal(0),
        d31to60: new Decimal(0),
        d61to90: new Decimal(0),
        over90: new Decimal(0),
      });
    }
    const row = perClientMap.get(clientId)!;

    if (daysOverdue <= 0) row.current = row.current.add(outstanding);
    else if (daysOverdue <= 30) row.d1to30 = row.d1to30.add(outstanding);
    else if (daysOverdue <= 60) row.d31to60 = row.d31to60.add(outstanding);
    else if (daysOverdue <= 90) row.d61to90 = row.d61to90.add(outstanding);
    else row.over90 = row.over90.add(outstanding);
  }

  const perClient: ClientAgingRow[] = Array.from(perClientMap.entries())
    .map(([clientId, row]) => {
      const total = row.current.add(row.d1to30).add(row.d31to60).add(row.d61to90).add(row.over90);
      return {
        clientId,
        clientName: row.name,
        current: row.current.toFixed(2),
        days1to30: row.d1to30.toFixed(2),
        days31to60: row.d31to60.toFixed(2),
        days61to90: row.d61to90.toFixed(2),
        over90: row.over90.toFixed(2),
        total: total.toFixed(2),
      };
    })
    .sort((a, b) => Number(b.total) - Number(a.total));

  return { summary: summaryBuckets, perClient };
}

// ──────────────────────────────────────────────────────────────────────────────
// B2 — Per-client XLSX export
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Строит XLSX-книгу с 3 листами по задолженности конкретного клиента.
 * Лист 1 «Долги»: брони с amountOutstanding > 0.
 * Лист 2 «Платежи»: все платежи клиента по этим броням.
 * Лист 3 «Счета»: post-cutoff инвойсы по этим броням.
 * Возвращает null если клиент не найден.
 */
export async function buildClientDebtExport(clientId: string): Promise<{ buf: Buffer; clientName: string } | null> {
  const now = new Date();

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, name: true },
  });
  if (!client) return null;

  // Брони с долгом (status != CANCELLED, amountOutstanding > 0)
  const bookings = await prisma.booking.findMany({
    where: {
      clientId,
      status: { not: "CANCELLED" },
      amountOutstanding: { gt: 0 },
    },
    orderBy: { startDate: "asc" },
  });

  // Все брони клиента (включая оплаченные) для платежей
  const allClientBookingIds = (
    await prisma.booking.findMany({
      where: { clientId, status: { not: "CANCELLED" } },
      select: { id: true },
    })
  ).map((b: { id: string }) => b.id);

  // Платежи по всем броням клиента
  const payments = allClientBookingIds.length > 0
    ? await prisma.payment.findMany({
        where: { bookingId: { in: allClientBookingIds }, direction: "INCOME", voidedAt: null },
        orderBy: { createdAt: "asc" },
        include: { booking: { select: { projectName: true } } },
      })
    : [];

  // Инвойсы по броням с долгом (post-cutoff — legacyFinance: false)
  const debtBookingIds = bookings.map((b: { id: string }) => b.id);
  const invoices = debtBookingIds.length > 0
    ? await prisma.invoice.findMany({
        where: {
          bookingId: { in: debtBookingIds },
          booking: { legacyFinance: false },
        },
        orderBy: { createdAt: "asc" },
        include: { booking: { select: { projectName: true } } },
      })
    : [];

  const BOOKING_STATUS_RU: Record<string, string> = {
    DRAFT: "Черновик",
    PENDING_APPROVAL: "На согласовании",
    CONFIRMED: "Подтверждена",
    ISSUED: "Выдана",
    ACTIVE: "В работе",
    RETURNED: "Возвращена",
    CLOSED: "Закрыта",
    CANCELLED: "Отменена",
  };

  const PAYMENT_METHOD_RU: Record<string, string> = {
    CASH: "Наличные",
    CARD: "Карта",
    BANK_TRANSFER: "Банк",
    CARD_TERMINAL: "Терминал",
    CREDIT_NOTE: "Кредит-нота",
    OTHER: "Прочее",
  };

  const INVOICE_STATUS_RU: Record<string, string> = {
    DRAFT: "Черновик",
    ISSUED: "Выпущен",
    PARTIAL_PAID: "Частично оплачен",
    PAID: "Оплачен",
    OVERDUE: "Просрочен",
    VOID: "Аннулирован",
  };

  const wb = new ExcelJS.Workbook();

  // Лист 1: Долги
  const wsDebts = wb.addWorksheet("Долги");
  const debtHeaders = ["Бронь", "Период", "Статус", "Стоимость", "Получено", "К получению", "Срок оплаты", "Дни просрочки"];
  wsDebts.addRow(debtHeaders);
  wsDebts.getRow(1).font = { bold: true };
  wsDebts.columns = debtHeaders.map((h) => ({ width: Math.max(14, h.length + 4) }));

  let totalOutstanding = new Decimal(0);

  for (const b of bookings) {
    const period = `${b.startDate.toLocaleDateString("ru-RU")}–${b.endDate.toLocaleDateString("ru-RU")}`;
    const daysOverdue = b.expectedPaymentDate
      ? Math.max(0, Math.floor((now.getTime() - b.expectedPaymentDate.getTime()) / 86400000))
      : 0;
    wsDebts.addRow([
      b.projectName,
      period,
      BOOKING_STATUS_RU[b.status] ?? b.status,
      Number(b.finalAmount.toString()),
      Number(b.amountPaid.toString()),
      Number(b.amountOutstanding.toString()),
      b.expectedPaymentDate ? b.expectedPaymentDate.toLocaleDateString("ru-RU") : "—",
      daysOverdue,
    ]);
    totalOutstanding = totalOutstanding.add(b.amountOutstanding.toString());
  }

  // Итого строка
  if (bookings.length > 0) {
    const totalRow = wsDebts.addRow(["ИТОГО", "", "", "", "", Number(totalOutstanding.toFixed(2)), "", ""]);
    totalRow.font = { bold: true };
  }

  // Лист 2: Платежи
  const wsPayments = wb.addWorksheet("Платежи");
  const paymentHeaders = ["Дата", "Сумма", "Метод", "Бронь", "Заметка"];
  wsPayments.addRow(paymentHeaders);
  wsPayments.getRow(1).font = { bold: true };
  wsPayments.columns = paymentHeaders.map((h) => ({ width: Math.max(14, h.length + 4) }));

  for (const p of payments) {
    const date = (p.paymentDate ?? p.receivedAt ?? p.createdAt).toLocaleDateString("ru-RU");
    wsPayments.addRow([
      date,
      Number(p.amount.toString()),
      PAYMENT_METHOD_RU[p.paymentMethod ?? ""] ?? p.paymentMethod,
      p.booking?.projectName ?? "",
      p.comment ?? "",
    ]);
  }

  // Лист 3: Счета (только при наличии)
  if (invoices.length > 0) {
    const wsInvoices = wb.addWorksheet("Счета");
    const invoiceHeaders = ["Номер", "Бронь", "Сумма", "Оплачено", "Срок", "Статус"];
    wsInvoices.addRow(invoiceHeaders);
    wsInvoices.getRow(1).font = { bold: true };
    wsInvoices.columns = invoiceHeaders.map((h) => ({ width: Math.max(14, h.length + 4) }));

    for (const inv of invoices) {
      wsInvoices.addRow([
        inv.number,
        inv.booking?.projectName ?? "",
        Number(inv.total.toString()),
        Number(inv.paidAmount.toString()),
        inv.dueDate ? inv.dueDate.toLocaleDateString("ru-RU") : "—",
        INVOICE_STATUS_RU[inv.status] ?? inv.status,
      ]);
    }
  }

  const xlsxBuf = await wb.xlsx.writeBuffer();
  const buf = Buffer.isBuffer(xlsxBuf) ? xlsxBuf : Buffer.from(xlsxBuf);
  return { buf, clientName: client.name };
}

// ──────────────────────────────────────────────────────────────────────────────
// B4 — Remindable clients helper
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Возвращает клиентов с долгом, у которых есть просроченный (> 7 дней)
 * неоплаченный инвойс и не было напоминания в последние 14 дней.
 */
export async function getRemindableClients(): Promise<
  Array<{ clientId: string; clientName: string; totalOutstanding: string; maxDaysOverdue: number }>
> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  // Клиенты с просроченными инвойсами (dueDate < now - 7 days)
  const overdueInvoices = await prisma.invoice.findMany({
    where: {
      status: { in: ["ISSUED", "PARTIAL_PAID", "OVERDUE"] },
      dueDate: { lt: sevenDaysAgo },
      booking: { legacyFinance: false },
    },
    include: {
      booking: {
        select: {
          clientId: true,
          client: { select: { id: true, name: true, lastReminderAt: true } },
        },
      },
    },
  });

  const clientMap = new Map<string, { name: string; lastReminderAt: Date | null; daysOverdue: number; outstanding: Decimal }>();

  for (const inv of overdueInvoices) {
    if (!inv.booking) continue;
    const { clientId, client } = inv.booking;
    const daysOverdue = inv.dueDate
      ? Math.floor((now.getTime() - inv.dueDate.getTime()) / 86400000)
      : 0;
    const outstanding = new Decimal(inv.total.toString()).sub(new Decimal(inv.paidAmount.toString()));
    if (outstanding.lte(0)) continue;

    const existing = clientMap.get(clientId) ?? {
      name: client.name,
      lastReminderAt: client.lastReminderAt,
      daysOverdue: 0,
      outstanding: new Decimal(0),
    };
    existing.daysOverdue = Math.max(existing.daysOverdue, daysOverdue);
    existing.outstanding = existing.outstanding.add(outstanding);
    clientMap.set(clientId, existing);
  }

  // Фильтруем: нет напоминания за последние 14 дней
  const result: Array<{ clientId: string; clientName: string; totalOutstanding: string; maxDaysOverdue: number }> = [];
  for (const [clientId, data] of clientMap) {
    const notRemindedRecently = !data.lastReminderAt || data.lastReminderAt < fourteenDaysAgo;
    if (notRemindedRecently) {
      result.push({
        clientId,
        clientName: data.name,
        totalOutstanding: data.outstanding.toFixed(2),
        maxDaysOverdue: data.daysOverdue,
      });
    }
  }

  return result.sort((a, b) => new Decimal(b.totalOutstanding).cmp(new Decimal(a.totalOutstanding)));
}

// ──────────────────────────────────────────────────────────────────────────────
// B2 — computeClientDebtReport: данные для PDF-отчёта по клиенту
// ──────────────────────────────────────────────────────────────────────────────

export type ClientDebtReportData = {
  client: { id: string; name: string; phone: string | null; email: string | null };
  bookings: DebtReportBooking[];
  generatedAt: Date;
};

export async function computeClientDebtReport(clientId: string): Promise<ClientDebtReportData> {
  const now = new Date();

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, name: true, phone: true, email: true },
  });
  if (!client) {
    throw new HttpError(404, "Клиент не найден");
  }

  const rawBookings = await prisma.booking.findMany({
    where: {
      clientId,
      status: { not: "CANCELLED" },
      amountOutstanding: { gt: 0 },
    },
    orderBy: { startDate: "desc" },
  });

  const bookings: DebtReportBooking[] = rawBookings.map((b) => {
    const daysOverdue = b.expectedPaymentDate
      ? Math.max(0, Math.floor((now.getTime() - b.expectedPaymentDate.getTime()) / 86400000))
      : 0;
    return {
      bookingId: b.id,
      startDate: b.startDate ?? null,
      endDate: b.endDate ?? null,
      projectName: b.projectName,
      finalAmount: new Decimal(b.finalAmount.toString()),
      amountPaid: new Decimal(b.amountPaid.toString()),
      amountOutstanding: new Decimal(b.amountOutstanding.toString()),
      expectedPaymentDate: b.expectedPaymentDate,
      daysOverdue,
      paymentStatus: b.paymentStatus,
    };
  });

  return {
    client: {
      id: client.id,
      name: client.name,
      phone: client.phone ?? null,
      email: client.email ?? null,
    },
    bookings,
    generatedAt: now,
  };
}
