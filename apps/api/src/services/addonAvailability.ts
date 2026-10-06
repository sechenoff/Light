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
import { standardReservations } from "./availability";
import { projectReservations, reservationOverlaps, type Reservation } from "./projectReservations";
import { computeAddCaps, lineWindowEnds } from "./stockCap";

type Db = Prisma.TransactionClient | typeof prisma;

export type HolderStatus = "PENDING_APPROVAL" | "CONFIRMED" | "ISSUED";

export interface AddonConflict {
  bookingId: string;
  bookingNo: string;          // "#A1B2C3"
  projectName: string;
  clientName: string | null;
  /**
   * ISO — начало брони-держателя. У партии проекта — когда позицию берёт сама
   * партия (выдача или её первый день), а не начало проекта: проект бывает
   * выдан неделю назад, а партия с этой позицией начинается завтра.
   */
  from: string;
  /** ISO — когда держатель вернёт позицию (у длинной позиции — позже конца брони, у партии — её срок). */
  to: string;
  /**
   * ISO — когда держатель освободит позицию (конец его брони). null, если
   * выданная бронь просрочена: срок прошёл, а возврат не отмечен — когда
   * вернут, неизвестно, и обещать дату нельзя.
   */
  freeFrom: string | null;
  holderStatus: HolderStatus;
  /** ISO — когда держателю выдали (только ISSUED; у проекта — выдача партии). */
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
 * занятость в getAvailability.
 *
 * Карточка описывает одно «держание»: все строки обычной брони на позицию или
 * одну партию проекта. Даты, статус и выдача — у него: проект бывает выдан
 * давно, а партия с этой позицией ещё на складе и начинается завтра.
 *
 * Из нескольких держаний показывается то, что занимает позицию раньше, — по
 * фактическому началу резерва (выданная заранее бронь — с выдачи, партия — со
 * своей выдачи или первого дня). При выдаче «сейчас» это тот, у кого прибор
 * сейчас. Кто задевает только хвост окна, расширенного под длинную позицию
 * (lineEndFor), начинается не раньше конца проверяемого отрезка — и уступает
 * тем, кто задевает сам отрезок.
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
      issuedAt: true,
      client: { select: { name: true } },
    },
  });
  const bookingById = new Map(bookings.map((b) => [b.id, b]));

  // Держание: начало — самое раннее у его резервов, срок возврата — самый
  // поздний (у длинной позиции он позже конца брони).
  const holdings = new Map<string, Holding>();
  for (const r of reservations) {
    if (!bookingById.has(r.bookingId)) continue;
    const key = `${r.equipmentId}|${r.bookingId}|${r.lotId ?? ""}`;
    const prev = holdings.get(key);
    const due = r.dueAt ?? r.end;
    holdings.set(key, {
      equipmentId: r.equipmentId,
      bookingId: r.bookingId,
      lotId: r.lotId ?? null,
      start: Math.min(prev?.start ?? r.start, r.start),
      due: Math.max(prev?.due ?? due, due),
    });
  }
  const nearest = new Map<string, Holding>();
  for (const h of holdings.values()) {
    const current = nearest.get(h.equipmentId);
    if (!current || compareHoldings(h, current) < 0) nearest.set(h.equipmentId, h);
  }

  const lotIds = Array.from(nearest.values()).flatMap((h) => (h.lotId ? [h.lotId] : []));
  const lots =
    lotIds.length === 0
      ? []
      : await client.projectLot.findMany({
          where: { id: { in: lotIds } },
          select: { id: true, status: true, issuedAt: true },
        });
  const lotById = new Map(lots.map((l) => [l.id, l]));

  const nowMs = a.now.getTime();
  for (const h of nearest.values()) {
    const b = bookingById.get(h.bookingId)!;
    const lot = h.lotId ? lotById.get(h.lotId) : undefined;
    // У партии свой статус: выдана — у клиента, иначе ждёт на складе, даже
    // если сам проект давно выдан.
    const holderStatus: HolderStatus = h.lotId
      ? lot?.status === "ISSUED" ? "ISSUED" : "CONFIRMED"
      : asHolderStatus(b.status);
    const issuedAt = holderStatus === "ISSUED" ? (h.lotId ? lot?.issuedAt : b.issuedAt) ?? null : null;
    const overdue = holderStatus === "ISSUED" && h.due < nowMs;
    const due = new Date(h.due).toISOString();
    holders.set(h.equipmentId, {
      bookingId: b.id,
      bookingNo: bookingNo(b.id),
      projectName: b.projectName,
      clientName: b.client?.name ?? null,
      from: (h.lotId ? new Date(h.start) : b.startDate).toISOString(),
      to: due,
      freeFrom: overdue ? null : due,
      holderStatus,
      issuedAt: issuedAt?.toISOString() ?? null,
      overdue,
    });
  }
  return holders;
}

/** Позиции обычной брони или одна партия проекта у одной брони-держателя. */
type Holding = { equipmentId: string; bookingId: string; lotId: string | null; start: number; due: number };

/** Раньше занимает — раньше в списке; при равенстве порядок стабильный. */
function compareHoldings(x: Holding, y: Holding): number {
  return x.start - y.start || x.bookingId.localeCompare(y.bookingId) || (x.lotId ?? "").localeCompare(y.lotId ?? "");
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
