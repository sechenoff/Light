/**
 * «Разнести по продолжениям»: один платёж клиента на всю семью броней.
 *
 * У основной брони и каждого продолжения свои деньги и свой долг. Клиент же
 * часто платит одним переводом за всё. Здесь один ввод превращается в
 * несколько платежей — по одному на бронь с долгом, начиная со старшей
 * (основной), одной транзакцией. Что осталось после всех долгов — переплата
 * на ту бронь, где вводили платёж.
 *
 * Лимиты кладовщика (наличные или карта, не больше 100 000 ₽, бронь выдана
 * или возвращена) проверяются по ВСЕЙ сумме и по броне, где вводили платёж:
 * разбивка на части не должна обходить лимит одного платежа.
 */
import { createHash } from "node:crypto";
import { Decimal } from "decimal.js";
import type { Payment, PaymentMethod, UserRole } from "@prisma/client";

import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { writeAuditEntry, diffFields } from "./audit";
import { recomputeBookingFinance } from "./finance";
import { validateWhLimits } from "./paymentService";
import { loadFamily } from "./bookingFamily";

export type FamilyPaymentPart = { bookingId: string; docNumber: string | null; amount: string };

/**
 * Как разложить сумму по семье: долги от старшей брони к младшей, остаток —
 * на бронь, где вводили платёж. Чистая функция — её же показывает окно оплаты.
 */
export function planFamilyPayment(
  members: ReadonlyArray<{ id: string; docNumber: string | null; amountOutstanding: Decimal | string | number }>,
  total: Decimal,
  targetBookingId: string,
): FamilyPaymentPart[] {
  let left = new Decimal(total);
  const parts = new Map<string, Decimal>();
  for (const m of members) {
    if (left.lte(0)) break;
    const owed = Decimal.max(0, new Decimal(m.amountOutstanding.toString()));
    if (owed.lte(0)) continue;
    const take = Decimal.min(owed, left);
    parts.set(m.id, (parts.get(m.id) ?? new Decimal(0)).add(take));
    left = left.sub(take);
  }
  if (left.gt(0)) parts.set(targetBookingId, (parts.get(targetBookingId) ?? new Decimal(0)).add(left));
  return members
    .filter((m) => parts.has(m.id))
    .map((m) => ({ bookingId: m.id, docNumber: m.docNumber, amount: parts.get(m.id)!.toDecimalPlaces(2).toFixed(2) }));
}

/** Живые брони семьи (без отменённых и архива) — в порядке создания, с долгом. */
async function familyMembersWithDebt(bookingId: string) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, rootBookingId: true, deletedAt: true, status: true },
  });
  if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
  if (booking.deletedAt) {
    throw new HttpError(409, "Бронь в архиве — платёж записать нельзя. Сначала восстановите её из архива.", "BOOKING_ARCHIVED");
  }
  const family = (await loadFamily(prisma, booking)).filter((m) => m.status !== "CANCELLED" && m.deletedAt == null);
  const money = await prisma.booking.findMany({
    where: { id: { in: family.map((m) => m.id) } },
    select: { id: true, amountOutstanding: true },
  });
  const owed = new Map(money.map((m) => [m.id, m.amountOutstanding]));
  return {
    booking,
    members: family.map((m) => ({ id: m.id, docNumber: m.docNumber, amountOutstanding: owed.get(m.id) ?? new Decimal(0) })),
  };
}

/** Превью разбивки для окна оплаты. */
export async function previewFamilyPayment(bookingId: string, amount: Decimal) {
  const { members } = await familyMembersWithDebt(bookingId);
  return { parts: planFamilyPayment(members, amount, bookingId), members: members.length };
}

/**
 * Записать платёж, разнесённый по семье. `requestKey` — от повтора одной и той
 * же отправки: каждая часть получает свой детерминированный id.
 */
export async function createFamilyPayment(args: {
  requestKey?: string;
  bookingId: string;
  amount: Decimal | number | string;
  method: PaymentMethod;
  receivedAt: Date;
  note?: string;
  createdBy: string;
  creatorRole?: UserRole;
}): Promise<Payment[]> {
  const total = new Decimal(args.amount.toString());
  const { booking, members } = await familyMembersWithDebt(args.bookingId);
  const role: UserRole = args.creatorRole ?? "SUPER_ADMIN";
  validateWhLimits(role, { method: args.method, amount: total }, { status: booking.status });
  const parts = planFamilyPayment(members, total, args.bookingId);
  const idOf = (bookingId: string) =>
    args.requestKey
      ? `idem_${createHash("sha256").update(`${args.createdBy}:${args.requestKey}:${bookingId}`).digest("hex")}`
      : undefined;

  // Повтор той же отправки — вернуть уже записанное, а не платить второй раз.
  if (args.requestKey) {
    const existing = await prisma.payment.findMany({ where: { id: { in: parts.map((p) => idOf(p.bookingId)!) } } });
    if (existing.length > 0) return existing;
  }
  const group = parts.length > 1 ? parts.map((p) => p.docNumber ?? p.bookingId.slice(-6)).join(" + ") : null;
  const auditAction = role === "WAREHOUSE" ? "PAYMENT_CREATE_BY_WH" : "PAYMENT_CREATE";

  return prisma.$transaction(async (tx) => {
    const created: Payment[] = [];
    for (const part of parts) {
      const note = [args.note?.trim() || null, group ? `один платёж на ${group}` : null].filter(Boolean).join(" · ") || null;
      const id = idOf(part.bookingId);
      const payment = await tx.payment.create({
        data: {
          ...(id ? { id } : {}),
          bookingId: part.bookingId,
          amount: new Decimal(part.amount),
          method: args.method,
          receivedAt: args.receivedAt,
          note,
          createdBy: args.createdBy,
          paymentMethod: args.method,
          paymentDate: args.receivedAt,
          comment: note,
          direction: "INCOME",
          status: "RECEIVED",
        },
      });
      await recomputeBookingFinance(part.bookingId, tx);
      await writeAuditEntry({
        tx,
        userId: args.createdBy,
        action: auditAction,
        entityType: "Payment",
        entityId: payment.id,
        before: null,
        after: diffFields({
          ...payment,
          amount: payment.amount.toString(),
          bookingId: part.bookingId,
          spreadFrom: args.bookingId,
          spreadTotal: total.toFixed(2),
        } as Record<string, unknown>),
      });
      created.push(payment);
    }
    return created;
  });
}
