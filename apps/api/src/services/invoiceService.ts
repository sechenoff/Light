import type { InvoiceKind, InvoiceStatus, Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import { Decimal } from "decimal.js";
import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { writeAuditEntry, diffFields } from "./audit";
import { generateInvoiceNumber } from "./numberingService";
import { getSettings } from "./organizationService";

type TxClient = Omit<
  Prisma.TransactionClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends" | "$use"
>;

export interface CreateInvoiceArgs {
  bookingId: string;
  kind: InvoiceKind;
  /** Сумма счёта. Для FULL/BALANCE — вычисляется из брони (estimate.totalAfterDiscount + transport), если не передана. */
  total?: Decimal | number | string;
  dueDate?: Date;
  notes?: string;
}

/**
 * Вычисляет сумму счёта из брони (как в recomputeBookingFinance).
 */
async function computeTotalFromBooking(bookingId: string): Promise<Decimal> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { estimate: true },
  });
  if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");

  const equipmentAfterDiscount = booking.estimate
    ? new Decimal(booking.estimate.totalAfterDiscount.toString())
    : new Decimal(booking.finalAmount.toString());

  const transport = booking.transportSubtotalRub
    ? new Decimal(booking.transportSubtotalRub.toString())
    : new Decimal(0);

  return equipmentAfterDiscount.add(transport);
}

/**
 * Создаёт счёт в статусе DRAFT.
 * Для kind=FULL/BALANCE total вычисляется из брони (если не передан явно).
 * Для kind=DEPOSIT/CORRECTION total обязателен.
 */
export async function createInvoice(args: CreateInvoiceArgs, userId: string) {
  const booking = await prisma.booking.findUnique({ where: { id: args.bookingId } });
  if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");

  // H1: Запрет создания инвойсов для pre-cutoff (legacy) броней
  if (booking.legacyFinance) {
    throw new HttpError(409, "Нельзя создать счёт для старой брони (legacyFinance=true). Используйте прямые платежи.", "LEGACY_BOOKING");
  }

  // H1: Запрет создания инвойсов для отменённых броней
  if (booking.status === "CANCELLED") {
    throw new HttpError(409, "Нельзя создать счёт для отменённой брони", "BOOKING_CANCELLED");
  }

  // H1: Для FULL-счёта — проверяем, что не-VOID FULL инвойс уже не существует
  if (args.kind === "FULL") {
    const existingFull = await prisma.invoice.findFirst({
      where: { bookingId: args.bookingId, kind: "FULL", status: { not: "VOID" } },
      select: { id: true },
    });
    if (existingFull) {
      throw new HttpError(409, "Для этой брони уже существует счёт типа FULL", "FULL_INVOICE_EXISTS");
    }
  }

  // Примечание: для BALANCE — не требуем наличия DEPOSIT (независимый тип, как в спеке Phase 2).
  // TODO Phase 3: добавить проверку наличия DEPOSIT перед BALANCE если бизнес-правило изменится.

  let total: Decimal;
  if (args.total !== undefined) {
    total = new Decimal(args.total.toString());
  } else if (args.kind === "FULL" || args.kind === "BALANCE") {
    total = await computeTotalFromBooking(args.bookingId);
  } else {
    throw new HttpError(400, "Для счёта типа DEPOSIT/CORRECTION необходимо указать сумму", "TOTAL_REQUIRED");
  }

  return prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.create({
      data: {
        // M2: Используем randomUUID вместо Date.now() для стабильного уникального temp-номера.
        // Заменяется реальным номером при issueInvoice.
        number: `DRAFT-${randomUUID()}`,
        bookingId: args.bookingId,
        kind: args.kind,
        status: "DRAFT",
        total: total.toDecimalPlaces(2).toString(),
        paidAmount: "0",
        dueDate: args.dueDate ?? null,
        notes: args.notes ?? null,
        createdBy: userId,
      },
    });

    await writeAuditEntry({
      tx: tx as TxClient,
      userId,
      action: "INVOICE_CREATE",
      entityType: "Invoice", // L4: правильный тип сущности
      entityId: invoice.id,
      before: null,
      after: diffFields({
        bookingId: args.bookingId,
        kind: args.kind,
        total: total.toString(),
        status: "DRAFT",
        dueDate: args.dueDate?.toISOString() ?? null,
      } as Record<string, unknown>),
    });

    return invoice;
  });
}

/**
 * Переводит счёт из DRAFT в ISSUED.
 * Генерирует уникальный номер (LR-YYYY-NNNN).
 * Устанавливает issuedAt.
 */
export async function issueInvoice(invoiceId: string, userId: string) {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new HttpError(404, "Счёт не найден", "INVOICE_NOT_FOUND");
  // L3: Идемпотентность — если счёт уже выставлен, возвращаем без ошибки
  if (invoice.status === "ISSUED") {
    // Уже выставлен — идемпотентный ответ
    return invoice;
  }
  if (invoice.status !== "DRAFT") {
    throw new HttpError(409, "Можно выставить только счёт в статусе DRAFT", "INVOICE_NOT_DRAFT");
  }

  // M5: generateInvoiceNumber вызывается ДО транзакции, потому что он сам открывает
  // собственный prisma.$transaction. Вложенные интерактивные транзакции в Prisma SQLite
  // не поддерживаются — они вызывают дедлок или таймаут соединения.
  // Гонка обрабатывается через retry в generateInvoiceNumber (P2002 → повтор), а
  // итоговая запись числа + обновление статуса атомарны через tx.invoice.update.
  const settings = await getSettings();
  const now = new Date();
  const number = await generateInvoiceNumber(settings.invoiceNumberPrefix, now.getFullYear());

  return prisma.$transaction(async (tx) => {
    const updated = await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        number,
        status: "ISSUED",
        issuedAt: now,
      },
    });

    await writeAuditEntry({
      tx: tx as TxClient,
      userId,
      action: "INVOICE_ISSUE",
      entityType: "Invoice",
      entityId: invoiceId,
      before: diffFields({ status: "DRAFT", number: invoice.number } as Record<string, unknown>),
      after: diffFields({ status: "ISSUED", number, issuedAt: now.toISOString() } as Record<string, unknown>),
    });

    return updated;
  });
}

/**
 * Аннулирует счёт (любой статус кроме VOID).
 * Номер сохраняется. Требует обязательную причину.
 */
export async function voidInvoice(invoiceId: string, reason: string, userId: string) {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new HttpError(404, "Счёт не найден", "INVOICE_NOT_FOUND");
  if (invoice.status === "VOID") {
    throw new HttpError(409, "Счёт уже аннулирован", "INVOICE_ALREADY_VOID");
  }
  if (!reason || reason.trim().length < 3) {
    throw new HttpError(400, "Причина аннулирования обязательна (минимум 3 символа)", "VOID_REASON_REQUIRED");
  }

  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const updated = await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        status: "VOID",
        voidedAt: now,
        voidedBy: userId,
        voidReason: reason.trim(),
      },
    });

    await writeAuditEntry({
      tx: tx as TxClient,
      userId,
      action: "INVOICE_VOID",
      entityType: "Invoice",
      entityId: invoiceId,
      before: diffFields({ status: invoice.status, number: invoice.number } as Record<string, unknown>),
      after: diffFields({ status: "VOID", voidReason: reason.trim(), voidedAt: now.toISOString() } as Record<string, unknown>),
    });

    return updated;
  });
}

/**
 * Пересчитывает paidAmount и status счёта на основе привязанных платежей.
 * paidAmount = sum(payments WHERE voidedAt IS NULL) — sum(refunds)
 * status:
 *   - VOID → не меняем
 *   - paidAmount >= total → PAID
 *   - paidAmount > 0 → PARTIAL_PAID
 *   - dueDate < now AND paidAmount < total → OVERDUE
 *   - иначе → ISSUED (или DRAFT если ещё не выставлен)
 *
 * M3: Overpay (paidAmount > total) коллапсирует в PAID.
 * TODO Phase 3: Добавить поле overpaidBy на Invoice для surfacing переплаты.
 */
export async function recomputeInvoiceStatus(invoiceId: string, txArg?: TxClient) {
  const tx = txArg ?? prisma;

  const invoice = await tx.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      payments: { where: { voidedAt: null } },
      refunds: true,
    },
  });

  if (!invoice) return null;
  if (invoice.status === "VOID") return invoice;

  const total = new Decimal(invoice.total.toString());
  const paymentsSum = invoice.payments.reduce(
    (acc, p) => acc.add(new Decimal(p.amount.toString())),
    new Decimal(0),
  );
  const refundsSum = invoice.refunds.reduce(
    (acc, r) => acc.add(new Decimal(r.amount.toString())),
    new Decimal(0),
  );

  const paidAmount = Decimal.max(paymentsSum.sub(refundsSum), new Decimal(0));

  let status: InvoiceStatus;
  if (paidAmount.greaterThanOrEqualTo(total) && total.greaterThan(0)) {
    status = "PAID";
  } else if (paidAmount.greaterThan(0)) {
    status = "PARTIAL_PAID";
  } else if (invoice.dueDate && invoice.dueDate.getTime() < Date.now() && paidAmount.lessThan(total)) {
    status = "OVERDUE";
  } else if (invoice.issuedAt) {
    status = "ISSUED";
  } else {
    status = "DRAFT";
  }

  return tx.invoice.update({
    where: { id: invoiceId },
    data: {
      paidAmount: paidAmount.toDecimalPlaces(2).toString(),
      status,
    },
  });
}

/**
 * Обновляет редактируемые поля счёта в статусе DRAFT.
 */
export async function updateInvoice(
  invoiceId: string,
  patch: { dueDate?: Date | null; notes?: string | null; total?: Decimal | number | string },
  userId: string,
) {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new HttpError(404, "Счёт не найден", "INVOICE_NOT_FOUND");
  if (invoice.status !== "DRAFT") {
    throw new HttpError(409, "Редактировать можно только счёт в статусе DRAFT", "INVOICE_NOT_DRAFT");
  }

  return prisma.$transaction(async (tx) => {
    const data: Prisma.InvoiceUpdateInput = {};
    if (patch.dueDate !== undefined) data.dueDate = patch.dueDate;
    if (patch.notes !== undefined) data.notes = patch.notes;
    if (patch.total !== undefined) data.total = new Decimal(patch.total.toString()).toDecimalPlaces(2).toString();

    const updated = await tx.invoice.update({ where: { id: invoiceId }, data });

    await writeAuditEntry({
      tx: tx as TxClient,
      userId,
      action: "INVOICE_UPDATE",
      entityType: "Invoice",
      entityId: invoiceId,
      before: diffFields({ dueDate: invoice.dueDate?.toISOString() ?? null, notes: invoice.notes, total: invoice.total.toString() } as Record<string, unknown>),
      after: diffFields({ dueDate: updated.dueDate?.toISOString() ?? null, notes: updated.notes, total: updated.total.toString() } as Record<string, unknown>),
    });

    return updated;
  });
}
