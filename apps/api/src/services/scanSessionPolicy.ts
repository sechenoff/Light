/**
 * Политика складских сессий киоска (выдача и приёмка): какая сессия «живая»,
 * кто её может закрыть, что блокирует добор со страницы брони, и единый список
 * кодов ошибок склада с русскими текстами.
 *
 * Правила (решения плана «Выдача и приёмка», раздел 0):
 *  - ISSUE-сессия живая, только если бронь CONFIRMED и не в архиве; RETURN —
 *    только если бронь ISSUED. Любая другая ACTIVE-сессия устаревшая: ничего не
 *    блокирует, не завершается и закрывается при первом обращении (STALE).
 *  - Ручные выдача / приёмка / отмена / архивация закрывают ACTIVE-сессии брони
 *    в своей транзакции — `closeActiveScanSessions`.
 *  - Блокирует добор и правку состава только живая сессия, в которой уже есть
 *    работа: черновик, скан или добор этой сессии — `findBlockingScanSession`.
 *
 * Модуль не импортирует warehouseScan / checklistService / bookingAddon: те
 * импортируют его, и обратная ссылка дала бы цикл.
 */

import { createHash } from "crypto";
import { Prisma } from "@prisma/client";
import type { Booking, BookingStatus, PrismaClient, ScanOperation, ScanSession } from "@prisma/client";

import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { toMoscowDateString } from "../utils/moscowDate";
import { writeAuditEntry } from "./audit";

/** Базовый клиент или клиент интерактивной транзакции. */
type DbClient = PrismaClient | Prisma.TransactionClient;

// ──────────────────────────────────────────────────────────────────────────────
// Коды и тексты ошибок (план, таблица 2.2 — общий список для API и web)
// ──────────────────────────────────────────────────────────────────────────────

export const SCAN_ERR = {
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  SESSION_ALREADY_COMPLETED: "SESSION_ALREADY_COMPLETED",
  SESSION_CANCELLED: "SESSION_CANCELLED",
  SESSION_STALE: "SESSION_STALE",
  CHECKLIST_OUTDATED: "CHECKLIST_OUTDATED",
  DRAFT_OUTDATED: "DRAFT_OUTDATED",
  DRAFT_TOO_LARGE: "DRAFT_TOO_LARGE",
  NOTHING_TO_ISSUE: "NOTHING_TO_ISSUE",
  ISSUE_TOO_EARLY: "ISSUE_TOO_EARLY",
  ADDON_ONLY_ON_ISSUE: "ADDON_ONLY_ON_ISSUE",
  ADDON_OVER_STOCK: "ADDON_OVER_STOCK",
  ADDON_CONFLICT: "ADDON_CONFLICT",
  SCAN_SESSION_ACTIVE: "SCAN_SESSION_ACTIVE",
  INVALID_BOOKING_STATE: "INVALID_BOOKING_STATE",
  NOT_ENOUGH_UNITS: "NOT_ENOUGH_UNITS",
  BOOKING_WRONG_STATUS: "BOOKING_WRONG_STATUS",
} as const;

export type ScanErrCode = (typeof SCAN_ERR)[keyof typeof SCAN_ERR];

/** Тексты без параметров. Параметризованные — функциями ниже. */
export const SCAN_MSG = {
  SESSION_NOT_FOUND: "Сессия склада не найдена",
  SESSION_CANCELLED: "Сессию склада прервали — откройте бронь заново",
  CHECKLIST_OUTDATED:
    "Состав брони изменился, пока был открыт чек-лист — список обновлён, проверьте строки",
  DRAFT_OUTDATED: "Чек-лист изменили на другом устройстве — загружена свежая версия",
  DRAFT_TOO_LARGE: "Черновик слишком большой",
  NOTHING_TO_ISSUE:
    "Нечего выдавать: все строки обнулены. Если бронь не состоялась — отмените её на карточке брони.",
  ADDON_ONLY_ON_ISSUE: "Добор на месте — только при выдаче",
} as const;

export type ScanCancelReason =
  | "KIOSK_ABORT"
  | "CARD_ABORT"
  | "EMPTY_LEAVE"
  | "BOOKING_ISSUED_MANUALLY"
  | "BOOKING_RETURNED_MANUALLY"
  | "BOOKING_CANCELLED"
  | "BOOKING_ARCHIVED"
  | "STALE";

/** Причины, которые может прислать клиент (`POST /sessions/:id/cancel`). */
export const CLIENT_CANCEL_REASONS = ["KIOSK_ABORT", "CARD_ABORT", "EMPTY_LEAVE"] as const;

/** Действие аудита для закрытия сессии киоска. */
export const SCAN_SESSION_CANCELLED_ACTION = "SCAN_SESSION_CANCELLED";


/** «24.09 08:42» по Москве. */
function formatMoscowDayTime(d: Date): string {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}.${get("month")} ${get("hour")}:${get("minute")}`;
}

export function alreadyCompletedMessage(op: ScanOperation): string {
  return op === "ISSUE" ? "Выдача по этой брони уже оформлена" : "Приёмка по этой брони уже завершена";
}

/** Текст `BOOKING_WRONG_STATUS` при открытии сессии в киоске. */
export function bookingWrongStatusMessage(op: ScanOperation, status: BookingStatus): string {
  if (op === "RETURN") return "Принять можно только выданную бронь";
  if (status === "ISSUED") {
    return "Бронь уже выдана — выдачу в киоске не открыть. Довезти позиции можно кнопкой «+ Добор» на карточке брони";
  }
  return "Выдать можно только подтверждённую бронь";
}

/**
 * Текст `INVALID_BOOKING_STATE` по паре «статус брони × действие» (ручные
 * кнопки карточки). Если пара допустима, а переход всё равно не удался — это
 * гонка: бронь поменяли между чтением и записью.
 */
export function invalidBookingStateMessage(
  status: BookingStatus,
  action: "issue" | "return" | "cancel" | string,
): string {
  if (status === "CANCELLED") return "Бронь отменена — обновите страницу";
  if (action === "cancel") {
    if (status === "ISSUED") return "Выданную бронь нельзя отменить — сначала примите возврат";
    if (status === "RETURNED") return "Принятую бронь нельзя отменить";
  }
  if (action === "issue") {
    if (status === "ISSUED") return "Бронь уже выдана — обновите страницу";
    if (status === "RETURNED") return "Бронь уже принята — обновите страницу";
    if (status === "DRAFT") return "Черновик нельзя выдать — сначала подтвердите бронь";
    if (status === "PENDING_APPROVAL") return "Бронь на согласовании — выдать можно после подтверждения";
  }
  if (action === "return") {
    if (status === "RETURNED") return "Бронь уже принята — обновите страницу";
    if (status === "DRAFT" || status === "PENDING_APPROVAL" || status === "CONFIRMED") {
      return "Бронь ещё не выдана — сначала отметьте выдачу";
    }
  }
  return "Бронь уже изменили — обновите страницу";
}

// ──────────────────────────────────────────────────────────────────────────────
// Живая / устаревшая сессия
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Живая ли сессия операции `op` на брони в этом состоянии.
 * ISSUE — бронь CONFIRMED и не в архиве; RETURN — бронь ISSUED (архив не
 * проверяется: выданную технику принять нужно в любом случае, а архивация
 * закрывает сессии сама, reason BOOKING_ARCHIVED).
 */
export function isSessionLive(
  op: ScanOperation,
  b: { status: BookingStatus; deletedAt: Date | null },
): boolean {
  if (op === "ISSUE") return b.status === "CONFIRMED" && b.deletedAt == null;
  return b.status === "ISSUED";
}

const STALE_TAIL = "чек-лист закрыт, изменения из него не применены";

/** Почему сессия устарела — текст `SESSION_STALE` для кладовщика. */
export function staleMessage(op: ScanOperation, bookingStatus: BookingStatus, deletedAt: Date | null): string {
  if (bookingStatus === "CANCELLED") return `Бронь отменена — ${STALE_TAIL}`;
  if (deletedAt) return `Бронь в архиве — ${STALE_TAIL}`;
  if (bookingStatus === "RETURNED") return `Бронь уже принята на карточке — ${STALE_TAIL}`;
  if (op === "ISSUE") {
    if (bookingStatus === "ISSUED") return `Бронь уже выдана на карточке — ${STALE_TAIL}`;
    if (bookingStatus === "PENDING_APPROVAL") return "Бронь вернули на согласование — выдавать пока нельзя";
    if (bookingStatus === "DRAFT") return "Бронь вернули в черновик — выдавать пока нельзя";
  } else if (bookingStatus !== "ISSUED") {
    return "Бронь не числится выданной — принимать по ней в киоске нечего";
  }
  return `Бронь изменили — ${STALE_TAIL}`;
}

type SessionRow = Pick<
  ScanSession,
  | "id"
  | "operation"
  | "status"
  | "workerName"
  | "completedAt"
  | "completedBy"
  | "cancelledAt"
  | "cancelReason"
  | "cancelledBy"
>;

/** 409 для завершённой или прерванной сессии; `null`, если сессия ACTIVE. */
export function closedSessionError(session: SessionRow): HttpError | null {
  if (session.status === "COMPLETED") {
    return new HttpError(409, alreadyCompletedMessage(session.operation), SCAN_ERR.SESSION_ALREADY_COMPLETED, {
      sessionId: session.id,
      operation: session.operation,
      completedAt: session.completedAt?.toISOString() ?? null,
      // Старые сессии не знают, кто нажал «Готово», — автор тот, кто открыл.
      completedBy: session.completedBy ?? session.workerName,
    });
  }
  if (session.status === "CANCELLED") {
    return new HttpError(409, SCAN_MSG.SESSION_CANCELLED, SCAN_ERR.SESSION_CANCELLED, {
      sessionId: session.id,
      operation: session.operation,
      cancelReason: session.cancelReason ?? null,
      cancelledAt: session.cancelledAt?.toISOString() ?? null,
      cancelledBy: session.cancelledBy ?? null,
    });
  }
  return null;
}

/** 409 `SESSION_STALE` для ACTIVE-сессии, которая больше не живая. */
export function staleSessionError(
  session: Pick<ScanSession, "id" | "operation">,
  booking: { status: BookingStatus; deletedAt: Date | null },
): HttpError {
  return new HttpError(409, staleMessage(session.operation, booking.status, booking.deletedAt), SCAN_ERR.SESSION_STALE, {
    sessionId: session.id,
    operation: session.operation,
    bookingStatus: booking.status,
  });
}

function isTransactionClient(client: DbClient): boolean {
  // У клиента интерактивной транзакции нет $transaction (deny-list Prisma).
  return typeof (client as { $transaction?: unknown }).$transaction !== "function";
}

/**
 * Проверяет, что в сессию можно писать: она есть, ACTIVE и живая.
 *  - нет сессии → 404 SESSION_NOT_FOUND;
 *  - COMPLETED → 409 SESSION_ALREADY_COMPLETED, CANCELLED → 409 SESSION_CANCELLED;
 *  - устаревшая → 409 SESSION_STALE. Вне транзакции сессия сразу закрывается
 *    (reason STALE, аудит) — действие идемпотентное. В транзакции только
 *    бросает: запись откатилась бы вместе с ней, закрывает вызывающий в catch.
 *
 * `inTx` по умолчанию определяется по клиенту.
 */
export async function assertSessionWritable(
  client: DbClient,
  sessionId: string,
  opts: { inTx?: boolean } = {},
): Promise<{ session: ScanSession; booking: Booking }> {
  const row = await client.scanSession.findUnique({ where: { id: sessionId }, include: { booking: true } });
  if (!row) throw new HttpError(404, SCAN_MSG.SESSION_NOT_FOUND, SCAN_ERR.SESSION_NOT_FOUND);
  const { booking, ...session } = row;

  const closed = closedSessionError(session);
  if (closed) throw closed;
  if (isSessionLive(session.operation, booking)) return { session, booking };

  const inTx = opts.inTx ?? isTransactionClient(client);
  if (!inTx) {
    const close = (tx: Prisma.TransactionClient) =>
      closeActiveScanSessions(tx, booking.id, { reason: "STALE", onlyIds: [session.id] });
    const closedNow = isTransactionClient(client)
      ? await close(client as Prisma.TransactionClient)
      : await (client as PrismaClient).$transaction(close);
    if (closedNow.length === 0) {
      // Сессию успели завершить или прервать между чтением и закрытием —
      // честнее ответить её настоящим состоянием.
      const fresh = await client.scanSession.findUnique({ where: { id: sessionId } });
      const freshErr = fresh ? closedSessionError(fresh) : null;
      if (freshErr) throw freshErr;
    }
  }
  throw staleSessionError(session, booking);
}

// ──────────────────────────────────────────────────────────────────────────────
// Системный автор аудита
// ──────────────────────────────────────────────────────────────────────────────

export const SYSTEM_AUDIT_USER_ID = "_system_" as const;

/** `_system_` точно закоммичен в базе — повторно не проверяем. */
let systemUserCommitted = false;
/** Транзакции, в которых `_system_` создан нами: при откате строка пропадёт. */
const createdInTx = new WeakSet<object>();

/**
 * Гарантирует AdminUser `_system_` — автора аудита для действий без сессии
 * CRM (PIN-кладовщик, автозакрытие устаревших сессий). У AuditEntry внешний
 * ключ на AdminUser, и без этой строки аудит внутри транзакции откатил бы саму
 * выдачу. Upsert как в `scripts/seed-system-user.ts`; новая строка создаётся
 * отключённой (`isActive: false`) — войти под ней нельзя, и счётчик «последнего
 * активного руководителя» она не раздувает.
 *
 * Кеш модуля ставится только когда строка точно закоммичена: создание внутри
 * транзакции, которая потом откатилась, не должно отключать проверку.
 */
export async function ensureSystemAuditUser(client: DbClient = prisma): Promise<typeof SYSTEM_AUDIT_USER_ID> {
  if (systemUserCommitted) return SYSTEM_AUDIT_USER_ID;
  const inTx = isTransactionClient(client);

  const existing = await client.adminUser.findUnique({
    where: { id: SYSTEM_AUDIT_USER_ID },
    select: { id: true },
  });
  if (existing) {
    if (!inTx || !createdInTx.has(client)) systemUserCommitted = true;
    return SYSTEM_AUDIT_USER_ID;
  }

  try {
    await client.adminUser.create({
      data: {
        id: SYSTEM_AUDIT_USER_ID,
        username: SYSTEM_AUDIT_USER_ID,
        passwordHash: "!disabled",
        role: "SUPER_ADMIN",
        isActive: false,
      },
    });
  } catch (err) {
    // Параллельный запрос успел создать строку — нам этого и надо.
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
  }
  if (inTx) createdInTx.add(client);
  else systemUserCommitted = true;
  return SYSTEM_AUDIT_USER_ID;
}

/** Только для тестов: база пересоздана — кеш модуля больше не верен. */
export function _resetSystemAuditUserCacheForTests(): void {
  systemUserCommitted = false;
}

// ──────────────────────────────────────────────────────────────────────────────
// Закрытие сессий
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Переводит ACTIVE-сессии брони в CANCELLED (+ cancelledAt / cancelReason /
 * cancelledBy) и пишет аудит `SCAN_SESSION_CANCELLED` на каждую — в переданной
 * транзакции. Аудит лежит на брони (`entityType: "Booking"`), чтобы закрытие
 * было видно в журнале карточки.
 *
 * Автор аудита — `actorUserId`, если такой пользователь есть; иначе `_system_`
 * (PIN-кладовщик, бот, автозакрытие). Имя кладовщика без учётки CRM уходит в
 * `after.workerName`. Каждая сессия закрывается условным updateMany по
 * статусу ACTIVE: параллельно завершённая сессия не закрывается и не аудируется.
 *
 * @returns реально закрытые сессии.
 */
export async function closeActiveScanSessions(
  tx: Prisma.TransactionClient,
  bookingId: string,
  a: {
    reason: ScanCancelReason;
    actorUserId?: string | null;
    actorName?: string | null;
    onlyIds?: string[];
  },
): Promise<Array<{ id: string; operation: ScanOperation }>> {
  if (a.onlyIds && a.onlyIds.length === 0) return [];
  const candidates = await tx.scanSession.findMany({
    where: {
      bookingId,
      status: "ACTIVE",
      ...(a.onlyIds ? { id: { in: a.onlyIds } } : {}),
    },
    select: { id: true, operation: true, workerName: true, startedAt: true },
    orderBy: { startedAt: "asc" },
  });
  if (candidates.length === 0) return [];

  const actor = a.actorUserId
    ? await tx.adminUser.findUnique({ where: { id: a.actorUserId }, select: { id: true, username: true } })
    : null;
  const actorName = a.actorName?.trim() || null;
  const cancelledBy = actorName ?? actor?.username ?? null;
  const auditUserId = actor?.id ?? (await ensureSystemAuditUser(tx));
  const cancelledAt = new Date();

  const closed: Array<{ id: string; operation: ScanOperation }> = [];
  for (const s of candidates) {
    const res = await tx.scanSession.updateMany({
      where: { id: s.id, status: "ACTIVE" },
      data: { status: "CANCELLED", cancelledAt, cancelReason: a.reason, cancelledBy },
    });
    if (res.count === 0) continue;
    await writeAuditEntry({
      tx,
      userId: auditUserId,
      action: SCAN_SESSION_CANCELLED_ACTION,
      entityType: "Booking",
      entityId: bookingId,
      before: null,
      after: {
        sessionId: s.id,
        operation: s.operation,
        reason: a.reason,
        startedBy: s.workerName,
        startedAt: s.startedAt.toISOString(),
        cancelledBy,
        ...(actorName ? { workerName: actorName } : {}),
      },
    });
    closed.push({ id: s.id, operation: s.operation });
  }
  return closed;
}

// ──────────────────────────────────────────────────────────────────────────────
// Блокирующая сессия
// ──────────────────────────────────────────────────────────────────────────────

export interface BlockingScanSession {
  id: string;
  operation: ScanOperation;
  workerName: string;
  startedAt: Date;
  hasDraft: boolean;
}

/**
 * Сессия, которая мешает добору со страницы и правке состава: ACTIVE, живая
 * и с работой (черновик, скан или добор этой сессии). «Открыл и посмотрел» и
 * устаревшие сессии ничего не блокируют.
 */
export async function findBlockingScanSession(
  client: DbClient,
  bookingId: string,
): Promise<BlockingScanSession | null> {
  const booking = await client.booking.findUnique({
    where: { id: bookingId },
    select: { status: true, deletedAt: true },
  });
  if (!booking) return null;
  const liveOps = (["ISSUE", "RETURN"] as const).filter((op) => isSessionLive(op, booking));
  if (liveOps.length === 0) return null;

  const session = await client.scanSession.findFirst({
    where: {
      bookingId,
      status: "ACTIVE",
      operation: { in: [...liveOps] },
      OR: [{ draftJson: { not: null } }, { scans: { some: {} } }, { addonRecords: { some: {} } }],
    },
    orderBy: { startedAt: "desc" },
    select: { id: true, operation: true, workerName: true, startedAt: true },
  });
  if (!session) return null;

  // Сам черновик до 256 КБ — читаем только факт его наличия.
  const hasDraft = (await client.scanSession.count({ where: { id: session.id, draftJson: { not: null } } })) > 0;
  return { ...session, hasDraft };
}

/** 409 `SCAN_SESSION_ACTIVE` с кладовщиком и временем начала. */
export function scanSessionActiveError(s: BlockingScanSession): HttpError {
  const who = `${s.workerName}, с ${formatMoscowDayTime(s.startedAt)}`;
  const message =
    s.operation === "RETURN"
      ? `На складе идёт приёмка по этой брони (${who}) — завершите её в киоске или прервите.`
      : `На складе открыта выдача по этой брони (${who}) — добавьте позицию в чек-листе киоска или прервите выдачу.`;
  return new HttpError(409, message, SCAN_ERR.SCAN_SESSION_ACTIVE, {
    sessionId: s.id,
    operation: s.operation,
    workerName: s.workerName,
    startedAt: s.startedAt.toISOString(),
    hasDraft: s.hasDraft,
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Ранняя выдача и версия состава
// ──────────────────────────────────────────────────────────────────────────────

const ISSUE_EARLY_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** До начала аренды больше суток — выдача считается ранней (нужен `force`). */
export function isIssueTooEarly(startDate: Date, now: Date = new Date()): boolean {
  return startDate.getTime() - now.getTime() > ISSUE_EARLY_THRESHOLD_MS;
}

/**
 * Мягкий гард дат: выдача раньше начала аренды более чем на сутки — почти
 * всегда промах («не та бронь» / «не тот день»). Не блокирует намертво:
 * осознанную раннюю выдачу подтверждают повтором с `force: true`. Общий для
 * кнопки «Выдать» на карточке и «Готово» в киоске.
 */
export function assertIssueNotTooEarly(startDate: Date, force: boolean, now: Date = new Date()): void {
  if (force) return;
  if (!isIssueTooEarly(startDate, now)) return;
  const [y, m, d] = toMoscowDateString(startDate).split("-");
  throw new HttpError(
    409,
    `Аренда начинается ${d}.${m}.${y} — до начала больше суток. Проверьте бронь; если выдаёте заранее осознанно, подтвердите выдачу.`,
    SCAN_ERR.ISSUE_TOO_EARLY,
    { startDate: startDate.toISOString() },
  );
}

/**
 * Версия состава брони для защиты от устаревшего чек-листа: sha1 по
 * отсортированным «id:количество», первые 16 hex-символов.
 */
export function computeItemsVersion(items: ReadonlyArray<{ id: string; quantity: number }>): string {
  const canonical = items
    .map((i) => `${i.id}:${i.quantity}`)
    .sort()
    .join("|");
  return createHash("sha1").update(canonical).digest("hex").slice(0, 16);
}
