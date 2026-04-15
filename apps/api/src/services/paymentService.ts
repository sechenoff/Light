import type { PaymentMethod, Payment, Prisma } from "@prisma/client";
import { Decimal } from "decimal.js";
import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { writeAuditEntry, diffFields } from "./audit";
import { recomputeBookingFinance } from "./finance";

type TxClient = Omit<
  Prisma.TransactionClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends" | "$use"
>;

export interface CreatePaymentArgs {
  bookingId: string;
  amount: Decimal | number | string;
  method: PaymentMethod;
  receivedAt: Date;
  note?: string;
  createdBy: string;
}

export async function createPayment(args: CreatePaymentArgs): Promise<Payment> {
  // Validate booking exists
  const booking = await prisma.booking.findUnique({ where: { id: args.bookingId } });
  if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");

  const amount = new Decimal(args.amount.toString());

  return prisma.$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: {
        bookingId: args.bookingId,
        amount: amount,
        method: args.method,
        receivedAt: args.receivedAt,
        note: args.note ?? null,
        createdBy: args.createdBy,
        // Legacy backfill
        paymentMethod: args.method,
        paymentDate: args.receivedAt,
        comment: args.note ?? null,
        direction: "INCOME",
        status: "RECEIVED",
      },
    });

    await recomputeBookingFinance(args.bookingId, tx as TxClient);

    await writeAuditEntry({
      tx: tx as TxClient,
      userId: args.createdBy,
      action: "PAYMENT_CREATE",
      entityType: "Payment",
      entityId: payment.id,
      before: null,
      after: diffFields({ ...payment, amount: payment.amount.toString() } as Record<string, unknown>),
    });

    return payment;
  });
}

export async function updatePayment(
  id: string,
  patch: Partial<CreatePaymentArgs>,
  userId: string,
): Promise<Payment> {
  return prisma.$transaction(async (tx) => {
    const before = await tx.payment.findUniqueOrThrow({ where: { id } });

    const data: Prisma.PaymentUpdateInput = {};
    if (patch.amount !== undefined) data.amount = new Decimal(patch.amount.toString());
    if (patch.method !== undefined) {
      data.method = patch.method;
      data.paymentMethod = patch.method; // legacy sync
    }
    if (patch.receivedAt !== undefined) {
      data.receivedAt = patch.receivedAt;
      data.paymentDate = patch.receivedAt; // legacy sync
    }
    if (patch.note !== undefined) {
      data.note = patch.note;
      data.comment = patch.note; // legacy sync
    }

    const after = await tx.payment.update({ where: { id }, data });

    const bookingId = before.bookingId;
    if (bookingId) await recomputeBookingFinance(bookingId, tx as TxClient);

    await writeAuditEntry({
      tx: tx as TxClient,
      userId,
      action: "PAYMENT_UPDATE",
      entityType: "Payment",
      entityId: id,
      before: diffFields({ ...before, amount: before.amount.toString() } as Record<string, unknown>),
      after: diffFields({ ...after, amount: after.amount.toString() } as Record<string, unknown>),
    });

    return after;
  });
}

export async function deletePayment(id: string, userId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const before = await tx.payment.findUniqueOrThrow({ where: { id } });

    await tx.payment.delete({ where: { id } });

    if (before.bookingId) await recomputeBookingFinance(before.bookingId, tx as TxClient);

    await writeAuditEntry({
      tx: tx as TxClient,
      userId,
      action: "PAYMENT_DELETE",
      entityType: "Payment",
      entityId: id,
      before: diffFields({ ...before, amount: before.amount.toString() } as Record<string, unknown>),
      after: null,
    });
  });
}

export interface ListPaymentsArgs {
  bookingId?: string;
  clientId?: string;
  method?: PaymentMethod;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

export async function listPayments(args: ListPaymentsArgs) {
  const limit = Math.min(args.limit ?? 50, 200);
  const offset = args.offset ?? 0;

  const andClauses: Prisma.PaymentWhereInput[] = [
    { direction: "INCOME" },
    { OR: [{ status: "RECEIVED" }, { receivedAt: { not: null } }] },
  ];

  if (args.bookingId) andClauses.push({ bookingId: args.bookingId });
  if (args.method) andClauses.push({ method: args.method });

  if (args.from || args.to) {
    const dateFilter: Prisma.DateTimeNullableFilter = {};
    if (args.from) dateFilter.gte = args.from;
    if (args.to) dateFilter.lte = args.to;
    andClauses.push({
      OR: [{ receivedAt: dateFilter }, { paymentDate: dateFilter }],
    });
  }

  if (args.clientId) {
    andClauses.push({ booking: { clientId: args.clientId } });
  }

  const where: Prisma.PaymentWhereInput = { AND: andClauses };

  const [items, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      include: {
        booking: {
          select: {
            id: true,
            projectName: true,
            client: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: [{ receivedAt: "desc" }, { paymentDate: "desc" }],
      take: limit,
      skip: offset,
    }),
    prisma.payment.count({ where }),
  ]);

  return { items, total };
}
