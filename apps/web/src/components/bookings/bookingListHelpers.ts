/**
 * bookingListHelpers.ts — чистые хелперы для списка броней (/bookings).
 *
 * Здесь живёт всё, что не требует React: сериализация фильтров в URL,
 * семантика пилюли оплаты (согласована с глоссарием финансовых терминов
 * src/lib/financeTerms.ts — «Оплачено» / «Частично» / «Не оплачено», как на
 * /finance/payments и /finance/debts), форматирование периода брони.
 */

import { formatRub, pluralize } from "../../lib/format";

// ── Статусы брони ────────────────────────────────────────────────────────────

export const BOOKING_STATUSES = [
  "DRAFT",
  "PENDING_APPROVAL",
  "CONFIRMED",
  "ISSUED",
  "RETURNED",
  "CANCELLED",
] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];
export type BookingPaymentStatus = "NOT_PAID" | "PARTIALLY_PAID" | "PAID" | "OVERDUE";

// ── Фильтры списка ↔ URL ────────────────────────────────────────────────────

export type BookingListFilters = {
  status: string;
  paid: "" | "PAID" | "UNPAID";
  from: string;
  to: string;
  q: string;
};

/**
 * Читает фильтры из query-параметров (расшариваемая ссылка / F5 / «назад»).
 * Невалидные значения тихо отбрасываются, чтобы мусорная ссылка не давала
 * 400 от серверной Zod-валидации `?status=`.
 */
export function readListFiltersFromParams(
  params: { get(name: string): string | null } | null
): BookingListFilters {
  const statusRaw = params?.get("status") ?? "";
  const paidRaw = params?.get("paid") ?? "";
  return {
    status: (BOOKING_STATUSES as readonly string[]).includes(statusRaw) ? statusRaw : "",
    paid: paidRaw === "PAID" || paidRaw === "UNPAID" ? paidRaw : "",
    from: params?.get("from") ?? "",
    to: params?.get("to") ?? "",
    q: params?.get("q") ?? "",
  };
}

/** Сериализует фильтры в query-string (пустые значения опускаются). */
export function filtersToQueryString(f: BookingListFilters): string {
  const p = new URLSearchParams();
  if (f.status) p.set("status", f.status);
  if (f.paid) p.set("paid", f.paid);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.q.trim()) p.set("q", f.q.trim());
  return p.toString();
}

// ── Даты ─────────────────────────────────────────────────────────────────────

const MSK_DDMM: Intl.DateTimeFormatOptions = {
  day: "2-digit",
  month: "2-digit",
  timeZone: "Europe/Moscow",
};

const MSK_DDMMYYYY: Intl.DateTimeFormatOptions = { ...MSK_DDMM, year: "numeric" };

/** Дата смены (startDate) — день, когда оборудование нужно клиенту. */
export function formatShiftDate(startDate: string): string {
  return new Date(startDate).toLocaleDateString("ru-RU", MSK_DDMMYYYY);
}

/**
 * Период брони «дд.мм — дд.мм.гггг» (начало — возврат). Однодневная бронь —
 * одиночная дата; при разных годах год показывается у обеих дат.
 */
export function formatBookingPeriod(startDate: string, endDate: string): string {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const startFull = start.toLocaleDateString("ru-RU", MSK_DDMMYYYY);
  const endFull = end.toLocaleDateString("ru-RU", MSK_DDMMYYYY);
  if (startFull === endFull) return startFull;
  const sameYear =
    start.toLocaleDateString("ru-RU", { year: "numeric", timeZone: "Europe/Moscow" }) ===
    end.toLocaleDateString("ru-RU", { year: "numeric", timeZone: "Europe/Moscow" });
  const startPart = sameYear ? start.toLocaleDateString("ru-RU", MSK_DDMM) : startFull;
  return `${startPart} — ${endFull}`;
}

// ── Оплата ───────────────────────────────────────────────────────────────────

/** Сколько дней прошло с ожидаемой даты оплаты. 0 если не наступила/не задана. */
export function daysOverdue(expectedPaymentDate: string | null, nowMs: number = Date.now()): number {
  if (!expectedPaymentDate) return 0;
  const expectedMs = new Date(expectedPaymentDate).getTime();
  if (!Number.isFinite(expectedMs) || nowMs <= expectedMs) return 0;
  return Math.floor((nowMs - expectedMs) / (1000 * 60 * 60 * 24));
}

export type PaymentPillInfo = {
  variant: "ok" | "warn" | "alert" | "none";
  label: string;
  /** Доп. строка для частичной оплаты: «40 000 ₽ из 100 000 ₽». */
  sub: string | null;
};

export type PaymentPillInput = {
  paymentStatus: BookingPaymentStatus;
  amountPaid: string;
  amountOutstanding: string;
  finalAmount: string;
  expectedPaymentDate: string | null;
};

/**
 * Семантика пилюли оплаты (термины — как на /finance, см. financeTerms.ts):
 *  - PAID → «Оплачено» (emerald);
 *  - внесено частично (amountPaid > 0 и amountOutstanding > 0) → «Частично»
 *    (amber) + суммы «N из M» — клиент с 90% предоплаты больше не выглядит
 *    как не заплативший ни рубля;
 *  - иначе «Не оплачено»; просрочка (серверный OVERDUE или прошедшая
 *    expectedPaymentDate) красит в rose.
 */
export function paymentPill(r: PaymentPillInput, nowMs: number = Date.now()): PaymentPillInfo {
  if (r.paymentStatus === "PAID") {
    return { variant: "ok", label: "Оплачено", sub: null };
  }
  const paid = Number(r.amountPaid ?? "0");
  const outstanding = Number(r.amountOutstanding ?? "0");
  if (paid > 0 && outstanding > 0) {
    return {
      variant: "warn",
      label: "Частично",
      sub: `${formatRub(r.amountPaid)} из ${formatRub(r.finalAmount)}`,
    };
  }
  const isOverdue = r.paymentStatus === "OVERDUE" || daysOverdue(r.expectedPaymentDate, nowMs) > 0;
  return { variant: isOverdue ? "alert" : "none", label: "Не оплачено", sub: null };
}

/** Тултип строки брони: просрочка / срок оплаты / статус. */
export function paymentTooltip(r: PaymentPillInput, nowMs: number = Date.now()): string {
  if (r.paymentStatus === "PAID") return "Платёж получен";
  const overdue = daysOverdue(r.expectedPaymentDate, nowMs);
  if (overdue > 0) {
    return `Просрочено на ${overdue} ${pluralize(overdue, "день", "дня", "дней")}`;
  }
  if (r.expectedPaymentDate) {
    const dateStr = new Date(r.expectedPaymentDate).toLocaleDateString("ru-RU", MSK_DDMMYYYY);
    return `Срок оплаты: ${dateStr}`;
  }
  const paid = Number(r.amountPaid ?? "0");
  const outstanding = Number(r.amountOutstanding ?? "0");
  if (paid > 0 && outstanding > 0) return "Частично оплачено";
  return "Не оплачено";
}
