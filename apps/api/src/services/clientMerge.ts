/**
 * Объединение карточек-дублей одного клиента.
 *
 * Дубль («источник») вливается в основную карточку («основная»): брони,
 * счета на оплату, кредит-ноты, задачи и доступ в кабинет переходят к
 * основной, дубль удаляется. Имя остаётся у основной — кто из двух
 * «основная», решает руководитель в окне объединения.
 *
 * Контакты не теряются: пустые поля основной дозаполняются из дубля, а
 * расходящиеся телефон, почта, ИНН и комментарий дубля дописываются в
 * комментарий основной. Реквизиты для счёта: нет у основной — переносятся
 * набором; тот же ИНН (или он не указан) — дополняются пустые поля; разные
 * ИНН — у основной остаются свои, а ИНН дубля уходит в комментарий: смешивать
 * наборы разных плательщиков нельзя, вышел бы ИНН одной фирмы с банком другой.
 *
 * Кабинет: если он есть у обеих карточек, остаётся тот, которым пользуются
 * (активный важнее ожидающего, ожидающий — отключённого), при равенстве — у
 * основной; второй закрывается.
 *
 * Выписанные счета на оплату задним числом не меняются: плательщик в них —
 * снимок на момент выставления. Предпросмотр и само объединение считают план
 * одной функцией (`planClientMerge`), поэтому окно показывает ровно то, что
 * произойдёт.
 */
import type { Prisma } from "@prisma/client";

import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { diffFields, writeAuditEntry } from "./audit";

type Db = Prisma.TransactionClient | typeof prisma;

export const CLIENT_LEGAL_KEYS = [
  "legalName",
  "inn",
  "kpp",
  "ogrn",
  "legalAddress",
  "postalAddress",
  "bankName",
  "bankBik",
  "rschet",
  "kschet",
] as const;
type LegalKey = (typeof CLIENT_LEGAL_KEYS)[number];

const mergeClientSelect = {
  id: true,
  name: true,
  phone: true,
  email: true,
  comment: true,
  lastReminderAt: true,
  legalName: true,
  inn: true,
  kpp: true,
  ogrn: true,
  legalAddress: true,
  postalAddress: true,
  bankName: true,
  bankBik: true,
  rschet: true,
  kschet: true,
  portalAccount: { select: { id: true, email: true, status: true } },
  _count: { select: { bookings: true } },
} as const;

export type MergeClient = Prisma.ClientGetPayload<{ select: typeof mergeClientSelect }>;

/** Что станет с полем основной: остаётся своё, дозаполняется, расходится. */
export type ContactOutcome = "keep" | "fill" | "conflict";
/** Реквизиты: «complete» — тот же плательщик, пустые поля дополнятся из дубля. */
export type RequisitesOutcome = ContactOutcome | "complete";
type PortalStatus = "PENDING" | "ACTIVE" | "DISABLED";

export type ClientMergePlan = {
  /** Поля основной карточки, которые запишет объединение. */
  data: Prisma.ClientUpdateInput;
  contact: {
    phone: ContactOutcome;
    email: ContactOutcome;
    /** «append» — в комментарий основной допишется строка «Из «дубль»: …». */
    comment: "keep" | "fill" | "append";
    requisites: RequisitesOutcome;
  };
  portal: {
    /**
     * none — кабинета нет ни у кого; keep — он только у основной;
     * move — только у дубля, переезжает; drop — у обеих, один закроется.
     */
    outcome: "none" | "keep" | "move" | "drop";
    keptEmail: string | null;
    droppedEmail: string | null;
    /** Чей кабинет остаётся (при «drop» — тот, которым пользуются). */
    keptFrom: "source" | "target" | null;
    keptStatus: PortalStatus | null;
    droppedStatus: PortalStatus | null;
  };
};

/** Каким кабинетом пользуются: активный важнее ожидающего, ожидающий — отключённого. */
const PORTAL_RANK: Record<string, number> = { ACTIVE: 2, PENDING: 1, DISABLED: 0 };

const blank = (v: string | null | undefined): boolean => !v || !v.trim();
const digits = (v: string) => v.replace(/\D/g, "");

function contactOutcome(target: string | null, source: string | null, same: (a: string, b: string) => boolean): ContactOutcome {
  if (blank(source)) return "keep";
  if (blank(target)) return "fill";
  return same(target!, source!) ? "keep" : "conflict";
}

/** План объединения: чистая функция, общая для предпросмотра и записи. */
export function planClientMerge(source: MergeClient, target: MergeClient): ClientMergePlan {
  const phone = contactOutcome(target.phone, source.phone, (a, b) => digits(a) === digits(b));
  const email = contactOutcome(target.email, source.email, (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase());

  const legalOf = (c: MergeClient) => CLIENT_LEGAL_KEYS.filter((k) => !blank(c[k]));
  const sourceLegal = legalOf(source);
  const targetLegal = legalOf(target);
  // Пустые поля основной, которые есть у дубля: заполняются набором (у
  // основной реквизитов нет) или дополняются (тот же плательщик).
  const blanks = sourceLegal.filter((k) => blank(target[k]));
  const innDiffers = !blank(source.inn) && !blank(target.inn) && source.inn!.trim() !== target.inn!.trim();
  const requisites: RequisitesOutcome =
    sourceLegal.length === 0
      ? "keep"
      : targetLegal.length === 0
        ? "fill"
        : innDiffers
          ? "conflict"
          : blanks.length > 0
            ? "complete"
            : "keep";

  const data: Prisma.ClientUpdateInput = {};
  if (phone === "fill") data.phone = source.phone!.trim();
  if (email === "fill") data.email = source.email!.trim();
  if (requisites === "fill" || requisites === "complete") {
    for (const k of blanks) (data as Record<LegalKey, string | null>)[k] = source[k];
  }
  if (source.lastReminderAt && (!target.lastReminderAt || source.lastReminderAt > target.lastReminderAt)) {
    data.lastReminderAt = source.lastReminderAt;
  }

  // Что из дубля не помещается в поля основной — в её комментарий.
  const sourceComment = source.comment?.trim() ?? "";
  const targetComment = target.comment?.trim() ?? "";
  const parts = [
    sourceComment && sourceComment !== targetComment ? sourceComment : null,
    phone === "conflict" ? `тел. ${source.phone!.trim()}` : null,
    email === "conflict" ? `почта ${source.email!.trim()}` : null,
    requisites === "conflict" ? `ИНН ${source.inn!.trim()}` : null,
  ].filter((p): p is string => Boolean(p));
  let comment: ClientMergePlan["contact"]["comment"] = "keep";
  if (parts.length > 0) {
    const onlySourceComment = parts.length === 1 && parts[0] === sourceComment;
    if (!targetComment && onlySourceComment) {
      data.comment = sourceComment;
      comment = "fill";
    } else {
      const note = `Из «${source.name}»: ${parts.join("; ")}`;
      data.comment = targetComment ? `${targetComment}\n${note}` : note;
      comment = "append";
    }
  }

  const s = source.portalAccount;
  const t = target.portalAccount;
  const status = (a: { status: string } | null) => (a ? (a.status as PortalStatus) : null);
  let portal: ClientMergePlan["portal"];
  if (s && t) {
    const keepSource = (PORTAL_RANK[s.status] ?? 0) > (PORTAL_RANK[t.status] ?? 0);
    const [kept, dropped] = keepSource ? [s, t] : [t, s];
    portal = {
      outcome: "drop",
      keptEmail: kept.email,
      droppedEmail: dropped.email,
      keptFrom: keepSource ? "source" : "target",
      keptStatus: status(kept),
      droppedStatus: status(dropped),
    };
  } else if (s) {
    portal = { outcome: "move", keptEmail: s.email, droppedEmail: null, keptFrom: "source", keptStatus: status(s), droppedStatus: null };
  } else if (t) {
    portal = { outcome: "keep", keptEmail: t.email, droppedEmail: null, keptFrom: "target", keptStatus: status(t), droppedStatus: null };
  } else {
    portal = { outcome: "none", keptEmail: null, droppedEmail: null, keptFrom: null, keptStatus: null, droppedStatus: null };
  }

  return { data, contact: { phone, email, comment, requisites }, portal };
}

export type ClientMergeMoves = { bookings: number; bills: number; creditNotes: number; tasks: number };

async function loadPair(db: Db, sourceId: string, targetId: string): Promise<{ source: MergeClient; target: MergeClient }> {
  if (sourceId === targetId) {
    throw new HttpError(400, "Нельзя объединить клиента с самим собой", "CLIENT_MERGE_SAME");
  }
  const source = await db.client.findUnique({ where: { id: sourceId }, select: mergeClientSelect });
  const target = await db.client.findUnique({ where: { id: targetId }, select: mergeClientSelect });
  if (!source || !target) throw new HttpError(404, "Клиент не найден", "CLIENT_NOT_FOUND");
  return { source, target };
}

async function countMoves(db: Db, sourceId: string): Promise<ClientMergeMoves> {
  const [bookings, bills, creditNotes, tasks] = [
    await db.booking.count({ where: { clientId: sourceId } }),
    await db.bill.count({ where: { clientId: sourceId } }),
    await db.creditNote.count({ where: { contactClientId: sourceId } }),
    await db.task.count({ where: { relatedClientId: sourceId } }),
  ];
  return { bookings, bills, creditNotes, tasks };
}

const summary = (c: MergeClient) => ({
  id: c.id,
  name: c.name,
  phone: c.phone,
  email: c.email,
  bookingCount: c._count.bookings,
  hasPortal: Boolean(c.portalAccount),
});

/** Предпросмотр: что переедет и что станет с контактами и кабинетом. Ничего не пишет. */
export async function previewClientMerge(sourceId: string, targetId: string) {
  const { source, target } = await loadPair(prisma, sourceId, targetId);
  const plan = planClientMerge(source, target);
  return {
    source: summary(source),
    target: summary(target),
    moves: await countMoves(prisma, source.id),
    contact: plan.contact,
    portal: plan.portal,
  };
}

const clientCardSelect = {
  id: true,
  name: true,
  phone: true,
  email: true,
  comment: true,
  createdAt: true,
  legalName: true,
  inn: true,
  kpp: true,
  ogrn: true,
  legalAddress: true,
  postalAddress: true,
  bankName: true,
  bankBik: true,
  rschet: true,
  kschet: true,
} as const;

const PORTAL_OUTCOME_TEXT: Record<ClientMergePlan["portal"]["outcome"], (p: ClientMergePlan["portal"]) => string | null> = {
  none: () => null,
  keep: () => null,
  move: (p) => `перенесён (${p.keptEmail})`,
  drop: (p) => `оставлен ${p.keptEmail}, закрыт ${p.droppedEmail}`,
};

const auditCard = (c: Pick<MergeClient, "name" | "phone" | "email" | "comment" | LegalKey>) => ({
  name: c.name,
  phone: c.phone,
  email: c.email,
  comment: c.comment,
  ...Object.fromEntries(CLIENT_LEGAL_KEYS.map((k) => [k, c[k]])),
});

/** Объединить дубль `sourceId` в основную карточку `targetId` одной транзакцией. */
export async function mergeClients(args: { sourceId: string; targetId: string; userId: string }) {
  return prisma.$transaction(async (tx) => {
    const { source, target } = await loadPair(tx, args.sourceId, args.targetId);
    const plan = planClientMerge(source, target);

    const bookings = await tx.booking.findMany({ where: { clientId: source.id }, select: { id: true } });
    await tx.booking.updateMany({ where: { clientId: source.id }, data: { clientId: target.id } });
    const bills = await tx.bill.updateMany({ where: { clientId: source.id }, data: { clientId: target.id } });
    const creditNotes = await tx.creditNote.updateMany({
      where: { contactClientId: source.id },
      data: { contactClientId: target.id },
    });
    const tasks = await tx.task.updateMany({ where: { relatedClientId: source.id }, data: { relatedClientId: target.id } });
    // Кабинет — до удаления дубля: иначе каскад унёс бы его вместе с карточкой.
    // У карточки кабинет один, поэтому лишний закрывается до переезда.
    if (plan.portal.outcome === "drop") {
      await tx.clientPortalAccount.delete({
        where: { clientId: plan.portal.keptFrom === "source" ? target.id : source.id },
      });
    }
    if (plan.portal.keptFrom === "source") {
      await tx.clientPortalAccount.update({ where: { clientId: source.id }, data: { clientId: target.id } });
    }
    await tx.client.delete({ where: { id: source.id } });
    const client = await tx.client.update({ where: { id: target.id }, data: plan.data, select: clientCardSelect });

    const moved: ClientMergeMoves = {
      bookings: bookings.length,
      bills: bills.count,
      creditNotes: creditNotes.count,
      tasks: tasks.count,
    };
    await writeAuditEntry({
      tx,
      userId: args.userId,
      action: "CLIENT_MERGE",
      entityType: "Client",
      entityId: target.id,
      before: diffFields(auditCard(target)),
      after: diffFields({
        ...auditCard(client),
        mergedClientId: source.id,
        mergedClientName: source.name,
        movedBookings: moved.bookings,
        movedBills: moved.bills,
        movedCreditNotes: moved.creditNotes,
        movedTasks: moved.tasks,
        portalOutcome: PORTAL_OUTCOME_TEXT[plan.portal.outcome](plan.portal),
      }),
    });
    await writeAuditEntry({
      tx,
      userId: args.userId,
      action: "CLIENT_MERGED_INTO",
      entityType: "Client",
      entityId: source.id,
      before: diffFields(auditCard(source)),
      after: { name: source.name, mergedIntoClientId: target.id, mergedIntoClientName: target.name },
    });
    // Журнал каждой брони говорит, почему у неё сменился клиент.
    for (const b of bookings) {
      await writeAuditEntry({
        tx,
        userId: args.userId,
        action: "BOOKING_CLIENT_CHANGED",
        entityType: "Booking",
        entityId: b.id,
        before: { clientId: source.id, clientName: source.name },
        after: { clientId: target.id, clientName: target.name, reason: "Объединение карточек клиента" },
      });
    }
    return { client: { ...client, bookingCount: target._count.bookings + moved.bookings }, moved };
  });
}
