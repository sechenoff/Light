import { prisma } from "../prisma";
import { moscowTodayStart, addDays, toMoscowDateString } from "../utils/moscowDate";

/**
 * Рабочий стол кладовщика v2 — read-only агрегаты для трёх экранов киоска:
 *  - computeShift()    → «Смена»: лента дня, счётчики, просрочка, моя выработка
 *  - computeJournal()  → «Журнал»: завершённые сессии + поломки, статистика
 *  - computeProblems() → «Поломки»: активные ремонты + открытые потеряшки
 *
 * Ноль записей в БД, ноль миграций — только чтение существующих моделей
 * (Booking, ScanSession, Repair, ProblemItem). Все даты — московская
 * date-only семантика через utils/moscowDate (как в задачах).
 *
 * NB: никаких barcode в ответах (конвенция «No Barcodes in UX») — только
 * названия оборудования и displayNo брони (#ABCDEF).
 */

// ── Типы ответов ─────────────────────────────────────────────────────────────

export type ShiftTimelineStatus = "DONE" | "PENDING" | "OVERDUE";

export interface ShiftTimelineEntry {
  kind: "ISSUE" | "RETURN";
  bookingId: string;
  displayNo: string;
  projectName: string;
  clientName: string;
  clientPhone: string | null;
  /** Плановое время (startDate для выдачи, endDate для возврата), ISO. */
  plannedAt: string;
  itemsCount: number;
  status: ShiftTimelineStatus;
  /** Фактическое время выполнения (issuedAt / completedAt RETURN-сессии). */
  doneAt: string | null;
  /** Для OVERDUE — на сколько дней просрочен возврат. */
  overdueDays: number;
}

export interface ShiftSummary {
  /** Московская дата смены, YYYY-MM-DD. */
  date: string;
  timeline: ShiftTimelineEntry[];
  /** Просроченные возвраты (status ISSUED, endDate < сегодня). */
  overdue: ShiftTimelineEntry[];
  counters: {
    issuesDone: number;
    issuesPlanned: number;
    returnsDone: number;
    returnsPlanned: number;
    overdue: number;
    inWork: number;
  };
  myShift: {
    workerName: string;
    sessions: number;
    items: number;
    firstAt: string | null;
    avgMinutes: number | null;
  };
}

export interface JournalEntry {
  kind: "SESSION" | "REPAIR";
  id: string;
  /** Момент события (startedAt сессии / createdAt ремонта), ISO. */
  at: string;
  /** SESSION */
  operation?: "ISSUE" | "RETURN";
  workerName?: string;
  bookingId?: string;
  displayNo?: string;
  projectName?: string;
  clientName?: string;
  itemsCount?: number;
  completedAt?: string | null;
  durationMinutes?: number | null;
  /** REPAIR */
  equipmentName?: string;
  reason?: string;
  repairStatus?: string;
  photosCount?: number;
}

export interface JournalSummary {
  entries: JournalEntry[];
  stats: {
    sessions: number;
    items: number;
    avgMinutes: number | null;
    /** 7 последних дней (включая сегодня), по возрастанию даты. */
    perDay: Array<{ date: string; issues: number; returns: number }>;
    repairsMonth: number;
    problemsMonth: number;
    closedMonth: number;
  };
}

export interface ProblemsSummary {
  repairs: Array<{
    id: string;
    equipmentName: string;
    quantity: number;
    reason: string;
    urgency: string;
    status: string;
    createdAt: string;
    photosCount: number;
    sourceProject: string | null;
  }>;
  problems: Array<{
    id: string;
    equipmentName: string;
    quantity: number;
    reason: string;
    comment: string;
    status: string;
    expectedBackDate: string | null;
    createdAt: string;
    sourceProject: string | null;
  }>;
}

// ── Хелперы ──────────────────────────────────────────────────────────────────

function displayNo(bookingId: string): string {
  return "#" + bookingId.slice(-6).toUpperCase();
}

function minutesBetween(a: Date, b: Date): number {
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 60000));
}

/** Среднее по массиву, округлённое до минуты; null для пустого. */
function avg(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return Math.round(nums.reduce((s, n) => s + n, 0) / nums.length);
}

// ── Смена ────────────────────────────────────────────────────────────────────

export async function computeShift(workerName: string): Promise<ShiftSummary> {
  const todayStart = moscowTodayStart();
  const tomorrowStart = addDays(todayStart, 1);

  const [issueBookings, returnBookings, overdueBookings, inWorkCount] =
    await Promise.all([
      // Выдачи с плановым стартом сегодня. CONFIRMED → ждёт, ISSUED/RETURNED → сделано.
      prisma.booking.findMany({
        where: {
          deletedAt: null,
          startDate: { gte: todayStart, lt: tomorrowStart },
          status: { in: ["CONFIRMED", "ISSUED", "RETURNED"] },
        },
        include: {
          client: { select: { name: true, phone: true } },
          _count: { select: { items: true } },
        },
        orderBy: { startDate: "asc" },
      }),
      // Возвраты с плановым концом сегодня. ISSUED → ждём, RETURNED → принято.
      prisma.booking.findMany({
        where: {
          deletedAt: null,
          endDate: { gte: todayStart, lt: tomorrowStart },
          status: { in: ["ISSUED", "RETURNED"] },
        },
        include: {
          client: { select: { name: true, phone: true } },
          _count: { select: { items: true } },
        },
        orderBy: { endDate: "asc" },
      }),
      // Просрочка: выдано, а плановый возврат уже в прошлом.
      prisma.booking.findMany({
        where: {
          deletedAt: null,
          status: "ISSUED",
          endDate: { lt: todayStart },
        },
        include: {
          client: { select: { name: true, phone: true } },
          _count: { select: { items: true } },
        },
        orderBy: { endDate: "asc" },
      }),
      prisma.booking.count({ where: { deletedAt: null, status: "ISSUED" } }),
    ]);

  // Фактическое время приёмки для RETURNED-броней — completedAt их RETURN-сессии.
  const returnedIds = returnBookings
    .filter((b) => b.status === "RETURNED")
    .map((b) => b.id);
  const returnSessions = returnedIds.length
    ? await prisma.scanSession.findMany({
        where: {
          bookingId: { in: returnedIds },
          operation: "RETURN",
          status: "COMPLETED",
        },
        orderBy: { completedAt: "desc" },
        select: { bookingId: true, completedAt: true },
      })
    : [];
  const returnDoneAt = new Map<string, Date>();
  for (const s of returnSessions) {
    if (s.completedAt && !returnDoneAt.has(s.bookingId)) {
      returnDoneAt.set(s.bookingId, s.completedAt);
    }
  }

  const nowMs = Date.now();
  const toEntry = (
    b: (typeof issueBookings)[number],
    kind: "ISSUE" | "RETURN",
    status: ShiftTimelineStatus,
    doneAt: Date | null,
  ): ShiftTimelineEntry => ({
    kind,
    bookingId: b.id,
    displayNo: displayNo(b.id),
    projectName: b.projectName,
    clientName: b.client?.name ?? "",
    clientPhone: b.client?.phone ?? null,
    plannedAt: (kind === "ISSUE" ? b.startDate : b.endDate).toISOString(),
    itemsCount: b._count.items,
    status,
    doneAt: doneAt?.toISOString() ?? null,
    overdueDays:
      status === "OVERDUE"
        ? Math.max(1, Math.floor((nowMs - b.endDate.getTime()) / 86400000))
        : 0,
  });

  const timeline: ShiftTimelineEntry[] = [
    ...issueBookings.map((b) =>
      toEntry(
        b,
        "ISSUE",
        b.status === "CONFIRMED" ? "PENDING" : "DONE",
        b.issuedAt ?? null,
      ),
    ),
    ...returnBookings.map((b) =>
      toEntry(
        b,
        "RETURN",
        b.status === "RETURNED" ? "DONE" : "PENDING",
        returnDoneAt.get(b.id) ?? null,
      ),
    ),
  ].sort((a, b) => a.plannedAt.localeCompare(b.plannedAt));

  const overdue = overdueBookings.map((b) =>
    toEntry(b, "RETURN", "OVERDUE", null),
  );

  // Моя выработка: сессии, начатые сегодня этим оператором.
  const mySessions = await prisma.scanSession.findMany({
    where: { workerName, startedAt: { gte: todayStart } },
    include: {
      booking: { select: { _count: { select: { items: true } } } },
    },
    orderBy: { startedAt: "asc" },
  });
  const myCompleted = mySessions.filter(
    (s) => s.status === "COMPLETED" && s.completedAt != null,
  );

  return {
    date: toMoscowDateString(todayStart),
    timeline,
    overdue,
    counters: {
      issuesDone: issueBookings.filter((b) => b.status !== "CONFIRMED").length,
      issuesPlanned: issueBookings.length,
      returnsDone: returnBookings.filter((b) => b.status === "RETURNED").length,
      returnsPlanned: returnBookings.length,
      overdue: overdue.length,
      inWork: inWorkCount,
    },
    myShift: {
      workerName,
      sessions: myCompleted.length,
      items: myCompleted.reduce((s, x) => s + x.booking._count.items, 0),
      firstAt: mySessions[0]?.startedAt.toISOString() ?? null,
      avgMinutes: avg(
        myCompleted.map((s) => minutesBetween(s.startedAt, s.completedAt!)),
      ),
    },
  };
}

// ── Журнал ───────────────────────────────────────────────────────────────────

export async function computeJournal(args: {
  days: number;
  scope: "me" | "all";
  workerName: string;
}): Promise<JournalSummary> {
  const todayStart = moscowTodayStart();
  const from = addDays(todayStart, -(args.days - 1));
  const weekFrom = addDays(todayStart, -6);
  const monthFrom = addDays(todayStart, -29);
  const scopeWhere =
    args.scope === "me" ? { workerName: args.workerName } : {};

  const [sessions, repairs, weekSessions, repairsMonth, problemsMonth, closedMonth] =
    await Promise.all([
      prisma.scanSession.findMany({
        where: { status: "COMPLETED", startedAt: { gte: from }, ...scopeWhere },
        orderBy: { startedAt: "desc" },
        take: 200,
        include: {
          booking: {
            select: {
              id: true,
              projectName: true,
              client: { select: { name: true } },
              _count: { select: { items: true } },
            },
          },
        },
      }),
      // Поломки в ленту. createdBy для kiosk-ремонтов хранит имя кладовщика
      // (см. CLAUDE.md, аудит warehouseScan) — поэтому scope=me фильтрует по нему.
      prisma.repair.findMany({
        where: {
          createdAt: { gte: from },
          ...(args.scope === "me" ? { createdBy: args.workerName } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: 100,
        include: {
          unit: { include: { equipment: { select: { name: true } } } },
          bookingItem: { include: { equipment: { select: { name: true } } } },
          equipment: { select: { name: true } },
          _count: { select: { photos: true } },
        },
      }),
      // Бары «по дням» — всегда последние 7 дней, той же областью видимости.
      prisma.scanSession.findMany({
        where: { status: "COMPLETED", startedAt: { gte: weekFrom }, ...scopeWhere },
        select: { operation: true, startedAt: true },
      }),
      prisma.repair.count({ where: { createdAt: { gte: monthFrom } } }),
      prisma.problemItem.count({ where: { createdAt: { gte: monthFrom } } }),
      prisma.repair.count({
        where: { status: "CLOSED", closedAt: { gte: monthFrom } },
      }),
    ]);

  const sessionEntries: JournalEntry[] = sessions.map((s) => ({
    kind: "SESSION",
    id: s.id,
    at: s.startedAt.toISOString(),
    operation: s.operation as "ISSUE" | "RETURN",
    workerName: s.workerName,
    bookingId: s.booking.id,
    displayNo: displayNo(s.booking.id),
    projectName: s.booking.projectName,
    clientName: s.booking.client?.name ?? "",
    itemsCount: s.booking._count.items,
    completedAt: s.completedAt?.toISOString() ?? null,
    durationMinutes: s.completedAt
      ? minutesBetween(s.startedAt, s.completedAt)
      : null,
  }));

  const repairEntries: JournalEntry[] = repairs.map((r) => ({
    kind: "REPAIR",
    id: r.id,
    at: r.createdAt.toISOString(),
    equipmentName:
      r.unit?.equipment.name ??
      r.bookingItem?.equipment?.name ??
      r.equipment?.name ??
      "Оборудование",
    reason: r.reason,
    repairStatus: r.status,
    photosCount: r._count.photos,
    workerName: r.createdBy,
  }));

  const entries = [...sessionEntries, ...repairEntries].sort((a, b) =>
    b.at.localeCompare(a.at),
  );

  // per-day агрегаты для баров: 7 дат подряд, включая пустые дни.
  const byDay = new Map<string, { issues: number; returns: number }>();
  for (let i = 0; i < 7; i++) {
    byDay.set(toMoscowDateString(addDays(weekFrom, i)), { issues: 0, returns: 0 });
  }
  for (const s of weekSessions) {
    const key = toMoscowDateString(s.startedAt);
    const bucket = byDay.get(key);
    if (!bucket) continue;
    if (s.operation === "ISSUE") bucket.issues += 1;
    else bucket.returns += 1;
  }

  return {
    entries,
    stats: {
      sessions: sessions.length,
      items: sessions.reduce((s, x) => s + x.booking._count.items, 0),
      avgMinutes: avg(
        sessions
          .filter((s) => s.completedAt)
          .map((s) => minutesBetween(s.startedAt, s.completedAt!)),
      ),
      perDay: Array.from(byDay.entries()).map(([date, v]) => ({ date, ...v })),
      repairsMonth,
      problemsMonth,
      closedMonth,
    },
  };
}

// ── Поломки ──────────────────────────────────────────────────────────────────

const ACTIVE_REPAIR_STATUSES = ["WAITING_REPAIR", "IN_REPAIR", "WAITING_PARTS"] as const;
const OPEN_PROBLEM_STATUSES = ["EXPECTED", "SEARCHING"] as const;

export async function computeProblems(): Promise<ProblemsSummary> {
  const [repairs, problems] = await Promise.all([
    prisma.repair.findMany({
      where: { status: { in: [...ACTIVE_REPAIR_STATUSES] } },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        unit: { include: { equipment: { select: { name: true } } } },
        bookingItem: { include: { equipment: { select: { name: true } } } },
        equipment: { select: { name: true } },
        sourceBooking: { select: { projectName: true } },
        _count: { select: { photos: true } },
      },
    }),
    prisma.problemItem.findMany({
      where: { status: { in: [...OPEN_PROBLEM_STATUSES] } },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        equipmentUnit: { include: { equipment: { select: { name: true } } } },
        bookingItem: { include: { equipment: { select: { name: true } } } },
      },
    }),
  ]);

  // ProblemItem.sourceBookingId — без relation в схеме, добираем проекты map-ом.
  const problemBookingIds = Array.from(
    new Set(problems.map((p) => p.sourceBookingId).filter((x): x is string => Boolean(x))),
  );
  const problemBookings = problemBookingIds.length
    ? await prisma.booking.findMany({
        where: { id: { in: problemBookingIds } },
        select: { id: true, projectName: true },
      })
    : [];
  const projectById = new Map(problemBookings.map((b) => [b.id, b.projectName]));

  return {
    repairs: repairs.map((r) => ({
      id: r.id,
      equipmentName:
        r.unit?.equipment.name ??
        r.bookingItem?.equipment?.name ??
        r.equipment?.name ??
        "Оборудование",
      quantity: r.quantity,
      reason: r.reason,
      urgency: r.urgency,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      photosCount: r._count.photos,
      sourceProject: r.sourceBooking?.projectName ?? null,
    })),
    problems: problems.map((p) => ({
      id: p.id,
      equipmentName:
        p.equipmentUnit?.equipment.name ??
        p.bookingItem?.equipment?.name ??
        "Оборудование",
      quantity: p.quantity,
      reason: p.reason,
      comment: p.comment,
      status: p.status,
      expectedBackDate: p.expectedBackDate?.toISOString() ?? null,
      createdAt: p.createdAt.toISOString(),
      sourceProject: p.sourceBookingId
        ? (projectById.get(p.sourceBookingId) ?? null)
        : null,
    })),
  };
}
