import type { BookingIssue, BookingIssueSummary, BookingIssuesResponse } from "@light-rental/shared";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { toMoscowDateString } from "../utils/moscowDate";
import { resolveActorNames, actorName } from "./repairView";

const closedRepairs = ["CLOSED", "WROTE_OFF"];
const closedProblems = ["FOUND", "NOT_FOUND", "WROTE_OFF"];
const reasons: Record<string, string> = {
  LEFT_ON_SITE: "Осталось на площадке", LOST: "Потеряно", STOLEN: "Украдено", DESTROYED: "Уничтожено", NOT_ON_SHELF: "Не найдено на складе",
};
const problemStatuses: Record<string, string> = {
  EXPECTED: "Ожидаем возврат", SEARCHING: "На поиске", FOUND: "Найдено", NOT_FOUND: "Не найдено", WROTE_OFF: "Списано",
};
const repairStatuses: Record<string, string> = {
  WAITING_REPAIR: "Ожидает диагностики", IN_REPAIR: "В ремонте", WAITING_PARTS: "Ждём запчасти", CLOSED: "Отремонтировано", WROTE_OFF: "Списано",
};
export const emptyIssueSummary = (): BookingIssueSummary => ({
  openCases: 0, missingCases: 0, missingQuantity: 0, damageCases: 0, damageQuantity: 0,
  waitingCases: 0, overdueCases: 0, closedCases: 0,
});
export function issueDateOverdue(date: Date | null, now: Date) {
  return !!date && toMoscowDateString(date) < toMoscowDateString(now);
}
const missingSelect = {
  sourceBookingId: true, bookingItem: { select: { bookingId: true } },
  status: true, resolvedAt: true, quantity: true, equipmentUnitId: true, expectedBackDate: true,
} satisfies Prisma.ProblemItemSelect;
const damageSelect = {
  sourceBookingId: true, bookingItem: { select: { bookingId: true } },
  status: true, quantity: true, unitId: true, expectedReadyAt: true,
} satisfies Prisma.RepairSelect;
export function summarizeBookingIssues(
  missing: Prisma.ProblemItemGetPayload<{ select: typeof missingSelect }>[],
  damage: Prisma.RepairGetPayload<{ select: typeof damageSelect }>[],
  now: Date,
) {
  const map = new Map<string, BookingIssueSummary>();
  function summary(id: string | null | undefined) {
    if (!id) return null;
    if (!map.has(id)) map.set(id, emptyIssueSummary());
    return map.get(id)!;
  }
  for (const item of missing) {
    const s = summary(item.sourceBookingId ?? item.bookingItem?.bookingId);
    if (!s) continue;
    if (item.resolvedAt || closedProblems.includes(item.status)) { s.closedCases++; continue; }
    s.openCases++; s.missingCases++; s.missingQuantity += item.equipmentUnitId ? 1 : item.quantity;
    if (item.status === "EXPECTED") s.waitingCases++;
    if (issueDateOverdue(item.expectedBackDate, now)) s.overdueCases++;
  }
  for (const item of damage) {
    const s = summary(item.sourceBookingId ?? item.bookingItem?.bookingId);
    if (!s) continue;
    if (closedRepairs.includes(item.status)) { s.closedCases++; continue; }
    s.openCases++; s.damageCases++; s.damageQuantity += item.unitId ? 1 : item.quantity;
    if (issueDateOverdue(item.expectedReadyAt, now)) s.overdueCases++;
  }
  return map;
}
export async function getBookingIssueSummaries(now: Date) {
  const [missing, damage] = await prisma.$transaction([
    prisma.problemItem.findMany({ select: missingSelect }),
    prisma.repair.findMany({ select: damageSelect }),
  ]);
  return summarizeBookingIssues(missing, damage, now);
}

/** One view of the existing warehouse and workshop records; no copies or writes. */
export async function getBookingIssues(bookingId: string, now = new Date()): Promise<BookingIssuesResponse> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId }, select: { id: true, projectName: true, deletedAt: true, client: { select: { name: true } } },
  });
  if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
  // Old COUNT records may carry only bookingItemId. An explicit source wins over that fallback.
  const where = { OR: [{ sourceBookingId: bookingId }, { sourceBookingId: null, bookingItem: { bookingId } }] };
  const [missing, damage] = await prisma.$transaction([
    prisma.problemItem.findMany({ where, include: {
      equipment: { select: { name: true } },
      equipmentUnit: { select: { equipment: { select: { name: true } } } },
      bookingItem: { select: { bookingId: true, customName: true, equipment: { select: { name: true } } } },
    } }),
    prisma.repair.findMany({ where, include: {
      unit: { select: { equipment: { select: { name: true } } } },
      equipment: { select: { name: true } },
      bookingItem: { select: { bookingId: true, customName: true, equipment: { select: { name: true } } } },
      photos: { select: { id: true }, orderBy: { createdAt: "asc" } },
      workLog: { select: { description: true, loggedAt: true }, orderBy: { loggedAt: "desc" }, take: 1 },
    } }),
  ]);
  const names = await resolveActorNames([
    ...missing.flatMap(i => [i.createdBy, i.resolvedBy]), ...damage.flatMap(i => [i.createdBy, i.assignedTo]),
  ]);
  const items: BookingIssue[] = missing.map(i => {
    const open = !i.resolvedAt && !closedProblems.includes(i.status);
    return {
      id: i.id, kind: "missing", equipmentName: i.equipmentUnit?.equipment.name ?? i.bookingItem?.equipment?.name ?? i.bookingItem?.customName ?? i.equipment?.name ?? "Позиция не указана",
      quantity: i.equipmentUnitId ? 1 : i.quantity, title: reasons[i.reason] ?? "Недостача", description: i.comment,
      statusLabel: problemStatuses[i.status], open, overdue: open && issueDateOverdue(i.expectedBackDate, now),
      expectedAt: i.expectedBackDate?.toISOString() ?? null, createdAt: i.createdAt.toISOString(),
      createdBy: actorName(names, i.createdBy), assignedTo: null,
      closedAt: i.resolvedAt?.toISOString() ?? null, closedBy: actorName(names, i.resolvedBy), resolution: i.resolutionNote,
      nextStep: open ? (i.status === "EXPECTED" ? "Связаться с клиентом и подтвердить досдачу" : "Уточнить местонахождение и зафиксировать результат поиска")
        : i.status === "FOUND" ? "Разбор завершён" : "Проверить отдельно, согласована ли компенсация; закрытие поиска не подтверждает оплату",
      photos: [], href: `/warehouse/problems?bookingId=${encodeURIComponent(bookingId)}`,
    };
  });
  for (const i of damage) {
    const open = !closedRepairs.includes(i.status);
    items.push({
      id: i.id, kind: "damage", equipmentName: i.unit?.equipment.name ?? i.equipment?.name ?? i.bookingItem?.equipment?.name ?? i.bookingItem?.customName ?? i.equipment?.name ?? "Позиция не указана",
      quantity: i.unitId ? 1 : i.quantity, title: "Повреждение", description: i.reason,
      statusLabel: repairStatuses[i.status], open, overdue: open && issueDateOverdue(i.expectedReadyAt, now),
      expectedAt: i.expectedReadyAt?.toISOString() ?? null, createdAt: i.createdAt.toISOString(),
      createdBy: actorName(names, i.createdBy), assignedTo: actorName(names, i.assignedTo),
      closedAt: i.closedAt?.toISOString() ?? null, closedBy: null,
      resolution: i.workLog[0]?.description ?? i.partsNote,
      nextStep: !open ? (i.status === "WROTE_OFF" ? "Оборудование списано; расчёты с клиентом проверяются отдельно" : "Ремонт завершён; расчёты с клиентом проверяются отдельно") : i.status === "WAITING_PARTS"
        ? `Уточнить поставку${i.partsNote ? `: ${i.partsNote}` : " запчастей"}`
        : i.assignedTo ? "Проверить ход ремонта и срок готовности" : "Назначить техника и срок диагностики",
      photos: i.photos.map(p => ({ id: p.id, url: `/api/repairs/${i.id}/photos/${p.id}` })), href: `/repair/${i.id}`,
    });
  }
  items.sort((a, b) => Number(b.open) - Number(a.open) || Number(b.overdue) - Number(a.overdue) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  return {
    booking: { id: booking.id, projectName: booking.projectName, clientName: booking.client.name, archived: !!booking.deletedAt },
    summary: summarizeBookingIssues(missing, damage, now).get(bookingId) ?? emptyIssueSummary(), items,
  };
}
