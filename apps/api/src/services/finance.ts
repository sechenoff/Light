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
        where: { direction: "INCOME", status: "RECEIVED" },
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

