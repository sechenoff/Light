"use client";

/**
 * Черновик чек-листа киоска на сервере (P6).
 *
 * Зачем: степпер, отметки «Выдано» и исходы приёмки жили только в памяти
 * компонента. Смена раздела, «←», перезагрузка планшета — и работа на 60+
 * строк пропадала, а «Готово» оформляло план вместо погруженного. Теперь
 * чек-лист отдаёт сюда свой черновик (`ChecklistDraftV1`), хук копит правки
 * 800 мс и пишет их `PUT /sessions/:id/draft`, а `/state` отдаёт черновик
 * обратно при следующем открытии.
 *
 * Как пользоваться в чек-листе:
 * ```tsx
 * const draft = useChecklistDraft({
 *   sessionId,
 *   serverRevision: state?.draftRevision,
 *   serverSavedAt: state?.draftSavedAt,
 *   serverSavedBy: state?.draftSavedBy,
 *   serverDraft: state?.draft,
 *   onOutdated: (fresh) => reseedFrom(fresh.draft),  // другое устройство успело раньше
 *   onSessionClosed: (err) => setClosedError(err),   // → <SessionClosedNotice />
 *   leaveRef,                                         // проп со страницы (необязателен)
 * });
 * // засев без сохранённого черновика: draft.setBaseline(seeded) — засев не работа;
 * // при каждом изменении: draft.schedule(buildDraft());
 * // перед «Готово»: const pre = await draft.flushBeforeSubmit();
 * //   if (!pre) return;  complete({ ..., draftRevision: pre.draftRevision })
 * // 409 DRAFT_OUTDATED из complete: draft.adoptOutdated(details) + перезасев;
 * // после успешного «Готово»: draft.discard();
 * // подпись: draft.statusLabel («Сохранено 14:05» / «Нет связи — не сохранено»)
 * ```
 *
 * Состояние сохранения живёт в модуле, а не в компоненте: чек-лист
 * размонтируется при смене раздела, а досылка должна дойти. `useScanSession`
 * перед чтением `/state` ждёт, пока досылка уляжется (`awaitDraftSettled`),
 * и подкладывает несохранённый черновик (`peekUnsavedDraft`), если связи не
 * было, — поэтому вернувшийся чек-лист видит последнюю правку.
 *
 * Досылка при уходе:
 *  - `visibilitychange` → hidden и `pagehide` — сразу, `fetch keepalive`;
 *  - размонтирование и `leaveRef` («←», выбор другой брони) — очередью за
 *    текущим сохранением: страница жива, запрос дойдёт.
 * Если в сессии не было никакой работы (черновика нет, правок не было), уход
 * через `leaveRef` или закрытие вкладки прерывают её:
 * `cancel({ onlyIfEmpty: true, reason: "EMPTY_LEAVE" })`. Сервер сам
 * проверяет, что работы нет (черновик, отметки, добор), иначе сессия
 * остаётся — «открыл и посмотрел» больше не плодит висящих сессий (P25).
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type MutableRefObject,
} from "react";
import { scanApi } from "./api";
import {
  SCAN_ERROR,
  getScanErrorDetails,
  isChecklistDraftV1,
  isScanApiError,
  isSessionClosedError,
  scanErrorCode,
} from "./types";
import type {
  CancelSessionResult,
  ChecklistDraftV1,
  DraftOutdatedDetails,
  ScanApiError,
} from "./types";

/** Задержка перед сохранением после последней правки. */
export const DRAFT_SAVE_DELAY_MS = 800;
/** Повтор сохранения, пока нет связи. */
export const DRAFT_RETRY_DELAY_MS = 5000;
/** Сколько `useScanSession` ждёт досылку перед чтением `/state`. */
export const DRAFT_SETTLE_TIMEOUT_MS = 4000;

/**
 * - `idle` — сохранять нечего;
 * - `pending` — правка ждёт задержки;
 * - `saving` — запрос в пути;
 * - `saved` — сервер принял последнюю правку;
 * - `offline` — нет связи, правка лежит в памяти и уйдёт повтором;
 * - `failed` — сервер отказал (например, черновик слишком большой);
 * - `outdated` — другое устройство сохранило позже, экран перезасеян;
 * - `closed` — сессия закрыта, сохранять больше некуда.
 */
export type DraftSaveStatus =
  | "idle"
  | "pending"
  | "saving"
  | "saved"
  | "offline"
  | "failed"
  | "outdated"
  | "closed";

/** Функция «ухожу с чек-листа», которую страница зовёт на «←» и смене брони. */
export type ChecklistLeaveFn = () => void;

// ── Время по Москве ──────────────────────────────────────────────────────────

function parseIso(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** «14:05» по Москве; `null` при непарсибельном входе. */
export function formatMoscowTime(iso: string | null | undefined): string | null {
  const d = parseIso(iso);
  if (!d) return null;
  return d.toLocaleTimeString("ru-RU", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** «12.07, 14:05» по Москве; `null` при непарсибельном входе. */
export function formatMoscowDayTime(iso: string | null | undefined): string | null {
  const d = parseIso(iso);
  if (!d) return null;
  const date = d.toLocaleDateString("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
  });
  return `${date}, ${formatMoscowTime(iso)}`;
}

// ── Восстановление строк из черновика ────────────────────────────────────────

/**
 * Сопоставить записи черновика (`issue.rows` или `return.grids`) со строками
 * текущего чек-листа. Сначала по `bookingItemId`. Запись, чьей позиции в брони
 * уже нет (позицию пересоздали правкой брони), переходит к строке с тем же
 * `equipmentId` — только если сопоставление однозначно: одна такая запись и
 * одна такая несопоставленная строка. Остальное не угадываем.
 *
 * `unmatchedCount` — сколько записей черновика не подошло ни к одной строке:
 * повод для жёлтой пометки «часть позиций изменилась — проверьте».
 */
export function matchDraftEntries<T extends { equipmentId: string | null }>(
  entries: Record<string, T> | null | undefined,
  items: ReadonlyArray<{ bookingItemId: string; equipmentId: string | null }>,
): { matched: Map<string, T>; unmatchedCount: number } {
  const matched = new Map<string, T>();
  if (!entries) return { matched, unmatchedCount: 0 };

  const itemIds = new Set(items.map((i) => i.bookingItemId));
  const used = new Set<string>();
  for (const item of items) {
    const entry = entries[item.bookingItemId];
    if (entry) {
      matched.set(item.bookingItemId, entry);
      used.add(item.bookingItemId);
    }
  }

  // Осиротевшие записи и несопоставленные строки — по equipmentId.
  const orphansByEq = new Map<string, string[]>();
  for (const key of Object.keys(entries)) {
    if (itemIds.has(key)) continue;
    const eq = entries[key]?.equipmentId;
    if (!eq) continue;
    orphansByEq.set(eq, [...(orphansByEq.get(eq) ?? []), key]);
  }
  const freeItemsByEq = new Map<string, string[]>();
  for (const item of items) {
    if (matched.has(item.bookingItemId) || !item.equipmentId) continue;
    freeItemsByEq.set(item.equipmentId, [
      ...(freeItemsByEq.get(item.equipmentId) ?? []),
      item.bookingItemId,
    ]);
  }
  for (const [eq, orphanKeys] of Array.from(orphansByEq.entries())) {
    const freeItems = freeItemsByEq.get(eq) ?? [];
    if (orphanKeys.length !== 1 || freeItems.length !== 1) continue;
    matched.set(freeItems[0], entries[orphanKeys[0]]);
    used.add(orphanKeys[0]);
  }

  const unmatchedCount = Object.keys(entries).filter((k) => !used.has(k)).length;
  return { matched, unmatchedCount };
}

// ── Канал сохранения одной сессии (живёт в модуле) ───────────────────────────

interface ChannelHandlers {
  onOutdated?: (fresh: DraftOutdatedDetails) => void;
  onSessionClosed?: (err: ScanApiError) => void;
}

interface DraftChannel {
  sessionId: string;
  /** Ревизия, от которой пишем следующий черновик; `null` — `/state` ещё не читали. */
  revision: number | null;
  /** Ревизия, с которой сессию открыли (0 — черновика на сервере не было). */
  serverRevision: number | null;
  /** Наибольшая ревизия, которую получили СВОИ успешные сохранения. */
  ownSavedRevision: number | null;
  /** Правка, которая ещё не ушла на сервер. */
  pending: ChecklistDraftV1 | null;
  /**
   * Последнее известное состояние экрана (канонический JSON): засев,
   * серверный черновик или последняя правка. Такая же правка повторно не
   * сохраняется — засев чек-листа по плану брони работой не считается.
   */
  lastJson: string | null;
  inFlight: Promise<void> | null;
  /** Черновик, который сейчас в пути, и ревизия, от которой он построен. */
  inFlightDraft: { draft: ChecklistDraftV1; baseRevision: number } | null;
  timer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  delayMs: number;
  status: DraftSaveStatus;
  savedAt: string | null;
  savedBy: string | null;
  lastError: ScanApiError | null;
  /** В этой сессии уже была правка черновика (с этого или прошлого экрана). */
  touched: boolean;
  /** Сессия закрыта или черновик сброшен — больше ничего не шлём. */
  closed: boolean;
  /** «Прервать пустую» уже отправили — второй раз не шлём. */
  emptyCancelSent: boolean;
  /** Сколько раз проиграли другому устройству (`DRAFT_OUTDATED`). */
  outdatedCount: number;
  listeners: Set<() => void>;
  handlers: ChannelHandlers;
}

const channels = new Map<string, DraftChannel>();

function getChannel(sessionId: string): DraftChannel {
  let ch = channels.get(sessionId);
  if (!ch) {
    ch = {
      sessionId,
      revision: null,
      serverRevision: null,
      ownSavedRevision: null,
      pending: null,
      lastJson: null,
      inFlight: null,
      inFlightDraft: null,
      timer: null,
      retryTimer: null,
      delayMs: DRAFT_SAVE_DELAY_MS,
      status: "idle",
      savedAt: null,
      savedBy: null,
      lastError: null,
      touched: false,
      closed: false,
      emptyCancelSent: false,
      outdatedCount: 0,
      listeners: new Set(),
      handlers: {},
    };
    channels.set(sessionId, ch);
  }
  return ch;
}

function notify(ch: DraftChannel): void {
  for (const l of Array.from(ch.listeners)) l();
}

function clearTimers(ch: DraftChannel): void {
  if (ch.timer) clearTimeout(ch.timer);
  if (ch.retryTimer) clearTimeout(ch.retryTimer);
  ch.timer = null;
  ch.retryTimer = null;
}

/** JSON с отсортированными ключами — чтобы порядок ключей не давал «правку». */
export function stableDraftJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(src).sort()) out[k] = src[k];
      return out;
    }
    return v;
  });
}

function toScanError(err: unknown): ScanApiError {
  if (isScanApiError(err)) return err;
  return {
    status: 0,
    code: SCAN_ERROR.NETWORK_ERROR,
    message: err instanceof Error ? err.message : "Не удалось сохранить черновик",
    details: null,
  };
}

function isTransient(err: ScanApiError): boolean {
  return err.status === 0 || err.status >= 500 || err.status === 429;
}

/**
 * 409 `DRAFT_OUTDATED` на досылку, которая обогнала наш же запрос (решается,
 * когда обогнанный запрос уже улёгся). Конфликт «свой», если ревизия в ответе:
 *  - ниже той, от которой досылка построена, — сервер ещё не видел даже нашего
 *    предыдущего сохранения, а чужое подняло бы ревизию до `base` и выше;
 *  - или не выше той, что получили наши же успешные сохранения, — сервер
 *    успел применить обогнанный запрос между проверкой и ответом.
 * Иначе ревизию поднял кто-то другой — честный конфликт устройств.
 */
function isSelfOvertake(ch: DraftChannel, err: unknown, base: number): boolean {
  const fresh = getScanErrorDetails(err, SCAN_ERROR.DRAFT_OUTDATED);
  if (typeof fresh?.revision !== "number") return false;
  if (fresh.revision < base) return true;
  return ch.ownSavedRevision !== null && fresh.revision <= ch.ownSavedRevision;
}

function scheduleRetry(ch: DraftChannel): void {
  if (ch.retryTimer || ch.closed) return;
  // Без открытого экрана не долбим сервер повторами: при следующем открытии
  // `useScanSession` сам дошлёт несохранённое (`awaitDraftSettled`).
  if (ch.listeners.size === 0) return;
  ch.retryTimer = setTimeout(() => {
    ch.retryTimer = null;
    void sendNow(ch, false);
  }, DRAFT_RETRY_DELAY_MS);
}

function handleSaveError(ch: DraftChannel, err: unknown, draft: ChecklistDraftV1): void {
  const e = toScanError(err);
  ch.lastError = e;

  if (scanErrorCode(e) === SCAN_ERROR.DRAFT_OUTDATED) {
    const fresh = getScanErrorDetails(e, SCAN_ERROR.DRAFT_OUTDATED);
    const safe: DraftOutdatedDetails = {
      revision: typeof fresh?.revision === "number" ? fresh.revision : (ch.revision ?? 0),
      draft: fresh && isChecklistDraftV1(fresh.draft) ? fresh.draft : null,
      savedAt: fresh?.savedAt ?? null,
      savedBy: fresh?.savedBy ?? null,
    };
    applyOutdated(ch, safe, false);
    return;
  }

  if (isSessionClosedError(e)) {
    clearTimers(ch);
    ch.closed = true;
    ch.pending = null;
    ch.status = "closed";
    ch.handlers.onSessionClosed?.(e);
    return;
  }

  if (isTransient(e)) {
    // Нет связи или сбой сервера: правка остаётся и уйдёт повтором, если за
    // это время не появилась более свежая.
    if (!ch.pending) ch.pending = draft;
    ch.status = "offline";
    scheduleRetry(ch);
    return;
  }

  // 400 / 413: этот черновик сервер не примет никогда — ждём следующую правку.
  ch.status = "failed";
}

/**
 * Отправить накопленную правку. `immediate` — не ждать текущий запрос, а
 * писать сразу поверх ревизии, которую он получит (ревизия растёт на 1):
 * так досылка при закрытии вкладки успевает уйти до выгрузки страницы.
 */
function sendNow(ch: DraftChannel, immediate: boolean): Promise<void> {
  if (ch.timer) {
    clearTimeout(ch.timer);
    ch.timer = null;
  }
  if (ch.closed || !ch.pending || ch.revision === null) {
    return ch.inFlight ?? Promise.resolve();
  }
  if (ch.inFlight && !immediate) {
    return ch.inFlight.then(() => sendNow(ch, false));
  }

  const draft = ch.pending;
  // Запрос, который обгоняем (`immediate` поверх летящего): его черновик
  // старше нашего, а ревизию он получит на 1 больше текущей.
  const overtaken = ch.inFlight;
  const overtakenDraft = overtaken ? (ch.inFlightDraft?.draft ?? null) : null;
  const base = overtaken ? ch.revision + 1 : ch.revision;
  ch.pending = null;
  ch.inFlightDraft = { draft, baseRevision: base };
  ch.status = "saving";
  notify(ch);

  const p: Promise<void> = scanApi
    .saveDraft(ch.sessionId, base, draft, { keepalive: immediate })
    .then((res) => {
      if (ch.closed) return;
      ch.revision = Math.max(ch.revision ?? 0, res.revision);
      ch.ownSavedRevision = Math.max(ch.ownSavedRevision ?? 0, res.revision);
      ch.savedAt = res.savedAt;
      ch.lastError = null;
      ch.status = ch.pending ? "pending" : "saved";
    })
    .catch((err: unknown): Promise<void> | void => {
      if (ch.closed) return;
      if (overtaken && scanErrorCode(err) === SCAN_ERROR.DRAFT_OUTDATED) {
        // Досылка могла дойти до сервера раньше нашего же предыдущего запроса
        // (запросы идут через прокси параллельно). Решаем, когда он уляжется.
        return overtaken.then(() => {
          if (ch.closed) return;
          if (!isSelfOvertake(ch, err, base)) {
            handleSaveError(ch, err, draft);
            return;
          }
          // Не конфликт устройств: правку не выбрасываем и шлём заново от
          // ревизии, которую получил предыдущий запрос.
          if (!ch.pending || ch.pending === overtakenDraft) ch.pending = draft;
          ch.status = "pending";
          void Promise.resolve().then(() => sendNow(ch, false));
        });
      }
      handleSaveError(ch, err, draft);
    })
    .finally(() => {
      if (ch.inFlight === p) {
        ch.inFlight = null;
        ch.inFlightDraft = null;
      }
      notify(ch);
    });
  ch.inFlight = p;
  return p;
}

/**
 * Другое устройство сохранило позже: берём его ревизию и черновик как
 * исходную точку. Наша несохранённая правка проиграла — досылать её поверх
 * свежей версии нельзя.
 */
function applyOutdated(ch: DraftChannel, fresh: DraftOutdatedDetails, silent: boolean): void {
  if (ch.timer) {
    clearTimeout(ch.timer);
    ch.timer = null;
  }
  ch.revision = Math.max(ch.revision ?? 0, fresh.revision);
  ch.savedAt = fresh.savedAt ?? ch.savedAt;
  ch.savedBy = fresh.savedBy ?? ch.savedBy;
  ch.pending = null;
  ch.lastJson = fresh.draft ? stableDraftJson(fresh.draft) : null;
  ch.status = "outdated";
  ch.outdatedCount += 1;
  if (!silent) ch.handlers.onOutdated?.(fresh);
}

function scheduleSave(ch: DraftChannel, draft: ChecklistDraftV1): void {
  if (ch.closed) return;
  const json = stableDraftJson(draft);
  if (json === ch.lastJson) return;
  ch.lastJson = json;
  ch.pending = draft;
  ch.touched = true;
  ch.lastError = null;
  if (ch.status !== "saving") ch.status = "pending";
  if (ch.timer) clearTimeout(ch.timer);
  if (ch.retryTimer) {
    clearTimeout(ch.retryTimer);
    ch.retryTimer = null;
  }
  ch.timer = setTimeout(() => {
    ch.timer = null;
    void sendNow(ch, false);
  }, ch.delayMs);
  notify(ch);
}

/** Та же ошибка, что вернул бы сервер на любой вызов в прерванную сессию. */
function emptyLeaveClosedError(sessionId: string, res: CancelSessionResult): ScanApiError {
  const raw = res as unknown as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    status: 409,
    code: SCAN_ERROR.SESSION_CANCELLED,
    message: "Сессию склада прервали — откройте бронь заново",
    details: {
      sessionId,
      operation: res.operation,
      cancelReason: "EMPTY_LEAVE",
      cancelledAt: str(raw.cancelledAt),
      cancelledBy: str(raw.cancelledBy),
    },
  };
}

function sendEmptyCancel(sessionId: string): void {
  scanApi
    .cancel(sessionId, { onlyIfEmpty: true, reason: "EMPTY_LEAVE", keepalive: true })
    .then((res) => {
      if (!res || !res.cancelled) return;
      const ch = channels.get(sessionId);
      // Пока летела отмена, кладовщик снова открыл эту же бронь, и сервер
      // продолжил ещё не прерванную сессию. Теперь она прервана: экран должен
      // это сказать, а не молча перестать сохранять и глохнуть на «Готово».
      const reopened = ch && !ch.closed && ch.listeners.size > 0 ? ch.handlers.onSessionClosed : null;
      discardDraft(sessionId);
      reopened?.(emptyLeaveClosedError(sessionId, res));
    })
    .catch(() => {
      /* Не вышло — не страшно: пустая сессия ничего не блокирует. */
    });
}

/** Прервать пустую сессию при уходе (сервер откажет, если работа была). */
function cancelIfEmpty(ch: DraftChannel): void {
  if (ch.closed || ch.emptyCancelSent || ch.touched || ch.pending || ch.inFlight) return;
  // Черновик был при открытии или ревизия неизвестна — работу не трогаем.
  if (ch.serverRevision !== 0) return;
  ch.emptyCancelSent = true;
  sendEmptyCancel(ch.sessionId);
}

// ── Внешнее API модуля ───────────────────────────────────────────────────────

/**
 * Дождаться, пока досылка черновика сессии уляжется (не дольше `timeoutMs`).
 * Зовёт `useScanSession` перед чтением `/state`, чтобы вернувшийся чек-лист
 * не прочитал черновик раньше, чем дойдёт последняя правка.
 */
export async function awaitDraftSettled(
  sessionId: string,
  timeoutMs: number = DRAFT_SETTLE_TIMEOUT_MS,
): Promise<void> {
  const ch = channels.get(sessionId);
  if (!ch || ch.closed) return;
  if (!ch.pending && !ch.inFlight) return;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const work = sendNow(ch, false).catch(() => undefined);
  await Promise.race([
    work,
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
}

/**
 * Несохранённый черновик сессии (связи не было) и ревизия, от которой он
 * построен. `useScanSession` подкладывает его вместо серверного, если сервер
 * с тех пор не получил ничего нового.
 */
export function peekUnsavedDraft(
  sessionId: string,
): { draft: ChecklistDraftV1; baseRevision: number } | null {
  const ch = channels.get(sessionId);
  if (!ch || ch.closed) return null;
  if (ch.pending && ch.revision !== null) return { draft: ch.pending, baseRevision: ch.revision };
  // Ответа ещё нет (ждать дольше `awaitDraftSettled` не стали) — это тоже
  // последняя правка экрана.
  return ch.inFlightDraft;
}

/**
 * Забыть черновик сессии: после «Готово», «Прервать» или закрытия сессии.
 * Отложенная досылка не уйдёт — иначе она попала бы в закрытую сессию.
 */
export function discardDraft(sessionId: string): void {
  const ch = channels.get(sessionId);
  if (!ch) return;
  clearTimers(ch);
  ch.closed = true;
  ch.pending = null;
  ch.status = "closed";
  channels.delete(sessionId);
  notify(ch);
}

/**
 * «Ухожу с чек-листа» (P25): «←» или выбор другой брони. Есть несохранённое —
 * досылаем. Работы не было — просим сервер прервать сессию, если она пустая
 * (`onlyIfEmpty`: черновик, отметки и добор сервер проверяет сам), чтобы
 * «открыл и посмотрел» не оставлял висящих сессий.
 *
 * Работает и без открытого экрана: страница зовёт его для сессии, чей
 * чек-лист уже размонтирован (другой раздел).
 */
export function leaveChecklistSession(sessionId: string): void {
  const ch = channels.get(sessionId);
  if (!ch) {
    // Чек-лист сессии так и не загрузился — своих правок нет, решает сервер.
    sendEmptyCancel(sessionId);
    return;
  }
  if (ch.closed) return;
  if (ch.pending || ch.inFlight) {
    void sendNow(ch, false);
    return;
  }
  cancelIfEmpty(ch);
}

/** Только для тестов: сбросить все каналы. */
export function _resetChecklistDraftsForTests(): void {
  for (const ch of Array.from(channels.values())) clearTimers(ch);
  channels.clear();
}

// ── Хук ──────────────────────────────────────────────────────────────────────

export interface UseChecklistDraftOptions {
  sessionId: string;
  /**
   * `state.draftRevision` из `/state`. Пока чек-лист не загружен — `undefined`:
   * правки копятся и уйдут, когда ревизия станет известна.
   */
  serverRevision: number | null | undefined;
  /** `state.draftSavedAt` — для подписи «Сохранено ЧЧ:ММ» до первой правки. */
  serverSavedAt?: string | null;
  /** `state.draftSavedBy`. */
  serverSavedBy?: string | null;
  /**
   * `state.draft` — черновик, которым засеян экран. Если экран сразу отдаст
   * его же в `schedule`, это не правка и на сервер не уходит.
   */
  serverDraft?: ChecklistDraftV1 | null;
  /** Задержка перед сохранением, мс. */
  delayMs?: number;
  /**
   * 409 `DRAFT_OUTDATED`: другое устройство сохранило позже. Экран должен
   * перезасеяться `fresh.draft` (строки — по `bookingItemId`, затем по
   * `equipmentId`). Ревизию хук уже взял из ответа.
   */
  onOutdated?: (fresh: DraftOutdatedDetails) => void;
  /** Сессия закрыта (`SESSION_*`) — показать `SessionClosedNotice`. */
  onSessionClosed?: (err: ScanApiError) => void;
  /**
   * Проп страницы: хук кладёт сюда «ухожу», страница зовёт его на «←» и при
   * выборе другой брони.
   */
  leaveRef?: MutableRefObject<ChecklistLeaveFn | null>;
}

export interface UseChecklistDraftResult {
  /** Правка экрана: сохранится через `delayMs` после последнего вызова. */
  schedule: (draft: ChecklistDraftV1) => void;
  /** Отправить накопленное сейчас; `true` — сервер принял всё. */
  flush: () => Promise<boolean>;
  /**
   * Перед «Готово»: дослать черновик и вернуть ревизию для
   * `complete({ draftRevision })`. `null` — завершать нельзя: другое
   * устройство сохранило позже (экран уже перезасеян) или сессия закрыта.
   * Нет связи — ревизия всё равно возвращается: решит сам `complete`.
   */
  flushBeforeSubmit: () => Promise<{ draftRevision: number | undefined } | null>;
  /**
   * Засев экрана без правок (например, количества по плану брони, когда
   * сохранённого черновика нет). Такое же состояние в `schedule` не сохраняется
   * и работой не считается — иначе «открыл и посмотрел» заблокировал бы
   * «+ Добор» на карточке брони.
   */
  setBaseline: (draft: ChecklistDraftV1) => void;
  /**
   * 409 `DRAFT_OUTDATED` из `complete`: принять свежую версию с сервера как
   * исходную точку (ревизия, черновик). Экран перезасеивает себя сам.
   */
  adoptOutdated: (fresh: DraftOutdatedDetails) => void;
  /** «Ухожу с чек-листа»: дослать черновик или прервать пустую сессию. */
  leave: ChecklistLeaveFn;
  /** Забыть черновик (после успешного «Готово» или «Прервать»). */
  discard: () => void;
  status: DraftSaveStatus;
  /** «Сохранено 14:05», «Сохраняем…», «Нет связи — не сохранено» или `null`. */
  statusLabel: string | null;
  /** ISO последнего сохранения (этим или другим устройством). */
  savedAt: string | null;
  savedBy: string | null;
  /** Текущая ревизия на сервере; `null` — ещё неизвестна. */
  revision: number | null;
  /** Есть правки, которые сервер ещё не принял. */
  dirty: boolean;
  /** Последняя ошибка сохранения (для подробностей в подсказке). */
  lastError: ScanApiError | null;
}

function statusLabelOf(ch: DraftChannel): string | null {
  switch (ch.status) {
    case "pending":
    case "saving":
      return "Сохраняем…";
    case "saved": {
      const t = formatMoscowTime(ch.savedAt);
      return t ? `Сохранено ${t}` : "Сохранено";
    }
    case "offline":
      return "Нет связи — не сохранено";
    case "failed":
      return ch.lastError?.code === SCAN_ERROR.DRAFT_TOO_LARGE
        ? "Черновик слишком большой — не сохранён"
        : "Не сохранено";
    case "outdated":
      return "Загружена версия с другого устройства";
    case "idle": {
      const t = formatMoscowTime(ch.savedAt);
      return t ? `Сохранено ${t}` : null;
    }
    case "closed":
    default:
      return null;
  }
}

export function useChecklistDraft(opts: UseChecklistDraftOptions): UseChecklistDraftResult {
  const {
    sessionId,
    serverRevision,
    serverSavedAt,
    serverSavedBy,
    serverDraft,
    delayMs = DRAFT_SAVE_DELAY_MS,
    onOutdated,
    onSessionClosed,
    leaveRef,
  } = opts;

  // Канал берётся заново при смене сессии; закрытый заменяется свежим только
  // для новой сессии (у той же сессии закрытие окончательное).
  const channel = useMemo(() => getChannel(sessionId), [sessionId]);
  channel.delayMs = delayMs;

  const [, rerender] = useReducer((x: number) => x + 1, 0);

  // Колбэки — через ref: канал переживает рендеры, а замыкания устаревают.
  const handlersRef = useRef<ChannelHandlers>({});
  handlersRef.current = { onOutdated, onSessionClosed };
  useEffect(() => {
    channel.handlers = {
      onOutdated: (fresh) => handlersRef.current.onOutdated?.(fresh),
      onSessionClosed: (err) => handlersRef.current.onSessionClosed?.(err),
    };
  }, [channel]);

  useEffect(() => {
    channel.listeners.add(rerender);
    return () => {
      channel.listeners.delete(rerender);
    };
  }, [channel]);

  // Ревизия с сервера — один раз на экземпляр экрана, когда `/state`
  // загрузился: экран засеян именно из этого ответа. Дальше хук ведёт её сам:
  // подхватить чужую ревизию молча значило бы затереть черновик другого
  // устройства вместо честного `DRAFT_OUTDATED`.
  const seededFromServerFor = useRef<string | null>(null);
  useEffect(() => {
    if (serverRevision === undefined || serverRevision === null) return;
    if (seededFromServerFor.current === channel.sessionId) return;
    seededFromServerFor.current = channel.sessionId;
    if (channel.serverRevision === null) channel.serverRevision = serverRevision;
    if (channel.revision === null) {
      channel.revision = serverRevision;
      if (!channel.savedAt) channel.savedAt = serverSavedAt ?? null;
      if (!channel.savedBy) channel.savedBy = serverSavedBy ?? null;
      if (channel.lastJson === null && serverDraft) channel.lastJson = stableDraftJson(serverDraft);
      if (channel.pending) void sendNow(channel, false);
      rerender();
      return;
    }
    // Экран открыли снова (смена раздела), а другое устройство за это время
    // сохранило позже. Новый экземпляр засеян из его черновика; своих
    // несохранённых правок нет — продолжаем от его ревизии. Иначе первая же
    // правка получила бы ложный DRAFT_OUTDATED, перезасев и пропала.
    // Несохранённая правка (нет связи) не подменяется — её судьбу решит
    // сервер тем же DRAFT_OUTDATED.
    if (
      !channel.closed &&
      !channel.pending &&
      !channel.inFlight &&
      serverRevision > channel.revision
    ) {
      channel.revision = serverRevision;
      channel.savedAt = serverSavedAt ?? channel.savedAt;
      channel.savedBy = serverSavedBy ?? channel.savedBy;
      // Прежняя «последняя правка» этого устройства уже не то, что лежит на
      // сервере: повтор её обязан уйти.
      channel.lastJson = serverDraft ? stableDraftJson(serverDraft) : null;
      channel.lastError = null;
      channel.status = "idle";
      rerender();
    }
  }, [channel, serverRevision, serverSavedAt, serverSavedBy, serverDraft]);

  // Досылка при уходе со страницы и при размонтировании.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") void sendNow(channel, true);
    };
    const onPageHide = () => {
      void sendNow(channel, true);
      cancelIfEmpty(channel);
    };
    const onOnline = () => {
      if (channel.pending) void sendNow(channel, false);
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("online", onOnline);
      // Страница жива (смена раздела, «←») — очередью за текущим запросом.
      void sendNow(channel, false);
    };
  }, [channel]);

  const schedule = useCallback(
    (draft: ChecklistDraftV1) => scheduleSave(channel, draft),
    [channel],
  );

  const flush = useCallback(async (): Promise<boolean> => {
    await sendNow(channel, false);
    // За время запроса могла прийти новая правка — досылаем до конца.
    while (!channel.closed && channel.pending && channel.revision !== null) {
      if (channel.status === "offline" || channel.status === "failed") break;
      await sendNow(channel, false);
    }
    return !channel.closed && !channel.pending && channel.status !== "failed" &&
      channel.status !== "outdated" && channel.status !== "offline";
  }, [channel]);

  const flushBeforeSubmit = useCallback(async (): Promise<
    { draftRevision: number | undefined } | null
  > => {
    const conflictsBefore = channel.outdatedCount;
    await flush();
    // Проиграли другому устройству именно сейчас — экран перезасеян, его
    // надо сначала увидеть. Давний конфликт завершению не мешает.
    if (channel.closed || channel.outdatedCount !== conflictsBefore) return null;
    return { draftRevision: channel.revision ?? undefined };
  }, [channel, flush]);

  const leave = useCallback<ChecklistLeaveFn>(() => {
    if (channel.closed) return;
    if (channel.pending || channel.inFlight) {
      void sendNow(channel, false);
      return;
    }
    cancelIfEmpty(channel);
  }, [channel]);

  const setBaseline = useCallback(
    (draft: ChecklistDraftV1) => {
      if (channel.closed || channel.pending) return;
      channel.lastJson = stableDraftJson(draft);
    },
    [channel],
  );

  const adoptOutdated = useCallback(
    (fresh: DraftOutdatedDetails) => {
      if (channel.closed) return;
      applyOutdated(channel, fresh, true);
      notify(channel);
    },
    [channel],
  );

  useEffect(() => {
    if (!leaveRef) return;
    leaveRef.current = leave;
    return () => {
      if (leaveRef.current === leave) leaveRef.current = null;
    };
  }, [leaveRef, leave]);

  const discard = useCallback(() => discardDraft(channel.sessionId), [channel]);

  return {
    schedule,
    flush,
    flushBeforeSubmit,
    setBaseline,
    adoptOutdated,
    leave,
    discard,
    status: channel.status,
    statusLabel: statusLabelOf(channel),
    savedAt: channel.savedAt,
    savedBy: channel.savedBy,
    revision: channel.revision,
    dirty: channel.pending !== null || channel.inFlight !== null,
    lastError: channel.lastError,
  };
}
