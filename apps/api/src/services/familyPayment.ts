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

type Db = Parameters<typeof loadFamily>[0];

/**
 * Живые брони семьи (без отменённых и архива) — в порядке создания, с долгом.
 * Бронь, где вводят платёж, в списке всегда: туда ложится остаток.
 */
async function familyMembersWithDebt(client: Db, bookingId: string) {
  const booking = await client.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, rootBookingId: true, deletedAt: true, status: true },
  });
  if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
  if (booking.deletedAt) {
    throw new HttpError(409, "Бронь в архиве — платёж записать нельзя. Сначала восстановите её из архива.", "BOOKING_ARCHIVED");
  }
  if (booking.status === "CANCELLED") {
    throw new HttpError(409, "Бронь отменена — платёж по семье на неё не разносится", "PAYMENT_SPREAD_CANCELLED_TARGET");
  }
  const family = (await loadFamily(client, booking)).filter((m) => m.status !== "CANCELLED" && m.deletedAt == null);
  const money = await client.booking.findMany({
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
  const { members } = await familyMembersWithDebt(prisma, bookingId);
  return { parts: planFamilyPayment(members, amount, bookingId), members: members.length };
}

/** Предел частей одного платежа — не больше броней в семье разумного размера. */
const MAX_PARTS = 100;

/**
 * Id частей платежа от ключа отправки — не от разбивки: при повторе после сбоя
 * долги уже изменились, и новая разбивка дала бы другие брони и другие id.
 * Повтор узнаётся по первой части, а возвращаются все.
 */
function partId(createdBy: string, requestKey: string, index: number): string {
  return `idem_${createHash("sha256").update(`${createdBy}:${requestKey}:family:${index}`).digest("hex")}`;
}

async function replayFamilyPayment(args: {
  requestKey: string;
  createdBy: string;
  method: PaymentMethod;
  receivedAt: Date;
}): Promise<Payment[] | null> {
  const first = await prisma.payment.findUnique({ where: { id: partId(args.createdBy, args.requestKey, 0) } });
  if (!first) return null;
  if (first.createdBy !== args.createdBy || first.method !== args.method || first.receivedAt?.getTime() !== args.receivedAt.getTime()) {
    throw new HttpError(409, "Этот платёж уже обрабатывался с другими данными. Проверьте журнал платежей.", "PAYMENT_REQUEST_CONFLICT");
  }
  const ids = Array.from({ length: MAX_PARTS }, (_, i) => partId(args.createdBy, args.requestKey, i));
  const parts = await prisma.payment.findMany({ where: { id: { in: ids } } });
  return ids.map((id) => parts.find((p) => p.id === id)).filter((p): p is Payment => p != null);
}

/**
 * Записать платёж, разнесённый по семье. Разбивка считается внутри
 * транзакции записи — по текущим долгам; сумма частей обязана совпасть с
 * введённой. `requestKey` — от повтора одной и той же отправки.
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
  if (total.decimalPlaces() > 2) {
    throw new HttpError(400, "Сумма — с точностью до копеек", "PAYMENT_AMOUNT_PRECISION");
  }
  if (args.requestKey) {
    const previous = await replayFamilyPayment({ ...args, requestKey: args.requestKey });
    if (previous) return previous;
  }
  const role: UserRole = args.creatorRole ?? "SUPER_ADMIN";
  const auditAction = role === "WAREHOUSE" ? "PAYMENT_CREATE_BY_WH" : "PAYMENT_CREATE";

  try {
    return await prisma.$transaction(async (tx) => {
      const { booking, members } = await familyMembersWithDebt(tx, args.bookingId);
      validateWhLimits(role, { method: args.method, amount: total }, { status: booking.status });
      const parts = planFamilyPayment(members, total, args.bookingId);
      const sum = parts.reduce((s, p) => s.add(p.amount), new Decimal(0));
      if (!sum.equals(total) || parts.length > MAX_PARTS) {
        throw new HttpError(500, "Не удалось разложить платёж по броням семьи", "PAYMENT_SPREAD_MISMATCH");
      }
      const group = parts.length > 1 ? parts.map((p) => p.docNumber ?? p.bookingId.slice(-6)).join(" + ") : null;
      const created: Payment[] = [];
      for (const [index, part] of parts.entries()) {
        const note = [args.note?.trim() || null, group ? `один платёж на ${group}` : null].filter(Boolean).join(" · ") || null;
        const payment = await tx.payment.create({
          data: {
            ...(args.requestKey ? { id: partId(args.createdBy, args.requestKey, index) } : {}),
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
  } catch (error) {
    // Две одинаковые отправки одновременно: вторая упирается в id первой части.
    if (args.requestKey && (error as { code?: string }).code === "P2002") {
      const concurrent = await replayFamilyPayment({ ...args, requestKey: args.requestKey });
      if (concurrent) return concurrent;
    }
    throw error;
  }
}
