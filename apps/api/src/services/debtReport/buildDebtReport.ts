/**
 * Отчёт по задолженности для сотрудника, который её взыскивает.
 *
 * Руководитель отмечает нужные брони в реестре долгов и жмёт «Сформировать
 * отчёт» — сюда приходит список `bookingIds`. Дальше это рабочий документ
 * обзвона: клиенты сверху вниз по остроте долга, у каждого свои проекты,
 * у каждого проекта — выставлено / оплачено / остаток, срок и просрочка,
 * и пустая графа, куда сотрудник пишет ручкой результат разговора.
 *
 * Данные перечитываются из базы, а не приходят с клиента: между открытием
 * страницы и нажатием кнопки долг мог быть погашен, и печатать его как
 * «к взысканию» — худшее, что может сделать такой документ.
 */
import Decimal from "decimal.js";

import { prisma } from "../../prisma";
import { HttpError } from "../../utils/errors";
import { getSettings } from "../organizationService";
import { isBookingOverdue } from "../finance";

/** Долг считается «старым» с этого порога — в документе он выделяется. */
export const OVER_AGED_DAYS = 60;

export interface DebtReportRow {
  bookingId: string;
  docNumber: string | null;
  projectName: string;
  startDate: Date | null;
  endDate: Date | null;
  /** Выставлено по брони (с надбавками и транспортом). */
  finalAmount: Decimal;
  amountPaid: Decimal;
  /** Прощённый остаток — без него «выставлено − оплачено» не сходится с остатком. */
  writeOffAmount: Decimal;
  outstanding: Decimal;
  expectedPaymentDate: Date | null;
  /** Дней просрочки; null — срок не наступил или не задан. */
  daysOverdue: number | null;
  isOverdue: boolean;
  paymentStatus: string;
  bookingStatus: string;
}

export interface DebtReportClient {
  clientId: string;
  clientName: string;
  /** Юр. имя из карточки клиента — если заполнено, в шапке группы печатается оно. */
  legalName: string | null;
  phone: string | null;
  email: string | null;
  rows: DebtReportRow[];
  total: Decimal;
  overdue: Decimal;
  maxDaysOverdue: number;
}

export interface DebtReportDocument {
  title: string;
  /** Дата, на которую собраны данные. */
  asOf: Date;
  note: string | null;
  includeContacts: boolean;
  org: { name: string | null; phone: string | null; email: string | null };
  clients: DebtReportClient[];
  totals: {
    clientsCount: number;
    bookingsCount: number;
    total: Decimal;
    overdue: Decimal;
    overAged: Decimal;
    overAgedCount: number;
  };
  /** Отмеченные брони, которых нет в отчёте, — с причиной для каждой. */
  skipped: SkippedBooking[];
}

/**
 * Почему отмеченная бронь не попала в документ. Различать обязательно:
 * «погашено» — хорошая новость, «отменена» и «в архиве» — повод проверить,
 * не потеряли ли долг. Валить всё в одну корзину значит печатать отчёт,
 * который молча короче, чем показывала панель, и не объяснять почему.
 */
export type SkipReason = "PAID" | "CANCELLED" | "ARCHIVED" | "NOT_FOUND";

export interface SkippedBooking {
  bookingId: string;
  reason: SkipReason;
}

const SKIP_REASON_LABELS: Record<SkipReason, { one: string; few: string; many: string }> = {
  PAID: { one: "уже погашен", few: "уже погашены", many: "уже погашены" },
  CANCELLED: { one: "отменён", few: "отменены", many: "отменены" },
  ARCHIVED: { one: "в архиве", few: "в архиве", many: "в архиве" },
  NOT_FOUND: { one: "не найден", few: "не найдены", many: "не найдены" },
};

function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/**
 * Человеческая фраза про отсеянное — уходит в заголовок ответа и всплывает
 * тостом рядом с документом: «2 долга не попали в отчёт: уже погашены».
 */
export function describeSkipped(skipped: SkippedBooking[]): string | null {
  if (skipped.length === 0) return null;
  const byReason = new Map<SkipReason, number>();
  for (const s of skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
  const parts = Array.from(byReason.entries()).map(([reason, count]) => {
    const l = SKIP_REASON_LABELS[reason];
    return `${count} — ${pluralRu(count, l.one, l.few, l.many)}`;
  });
  const total = skipped.length;
  const noun = pluralRu(total, "долг", "долга", "долгов");
  return `${total} ${noun} не ${pluralRu(total, "попал", "попали", "попали")} в отчёт: ${parts.join(", ")}`;
}

export interface BuildDebtReportArgs {
  bookingIds: string[];
  title?: string | null;
  note?: string | null;
  includeContacts?: boolean;
  /** Подставляется в «по состоянию на»; по умолчанию — сейчас. */
  asOf?: Date;
}

export const DEFAULT_REPORT_TITLE = "Реестр задолженности";

/** Статусы броней, по которым долг вообще взыскивается (зеркало computeDebts). */
const DEBT_BOOKING_STATUSES = ["CONFIRMED", "ISSUED", "RETURNED"] as const;

const dec = (v: { toString(): string } | null | undefined): Decimal =>
  new Decimal((v ?? 0).toString());

export async function buildDebtReport(args: BuildDebtReportArgs): Promise<DebtReportDocument> {
  const ids = Array.from(new Set(args.bookingIds.filter((id) => typeof id === "string" && id.length > 0)));
  if (ids.length === 0) throw new HttpError(400, "Не выбрано ни одной брони", "DEBT_REPORT_EMPTY");

  const asOf = args.asOf ?? new Date();
  const bookings = await prisma.booking.findMany({
    where: { id: { in: ids } },
    include: {
      client: { select: { id: true, name: true, legalName: true, phone: true, email: true } },
    },
  });

  const found = new Map(bookings.map((b) => [b.id, b]));
  const skipped: SkippedBooking[] = [];
  const byClient = new Map<string, DebtReportClient>();

  for (const id of ids) {
    const b = found.get(id);
    if (!b) {
      skipped.push({ bookingId: id, reason: "NOT_FOUND" });
      continue;
    }
    const outstanding = dec(b.amountOutstanding);
    // Бронь могли погасить, отменить или убрать в архив, пока руководитель
    // собирал отчёт. Причину различаем: архивная бронь с живым долгом — это
    // не «погашено», и печатать так значило бы потерять долг из виду.
    const skipReason: SkipReason | null =
      b.deletedAt !== null
        ? "ARCHIVED"
        : !(DEBT_BOOKING_STATUSES as readonly string[]).includes(b.status)
          ? "CANCELLED"
          : !outstanding.gt(0)
            ? "PAID"
            : null;
    if (skipReason) {
      skipped.push({ bookingId: id, reason: skipReason });
      continue;
    }

    const daysOverdue = b.expectedPaymentDate
      ? Math.floor((asOf.getTime() - b.expectedPaymentDate.getTime()) / 86_400_000)
      : null;
    const overdue = isBookingOverdue(b, asOf);

    const row: DebtReportRow = {
      bookingId: b.id,
      docNumber: b.docNumber ?? null,
      projectName: b.projectName,
      startDate: b.startDate ?? null,
      endDate: b.endDate ?? null,
      finalAmount: dec(b.finalAmount),
      amountPaid: dec(b.amountPaid),
      writeOffAmount: dec(b.writeOffAmount),
      outstanding,
      expectedPaymentDate: b.expectedPaymentDate ?? null,
      daysOverdue: overdue ? daysOverdue : null,
      isOverdue: overdue,
      paymentStatus: b.paymentStatus,
      bookingStatus: b.status,
    };

    const acc = byClient.get(b.clientId) ?? {
      clientId: b.clientId,
      clientName: b.client.name,
      legalName: b.client.legalName ?? null,
      phone: b.client.phone ?? null,
      email: b.client.email ?? null,
      rows: [],
      total: new Decimal(0),
      overdue: new Decimal(0),
      maxDaysOverdue: 0,
    };
    acc.rows.push(row);
    acc.total = acc.total.add(outstanding);
    if (overdue) {
      acc.overdue = acc.overdue.add(outstanding);
      if (daysOverdue !== null && daysOverdue > acc.maxDaysOverdue) acc.maxDaysOverdue = daysOverdue;
    }
    byClient.set(b.clientId, acc);
  }

  if (byClient.size === 0) {
    throw new HttpError(
      400,
      "По выбранным броням долгов не осталось — все они уже погашены",
      "DEBT_REPORT_NOTHING_TO_COLLECT",
      { skipped },
    );
  }

  // Порядок — рабочий, а не алфавитный: сотрудник начинает обзвон сверху.
  // Сначала те, у кого просрочено больше денег, потом по общему долгу.
  const clients = Array.from(byClient.values()).sort((a, b) => {
    const byOverdue = b.overdue.comparedTo(a.overdue);
    if (byOverdue !== 0) return byOverdue;
    const byTotal = b.total.comparedTo(a.total);
    if (byTotal !== 0) return byTotal;
    return a.clientName.localeCompare(b.clientName, "ru");
  });
  for (const c of clients) {
    c.rows.sort((a, b) => {
      const byDays = (b.daysOverdue ?? -1) - (a.daysOverdue ?? -1);
      if (byDays !== 0) return byDays;
      return (a.startDate?.getTime() ?? 0) - (b.startDate?.getTime() ?? 0);
    });
  }

  const allRows = clients.flatMap((c) => c.rows);
  const overAgedRows = allRows.filter((r) => (r.daysOverdue ?? 0) > OVER_AGED_DAYS);
  const settings = await getSettings();
  const clean = (v: string | null | undefined) => (v ?? "").trim() || null;

  return {
    title: clean(args.title) ?? DEFAULT_REPORT_TITLE,
    asOf,
    note: clean(args.note),
    includeContacts: args.includeContacts ?? false,
    org: { name: clean(settings.legalName), phone: clean(settings.phone), email: clean(settings.email) },
    clients,
    totals: {
      clientsCount: clients.length,
      bookingsCount: allRows.length,
      total: allRows.reduce((s, r) => s.add(r.outstanding), new Decimal(0)),
      overdue: allRows.filter((r) => r.isOverdue).reduce((s, r) => s.add(r.outstanding), new Decimal(0)),
      overAged: overAgedRows.reduce((s, r) => s.add(r.outstanding), new Decimal(0)),
      overAgedCount: overAgedRows.length,
    },
    skipped,
  };
}

/** Имя файла: «Реестр задолженности 16.09.2026». */
export function debtReportFileBase(doc: DebtReportDocument): string {
  const d = doc.asOf;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${doc.title} ${dd}.${mm}.${d.getFullYear()}`;
}
