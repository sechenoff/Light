import type { PaymentMethod, Prisma } from "@prisma/client";
import { Decimal } from "decimal.js";
import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { writeAuditEntry, diffFields } from "./audit";
import { recomputeInvoiceStatus } from "./invoiceService";

type TxClient = Omit<
  Prisma.TransactionClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends" | "$use"
>;

export interface CreateRefundArgs {
  invoiceId?: string;
  paymentId?: string;
  bookingId?: string;
  amount: Decimal | number | string;
  reason: string;
  method: PaymentMethod;
  refundedAt?: Date;
}

/**
 * Создаёт запись о возврате денег клиенту.
 * Требует хотя бы одно из: invoiceId, paymentId, bookingId.
 * После создания пересчитывает статус счёта (если invoiceId задан).
 */
export async function createRefund(args: CreateRefundArgs, userId: string) {
  if (!args.invoiceId && !args.paymentId && !args.bookingId) {
    throw new HttpError(400, "Необходимо указать invoiceId, paymentId или bookingId", "REFUND_MISSING_REFERENCE");
  }

  if (!args.reason || args.reason.trim().length < 3) {
    throw new HttpError(400, "Причина возврата обязательна (минимум 3 символа)", "REFUND_REASON_REQUIRED");
  }

  const amount = new Decimal(args.amount.toString());
  if (amount.lessThanOrEqualTo(0)) {
    throw new HttpError(400, "Сумма возврата должна быть больше 0", "REFUND_AMOUNT_INVALID");
  }

  // H3: Проверки существования invoice/payment перенесены ВНУТРЬ транзакции
  // для закрытия race window (concurrent delete между check и create).
  return prisma.$transaction(async (tx) => {
    // Проверяем существование invoice и D8: валидируем, что возврат не превышает оплаченную сумму
    if (args.invoiceId) {
      const inv = await tx.invoice.findUnique({ where: { id: args.invoiceId }, select: { id: true } });
      if (!inv) throw new HttpError(404, "Счёт не найден", "INVOICE_NOT_FOUND");

      // D8: Вычисляем фактически полученную сумму по счёту из платежей (а не из кеша paidAmount)
      // чтобы не зависеть от своевременности обновления paidAmount.
      const [paymentsSum, refundsSum] = await Promise.all([
        tx.payment.aggregate({
          where: { invoiceId: args.invoiceId, voidedAt: null, direction: "INCOME" },
          _sum: { amount: true },
        }),
        tx.refund.aggregate({
          where: { invoiceId: args.invoiceId },
          _sum: { amount: true },
        }),
      ]);
      const received = new Decimal((paymentsSum._sum.amount ?? 0).toString());
      const alreadyRefunded = new Decimal((refundsSum._sum.amount ?? 0).toString());
      const available = received.sub(alreadyRefunded);
      if (amount.gt(available)) {
        throw new HttpError(422, `Сумма возврата (${amount}) превышает доступную к возврату (${available.toFixed(2)})`, "REFUND_EXCEEDS_PAID_AMOUNT");
      }
    }

    // Проверяем существование payment, если задан
    if (args.paymentId) {
      const pay = await tx.payment.findUnique({ where: { id: args.paymentId }, select: { id: true, amount: true } });
      if (!pay) throw new HttpError(404, "Платёж не найден", "PAYMENT_NOT_FOUND");

      // D8: Проверяем, что сумма возврата не превышает сумму платежа
      const existingRefundsSum = await tx.refund.aggregate({
        where: { paymentId: args.paymentId },
        _sum: { amount: true },
      });
      const alreadyRefunded = new Decimal((existingRefundsSum._sum.amount ?? 0).toString());
      const payAmount = new Decimal(pay.amount.toString());
      const available = payAmount.sub(alreadyRefunded);
      if (amount.gt(available)) {
        throw new HttpError(422, `Сумма возврата (${amount}) превышает доступную к возврату по платежу (${available.toFixed(2)})`, "REFUND_EXCEEDS_PAYMENT_AMOUNT");
      }
    }

    const refund = await tx.refund.create({
      data: {
        invoiceId: args.invoiceId ?? null,
        paymentId: args.paymentId ?? null,
        bookingId: args.bookingId ?? null,
        amount: amount.toDecimalPlaces(2).toString(),
        reason: args.reason.trim(),
        method: args.method,
        refundedAt: args.refundedAt ?? new Date(),
        createdBy: userId,
      },
    });

    await writeAuditEntry({
      tx: tx as TxClient,
      userId,
      action: "REFUND_CREATE",
      entityType: "Payment",
      entityId: refund.id,
      before: null,
      after: diffFields({
        amount: amount.toString(),
        reason: args.reason.trim(),
        method: args.method,
        invoiceId: args.invoiceId ?? null,
        paymentId: args.paymentId ?? null,
        bookingId: args.bookingId ?? null,
      } as Record<string, unknown>),
    });

    // Пересчитываем статус счёта после возврата
    if (args.invoiceId) {
      await recomputeInvoiceStatus(args.invoiceId, tx as TxClient);
    }

    return refund;
  });
}

export async function listRefunds(args: { invoiceId?: string; bookingId?: string; limit?: number; offset?: number }) {
  const limit = Math.min(args.limit ?? 50, 200);
  const offset = args.offset ?? 0;

  const where: Prisma.RefundWhereInput = {};
  if (args.invoiceId) where.invoiceId = args.invoiceId;
  if (args.bookingId) where.bookingId = args.bookingId;

  const [items, total] = await Promise.all([
    prisma.refund.findMany({
      where,
      orderBy: { refundedAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.refund.count({ where }),
  ]);

  return { items, total };
}
