import Decimal from "decimal.js";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { toMoscowDateString } from "../utils/moscowDate";
import { getAvailability } from "./availability";
import { recomputeProjectFinance } from "./projectFinance";
import { writeAuditEntry } from "./audit";
import {
  defaultDayKind,
  nextDate,
  priceProject,
  projectDates,
  projectMidnight,
  suggestedPeriodEnd,
  type ProjectPriceLine,
} from "./projectPricing";

type Tx = Prisma.TransactionClient;
const include = {
  booking: { include: { client: true } },
  days: { orderBy: { date: "asc" as const } },
  lots: {
    include: { returns: true, units: true },
    orderBy: { createdAt: "asc" as const },
  },
  periods: {
    orderBy: { createdAt: "asc" as const },
    include: { invoice: true },
  },
  charges: true,
  events: { orderBy: { createdAt: "desc" as const }, take: 100 },
};
async function read(tx: Tx, id: string) {
  const p = await tx.bookingProject.findUnique({
    where: { bookingId: id },
    include,
  });
  if (!p || p.booking.deletedAt) throw new HttpError(404, "Проект не найден");
  return p;
}
type Project = Awaited<ReturnType<typeof read>>;
function open(p: Project) {
  if (["RETURNED", "CANCELLED"].includes(p.booking.status))
    throw new HttpError(409, "Проект завершён");
}
function lockedThrough(p: Project) {
  return (
    p.periods
      .filter((p) => p.kind === "PERIOD")
      .map((p) => p.throughDate)
      .sort()
      .at(-1) ?? ""
  );
}
function unlocked(p: Project, date: string) {
  if (date <= lockedThrough(p))
    throw new HttpError(
      409,
      "Этот период уже закрыт. Оформите корректировку в расчётах.",
      "PROJECT_PERIOD_LOCKED",
    );
}
async function event(
  tx: Tx,
  id: string,
  userId: string,
  kind: string,
  text: string,
) {
  await tx.projectEvent.create({
    data: { bookingId: id, createdBy: userId, kind, text },
  });
  if (
    await tx.adminUser.findUnique({
      where: { id: userId },
      select: { id: true },
    })
  )
    await writeAuditEntry({
      tx,
      userId,
      action: "PROJECT_" + kind,
      entityType: "Booking",
      entityId: id,
      before: null,
      after: { text },
    });
}
async function mutate<T>(
  id: string,
  revision: number,
  fn: (tx: Tx, p: Project) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      const updated = await tx.bookingProject.updateMany({
        where: { bookingId: id, revision },
        data: { revision: { increment: 1 } },
      });
      if (!updated.count)
        throw new HttpError(
          409,
          "Проект изменился. Обновите страницу и повторите действие.",
          "PROJECT_CHANGED",
        );
      return fn(tx, await read(tx, id));
    },
    { timeout: 20_000 },
  );
}
function bounds(p: Project) {
  return {
    from: toMoscowDateString(p.booking.startDate),
    through: nextDate(toMoscowDateString(p.booking.endDate), -1),
  };
}
function lotIn(p: Project, id: string) {
  const lot = p.lots.find((l) => l.id === id);
  if (!lot) throw new HttpError(404, "Поставка не найдена");
  return lot;
}
async function capacity(tx: Tx, lot: Project["lots"][number]) {
  const rows = await getAvailability({
    startDate: projectMidnight(lot.fromDate),
    endDate: new Date(projectMidnight(nextDate(lot.throughDate)).getTime() - 1),
    equipmentIds: [lot.equipmentId],
    excludeProjectLotId: lot.id,
    tx,
  });
  const needed = lot.quantity - lot.returns.reduce((s, r) => s + r.quantity, 0);
  if (!rows[0] || rows[0].availableQuantity < needed)
    throw new HttpError(
      409,
      `Недостаточно «${lot.nameSnapshot}» на выбранные даты: нужно ${needed}, доступно ${rows[0]?.availableQuantity ?? 0}`,
      "PROJECT_STOCK_CONFLICT",
    );
}
function periodQuote(
  p: Project,
  fromDate: string,
  throughDate: string,
  actual: boolean,
) {
  const priced = priceProject({
    fromDate,
    throughDate,
    restFactor: p.restFactor,
    days: p.days,
    lots: p.lots,
    actual,
  });
  const extra = p.charges
    .filter((c) => c.date >= fromDate && c.date <= throughDate)
    .map((c) => ({
      name: c.description,
      quantity: 1,
      fromDate: c.date,
      throughDate: c.date,
      shootDays: 0,
      restDays: 0,
      restFactor: "0",
      rate: c.amount.toString(),
      amount: c.amount.toString(),
    }));
  const lines: ProjectPriceLine[] = [...priced.lines, ...extra];
  const base = lines.reduce((s, l) => s.add(l.amount), new Decimal(0));
  const surcharge =
    p.booking.paymentForm === "CASHLESS"
      ? base
          .mul(p.booking.cashlessSurchargePercent?.toString() ?? "0")
          .div(100)
          .toDecimalPlaces(2)
      : new Decimal(0);
  if (surcharge.gt(0))
    lines.push({
      name: `Надбавка за безнал ${p.booking.cashlessSurchargePercent}%`,
      quantity: 1,
      fromDate,
      throughDate,
      shootDays: 0,
      restDays: 0,
      restFactor: "0",
      rate: surcharge.toFixed(2),
      amount: surcharge.toFixed(2),
    });
  const corrections = actual
    ? []
    : p.periods.filter((x) => x.kind === "CORRECTION");
  for (const correction of corrections)
    lines.push({
      name: "Корректировка закрытого периода",
      quantity: 1,
      fromDate: correction.fromDate,
      throughDate: correction.throughDate,
      shootDays: 0,
      restDays: 0,
      restFactor: "0",
      rate: correction.amount.toString(),
      amount: correction.amount.toString(),
    });
  return {
    lines,
    total: corrections
      .reduce((sum, x) => sum.add(x.amount.toString()), base.add(surcharge))
      .toFixed(2),
  };
}
export async function createProject(
  args: {
    clientId: string;
    projectName: string;
    fromDate: string;
    throughDate: string;
    restFactor: number;
    billingCycle: string;
    paymentTermsDays: number;
    paymentForm: "CASH" | "CASHLESS";
    cashlessSurchargePercent: number;
  },
  userId: string,
) {
  const dates = projectDates(args.fromDate, args.throughDate);
  return prisma.$transaction(async (tx) => {
    if (!(await tx.client.findUnique({ where: { id: args.clientId } })))
      throw new HttpError(404, "Клиент не найден");
    const b = await tx.booking.create({
      data: {
        clientId: args.clientId,
        projectName: args.projectName,
        mode: "PROJECT",
        startDate: projectMidnight(args.fromDate),
        endDate: projectMidnight(nextDate(args.throughDate)),
        status: "DRAFT",
        legacyFinance: false,
        paymentForm: args.paymentForm,
        cashlessSurchargePercent:
          args.paymentForm === "CASHLESS"
            ? args.cashlessSurchargePercent
            : null,
        project: {
          create: {
            restFactor: args.restFactor,
            billingCycle: args.billingCycle,
            paymentTermsDays: args.paymentTermsDays,
            days: {
              create: dates.map((date) => ({
                date,
                kind: defaultDayKind(date),
              })),
            },
          },
        },
      },
    });
    await event(tx, b.id, userId, "CREATED", "Создан длинный проект");
    return { id: b.id };
  });
}
export async function projectDetail(id: string) {
  return prisma.$transaction(
    async (tx) => {
      const p = await read(tx, id);
      const b = bounds(p);
      const finance = await recomputeProjectFinance(id, tx);
      const nextFrom = lockedThrough(p) ? nextDate(lockedThrough(p)) : b.from;
      const nextThrough =
        nextFrom <= b.through
          ? suggestedPeriodEnd(nextFrom, p.billingCycle, b.through)
          : null;
      const ids = [...new Set(p.lots.map((l) => l.equipmentId))];
      const units = await tx.equipmentUnit.findMany({
        where: { equipmentId: { in: ids } },
        select: {
          id: true,
          equipmentId: true,
          status: true,
          internalInventoryNumber: true,
        },
      });
      const equipment = await tx.equipment.findMany({
        where: { id: { in: ids } },
        select: { id: true, stockTrackingMode: true },
      });
      const payments = await tx.payment.findMany({
        where: { bookingId: id },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      return {
        ...p,
        lots: p.lots.map((l) => ({
          ...l,
          trackingMode:
            equipment.find((e) => e.id === l.equipmentId)?.stockTrackingMode ??
            "COUNT",
        })),
        booking: { ...p.booking, ...finance.booking, client: p.booking.client },
        units,
        payments,
        allocations: finance.allocations,
        advance: finance.advance,
        forecast: periodQuote(p, b.from, b.through, false),
        nextPeriod: nextThrough
          ? {
              fromDate: nextFrom,
              throughDate: nextThrough,
              ...periodQuote(p, nextFrom, nextThrough, true),
            }
          : null,
        fromDate: b.from,
        throughDate: b.through,
      };
    },
    { timeout: 20_000 },
  );
}
export async function addProjectLot(
  id: string,
  args: {
    revision: number;
    equipmentId: string;
    quantity: number;
    ratePerShift?: number;
    fromDate: string;
    throughDate: string;
  },
  userId: string,
) {
  projectDates(args.fromDate, args.throughDate);
  return mutate(id, args.revision, async (tx, p) => {
    open(p);
    unlocked(p, args.fromDate);
    const b = bounds(p);
    if (args.fromDate < b.from || args.throughDate > b.through)
      throw new HttpError(
        400,
        "Даты поставки должны быть внутри срока проекта",
      );
    const eq = await tx.equipment.findUnique({
      where: { id: args.equipmentId },
    });
    if (!eq) throw new HttpError(404, "Оборудование не найдено");
    const lot = await tx.projectLot.create({
      data: {
        bookingId: id,
        equipmentId: eq.id,
        nameSnapshot: eq.name,
        quantity: args.quantity,
        ratePerShift: args.ratePerShift ?? eq.rentalRatePerShift,
        fromDate: args.fromDate,
        throughDate: args.throughDate,
      },
      include: { returns: true, units: true },
    });
    if (p.booking.status !== "DRAFT") await capacity(tx, lot);
    await event(
      tx,
      id,
      userId,
      "LOT_PLANNED",
      `Запланирован добор: ${eq.name} × ${args.quantity}, ${args.fromDate} — ${args.throughDate}`,
    );
    return lot;
  });
}
export async function confirmProject(
  id: string,
  revision: number,
  userId: string,
) {
  return mutate(id, revision, async (tx, p) => {
    if (p.booking.status !== "DRAFT")
      throw new HttpError(409, "Проект уже забронирован");
    if (!p.lots.some((l) => l.status !== "CANCELLED"))
      throw new HttpError(400, "Добавьте оборудование");
    await tx.booking.update({
      where: { id },
      data: { status: "CONFIRMED", confirmedAt: new Date() },
    });
    for (const lot of p.lots.filter((l) => l.status !== "CANCELLED"))
      await capacity(tx, lot);
    await event(
      tx,
      id,
      userId,
      "CONFIRMED",
      "Проект забронирован, оборудование зарезервировано",
    );
  });
}
export async function updateProjectDays(
  id: string,
  args: {
    revision: number;
    fromDate: string;
    throughDate: string;
    kind: "SHOOT" | "REST" | "WEEKDAYS";
  },
  userId: string,
) {
  const dates = projectDates(args.fromDate, args.throughDate);
  return mutate(id, args.revision, async (tx, p) => {
    open(p);
    unlocked(p, args.fromDate);
    const b = bounds(p);
    if (args.fromDate < b.from || args.throughDate > b.through)
      throw new HttpError(400, "Даты вне проекта");
    for (const date of dates)
      await tx.projectDay.update({
        where: { bookingId_date: { bookingId: id, date } },
        data: {
          kind: args.kind === "WEEKDAYS" ? defaultDayKind(date) : args.kind,
        },
      });
    await event(
      tx,
      id,
      userId,
      "CALENDAR",
      `Изменён календарь ${args.fromDate} — ${args.throughDate}: ${args.kind === "REST" ? "выходные" : args.kind === "SHOOT" ? "съёмочные" : "шаблон 5/2"}`,
    );
  });
}
export async function issueProjectLot(
  id: string,
  lotId: string,
  args: { revision: number; fromDate: string; unitIds: string[] },
  userId: string,
) {
  return mutate(id, args.revision, async (tx, p) => {
    open(p);
    if (!["CONFIRMED", "ISSUED"].includes(p.booking.status))
      throw new HttpError(409, "Сначала забронируйте проект");
    const lot = lotIn(p, lotId);
    if (lot.status !== "PLANNED")
      throw new HttpError(409, "Эта поставка уже выдана или отменена");
    const today = toMoscowDateString(new Date());
    if (
      args.fromDate > today ||
      args.fromDate < bounds(p).from ||
      args.fromDate > lot.throughDate
    )
      throw new HttpError(
        400,
        "Первый оплачиваемый день должен быть внутри поставки и не позже сегодня",
      );
    unlocked(p, args.fromDate);
    const changed = { ...lot, fromDate: args.fromDate };
    await capacity(tx, changed);
    const eq = await tx.equipment.findUniqueOrThrow({
      where: { id: lot.equipmentId },
    });
    if (eq.stockTrackingMode === "COUNT") {
      const { getLostCountByEquipmentMap, getRepairCountByEquipmentMap } =
        await import("./availability");
      const lost =
        (await getLostCountByEquipmentMap([eq.id], tx)).get(eq.id) ?? 0;
      const repair =
        (await getRepairCountByEquipmentMap([eq.id], tx)).get(eq.id) ?? 0;
      const ordinary = await tx.bookingItem.aggregate({
        where: {
          equipmentId: eq.id,
          booking: { mode: "STANDARD", status: "ISSUED" },
        },
        _sum: { quantity: true },
      });
      const held = await tx.projectLot.findMany({
        where: { equipmentId: eq.id, status: "ISSUED" },
        include: { returns: true },
      });
      const occupied = held.reduce(
        (sum, l) =>
          sum + l.quantity - l.returns.reduce((n, r) => n + r.quantity, 0),
        ordinary._sum.quantity ?? 0,
      );
      if (eq.totalQuantity - lost - repair - occupied < lot.quantity)
        throw new HttpError(
          409,
          "На складе физически недостаточно оборудования: есть невозвращённые поставки",
          "PROJECT_STOCK_CONFLICT",
        );
    }
    if (eq.stockTrackingMode === "UNIT") {
      if (new Set(args.unitIds).size !== lot.quantity)
        throw new HttpError(400, `Выберите ${lot.quantity} разных экземпляров`);
      const units = await tx.equipmentUnit.findMany({
        where: {
          id: { in: args.unitIds },
          equipmentId: eq.id,
          status: "AVAILABLE",
        },
      });
      if (units.length !== lot.quantity)
        throw new HttpError(409, "Один из экземпляров недоступен");
      const reserved = await tx.bookingItemUnit.count({
        where: {
          equipmentUnitId: { in: args.unitIds },
          returnedAt: null,
          bookingItem: {
            booking: {
              deletedAt: null,
              status: { in: ["PENDING_APPROVAL", "CONFIRMED", "ISSUED"] },
              startDate: { lte: projectMidnight(nextDate(lot.throughDate)) },
              endDate: { gte: new Date() },
            },
          },
        },
      });
      if (reserved)
        throw new HttpError(
          409,
          "Выбранный экземпляр зарезервирован другой бронью",
        );
      await tx.projectLotUnit.createMany({
        data: args.unitIds.map((equipmentUnitId) => ({
          lotId,
          equipmentUnitId,
        })),
      });
      await tx.equipmentUnit.updateMany({
        where: { id: { in: args.unitIds }, status: "AVAILABLE" },
        data: { status: "ISSUED" },
      });
    }
    await tx.projectLot.update({
      where: { id: lotId },
      data: { status: "ISSUED", issuedAt: new Date(), fromDate: args.fromDate },
    });
    await tx.booking.update({
      where: { id },
      data: { status: "ISSUED", issuedAt: p.booking.issuedAt ?? new Date() },
    });
    await event(
      tx,
      id,
      userId,
      "ISSUED",
      `Выдано: ${lot.nameSnapshot} × ${lot.quantity}; первый оплачиваемый день ${args.fromDate}`,
    );
  });
}
export async function returnProjectLot(
  id: string,
  lotId: string,
  args: {
    revision: number;
    quantity: number;
    lastBillableDate: string;
    unitIds: string[];
    condition: "OK" | "REPAIR" | "MISSING";
    reason?: string;
  },
  userId: string,
) {
  return mutate(id, args.revision, async (tx, p) => {
    open(p);
    const lot = lotIn(p, lotId);
    const remaining =
      lot.quantity - lot.returns.reduce((s, r) => s + r.quantity, 0);
    if (lot.status !== "ISSUED" || args.quantity > remaining)
      throw new HttpError(
        409,
        "Нельзя вернуть больше, чем находится у клиента",
      );
    if (
      args.lastBillableDate < lot.fromDate ||
      args.lastBillableDate > toMoscowDateString(new Date())
    )
      throw new HttpError(400, "Проверьте последний оплачиваемый день");
    // Возврат сразу после закрытого дня допустим: меняется только будущее.
    if (args.lastBillableDate < lockedThrough(p))
      throw new HttpError(
        409,
        "Дата возврата меняет закрытый период. Сначала выберите последний закрытый день, затем оформите корректировку.",
      );
    const eq = await tx.equipment.findUniqueOrThrow({
      where: { id: lot.equipmentId },
    });
    if (
      args.condition !== "OK" &&
      (!args.reason || args.reason.trim().length < 3)
    )
      throw new HttpError(400, "Укажите причину повреждения или недостачи");
    if (eq.stockTrackingMode === "UNIT") {
      const active = lot.units
        .filter((u) => !u.returnedAt)
        .map((u) => u.equipmentUnitId);
      if (
        new Set(args.unitIds).size !== args.quantity ||
        args.unitIds.some((i) => !active.includes(i))
      )
        throw new HttpError(
          400,
          "Выберите возвращаемые экземпляры этой поставки",
        );
      await tx.projectLotUnit.updateMany({
        where: {
          lotId,
          equipmentUnitId: { in: args.unitIds },
          returnedAt: null,
        },
        data: { returnedAt: new Date() },
      });
      await tx.equipmentUnit.updateMany({
        where: { id: { in: args.unitIds }, status: "ISSUED" },
        data: {
          status:
            args.condition === "REPAIR"
              ? "MAINTENANCE"
              : args.condition === "MISSING"
                ? "MISSING"
                : "AVAILABLE",
        },
      });
    }
    if (args.condition === "REPAIR") {
      const rows =
        eq.stockTrackingMode === "UNIT"
          ? args.unitIds.map((unitId) => ({ unitId, quantity: 1 }))
          : [{ unitId: null, quantity: args.quantity }];
      for (const row of rows)
        await tx.repair.create({
          data: {
            ...row,
            equipmentId: eq.id,
            sourceBookingId: id,
            reason: args.reason!,
            createdBy: userId,
          },
        });
    }
    if (args.condition === "MISSING") {
      const item = await tx.bookingItem.upsert({
        where: { bookingId_equipmentId: { bookingId: id, equipmentId: eq.id } },
        create: { bookingId: id, equipmentId: eq.id, quantity: 0 },
        update: {},
      });
      const rows =
        eq.stockTrackingMode === "UNIT"
          ? args.unitIds.map((equipmentUnitId) => ({
              equipmentUnitId,
              quantity: 1,
            }))
          : [{ equipmentUnitId: null, quantity: args.quantity }];
      for (const row of rows)
        await tx.problemItem.create({
          data: {
            ...row,
            bookingItemId: item.id,
            sourceBookingId: id,
            reason: "LOST",
            comment: args.reason!,
            createdBy: userId,
          },
        });
    }
    await tx.projectLotReturn.create({
      data: {
        lotId,
        quantity: args.quantity,
        lastBillableDate: args.lastBillableDate,
        createdBy: userId,
      },
    });
    await tx.projectLot.update({
      where: { id: lotId },
      data: {
        ...(remaining === args.quantity ? { status: "RETURNED" } : {}),
        throughDate:
          args.lastBillableDate > lot.throughDate
            ? args.lastBillableDate
            : lot.throughDate,
      },
    });
    await extendProjectDates(tx, p, args.lastBillableDate);
    await event(
      tx,
      id,
      userId,
      "RETURNED",
      `${args.condition === "MISSING" ? "Недостача" : args.condition === "REPAIR" ? "Принято в ремонт" : "Принято"}: ${lot.nameSnapshot} × ${args.quantity}; последний оплачиваемый день ${args.lastBillableDate}`,
    );
  });
}
async function extendProjectDates(tx: Tx, p: Project, throughDate: string) {
  const b = bounds(p);
  if (throughDate <= b.through) return;
  projectDates(b.from, throughDate);
  await tx.projectDay.createMany({
    data: projectDates(nextDate(b.through), throughDate).map((date) => ({
      bookingId: p.bookingId,
      date,
      kind: defaultDayKind(date),
    })),
  });
  await tx.booking.update({
    where: { id: p.bookingId },
    data: { endDate: projectMidnight(nextDate(throughDate)) },
  });
}
export async function changeProjectLot(
  id: string,
  lotId: string,
  args: { revision: number; action: "CANCEL" | "EXTEND"; throughDate?: string },
  userId: string,
) {
  return mutate(id, args.revision, async (tx, p) => {
    open(p);
    const lot = lotIn(p, lotId);
    if (args.action === "CANCEL") {
      if (lot.status !== "PLANNED")
        throw new HttpError(409, "Отменить можно только невыданную поставку");
      await tx.projectLot.update({
        where: { id: lotId },
        data: { status: "CANCELLED" },
      });
      await event(
        tx,
        id,
        userId,
        "CANCELLED_LOT",
        `Отменена поставка: ${lot.nameSnapshot} × ${lot.quantity}`,
      );
    } else {
      if (
        !["PLANNED", "ISSUED"].includes(lot.status) ||
        !args.throughDate ||
        args.throughDate <= lot.throughDate
      )
        throw new HttpError(400, "Укажите более поздний последний день");
      projectDates(lot.fromDate, args.throughDate);
      const changed = { ...lot, throughDate: args.throughDate };
      if (p.booking.status !== "DRAFT") await capacity(tx, changed);
      await extendProjectDates(tx, p, args.throughDate);
      await tx.projectLot.update({
        where: { id: lotId },
        data: { throughDate: args.throughDate },
      });
      await event(
        tx,
        id,
        userId,
        "EXTENDED",
        `Продлена поставка «${lot.nameSnapshot}» до ${args.throughDate}`,
      );
    }
  });
}
export async function addProjectCharge(
  id: string,
  args: { revision: number; date: string; description: string; amount: number },
  userId: string,
) {
  return mutate(id, args.revision, async (tx, p) => {
    open(p);
    unlocked(p, args.date);
    const b = bounds(p);
    if (args.date < b.from || args.date > b.through)
      throw new HttpError(400, "Дата услуги вне проекта");
    await tx.projectCharge.create({
      data: {
        bookingId: id,
        date: args.date,
        description: args.description,
        amount: args.amount,
      },
    });
    await event(
      tx,
      id,
      userId,
      "CHARGE",
      `Услуга: ${args.description}, ${args.amount} ₽`,
    );
  });
}
export async function previewProjectPeriod(id: string, throughDate: string) {
  return prisma.$transaction(async (tx) => {
    const p = await read(tx, id);
    const fromDate = lockedThrough(p)
      ? nextDate(lockedThrough(p))
      : bounds(p).from;
    projectDates(fromDate, throughDate);
    if (throughDate > bounds(p).through)
      throw new HttpError(400, "Период выходит за срок проекта");
    return {
      fromDate,
      throughDate,
      ...periodQuote(p, fromDate, throughDate, true),
    };
  });
}
export async function closeProjectPeriod(
  id: string,
  args: { revision: number; throughDate: string; requestKey: string },
  userId: string,
) {
  // Повтор запроса с тем же ключом возвращает тот же документ.
  const existing = await prisma.projectBillingPeriod.findUnique({
    where: {
      bookingId_requestKey: { bookingId: id, requestKey: args.requestKey },
    },
  });
  if (existing) {
    if (existing.kind !== "PERIOD" || existing.throughDate !== args.throughDate)
      throw new HttpError(
        409,
        "Ключ запроса уже использован для другого расчёта. Откройте действие заново.",
      );
    return existing;
  }
  return mutate(id, args.revision, async (tx, p) => {
    if (!["CONFIRMED", "ISSUED", "RETURNED"].includes(p.booking.status))
      throw new HttpError(409, "Сначала забронируйте проект");
    const fromDate = lockedThrough(p)
      ? nextDate(lockedThrough(p))
      : bounds(p).from;
    projectDates(fromDate, args.throughDate);
    if (
      args.throughDate > toMoscowDateString(new Date()) ||
      args.throughDate > bounds(p).through
    )
      throw new HttpError(400, "Нельзя закрыть будущий период");
    if (
      p.lots.some(
        (l) => l.status === "PLANNED" && l.fromDate <= args.throughDate,
      )
    )
      throw new HttpError(
        409,
        "В периоде есть невыданные поставки. Выдайте или отмените их до закрытия.",
      );
    if (
      p.lots.some(
        (l) => l.status === "ISSUED" && l.throughDate < args.throughDate,
      )
    )
      throw new HttpError(
        409,
        "Есть просроченный возврат. Продлите поставку или подтвердите приёмку.",
      );
    const quote = periodQuote(p, fromDate, args.throughDate, true);
    // Payment is due through the end of the agreed Moscow calendar day.
    const dueDate = new Date(
      projectMidnight(
        nextDate(args.throughDate, p.paymentTermsDays + 1),
      ).getTime() - 1,
    );
    const n = p.periods.filter((x) => x.kind === "PERIOD").length + 1;
    const number = `ПР-${id.slice(-8).toUpperCase()}-${String(n).padStart(3, "0")}`;
    const invoice = await tx.invoice.create({
      data: {
        number,
        bookingId: id,
        kind: "PERIOD",
        status: "ISSUED",
        total: quote.total,
        dueDate,
        issuedAt: new Date(),
        createdBy: userId,
        notes: `${fromDate} — ${args.throughDate}`,
      },
    });
    const seller = await tx.organizationSettings.findUnique({
      where: { id: "singleton" },
    });
    const documentJson = JSON.stringify({
      projectName: p.booking.projectName,
      client: p.booking.client,
      seller,
    });
    const period = await tx.projectBillingPeriod.create({
      data: {
        bookingId: id,
        requestKey: args.requestKey,
        fromDate,
        throughDate: args.throughDate,
        amount: quote.total,
        linesJson: JSON.stringify(quote.lines),
        documentJson,
        dueDate,
        invoiceId: invoice.id,
        createdBy: userId,
      },
    });
    await recomputeProjectFinance(id, tx);
    await event(
      tx,
      id,
      userId,
      "PERIOD_CLOSED",
      `Закрыт период ${fromDate} — ${args.throughDate}: ${quote.total} ₽, ${number}`,
    );
    return period;
  });
}
export async function correctProjectPeriod(
  id: string,
  periodId: string,
  args: {
    revision: number;
    amount: number;
    reason: string;
    requestKey: string;
  },
  userId: string,
) {
  const prior = await prisma.projectBillingPeriod.findUnique({
    where: {
      bookingId_requestKey: { bookingId: id, requestKey: args.requestKey },
    },
  });
  if (prior) {
    if (
      prior.kind !== "CORRECTION" ||
      prior.correctsId !== periodId ||
      !new Decimal(prior.amount.toString()).eq(args.amount) ||
      JSON.parse(prior.linesJson)[0]?.name !== args.reason
    )
      throw new HttpError(
        409,
        "Ключ запроса уже использован для другой корректировки. Откройте действие заново.",
      );
    return prior;
  }
  return mutate(id, args.revision, async (tx, p) => {
    const period = p.periods.find(
      (x) => x.id === periodId && x.kind === "PERIOD",
    );
    if (!period) throw new HttpError(404, "Период не найден");
    const corrected = p.periods
      .filter((x) => x.correctsId === periodId)
      .reduce(
        (s, x) => s.add(x.amount.toString()),
        new Decimal(period.amount.toString()),
      )
      .add(args.amount);
    if (corrected.lt(0))
      throw new HttpError(
        400,
        "Корректировка не может сделать начисление отрицательным",
      );
    const row = await tx.projectBillingPeriod.create({
      data: {
        bookingId: id,
        kind: "CORRECTION",
        correctsId: periodId,
        documentJson: period.documentJson,
        requestKey: args.requestKey,
        fromDate: period.fromDate,
        throughDate: period.throughDate,
        amount: args.amount,
        linesJson: JSON.stringify([
          {
            name: args.reason,
            amount: String(args.amount),
            quantity: 1,
            fromDate: period.fromDate,
            throughDate: period.throughDate,
          },
        ]),
        dueDate: period.dueDate,
        createdBy: userId,
      },
    });
    await recomputeProjectFinance(id, tx);
    await event(
      tx,
      id,
      userId,
      "CORRECTION",
      `Корректировка ${args.amount} ₽: ${args.reason}`,
    );
    return row;
  });
}
export async function recordProjectPayment(
  id: string,
  args: {
    revision: number;
    amount: number;
    method: "CASH" | "BANK_TRANSFER" | "CARD" | "OTHER";
    comment?: string;
  },
  userId: string,
) {
  return mutate(id, args.revision, async (tx, p) => {
    if (p.booking.status === "CANCELLED")
      throw new HttpError(409, "Проект отменён");
    await tx.payment.create({
      data: {
        bookingId: id,
        amount: args.amount,
        direction: "INCOME",
        status: "RECEIVED",
        paymentMethod: args.method,
        method: args.method,
        receivedAt: new Date(),
        paymentDate: new Date(),
        comment: args.comment,
        createdBy: userId,
      },
    });
    await recomputeProjectFinance(id, tx);
    await event(
      tx,
      id,
      userId,
      "PAYMENT",
      `Принята оплата ${args.amount} ₽. Зачёт по срокам оплаты периодов.`,
    );
  });
}
export async function cancelProject(
  id: string,
  revision: number,
  userId: string,
) {
  return mutate(id, revision, async (tx, p) => {
    open(p);
    if (p.lots.some((l) => l.issuedAt) || p.periods.length)
      throw new HttpError(
        409,
        "По проекту уже была работа. Примите оборудование и завершите проект.",
      );
    const finance = await recomputeProjectFinance(id, tx);
    if (Number(finance.booking.amountPaid) > 0)
      throw new HttpError(
        409,
        "Сначала оформите возврат аванса в журнале платежей.",
      );
    await tx.projectLot.updateMany({
      where: { bookingId: id, status: "PLANNED" },
      data: { status: "CANCELLED" },
    });
    await tx.booking.update({ where: { id }, data: { status: "CANCELLED" } });
    await event(
      tx,
      id,
      userId,
      "CANCELLED",
      "Проект отменён до первой выдачи; резервы сняты.",
    );
  });
}

export async function finishProject(
  id: string,
  revision: number,
  userId: string,
) {
  return mutate(id, revision, async (tx, p) => {
    open(p);
    if (p.lots.some((l) => ["PLANNED", "ISSUED"].includes(l.status)))
      throw new HttpError(
        409,
        "Сначала примите выданное оборудование и отмените невыданные поставки",
      );
    await tx.booking.update({ where: { id }, data: { status: "RETURNED" } });
    await event(
      tx,
      id,
      userId,
      "FINISHED",
      "Складской цикл проекта завершён. Расчёты остаются доступны.",
    );
  });
}

/** Складская выборка без ставок, финансов и реквизитов клиента. */
export async function projectWarehouseOperations() {
  const lots = await prisma.projectLot.findMany({
    where: {
      status: { in: ["PLANNED", "ISSUED"] },
      project: {
        booking: { deletedAt: null, status: { in: ["CONFIRMED", "ISSUED"] } },
      },
    },
    include: {
      returns: true,
      units: true,
      equipment: {
        select: {
          stockTrackingMode: true,
          units: {
            select: { id: true, status: true, internalInventoryNumber: true },
          },
        },
      },
      project: {
        select: {
          revision: true,
          booking: {
            select: { projectName: true, client: { select: { name: true } } },
          },
        },
      },
    },
    orderBy: [{ fromDate: "asc" }, { createdAt: "asc" }],
  });
  return lots.map((l) => ({
    id: l.id,
    bookingId: l.bookingId,
    revision: l.project.revision,
    name: l.nameSnapshot,
    projectName: l.project.booking.projectName,
    clientName: l.project.booking.client.name,
    status: l.status,
    fromDate: l.fromDate,
    throughDate: l.throughDate,
    quantity: l.quantity,
    remaining: l.quantity - l.returns.reduce((s, r) => s + r.quantity, 0),
    trackingMode: l.equipment.stockTrackingMode,
    units: l.equipment.units
      .filter((u) =>
        l.status === "PLANNED"
          ? u.status === "AVAILABLE"
          : l.units.some((a) => a.equipmentUnitId === u.id && !a.returnedAt),
      )
      .map((u) => ({
        id: u.id,
        label: u.internalInventoryNumber || u.id.slice(-8),
      })),
  }));
}
