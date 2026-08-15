import express from "express";
import { z } from "zod";
import type { BookingStatus } from "@prisma/client";

import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { parseBookingRangeBound } from "../utils/dates";
import { rolesGuard } from "../middleware/rolesGuard";
import { moscowTodayStart, addDays } from "../utils/moscowDate";
import { getMyTasksForToday } from "../services/taskService";
import {
  getUsableUnitBaseMap,
  getLostCountByEquipmentMap,
  getRepairCountByEquipmentMap,
} from "../services/availability";
import { listReadyForPickup } from "../services/warehouseWorkstation";

const router = express.Router();

const querySchema = z.object({
  date: z.string().optional(),
});

/**
 * GET /api/dashboard/today
 * Возвращает брони для дашборда: pickups, returns, active.
 */
router.get("/today", async (req, res, next) => {
  try {
    const q = querySchema.parse(req.query);

    let todayStart: Date;
    let todayEnd: Date;

    if (q.date) {
      try {
        todayStart = parseBookingRangeBound(q.date, "start");
        todayEnd = parseBookingRangeBound(q.date, "end");
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : "Некорректный формат даты");
      }
    } else {
      // MD-1: границы «сегодня» — по Москве (как в /task-stats ниже), не по UTC.
      // Иначе ночью 00:00–03:00 МСК дашборд показывал операции вчерашнего дня.
      todayStart = moscowTodayStart();
      todayEnd = new Date(addDays(todayStart, 1).getTime() - 1);
    }

    const includeArgs = {
      client: true,
      items: {
        include: {
          equipment: { select: { name: true } },
        },
      },
    } as const;

    const userId = req.adminUser?.userId ?? "";

    // RR-4: везде deletedAt: null — архивные брони не должны попадать в операции дня.
    const [pickupsRaw, returnsRaw, activeRaw, myTasks] = await Promise.all([
      // Pickups: CONFIRMED брони начинающиеся сегодня
      prisma.booking.findMany({
        where: {
          status: "CONFIRMED",
          deletedAt: null,
          startDate: { gte: todayStart, lte: todayEnd },
        },
        include: includeArgs,
      }),
      // Returns: ISSUED брони заканчивающиеся сегодня
      prisma.booking.findMany({
        where: {
          status: "ISSUED",
          deletedAt: null,
          endDate: { gte: todayStart, lte: todayEnd },
        },
        include: includeArgs,
      }),
      // Active: все ISSUED брони
      prisma.booking.findMany({
        where: { status: "ISSUED", deletedAt: null },
        include: includeArgs,
      }),
      // Мои задачи на сегодня (overdue ∪ today ∪ urgent-undated), до 5
      getMyTasksForToday(userId),
    ]);

    function mapBooking(b: typeof pickupsRaw[number]) {
      return {
        id: b.id,
        projectName: b.projectName,
        clientName: b.client.name,
        startDate: b.startDate.toISOString(),
        endDate: b.endDate.toISOString(),
        status: b.status,
        finalAmount: b.finalAmount.toString(),
        itemCount: b.items.length,
        items: b.items.map((item) => ({
          equipmentName: item.equipment?.name ?? (item as any).customName ?? "—",
          quantity: item.quantity,
        })),
      };
    }

    res.json({
      pickups: pickupsRaw.map(mapBooking),
      returns: returnsRaw.map(mapBooking),
      active: activeRaw.map(mapBooking),
      myTasks,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/dashboard/pending-approvals
 * Возвращает брони со статусом PENDING_APPROVAL (ждут решения руководителя).
 *
 * Доступ — SUPER_ADMIN + WAREHOUSE: в ответе есть `finalAmount` (денежные данные),
 * а TECHNICIAN по матрице прав не имеет доступа к финансам. Router-level rolesGuard
 * допускает все три роли (нужен для /today и /repair-stats), поэтому здесь добавляем
 * явный per-route guard.
 */
router.get("/pending-approvals", rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]), async (_req, res, next) => {
  try {
    // dd-05: total раньше = bookings.length (обрезано take:20) → при >20 застревал
    // на 20, алерт/футер занижали число. Берём честный count под тем же where.
    // Заодно исключаем архивные (deletedAt) — их в очереди согласования быть не должно.
    const where = { status: "PENDING_APPROVAL" as const, deletedAt: null };
    const [bookings, total] = await Promise.all([
      prisma.booking.findMany({
        where,
        include: { client: true },
        orderBy: { startDate: "asc" },
        take: 20,
      }),
      prisma.booking.count({ where }),
    ]);

    // repair-cluster dd-approval-overdue: бронь на согласовании, у которой дата
    // выдачи уже прошла, «зависла» — руководитель не решил вовремя. Считаем это
    // на сервере (авторитетный флаг), чтобы UI не дублировал date-math и подсвечивал
    // «просрочено согласование». Граница «сегодня» — по Москве, как везде в дашборде.
    const todayStart = moscowTodayStart();
    const overdueCount = bookings.filter((b) => b.startDate < todayStart).length;

    res.json({
      bookings: bookings.map((b) => ({
        id: b.id,
        projectName: b.projectName,
        clientName: b.client.name,
        startDate: b.startDate.toISOString(),
        endDate: b.endDate.toISOString(),
        finalAmount: b.finalAmount.toString(),
        // true, если дата выдачи уже прошла — бронь застряла в согласовании.
        approvalOverdue: b.startDate < todayStart,
      })),
      total,
      // Сколько из показанных броней просрочено (для отдельной подписи в алерте).
      overdueCount,
    });
  } catch (err) {
    next(err);
  }
});

// ── Сводка мастерской ────────────────────────────────────────────────────────

/** Открытая карточка ремонта: прибор физически в мастерской, а не на полке. */
const ACTIVE_REPAIR_STATUSES = ["WAITING_REPAIR", "IN_REPAIR", "WAITING_PARTS"] as const;

/**
 * Брони, которые занимают оборудование. Локальная копия того же списка, что в
 * availability.ts и calendar.ts (константа там не экспортируется). Если списки
 * разойдутся, «под угрозой» и календарь начнут показывать разные конфликты.
 */
const BLOCKING_BOOKING_STATUSES: BookingStatus[] = ["PENDING_APPROVAL", "CONFIRMED", "ISSUED"];

/**
 * Горизонт поиска блокирующей брони. Дальше месяца смотреть смысла нет:
 * ремонт либо закончится, либо к тому сроку успеют докупить подмену.
 */
const RISK_HORIZON_DAYS = 30;

/** Сколько суток без записей в журнале работ делают ремонт «тихим». */
const QUIET_REPAIR_DAYS = 5;

/** Сколько неутверждённых расходов показывать списком (счётчик и сумма — по всем). */
const PENDING_EXPENSES_LIMIT = 20;

/**
 * Сколько активных ремонтов реально срывают ближайшую бронь (risk.level === "BLOCKS").
 *
 * Критерий тот же, что у per-repair `risk` в разделе мастерской: подмены на
 * ближайшую блокирующую бронь не хватает И срок либо не назначен, либо позже
 * даты выдачи. Если подмена есть — ремонт неприятен, но никого не срывает;
 * если срок раньше выдачи — успеваем, это «впритык», а не «сорвано».
 *
 * Считаем и позиции без штучного учёта (кабели, стойки): у них нет юнита, но
 * сорвать смену отсутствием кабеля можно ровно так же.
 */
async function countAtRiskRepairs(): Promise<number> {
  const repairs = await prisma.repair.findMany({
    where: { status: { in: [...ACTIVE_REPAIR_STATUSES] } },
    select: {
      expectedReadyAt: true,
      equipmentId: true,
      unit: { select: { equipmentId: true } },
      bookingItem: { select: { equipmentId: true } },
    },
  });

  // Позиция каталога: юнит → прямая ссылка → строка сметы. Ремонт, у которого
  // позиции не осталось вовсе, ничью бронь сорвать не может — он вне расчёта.
  const withEquipment = repairs
    .map((r) => ({
      expectedReadyAt: r.expectedReadyAt,
      equipmentId: r.unit?.equipmentId ?? r.equipmentId ?? r.bookingItem?.equipmentId ?? null,
    }))
    .filter((r): r is { expectedReadyAt: Date | null; equipmentId: string } => r.equipmentId !== null);

  if (withEquipment.length === 0) return 0;

  const equipmentIds = Array.from(new Set(withEquipment.map((r) => r.equipmentId)));
  const todayStart = moscowTodayStart();
  const horizonEnd = addDays(todayStart, RISK_HORIZON_DAYS);

  const [equipments, blockingItems] = await Promise.all([
    prisma.equipment.findMany({
      where: { id: { in: equipmentIds } },
      select: { id: true, stockTrackingMode: true, totalQuantity: true },
    }),
    // Только будущие выдачи: бронь, которая уже на руках у клиента, этим
    // ремонтом не срывается — оборудование по ней уже уехало.
    prisma.bookingItem.findMany({
      where: {
        equipmentId: { in: equipmentIds },
        booking: {
          status: { in: BLOCKING_BOOKING_STATUSES },
          deletedAt: null,
          startDate: { gte: todayStart, lte: horizonEnd },
        },
      },
      select: {
        equipmentId: true,
        quantity: true,
        booking: { select: { id: true, startDate: true } },
      },
    }),
  ]);

  const unitEquipmentIds = equipments.filter((e) => e.stockTrackingMode === "UNIT").map((e) => e.id);
  const countEquipmentIds = equipments.filter((e) => e.stockTrackingMode !== "UNIT").map((e) => e.id);
  const [usableUnits, lostCount, inRepairCount] = await Promise.all([
    getUsableUnitBaseMap(unitEquipmentIds),
    getLostCountByEquipmentMap(countEquipmentIds),
    getRepairCountByEquipmentMap(equipmentIds),
  ]);

  // Свободных единиц после вычета мастерской. У штучных позиций сломанный юнит
  // уже стоит в MAINTENANCE и в usableUnits не попал; getRepairCountByEquipmentMap
  // добирает безъюнитные ремонты, поэтому дважды ничего не вычитается.
  const sparesLeft = new Map<string, number>();
  for (const e of equipments) {
    const base =
      e.stockTrackingMode === "UNIT"
        ? (usableUnits.get(e.id) ?? 0)
        : e.totalQuantity - (lostCount.get(e.id) ?? 0);
    sparesLeft.set(e.id, Math.max(0, base - (inRepairCount.get(e.id) ?? 0)));
  }

  // Ближайшая блокирующая бронь на позицию + сколько штук она просит.
  // Одна бронь может просить позицию несколькими строками — суммируем внутри брони.
  const neededByBooking = new Map<string, Map<string, { startDate: Date; needed: number }>>();
  for (const bi of blockingItems) {
    if (!bi.equipmentId || !bi.booking) continue;
    let bookings = neededByBooking.get(bi.equipmentId);
    if (!bookings) {
      bookings = new Map();
      neededByBooking.set(bi.equipmentId, bookings);
    }
    const prev = bookings.get(bi.booking.id);
    bookings.set(bi.booking.id, {
      startDate: bi.booking.startDate,
      needed: (prev?.needed ?? 0) + bi.quantity,
    });
  }

  const nearestBooking = new Map<string, { startDate: Date; needed: number }>();
  for (const [equipmentId, bookings] of neededByBooking) {
    for (const b of bookings.values()) {
      const current = nearestBooking.get(equipmentId);
      if (!current || b.startDate < current.startDate) nearestBooking.set(equipmentId, b);
    }
  }

  return withEquipment.filter((r) => {
    const booking = nearestBooking.get(r.equipmentId);
    if (!booking) return false;                                          // блокирующих броней нет
    if (booking.needed <= (sparesLeft.get(r.equipmentId) ?? 0)) return false; // подмена есть
    return r.expectedReadyAt === null || r.expectedReadyAt > booking.startDate;
  }).length;
}

/**
 * GET /api/dashboard/repair-stats
 * Сводка мастерской:
 *   - openCount: открытые (WAITING_REPAIR/IN_REPAIR/WAITING_PARTS)
 *   - newCount: WAITING_REPAIR (то, что нужно взять в работу)
 *   - closedThisMonth: закрытые в текущем календарном месяце (CLOSED)
 *   - writtenOffThisMonth: списано в текущем месяце (WROTE_OFF)
 *   - atRiskCount: ремонты, срывающие ближайшую бронь (см. countAtRiskRepairs)
 *   - quietCount: «в ремонте», но без движения QUIET_REPAIR_DAYS суток
 *   - noEtaCount: активные ремонты без назначенного срока
 *   - spentThisMonth / spentPrevMonth: approved-расходы с linkedRepairId.
 *     Прошлый месяц нужен как база сравнения: «потрачено 46 800 ₽» само по себе
 *     не говорит ничего — много это или обычная норма, видно только рядом с прошлым.
 *   - pendingExpenses: расходы по ремонтам, которые никто не утвердил. Техник
 *     заводит их при закрытии карточки, KPI считает только approved — и владелец
 *     видит заниженную сумму, не зная, что часть трат висит непринятой.
 *   - readyForPickup: закрытые ремонты за неделю (общий источник с экраном
 *     «Смена» кладовщика — listReadyForPickup).
 *
 * Доступ — все три роли (rolesGuard на router-уровне), но денежные поля
 * (spent*, pendingExpenses) отдаются только SUPER_ADMIN: WAREHOUSE и TECHNICIAN
 * видят ту же сводку без экономики, как в витрине автопарка (routes/vehicles.ts).
 */
router.get("/repair-stats", async (req, res, next) => {
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
    const quietBefore = new Date(now.getTime() - QUIET_REPAIR_DAYS * 86400000);

    const spentWhere = { approved: true, linkedRepairId: { not: null } } as const;
    const pendingWhere = { approved: false, linkedRepairId: { not: null } } as const;

    const [
      openCount,
      newCount,
      noEtaCount,
      closedThisMonth,
      writtenOffThisMonth,
      thisMonthAgg,
      prevMonthAgg,
      inRepairRows,
      pendingAgg,
      pendingRows,
      atRiskCount,
      readyForPickup,
    ] = await Promise.all([
      prisma.repair.count({ where: { status: { in: [...ACTIVE_REPAIR_STATUSES] } } }),
      prisma.repair.count({ where: { status: "WAITING_REPAIR" } }),
      prisma.repair.count({
        where: { status: { in: [...ACTIVE_REPAIR_STATUSES] }, expectedReadyAt: null },
      }),
      prisma.repair.count({ where: { status: "CLOSED", closedAt: { gte: monthStart } } }),
      prisma.repair.count({ where: { status: "WROTE_OFF", closedAt: { gte: monthStart } } }),
      prisma.expense.aggregate({
        where: { ...spentWhere, expenseDate: { gte: monthStart } },
        _sum: { amount: true },
      }),
      prisma.expense.aggregate({
        where: { ...spentWhere, expenseDate: { gte: prevMonthStart, lt: monthStart } },
        _sum: { amount: true },
      }),
      // «Тихие» ремонты: взяли в работу и забыли. Последняя запись журнала, а
      // если журнала нет — момент заведения карточки: молчание с самого начала
      // тоже молчание.
      prisma.repair.findMany({
        where: { status: "IN_REPAIR" },
        select: {
          createdAt: true,
          workLog: { select: { loggedAt: true }, orderBy: { loggedAt: "desc" }, take: 1 },
        },
      }),
      prisma.expense.aggregate({ where: pendingWhere, _sum: { amount: true }, _count: true }),
      prisma.expense.findMany({
        where: pendingWhere,
        orderBy: { createdAt: "desc" },
        take: PENDING_EXPENSES_LIMIT,
        select: {
          id: true,
          name: true,
          amount: true,
          createdBy: true,
          createdAt: true,
          linkedRepairId: true,
        },
      }),
      countAtRiskRepairs(),
      listReadyForPickup(),
    ]);

    const quietCount = inRepairRows.filter(
      (r) => (r.workLog[0]?.loggedAt ?? r.createdAt) < quietBefore,
    ).length;

    // createdBy хранит AdminUser.id, но у расхода, заведённого со склада по
    // PIN-входу, там лежит имя кладовщика (двойное пространство имён, см. CLAUDE.md).
    // Незнакомое значение печатаем как есть — это имя, а не потерянная ссылка.
    const creatorIds = Array.from(
      new Set(pendingRows.map((e) => e.createdBy).filter((x): x is string => Boolean(x))),
    );
    const creators = creatorIds.length
      ? await prisma.adminUser.findMany({
          where: { id: { in: creatorIds } },
          select: { id: true, username: true },
        })
      : [];
    const nameById = new Map(creators.map((u) => [u.id, u.username]));

    const pendingExpenses = {
      count: pendingAgg._count,
      total: pendingAgg._sum.amount?.toString() ?? "0",
      items: pendingRows.map((e) => ({
        id: e.id,
        title: e.name,
        amount: e.amount.toString(),
        createdByName: e.createdBy ? (nameById.get(e.createdBy) ?? e.createdBy) : null,
        createdAt: e.createdAt.toISOString(),
        repairId: e.linkedRepairId,
      })),
    };

    const canSeeMoney = req.adminUser?.role === "SUPER_ADMIN" || req.botAccess === true;

    res.json({
      openCount,
      newCount,
      closedThisMonth,
      writtenOffThisMonth,
      atRiskCount,
      quietCount,
      noEtaCount,
      readyForPickup,
      spentThisMonth: canSeeMoney ? (thisMonthAgg._sum.amount?.toString() ?? "0") : null,
      spentPrevMonth: canSeeMoney ? (prevMonthAgg._sum.amount?.toString() ?? "0") : null,
      pendingExpenses: canSeeMoney ? pendingExpenses : null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/dashboard/task-stats
 * Статистика задач для текущего пользователя.
 *
 * myOpen — открытые задачи, назначенные на текущего пользователя.
 * myOverdue — просроченные открытые задачи (dueDate < сегодня по Москве).
 * myToday — на сегодня: dueDate сегодня по Москве ИЛИ срочные без даты.
 * myUrgent — все срочные открытые задачи.
 *
 * Доступ — все три роли (rolesGuard на router-уровне).
 */
router.get("/task-stats", rolesGuard(["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"]), async (req, res, next) => {
  try {
    const userId = req.adminUser!.userId;
    const todayStart = moscowTodayStart();
    const tomorrowStart = addDays(todayStart, 1);

    const [myOpen, myOverdue, myToday, myUrgent] = await Promise.all([
      prisma.task.count({ where: { status: "OPEN", assignedTo: userId } }),
      prisma.task.count({ where: { status: "OPEN", assignedTo: userId, dueDate: { lt: todayStart } } }),
      prisma.task.count({
        where: {
          status: "OPEN",
          assignedTo: userId,
          OR: [
            { dueDate: { gte: todayStart, lt: tomorrowStart } }, // due today (Moscow)
            { dueDate: null, urgent: true },                      // urgent undated → promotes to today
          ],
        },
      }),
      prisma.task.count({ where: { status: "OPEN", assignedTo: userId, urgent: true } }),
    ]);

    res.json({ myOpen, myOverdue, myToday, myUrgent });
  } catch (err) {
    next(err);
  }
});

export { router as dashboardRouter };
