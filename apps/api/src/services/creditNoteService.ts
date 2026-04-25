import type { Prisma } from "@prisma/client";
import { Decimal } from "decimal.js";
import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { writeAuditEntry, diffFields } from "./audit";
import { recomputeBookingFinance } from "./finance";
import { recomputeInvoiceStatus } from "./invoiceService";

type TxClient = Omit<
  Prisma.TransactionClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends" | "$use"
>;

export interface CreateCreditNoteArgs {
  contactClientId: string;
  bookingId?: string;
  amount: Decimal | number | string;
  reason: string;
  expiresAt?: Date;
}

/**
 * Создаёт кредит-ноту.
 * remaining = amount изначально (полная сумма доступна для применения).
 */
export async function createCreditNote(args: CreateCreditNoteArgs, userId: string) {
  if (!args.reason || args.reason.trim().length < 3) {
    throw new HttpError(400, "Причина обязательна (минимум 3 символа)", "CREDIT_NOTE_REASON_REQUIRED");
  }

  const amount = new Decimal(args.amount.toString());
  if (amount.lessThanOrEqualTo(0)) {
    throw new HttpError(400, "Сумма кредит-ноты должна быть больше 0", "CREDIT_NOTE_AMOUNT_INVALID");
  }

  // Проверяем наличие клиента
  const client = await prisma.client.findUnique({ where: { id: args.contactClientId } });
  if (!client) throw new HttpError(404, "Клиент не найден", "CLIENT_NOT_FOUND");

  return prisma.$transaction(async (tx) => {
    const note = await tx.creditNote.create({
      data: {
        contactClientId: args.contactClientId,
        bookingId: args.bookingId ?? null,
        amount: amount.toDecimalPlaces(2).toString(),
        remaining: amount.toDecimalPlaces(2).toString(),
        reason: args.reason.trim(),
        expiresAt: args.expiresAt ?? null,
        createdBy: userId,
      },
    });

    await writeAuditEntry({
      tx: tx as TxClient,
      userId,
      action: "CREDIT_NOTE_CREATE",
      entityType: "CreditNote",
      entityId: note.id,
      before: null,
      after: diffFields({
        contactClientId: args.contactClientId,
        bookingId: args.bookingId ?? null,
        amount: amount.toString(),
        reason: args.reason.trim(),
      } as Record<string, unknown>),
    });

    return note;
  });
}

/**
 * Применяет кредит-ноту к брони.
 * Phase 2 — full apply only (partial defer).
 * Проверяет что remaining > 0, ставит appliedAt + appliedToBookingId.
 */
export async function applyCreditNote(noteId: string, applyToBookingId: string, userId: string) {
  const note = await prisma.creditNote.findUnique({ where: { id: noteId } });
  if (!note) throw new HttpError(404, "Кредит-нота не найдена", "CREDIT_NOTE_NOT_FOUND");

  const remaining = new Decimal(note.remaining.toString());
  if (remaining.lessThanOrEqualTo(0)) {
    throw new HttpError(409, "Кредит-нота уже применена (remaining = 0)", "CREDIT_NOTE_EXHAUSTED");
  }

  if (note.appliedToBookingId) {
    throw new HttpError(409, "Кредит-нота уже применена к другой броне", "CREDIT_NOTE_ALREADY_APPLIED");
  }

  // Проверяем наличие брони
  const booking = await prisma.booking.findUnique({ where: { id: applyToBookingId } });
  if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");

  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const updated = await tx.creditNote.update({
      where: { id: noteId },
      data: {
        remaining: "0",
        appliedToBookingId: applyToBookingId,
        appliedAt: now,
      },
    });

    // Ищем первый открытый счёт у брони для привязки синтетического платежа
    const openInvoice = await tx.invoice.findFirst({
      where: {
        bookingId: applyToBookingId,
        status: { in: ["DRAFT", "ISSUED", "PARTIAL_PAID", "OVERDUE"] },
      },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });

    // Создаём синтетический платёж на сумму кредит-ноты
    // Метод OTHER используется для типа CREDIT_NOTE — добавление enum CREDIT_NOTE отложено до Phase 3
    const syntheticPayment = await tx.payment.create({
      data: {
        bookingId: applyToBookingId,
        amount: remaining.toDecimalPlaces(2).toString(),
        method: "OTHER",
        paymentMethod: "OTHER",
        receivedAt: now,
        paymentDate: now,
        note: `Кредит-нота ${noteId}: ${note.reason}`,
        comment: `Кредит-нота ${noteId}: ${note.reason}`,
        createdBy: userId,
        invoiceId: openInvoice?.id ?? null,
        direction: "INCOME",
        status: "RECEIVED",
      },
    });

    // Пересчитываем финансы брони
    await recomputeBookingFinance(applyToBookingId, tx as TxClient);

    // Пересчитываем статус счёта, если привязан
    if (openInvoice) {
      await recomputeInvoiceStatus(openInvoice.id, tx as TxClient);
    }

    await writeAuditEntry({
      tx: tx as TxClient,
      userId,
      action: "CREDIT_NOTE_APPLY",
      entityType: "CreditNote",
      entityId: noteId,
      before: diffFields({ remaining: note.remaining.toString(), appliedToBookingId: null } as Record<string, unknown>),
      after: diffFields({
        remaining: "0",
        appliedToBookingId: applyToBookingId,
        appliedAt: now.toISOString(),
        syntheticPaymentId: syntheticPayment.id,
      } as Record<string, unknown>),
    });

    await writeAuditEntry({
      tx: tx as TxClient,
      userId,
      action: "PAYMENT_CREATE_FROM_CREDIT",
      entityType: "CreditNote",
      entityId: syntheticPayment.id,
      before: null,
      after: diffFields({
        creditNoteId: noteId,
        bookingId: applyToBookingId,
        amount: remaining.toString(),
        invoiceId: openInvoice?.id ?? null,
      } as Record<string, unknown>),
    });

    return updated;
  });
}

export async function listCreditNotes(args: { contactClientId?: string; bookingId?: string; limit?: number; offset?: number }) {
  const limit = Math.min(args.limit ?? 50, 200);
  const offset = args.offset ?? 0;

  const where: Prisma.CreditNoteWhereInput = {};
  if (args.contactClientId) where.contactClientId = args.contactClientId;
  if (args.bookingId) where.bookingId = args.bookingId;

  const [items, total] = await Promise.all([
    prisma.creditNote.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.creditNote.count({ where }),
  ]);

  return { items, total };
}
