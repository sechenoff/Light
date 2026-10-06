/**
 * Конфликт добора и «кто держит» позицию.
 *
 * v2 (2026-09-28): считается той же формулой, что витрина и потолок добора
 * (stockCap → getAvailability): занятость — пик, а не сумма; черновик и архив
 * склад не держат; бронь на согласовании держит; мастерская и потеряшки
 * вычтены. Старое правило «сумма чужих броней + 1 ≤ totalQuantity» давало
 * ложный «занят» при двух непересекающихся бронях и не знало, сколько просят.
 *
 * Конфликт ⇔ в окне есть чужие брони И свободно меньше, чем «уже в брони +
 * запрошено». Если позиции не хватает только из-за мастерской или потерь,
 * держателя нет — это не конфликт, а отказ по складу (ADDON_OVER_STOCK).
 *
 * Карточка держателя отвечает на вопрос кладовщика «где прибор и когда
 * освободится»: статус брони, дата выдачи, просрочен ли возврат, сколько
 * свободно нам и сколько можно взять под ответственность.
 */
import type { Prisma } from "@prisma/client";

import { prisma } from "../prisma";
import { bookingOccupancyInterval, standardReservations } from "./availability";
import { projectReservations, reservationOverlaps, type Reservation } from "./projectReservations";
import { computeAddCaps, lineWindowEnds } from "./stockCap";

type Db = Prisma.TransactionClient | typeof prisma;

export type HolderStatus = "PENDING_APPROVAL" | "CONFIRMED" | "ISSUED";

export interface AddonConflict {
  bookingId: string;
  bookingNo: string;          // "#A1B2C3"
  projectName: string;
  clientName: string | null;
  from: string;               // ISO — начало брони-держателя
  to: string;                 // ISO — когда держатель вернёт позицию (у длинной позиции — позже конца брони)
  /**
   * ISO — когда держатель освободит позицию (конец его брони). null, если
   * выданная бронь просрочена: срок прошёл, а возврат не отмечен — когда
   * вернут, неизвестно, и обещать дату нельзя.
   */
  freeFrom: string | null;
  holderStatus: HolderStatus;
  /** ISO — когда держателю выдали (только ISSUED). */
  issuedAt: string | null;
  /** Выдана, срок возврата прошёл, возврат не отмечен. */
  overdue: boolean;
  /** Сколько можно добрать без подтверждения (addCap). */
  freeForUs: number;
  /** Сколько можно добрать под ответственность (ackCap). */
  ackCap: number;
}

type Holder = Omit<AddonConflict, "freeForUs" | "ackCap">;

export function bookingNo(id: string): string {
  return "#" + id.slice(-6).toUpperCase();
}

function asHolderStatus(status: string): HolderStatus {
  return status === "ISSUED" || status === "PENDING_APPROVAL" ? status : "CONFIRMED";
}

/**
 * Держатель по каждой позиции: чужая бронь, чей резерв (обычный или проектный
 * лот) попадает в окно — из того же списка резервов и по тем же границам, что
 * занятость в getAvailability. Из нескольких держателей показывается тот, кто
 * занял позицию раньше (выданная заранее — с момента выдачи): при выдаче
 * «сейчас» это тот, у кого прибор сейчас.
 */
async function loadHolders(
  client: Db,
  a: {
    equipmentIds: string[];
    start: Date;
    end: Date;
    excludeBookingId: string;
    now: Date;
    /**
     * Брони, которые держателем не называть, хотя склад они занимают: семья
     * разделяемой брони (её же продолжения) — позиция нужна не им.
     */
    excludeHolderIds?: string[];
  },
): Promise<Map<string, Holder>> {
  const holders = new Map<string, Holder>();
  if (a.equipmentIds.length === 0) return holders;

  const windowArgs = {
    start: a.start,
    end: a.end,
    equipmentIds: a.equipmentIds,
    excludeBookingId: a.excludeBookingId,
  };
  const reservations: Reservation[] = [
    ...(await standardReservations(client, windowArgs)),
    ...(await projectReservations(windowArgs, client)),
  ].filter(
    (r) =>
      r.quantity > 0 &&
      r.bookingId !== a.excludeBookingId &&
      !(a.excludeHolderIds ?? []).includes(r.bookingId) &&
      reservationOverlaps(r, a.start.getTime(), a.end.getTime()),
  );
  if (reservations.length === 0) return holders;

  const bookings = await client.booking.findMany({
    where: { id: { in: Array.from(new Set(reservations.map((r) => r.bookingId))) } },
    select: {
      id: true,
      projectName: true,
      status: true,
      startDate: true,
      endDate: true,
      issuedAt: true,
      client: { select: { name: true } },
    },
  });
  const bookingById = new Map(bookings.map((b) => [b.id, b]));

  // Срок возврата позиции у держателя: у длинной позиции он позже конца брони.
  const dueByEquipmentBooking = new Map<string, number>();
  for (const r of reservations) {
    if (r.dueAt == null) continue;
    const key = `${r.equipmentId}|${r.bookingId}`;
    dueByEquipmentBooking.set(key, Math.max(dueByEquipmentBooking.get(key) ?? 0, r.dueAt));
  }

  const byEquipment = new Map<string, typeof bookings>();
  for (const r of reservations) {
    const b = bookingById.get(r.bookingId);
    if (!b) continue;
    const list = byEquipment.get(r.equipmentId) ?? [];
    if (!list.some((x) => x.id === b.id)) list.push(b);
    byEquipment.set(r.equipmentId, list);
  }

  const nowMs = a.now.getTime();
  for (const [equipmentId, list] of byEquipment) {
    const occupiedFrom = (b: (typeof list)[number]) => bookingOccupancyInterval(b, nowMs).start;
    const nearest = [...list].sort(
      (x, y) => occupiedFrom(x) - occupiedFrom(y) || x.id.localeCompare(y.id),
    )[0];
    const holderStatus = asHolderStatus(nearest.status);
    const due = new Date(dueByEquipmentBooking.get(`${equipmentId}|${nearest.id}`) ?? nearest.endDate.getTime());
    const overdue = holderStatus === "ISSUED" && due.getTime() < nowMs;
    holders.set(equipmentId, {
      bookingId: nearest.id,
      bookingNo: bookingNo(nearest.id),
      projectName: nearest.projectName,
      clientName: nearest.client?.name ?? null,
      from: nearest.startDate.toISOString(),
      to: due.toISOString(),
      freeFrom: overdue ? null : due.toISOString(),
      holderStatus,
      issuedAt: holderStatus === "ISSUED" ? nearest.issuedAt?.toISOString() ?? null : null,
      overdue,
    });
  }
  return holders;
}

/** Конец окна для длинных позиций брони `bookingId` (см. stockCap.lineWindowEnds). */
async function lineEndFor(
  client: Db,
  bookingId: string,
  window: { start: Date; end: Date },
  equipmentIds: string[],
): Promise<Map<string, Date>> {
  const items = await client.bookingItem.findMany({
    where: { bookingId, equipmentId: { in: equipmentIds }, shifts: { not: null } },
    select: { equipmentId: true, shifts: true },
  });
  const ends = await lineWindowEnds(client, bookingId, window, items);
  return new Map(Array.from(ends, ([id, ms]) => [id, new Date(ms)]));
}

/**
 * Конфликт добора позиции в бронь `excludeBookingId` на окне [start, end].
 * null — конфликта нет (свободно хватает, либо держателя нет вовсе).
 *
 * opts:
 *  - `requested` — сколько добираем (по умолчанию 1);
 *  - `alreadyInBooking` — сколько позиции уже в брони (по умолчанию 0: так
 *    считало старое правило; новые вызовы передают реальное число);
 *  - `tx` — клиент транзакции.
 */
export async function findAddonConflict(
  equipmentId: string,
  start: Date,
  end: Date,
  excludeBookingId: string,
  opts?: { requested?: number; alreadyInBooking?: number; tx?: Db },
): Promise<AddonConflict | null> {
  const client = opts?.tx ?? prisma;
  const requested = Math.max(0, opts?.requested ?? 1);
  const alreadyInBooking = Math.max(0, opts?.alreadyInBooking ?? 0);

  const caps = await computeAddCaps(client, {
    bookingId: excludeBookingId,
    equipmentIds: [equipmentId],
    window: { start, end },
    alreadyInBooking: new Map([[equipmentId, alreadyInBooking]]),
  });
  const cap = caps.get(equipmentId);
  if (!cap) return null;

  const available = Math.max(0, cap.physicalStock - cap.occupiedByOthers);
  if (available >= alreadyInBooking + requested) return null;

  // Длинная позиция брони занята до своего срока — держателя ищем в том же
  // окне, по которому посчитан потолок (computeAddCaps).
  const lineEnd = await lineEndFor(client, excludeBookingId, { start, end }, [equipmentId]);
  const holders = await loadHolders(client, {
    equipmentIds: [equipmentId],
    start,
    end: lineEnd.get(equipmentId) ?? end,
    excludeBookingId,
    now: new Date(),
  });
  const holder = holders.get(equipmentId);
  if (!holder) return null;
  return { ...holder, freeForUs: cap.addCap, ackCap: cap.ackCap };
}

/**
 * Держатели по нескольким позициям одним вызовом — для чек-листа (подпись
 * «Занято: …» у степпера), поиска и текста ошибки подтверждения брони.
 * В ответе только позиции, у которых в окне есть чужие брони; «уже в брони»
 * для freeForUs / ackCap берётся из самой брони `excludeBookingId`.
 */
export async function findHoldersBatch(
  client: Db,
  a: { equipmentIds: string[]; start: Date; end: Date; excludeBookingId: string; excludeHolderIds?: string[] },
): Promise<Map<string, AddonConflict>> {
  const result = new Map<string, AddonConflict>();
  const equipmentIds = Array.from(new Set(a.equipmentIds));
  if (equipmentIds.length === 0) return result;

  // Позиции с одинаковым концом окна — одним запросом; длинные позиции брони
  // — на своём окне до срока (тот же расчёт, что у computeAddCaps).
  const lineEnd = await lineEndFor(client, a.excludeBookingId, { start: a.start, end: a.end }, equipmentIds);
  const groups = new Map<number, string[]>();
  for (const id of equipmentIds) {
    const end = lineEnd.get(id)?.getTime() ?? a.end.getTime();
    groups.set(end, [...(groups.get(end) ?? []), id]);
  }
  const holders = new Map<string, Holder>();
  for (const [end, ids] of groups) {
    const groupHolders = await loadHolders(client, { ...a, end: new Date(end), equipmentIds: ids, now: new Date() });
    for (const [id, h] of groupHolders) holders.set(id, h);
  }
  if (holders.size === 0) return result;
  const caps = await computeAddCaps(client, {
    bookingId: a.excludeBookingId,
    equipmentIds: Array.from(holders.keys()),
    window: { start: a.start, end: a.end },
  });
  for (const [equipmentId, holder] of holders) {
    const cap = caps.get(equipmentId);
    result.set(equipmentId, { ...holder, freeForUs: cap?.addCap ?? 0, ackCap: cap?.ackCap ?? 0 });
  }
  return result;
}
