import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import { z } from "zod";
import {
  REGISTER_STATUSES,
  REGISTER_SCOPES,
  REGISTER_SORTS,
  REGISTER_DATE_FIELDS,
  type BookingRegisterRow,
  type BookingRegisterEvent,
  type BookingRegisterResponse,
  type RegisterScope,
  type RegisterTotals,
  type RegisterFinanceState,
} from "@light-rental/shared";
import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { toMoscowDateString } from "../utils/moscowDate";
import { getBookingIssueSummaries, emptyIssueSummary } from "./bookingIssues";
import { nextDate, suggestedPeriodEnd } from "./projectPricing";

const date = z.string().refine((v) => {
  const parsed = new Date(v + "T00:00:00Z");
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === v
  );
}, "Некорректная календарная дата");
const optionalDate = z.preprocess(
  (v) => (v === "" ? undefined : v),
  date.optional(),
);
const amount = z.preprocess(
  (v) => (v === "" ? undefined : v),
  z.coerce.number().finite().min(0).max(1e12).optional(),
);
export const registerQuerySchema = z
  .object({
    scope: z.enum(REGISTER_SCOPES).default("active"),
    q: z.string().trim().max(200).default(""),
    clientId: z.string().max(100).default(""),
    projectId: z.string().max(100).default(""),
    status: z
      .string()
      .default("")
      .refine(
        (v) =>
          !v ||
          v
            .split(",")
            .every((s) => (REGISTER_STATUSES as readonly string[]).includes(s)),
        "Неизвестный статус",
      ),
    mode: z.enum(["", "STANDARD", "PROJECT"]).default(""),
    payment: z
      .enum([
        "",
        "unpaid",
        "partial",
        "overdue",
        "paid",
        "unpriced",
        "credit",
        "settled",
        "zero",
      ])
      .default(""),
    dateField: z.enum(REGISTER_DATE_FIELDS).default("rental"),
    from: optionalDate,
    to: optionalDate,
    amountField: z
      .enum(["outstanding", "total", "paid", "overdue"])
      .default("outstanding"),
    min: amount,
    max: amount,
    action: z
      .enum([
        "",
        "prepare",
        "approve",
        "issue",
        "return",
        "payment",
        "period",
        "review",
      ])
      .default(""),
    issue: z.enum(["", "open", "missing", "damage", "waiting", "overdue", "history"]).default(""),
    age: z.enum(["", "1-7", "8-30", "31+"]).default(""),
    sort: z.enum(REGISTER_SORTS).default("startDate"),
    direction: z.enum(["asc", "desc"]).default("desc"),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().max(2048).optional(),
    day: optionalDate,
  })
  .superRefine((q, ctx) => {
    if (q.from && q.to && q.from > q.to)
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: "Конец периода раньше начала",
      });
    if (q.min !== undefined && q.max !== undefined && q.min > q.max)
      ctx.addIssue({
        code: "custom",
        path: ["max"],
        message: "Максимальная сумма меньше минимальной",
      });
  });
type Query = z.infer<typeof registerQuerySchema>;

// No document JSON, estimates or payment journals: this projection stays small.
const select = {
  id: true,
  docNumber: true,
  mode: true,
  status: true,
  projectName: true,
  client: { select: { id: true, name: true } },
  startDate: true,
  endDate: true,
  createdAt: true,
  updatedAt: true,
  expectedPaymentDate: true,
  confirmedAt: true,
  issuedAt: true,
  finalAmount: true,
  manualFinalAmount: true,
  amountPaid: true,
  amountOutstanding: true,
  writeOffAmount: true,
  paymentStatus: true,
  paymentForm: true,
  legacyFinance: true,
  forfeitedAt: true,
  items: { select: { quantity: true } },
  scanSessions: {
    select: { operation: true, status: true },
    orderBy: { startedAt: "desc" },
    take: 1,
  },
  project: {
    select: {
      billingCycle: true,
      periods: {
        select: {
          id: true,
          kind: true,
          correctsId: true,
          amount: true,
          dueDate: true,
          throughDate: true,
          createdAt: true,
        },
        orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
      },
      lots: {
        select: {
          id: true,
          quantity: true,
          fromDate: true,
          throughDate: true,
          status: true,
          issuedAt: true,
          returns: { select: { quantity: true, lastBillableDate: true } },
        },
      },
      charges: { select: { date: true } },
    },
  },
} satisfies Prisma.BookingSelect;
type SourceRow = Prisma.BookingGetPayload<{ select: typeof select }>;
const dec = (value: { toString(): string } | string | number | null) =>
  new Decimal(value?.toString() ?? "0");
const iso = (value: Date | null) => value?.toISOString() ?? null;
const dayOf = (value: Date) => toMoscowDateString(value);
// Project endDate is exclusive; standard bookings store the actual return time.
const rentalEnd = (b: SourceRow) =>
  b.mode === "PROJECT" ? new Date(b.endDate.getTime() - 1) : b.endDate;

function projectState(b: SourceRow) {
  if (!b.project) return null;
  const lots = b.project.lots.filter((l) => l.status !== "CANCELLED");
  const periods = b.project.periods.filter((p) => p.kind === "PERIOD");
  const closedThrough =
    periods
      .map((p) => p.throughDate)
      .sort()
      .at(-1) ?? null;
  const start = dayOf(b.startDate);
  // Returned lots end on the real last billable date, not the old planned end.
  const billableThrough = [
    ...lots
      .filter((l) => l.issuedAt)
      .flatMap((l) => [
        ...l.returns.map((r) => r.lastBillableDate),
        ...(l.quantity > l.returns.reduce((s, r) => s + r.quantity, 0)
          ? [l.throughDate]
          : []),
      ]),
    ...b.project.charges.map((c) => c.date),
  ]
    .sort()
    .at(-1);
  const unclosedBilling =
    !!billableThrough && (!closedThrough || closedThrough < billableThrough);
  const nextFrom = closedThrough ? nextDate(closedThrough) : start;
  const through =
    b.status === "RETURNED"
      ? (billableThrough ?? dayOf(rentalEnd(b)))
      : dayOf(rentalEnd(b));
  return {
    periodCount: periods.length,
    closedThrough,
    unclosedBilling,
    nextCloseDate:
      nextFrom <= through
        ? suggestedPeriodEnd(nextFrom, b.project.billingCycle, through)
        : null,
    plannedQuantity: lots
      .filter((l) => l.status === "PLANNED")
      .reduce((s, l) => s + l.quantity, 0),
    totalQuantity: lots.reduce((s, l) => s + l.quantity, 0),
  };
}

export function projectRegisterRow(
  b: SourceRow,
  openProblems: number,
  now: Date,
  issues = emptyIssueSummary(),
): BookingRegisterRow {
  const total = dec(b.finalAmount),
    paid = dec(b.amountPaid),
    outstanding = dec(b.amountOutstanding);
  const writtenOff = dec(b.writeOffAmount);
  const credit = Decimal.max(0, paid.sub(total));
  const projectSummary = projectState(b);
  let due = outstanding.gt(0) ? b.expectedPaymentDate : null;
  let overdue = due && due < now ? outstanding : new Decimal(0);
  if (b.project) {
    let available = paid;
    overdue = new Decimal(0);
    due = null;
    for (const p of b.project.periods.filter((p) => p.kind === "PERIOD")) {
      const charge = b.project.periods
        .filter((c) => c.correctsId === p.id)
        .reduce((s, c) => s.add(c.amount.toString()), dec(p.amount));
      const applied = Decimal.min(available, Decimal.max(0, charge));
      available = available.sub(applied);
      const remaining = Decimal.max(0, charge.sub(applied));
      if (remaining.gt(0)) {
        if (!due) due = p.dueDate;
        if (p.dueDate < now) overdue = overdue.add(remaining);
      }
    }
    overdue = Decimal.min(overdue, outstanding);
  }
  let financeState: RegisterFinanceState = "UNPAID";
  if (outstanding.gt(0)) financeState = paid.gt(0) ? "PARTIAL" : "UNPAID";
  else if (credit.gt(0)) financeState = "CREDIT";
  else if (writtenOff.gt(0)) financeState = "SETTLED";
  else if (b.project && !projectSummary?.periodCount)
    financeState = "NO_CHARGES";
  else if (total.lte(0))
    financeState =
      b.status === "DRAFT" && b.manualFinalAmount === null
        ? "UNPRICED"
        : "ZERO";
  else financeState = "PAID";
  const onHand = b.project
    ? b.project.lots
        .filter((l) => l.issuedAt && l.status !== "CANCELLED")
        .reduce(
          (s, l) =>
            s +
            Math.max(
              0,
              l.quantity - l.returns.reduce((n, r) => n + r.quantity, 0),
            ),
          0,
        )
    : b.status === "ISSUED"
      ? b.items.reduce((s, i) => s + i.quantity, 0)
      : 0;
  const returnOverdue = b.project
    ? b.project.lots.some(
        (l) =>
          l.status === "ISSUED" &&
          l.throughDate < dayOf(now) &&
          l.quantity > l.returns.reduce((s, r) => s + r.quantity, 0),
      )
    : b.status === "ISSUED" && b.endDate < now;
  const cancellationReview =
    b.status === "CANCELLED" && paid.gt(0) && !b.forfeitedAt;
  const needsReview =
    openProblems > 0 ||
    issues.openCases > 0 ||
    returnOverdue ||
    cancellationReview ||
    (["DRAFT", "PENDING_APPROVAL", "CONFIRMED"].includes(b.status) &&
      b.endDate < now);
  const completed =
    ["RETURNED", "CANCELLED"].includes(b.status) &&
    !outstanding.gt(0) &&
    !credit.gt(0) &&
    !openProblems &&
    !issues.openCases &&
    !cancellationReview &&
    !projectSummary?.unclosedBilling &&
    onHand === 0 &&
    !projectSummary?.plannedQuantity;
  const actions: BookingRegisterRow["actions"] = [];
  if (b.status === "DRAFT") actions.push("prepare");
  if (b.status === "PENDING_APPROVAL") actions.push("approve");
  if (
    (b.mode === "STANDARD" && b.status === "CONFIRMED") ||
    projectSummary?.plannedQuantity
  )
    actions.push("issue");
  if (b.status === "ISSUED" || onHand > 0) actions.push("return");
  if (outstanding.gt(0)) actions.push("payment");
  if (
    projectSummary?.nextCloseDate &&
    projectSummary.nextCloseDate <= dayOf(now) &&
    b.status !== "CANCELLED"
  )
    actions.push("period");
  if (needsReview) actions.push("review");
  const overdueDays =
    overdue.gt(0) && due
      ? Math.max(
          0,
          Math.round(
            (Date.parse(dayOf(now)) - Date.parse(dayOf(due))) / 86400000,
          ),
        )
      : 0;
  return {
    id: b.id,
    docNumber: b.docNumber,
    mode: b.mode === "PROJECT" ? "PROJECT" : "STANDARD",
    status: b.status,
    projectName: b.projectName,
    client: b.client,
    startDate: b.startDate.toISOString(),
    endDate: rentalEnd(b).toISOString(),
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
    confirmedAt: iso(b.confirmedAt),
    issuedAt: iso(b.issuedAt),
    expectedPaymentDate: iso(due),
    finalAmount: total.toFixed(2),
    amountPaid: paid.toFixed(2),
    amountOutstanding: outstanding.toFixed(2),
    writeOffAmount: writtenOff.toFixed(2),
    paymentStatus: b.paymentStatus,
    paymentForm: b.paymentForm,
    legacyFinance: b.legacyFinance,
    hasScanSessions: b.scanSessions.length > 0,
    lastScanOperation: b.scanSessions[0]?.operation ?? null,
    lastScanStatus: b.scanSessions[0]?.status ?? null,
    financeState,
    overdueAmount: overdue.toFixed(2),
    overdueDays,
    creditAmount: credit.toFixed(2),
    completed,
    returnOverdue,
    openProblems,
    issues,
    needsReview,
    actions,
    onHand,
    projectSummary,
  };
}

export function inRegisterScope(
  row: BookingRegisterRow,
  scope: RegisterScope,
): boolean {
  switch (scope) {
    case "active":
      return !row.completed;
    case "completed":
      return row.completed;
    case "unpaid":
      return dec(row.amountOutstanding).gt(0);
    case "overdue":
      return dec(row.overdueAmount).gt(0);
    case "paid":
      return row.financeState === "PAID";
    case "issued":
      return row.status === "ISSUED" || row.onHand > 0;
    case "pending":
      return row.status === "PENDING_APPROVAL";
    default:
      return true;
  }
}
function totals(rows: BookingRegisterRow[]): RegisterTotals {
  const sum = (
    key: "amountOutstanding" | "overdueAmount" | "finalAmount" | "amountPaid",
  ) => rows.reduce((s, b) => s.add(b[key]), new Decimal(0)).toFixed(2);
  return {
    count: rows.length,
    outstanding: sum("amountOutstanding"),
    overdue: sum("overdueAmount"),
    total: sum("finalAmount"),
    paid: sum("amountPaid"),
  };
}
function matches(row: BookingRegisterRow, q: Query) {
  if (
    q.q &&
    !`${row.projectName} ${row.client.name} ${row.docNumber ?? ""} ${row.id}`
      .toLocaleLowerCase("ru-RU")
      .includes(q.q.toLocaleLowerCase("ru-RU"))
  )
    return false;
  if (
    (q.clientId && q.clientId !== row.client.id) ||
    (q.projectId && q.projectId !== row.id) ||
    (q.mode && q.mode !== row.mode)
  )
    return false;
  if (q.status && !q.status.split(",").includes(row.status)) return false;
  const states: Record<string, boolean> = {
    unpaid: dec(row.amountOutstanding).gt(0),
    partial: row.financeState === "PARTIAL",
    overdue: dec(row.overdueAmount).gt(0),
    paid: row.financeState === "PAID",
    unpriced: ["UNPRICED", "NO_CHARGES"].includes(row.financeState),
    credit: row.financeState === "CREDIT",
    settled: row.financeState === "SETTLED",
    zero: row.financeState === "ZERO",
  };
  if (q.payment && !states[q.payment]) return false;
  if (q.action && !row.actions.includes(q.action)) return false;
  if (q.issue) {
    const s = row.issues ?? emptyIssueSummary();
    const counts = { open: s.openCases, missing: s.missingCases, damage: s.damageCases,
      waiting: s.waitingCases, overdue: s.overdueCases, history: s.openCases + s.closedCases };
    if (!counts[q.issue]) return false;
  }
  if (
    q.age &&
    (!dec(row.overdueAmount).gt(0) ||
      (q.age === "1-7"
        ? row.overdueDays > 7
        : q.age === "8-30"
          ? row.overdueDays < 8 || row.overdueDays > 30
          : row.overdueDays < 31))
  )
    return false;
  if (q.from || q.to) {
    const begin =
      q.dateField === "due"
        ? row.expectedPaymentDate
        : q.dateField === "end"
          ? row.endDate
          : q.dateField === "created"
            ? row.createdAt
            : row.startDate;
    if (!begin) return false;
    const from = dayOf(new Date(begin)),
      through = q.dateField === "rental" ? dayOf(new Date(row.endDate)) : from;
    if ((q.from && through < q.from) || (q.to && from > q.to)) return false;
  }
  const key = {
    outstanding: "amountOutstanding",
    total: "finalAmount",
    paid: "amountPaid",
    overdue: "overdueAmount",
  } as const;
  const value = dec(row[key[q.amountField]]);
  return !(
    (q.min !== undefined && value.lt(q.min)) ||
    (q.max !== undefined && value.gt(q.max))
  );
}
function sortValue(row: BookingRegisterRow, q: Query): string | null {
  return q.sort === "dueDate"
    ? row.expectedPaymentDate
    : q.sort === "outstanding"
      ? row.amountOutstanding
      : q.sort === "total"
        ? row.finalAmount
        : q.sort === "client"
          ? row.client.name
          : row[q.sort];
}
function compare(
  a: { value: string | null; id: string },
  b: { value: string | null; id: string },
  q: Query,
) {
  if (a.value === null || b.value === null)
    return a.value === b.value
      ? a.id.localeCompare(b.id)
      : a.value === null
        ? 1
        : -1;
  const value = ["outstanding", "total"].includes(q.sort)
    ? dec(a.value).cmp(dec(b.value))
    : a.value.localeCompare(b.value, "ru");
  return (value || a.id.localeCompare(b.id)) * (q.direction === "asc" ? 1 : -1);
}
function dayEvents(
  sources: SourceRow[],
  rows: BookingRegisterRow[],
  day: string,
): BookingRegisterEvent[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const result: BookingRegisterEvent[] = [];
  const add = (
    b: SourceRow,
    kind: BookingRegisterEvent["kind"],
    when: string,
    quantity: number | null,
    suffix = "",
    time: string | null = null,
  ) => {
    if (when !== day) return;
    result.push({
      id: `${b.id}:${kind}:${suffix}`,
      bookingId: b.id,
      kind,
      date: when,
      time,
      quantity,
      label: {
        ISSUE: "Выдача",
        RETURN: "Возврат",
        ADDON: "Добор",
        PERIOD: "Закрыть период",
      }[kind],
    });
  };
  for (const b of sources) {
    const row = byId.get(b.id);
    if (!row || b.status === "CANCELLED") continue;
    if (b.project) {
      const alreadyIssued = b.project.lots.some((l) => l.issuedAt);
      for (const l of b.project.lots) {
        if (l.status === "PLANNED")
          add(
            b,
            alreadyIssued ? "ADDON" : "ISSUE",
            l.fromDate,
            l.quantity,
            l.id,
          );
        const left = l.quantity - l.returns.reduce((s, r) => s + r.quantity, 0);
        if (l.status === "ISSUED" && left > 0)
          add(b, "RETURN", l.throughDate, left, l.id);
      }
      if (row.projectSummary?.nextCloseDate)
        add(b, "PERIOD", row.projectSummary.nextCloseDate, null);
    } else {
      const time = (d: Date) =>
        d.toLocaleTimeString("ru-RU", {
          timeZone: "Europe/Moscow",
          hour: "2-digit",
          minute: "2-digit",
        });
      if (b.status === "CONFIRMED")
        add(
          b,
          "ISSUE",
          dayOf(b.startDate),
          b.items.reduce((s, i) => s + i.quantity, 0),
          "",
          time(b.startDate),
        );
      if (b.status === "ISSUED")
        add(b, "RETURN", dayOf(b.endDate), row.onHand, "", time(b.endDate));
    }
  }
  return result.sort(
    (a, b) =>
      (a.time ?? "99:99").localeCompare(b.time ?? "99:99") ||
      a.id.localeCompare(b.id),
  );
}

/** Derived views never archive bookings or recompute/write historical finances. */
export async function listBookingRegister(
  input: unknown,
  now = new Date(),
): Promise<BookingRegisterResponse> {
  const q = registerQuerySchema.parse(input);
  const [sources, summaries] = await Promise.all([
    prisma.booking.findMany({ where: { deletedAt: null }, select }),
    getBookingIssueSummaries(now),
  ]);
  const all = sources.map((b) => {
    const issues = summaries.get(b.id) ?? emptyIssueSummary();
    return projectRegisterRow(b, issues.missingCases, now, issues);
  });
  const base = all.filter((r) => matches(r, q));
  const scopeCounts = Object.fromEntries(
    REGISTER_SCOPES.map((s) => [
      s,
      base.filter((r) => inRegisterScope(r, s)).length,
    ]),
  ) as Record<RegisterScope, number>;
  const selected = base.filter((r) => inRegisterScope(r, q.scope));
  selected.sort((a, b) =>
    compare(
      { id: a.id, value: sortValue(a, q) },
      { id: b.id, value: sortValue(b, q) },
      q,
    ),
  );
  const { cursor: _, limit: __, ...queryIdentity } = q;
  const signature = createHash("sha256")
    .update(JSON.stringify(queryIdentity))
    .digest("hex")
    .slice(0, 16);
  let after = selected;
  if (q.cursor) {
    try {
      const c = z
        .object({
          signature: z.literal(signature),
          id: z.string(),
          value: z.string().nullable(),
        })
        .parse(JSON.parse(Buffer.from(q.cursor, "base64url").toString()));
      after = selected.filter(
        (row) => compare({ id: row.id, value: sortValue(row, q) }, c, q) > 0,
      );
    } catch {
      throw new HttpError(
        400,
        "Список изменился. Обновите результаты.",
        "INVALID_REGISTER_CURSOR",
      );
    }
  }
  const bookings = after.slice(0, q.limit),
    last = bookings.at(-1);
  const day = q.day ?? dayOf(now);
  const events = dayEvents(sources, base, day);
  const eventIds = new Set(events.map((e) => e.bookingId));
  const dayRows = base.filter(
    (r) =>
      eventIds.has(r.id) ||
      r.returnOverdue ||
      (r.issues?.openCases ?? 0) > 0 ||
      dec(r.overdueAmount).gt(0) ||
      r.status === "DRAFT" ||
      r.status === "PENDING_APPROVAL",
  );
  return {
    bookings,
    totalCount: selected.length,
    nextCursor:
      after.length > q.limit && last
        ? Buffer.from(
            JSON.stringify({
              signature,
              id: last.id,
              value: sortValue(last, q),
            }),
          ).toString("base64url")
        : null,
    totals: totals(selected),
    scopeCounts,
    summary: {
      ...totals(all),
      active: all.filter((r) => !r.completed).length,
      issued: all.filter((r) => inRegisterScope(r, "issued")).length,
      unpaid: all.filter((r) => inRegisterScope(r, "unpaid")).length,
      overdueCount: all.filter((r) => inRegisterScope(r, "overdue")).length,
      pending: all.filter((r) => inRegisterScope(r, "pending")).length,
    },
    options: {
      clients: [
        ...new Map(all.map((r) => [r.client.id, r.client])).values(),
      ].sort((a, b) => a.name.localeCompare(b.name, "ru")),
      projects: all
        .map((r) => ({
          id: r.id,
          name: `${r.projectName} · ${r.client.name}${r.docNumber ? " · " + r.docNumber : ""}`,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, "ru")),
    },
    day: { date: day, events, bookings: dayRows },
    asOf: now.toISOString(),
  };
}
