"use client";

/**
 * Чек-лист выдачи — экран кладовщика «выдача».
 *
 * Каждая позиция брони — строка со степпером `[−] N [+]` (N — сколько реально
 * грузим) и отметкой «Выдано» (грузчик унёс). Разница с согласованным видна
 * пилюлей, внизу — живой блок финансов и «Готово, выдать»: корректировки
 * уходят одним `/complete` без промежуточной сверки.
 *
 * Что изменилось (PR «Выдача и приёмка»):
 *  - Черновик на сервере (P6). Степпер, отметки и «под ответственность»
 *    сохраняются через `useChecklistDraft` (800 мс) и восстанавливаются из
 *    `/state` — смена раздела, «←», перезагрузка и второй планшет больше не
 *    теряют погруженное. В черновик попадают только строки, отличные от плана.
 *  - Один потолок (P4). Степпер упирается в свободное (`addCap`); если вещь
 *    держит чужая бронь, под серым «+» — у кого занято и «Добрать под
 *    ответственность» (потолок `ackCap`, `acknowledgedConflict` в `/complete`).
 *  - Защита от устаревшего экрана (P3, P14). `/complete` получает
 *    `itemsVersion` и `draftRevision`; коды `SESSION_*` показывают
 *    `SessionClosedNotice`, `CHECKLIST_OUTDATED` перечитывает чек-лист и
 *    заново применяет черновик, `ISSUE_TOO_EARLY` спрашивает «Выдать заранее»
 *    (P12), строки ×0 без единой выдачи — «Нечего выдавать» (P5).
 *  - Финансы от снимка сметы (P16), счётчик доборов по строкам сверх
 *    исходного и договорной итог (P17, P22).
 *
 * Состояние чек-листа: `useScanSession` (загрузку открывает страница).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useScanSession } from "./useScanSession";
import { AddonSearch } from "./AddonSearch";
import { DriverPanel } from "./DriverPanel";
import { AbortSessionButton } from "./AbortSessionButton";
import { ResumedSessionBanner } from "./ResumedSessionBanner";
import { SessionClosedNotice } from "./SessionClosedNotice";
import { formatMoscowDayTime, useChecklistDraft } from "./useChecklistDraft";
import type {
  ChecklistDraftV1,
  ChecklistItem,
  ChecklistSessionProps,
  ChecklistState,
  CompleteResult,
  DraftOutdatedDetails,
  IssuanceAdjustment,
  ScanApiError,
} from "./types";
import {
  SCAN_ERROR,
  getScanErrorDetails,
  isChecklistDraftV1,
  isScanApiError,
  isSessionClosedError,
  scanErrorCode,
} from "./types";
import { groupByCategory } from "../../lib/groupByCategory";
import { scanApi } from "./api";
import { IssueResultView } from "./IssueResultView";
import { STICKY_ABOVE_TAB_BAR } from "./WorkstationShell";
import {
  buildIssueDraft,
  freeAddCap,
  issueDraftHasRows,
  mergeNewItems,
  rowMax,
  rowOf,
  seedIssueRows,
  type IssueRowMap,
  type IssueRowState,
} from "./issueChecklistDraft";
import { computeLiveFinance, emptyLiveFinance } from "./issueLiveFinance";
import {
  ChecklistMessage,
  ChecklistSkeleton,
  ConfirmPartialDialog,
  EarlyIssueDialog,
  IssueChecklistHeading,
  IssueRow,
  LiveFinanceBlock,
  type IssueRowProblem,
} from "./IssueChecklistParts";

export { computeLiveFinance } from "./issueLiveFinance";

/** «#» + последние 6 символов id брони, в верхнем регистре (как в BookingList). */
function displayNo(id: string): string {
  return "#" + id.slice(-6).toUpperCase();
}

const EARLY_ISSUE_HINT_MS = 24 * 3600 * 1000;
/** Код сервера вне таблицы 2.2 — сохранён со времён сканера. */
const ADJUSTMENT_CONFLICTS_WITH_SCANS = "ADJUSTMENT_CONFLICTS_WITH_SCANS";

type IssuePhase = "checklist" | "submitting" | "result";

/** Что осталось от восстановления черновика — для плашки «Продолжена выдача». */
interface RestoreInfo {
  restored: boolean;
  partial: boolean;
}

export function IssueChecklist({
  sessionId,
  projectName,
  onBack,
  onComplete,
  onCompleted,
  resumed = null,
  leaveRef,
  onSessionClosed,
}: {
  sessionId: string;
  projectName: string;
  onBack: () => void;
  /** «Готово» на экране итога — к списку броней. */
  onComplete?: () => void;
  /**
   * Сразу после успешного `/complete` — страница перезагружает списки, чтобы
   * выданная бронь ушла из очереди «Выдача» ещё до «Готово».
   */
  onCompleted?: () => void;
} & ChecklistSessionProps) {
  const session = useScanSession();
  const { state: rawState, loading, error, openSession, refresh } = session;
  // Состояние другой сессии (экран переиспользован без key) — ещё не наше.
  const state: ChecklistState | null =
    rawState && rawState.sessionId === sessionId ? rawState : null;

  const [addonOpen, setAddonOpen] = useState(false);
  const [rows, setRows] = useState<IssueRowMap>(() => new Map());
  const [restoreInfo, setRestoreInfo] = useState<RestoreInfo | null>(null);
  const [bannerHidden, setBannerHidden] = useState(false);
  // Доборы из поиска, взятые «под ответственность» (подсказка про аудит).
  const [conflictAddons, setConflictAddons] = useState<Set<string>>(new Set());
  // Жёлтое уведомление над списком: перечитали после изменения состава,
  // загрузили версию с другого устройства, урезали количества.
  const [notice, setNotice] = useState<string | null>(null);
  const [rowProblem, setRowProblem] = useState<
    { bookingItemId: string; problem: IssueRowProblem } | null
  >(null);
  const [localClosed, setLocalClosed] = useState<ScanApiError | null>(null);
  const [earlyIssueMessage, setEarlyIssueMessage] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const [phase, setPhase] = useState<IssuePhase>("checklist");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<CompleteResult | null>(null);

  // Экран переиспользован под другую сессию без remount — всё локальное
  // (итог, ошибки, окна) относится к прежней сессии и сбрасывается сразу, до
  // отрисовки: иначе новая бронь мелькнула бы чужим «Выдача оформлена» (P7).
  const [boundSessionId, setBoundSessionId] = useState(sessionId);
  if (boundSessionId !== sessionId) {
    setBoundSessionId(sessionId);
    setPhase("checklist");
    setResult(null);
    setSubmitError(null);
    setRows(new Map());
    setRestoreInfo(null);
    setBannerHidden(false);
    setConflictAddons(new Set());
    setNotice(null);
    setRowProblem(null);
    setLocalClosed(null);
    setEarlyIssueMessage(null);
    setConfirmOpen(false);
    setAddonOpen(false);
  }

  const closedError: ScanApiError | null = localClosed ?? session.closedError ?? null;
  // Закрытие сессии видно и внутри async «Готово» (ставится прямо в колбэке,
  // не дожидаясь перерисовки); сбрасывается только сменой сессии.
  const closedForRef = useRef<string | null>(null);
  if (closedError) closedForRef.current = sessionId;
  const markClosed = useCallback(
    (err: ScanApiError) => {
      closedForRef.current = sessionId;
      setLocalClosed(err);
    },
    [sessionId],
  );

  // Черновик, который надо заново наложить на свежий `/state` (после 409
  // `CHECKLIST_OUTDATED` позиции брони могли получить новые id).
  const reseedRef = useRef<{ sessionId: string; draft: ChecklistDraftV1 } | null>(null);
  const seededForRef = useRef<string | null>(null);
  // Строки прошлого `/state` — чтобы нетронутая строка шла за новым планом.
  const lastItemsRef = useRef<readonly ChecklistItem[] | null>(null);
  const stateRef = useRef<ChecklistState | null>(state);
  stateRef.current = state;

  const handleOutdated = useCallback((fresh: DraftOutdatedDetails) => {
    const current = stateRef.current;
    if (current) {
      const seed = seedIssueRows(current.items, isChecklistDraftV1(fresh.draft) ? fresh.draft : null);
      setRows(seed.rows);
    }
    setNotice(
      "Чек-лист изменили на другом устройстве — загружена свежая версия. Проверьте строки.",
    );
  }, []);

  const draft = useChecklistDraft({
    sessionId,
    serverRevision: state?.draftRevision,
    serverSavedAt: state?.draftSavedAt,
    serverSavedBy: state?.draftSavedBy,
    serverDraft: state?.draft,
    onOutdated: handleOutdated,
    onSessionClosed: markClosed,
    leaveRef,
  });
  const scheduleDraft = draft.schedule;
  const setDraftBaseline = draft.setBaseline;

  // Открыть сессию в хуке (страница уже создала её на сервере).
  useEffect(() => {
    void openSession(sessionId, "ISSUE");
  }, [sessionId, openSession]);

  // Засев строк: из черновика при первом чтении сессии, заново — после
  // изменения состава брони; иначе (добор этой сессии) — только новые строки.
  useEffect(() => {
    if (!state) return;
    const prevItems = lastItemsRef.current;
    lastItemsRef.current = state.items;
    const pending = reseedRef.current;
    if (pending && pending.sessionId === state.sessionId) {
      reseedRef.current = null;
      const seed = seedIssueRows(state.items, pending.draft);
      setRows(seed.rows);
      // Позиции брони пересоздали — черновик на сервере ссылается на старые id.
      if (issueDraftHasRows(pending.draft)) {
        scheduleDraft(buildIssueDraft(state.items, seed.rows));
      }
      return;
    }
    if (seededForRef.current !== state.sessionId) {
      seededForRef.current = state.sessionId;
      const seed = seedIssueRows(state.items, state.draft);
      const draftRows = state.draft?.issue ? Object.keys(state.draft.issue.rows).length : 0;
      setRows(seed.rows);
      // Засев по плану — не работа: пока оператор ничего не менял, черновик на
      // сервер не уходит, и сессия «открыл и посмотрел» ничего не блокирует.
      if (!state.draft) setDraftBaseline(buildIssueDraft(state.items, seed.rows));
      setRestoreInfo({
        restored: seed.restored > 0,
        partial: seed.clamped.length > 0 || seed.restored < draftRows,
      });
      if (seed.clamped.length > 0) {
        setNotice(
          `Столько сейчас нет на складе — количество уменьшено: ${seed.clamped.join(", ")}. Проверьте эти строки.`,
        );
      }
      return;
    }
    setRows((prev) => mergeNewItems(prev, state.items, prevItems));
  }, [state, scheduleDraft, setDraftBaseline]);

  // Группы категорий в порядке первого появления: порядок строк задаёт сервер.
  const groups = useMemo(
    () => (state ? groupByCategory(state.items, (item) => item.category) : []),
    [state],
  );

  const itemById = useMemo(() => {
    const m = new Map<string, ChecklistItem>();
    for (const item of state?.items ?? []) m.set(item.bookingItemId, item);
    return m;
  }, [state]);

  // ── Правки строк: экран + черновик на сервере ────────────────────────────
  function commitRows(next: IssueRowMap) {
    setRows(next);
    if (!state) return;
    // Хук сам не шлёт то же, что уже сохранено или засеяно.
    scheduleDraft(buildIssueDraft(state.items, next));
  }

  function updateRow(biId: string, fn: (r: IssueRowState, item: ChecklistItem) => IssueRowState) {
    const item = itemById.get(biId);
    if (!item) return;
    const cur = rowOf(rows, item);
    const nextRow = fn(cur, item);
    if (nextRow.qty === cur.qty && nextRow.checked === cur.checked && nextRow.ack === cur.ack) {
      return;
    }
    const next = new Map(rows);
    next.set(biId, nextRow);
    commitRows(next);
    if (rowProblem?.bookingItemId === biId) setRowProblem(null);
  }

  function setRowQty(biId: string, value: number) {
    updateRow(biId, (r, item) => {
      const qty = Math.max(0, Math.min(rowMax(item, r.ack), Math.floor(value) || 0));
      // Обнулённая строка — снимаем «Выдано»: выдавать по ней нечего.
      return { ...r, qty, checked: qty === 0 ? false : r.checked };
    });
  }

  function bumpRowQty(biId: string, delta: number) {
    const item = itemById.get(biId);
    if (!item) return;
    setRowQty(biId, rowOf(rows, item).qty + delta);
  }

  function toggleRowChecked(biId: string) {
    updateRow(biId, (r) => {
      // Обнулённую строку («не выдаём») не отмечаем — прогресс бы врал.
      if (r.qty === 0 && !r.checked) return r;
      return { ...r, checked: !r.checked };
    });
  }

  function setRowAck(biId: string, on: boolean) {
    updateRow(biId, (r, item) => {
      if (on) return { ...r, ack: true };
      // Отказ от «под ответственность» — количество не выше свободного.
      const qty = Math.min(r.qty, item.quantity + freeAddCap(item));
      return { ...r, ack: false, qty, checked: qty === 0 ? false : r.checked };
    });
  }

  function setAllChecked(checked: boolean) {
    if (!state) return;
    const next = new Map(rows);
    for (const item of state.items) {
      const r = rowOf(rows, item);
      next.set(item.bookingItemId, { ...r, checked: checked && r.qty > 0 });
    }
    commitRows(next);
  }

  // ── Производные числа ────────────────────────────────────────────────────
  const intendedQty = useMemo(() => {
    const m = new Map<string, number>();
    for (const item of state?.items ?? []) m.set(item.bookingItemId, rowOf(rows, item).qty);
    return m;
  }, [state, rows]);

  const finance = useMemo(
    () => (state ? computeLiveFinance(state, intendedQty) : emptyLiveFinance()),
    [state, intendedQty],
  );

  const existingEquipmentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of state?.items ?? []) if (item.equipmentId) ids.add(item.equipmentId);
    return ids;
  }, [state]);

  // Для экрана итога: выдано единиц и доборов — строк сверх исходного
  // количества (каталожный добор приходит с originalQuantity 0, P17).
  const counts = useMemo(() => {
    let issuedUnits = 0;
    let addons = 0;
    let addonsInSession = 0;
    for (const item of state?.items ?? []) {
      const intended = rowOf(rows, item).qty;
      issuedUnits += Math.max(0, intended);
      if (intended > item.originalQuantity) addons += 1;
      if ((item.addedOnSite ?? 0) > 0) addonsInSession += 1;
    }
    return { issuedUnits, addons, addonsInSession };
  }, [state, rows]);

  // Прогресс сборки — только строки с количеством больше нуля.
  const { activeTotal, activeChecked } = useMemo(() => {
    let total = 0;
    let checked = 0;
    for (const item of state?.items ?? []) {
      const r = rowOf(rows, item);
      if (r.qty <= 0) continue;
      total += 1;
      if (r.checked) checked += 1;
    }
    return { activeTotal: total, activeChecked: checked };
  }, [state, rows]);

  const startsLater = useMemo(() => {
    const start = state?.booking?.startDate;
    if (!start) return null;
    const ms = Date.parse(start);
    if (!Number.isFinite(ms) || ms - Date.now() <= EARLY_ISSUE_HINT_MS) return null;
    return formatMoscowDayTime(start);
  }, [state]);

  function handleAddonAdded(bookingItemId: string, hadConflict: boolean) {
    if (hadConflict) {
      setConflictAddons((prev) => {
        if (prev.has(bookingItemId)) return prev;
        const n = new Set(prev);
        n.add(bookingItemId);
        return n;
      });
    }
    void refresh();
  }

  // ── Состояния загрузки ───────────────────────────────────────────────────

  const closeAfterSessionEnd = onSessionClosed ?? onBack;

  if (closedError) {
    return (
      <SessionClosedNotice
        error={closedError}
        operation="ISSUE"
        onBack={closeAfterSessionEnd}
      />
    );
  }

  if (!state && (loading || (rawState && rawState.sessionId !== sessionId))) {
    return <ChecklistSkeleton />;
  }

  if (error && !state) {
    return (
      <ChecklistMessage
        tone="error"
        text={error.message || "Не удалось загрузить чек-лист"}
        onBack={onBack}
      />
    );
  }

  if (state && state.items.length === 0) {
    return <ChecklistMessage text="В этой брони нет позиций для выдачи" onBack={onBack} />;
  }

  if (!state) return null;
  const current = state;

  /**
   * Корректировки для `/complete`: только строки, где выдаём не столько, сколько
   * в брони. Больше брони — добор на месте; взято «под ответственность» — с
   * флагом. Флаг уходит на любую прибавку такой строки, а не только сверх
   * `addCap` с экрана: тот мог устареть (строку отверг сервер, а `/state` ещё
   * не перечитан). Сервер учитывает флаг, только если свободного не хватает.
   */
  function buildIssuanceAdjustments(): IssuanceAdjustment[] {
    const adjustments: IssuanceAdjustment[] = [];
    for (const item of current.items) {
      const r = rowOf(rows, item);
      if (r.qty === item.quantity) continue;
      adjustments.push({
        bookingItemId: item.bookingItemId,
        actualQuantity: r.qty,
        ...(r.ack && r.qty > item.quantity ? { acknowledgedConflict: true } : {}),
      });
    }
    return adjustments;
  }

  /** Строку отвергли при «Готово»: подсветить и объяснить. */
  function markRow(bookingItemId: string | undefined, problem: IssueRowProblem) {
    if (!bookingItemId || !itemById.has(bookingItemId)) return;
    setRowProblem({ bookingItemId, problem });
  }

  function handleCompleteError(err: unknown): void {
    if (isSessionClosedError(err)) {
      draft.discard();
      markClosed(err);
      return;
    }
    const code = scanErrorCode(err);
    const message = isScanApiError(err) ? err.message : "Сеть недоступна";

    if (code === SCAN_ERROR.ISSUE_TOO_EARLY) {
      setEarlyIssueMessage(message);
      return;
    }

    if (code === SCAN_ERROR.CHECKLIST_OUTDATED) {
      // Состав брони поменяли: перечитать чек-лист и заново наложить то, что
      // уже погружено (строки найдутся по позиции или по прибору).
      reseedRef.current = { sessionId, draft: buildIssueDraft(current.items, rows) };
      setNotice(message);
      void refresh();
      return;
    }

    if (code === SCAN_ERROR.DRAFT_OUTDATED) {
      const fresh = getScanErrorDetails(err, SCAN_ERROR.DRAFT_OUTDATED);
      const freshDraft = fresh && isChecklistDraftV1(fresh.draft) ? fresh.draft : null;
      // Хук черновика берёт свежую ревизию — следующее «Готово» и следующая
      // правка уйдут уже от неё; экран перезасеивается версией из ответа.
      if (fresh) {
        draft.adoptOutdated({
          revision: fresh.revision,
          draft: freshDraft,
          savedAt: fresh.savedAt ?? null,
          savedBy: fresh.savedBy ?? null,
        });
      }
      const seed = seedIssueRows(current.items, freshDraft);
      setRows(seed.rows);
      setNotice(`${message} Проверьте строки и нажмите «Готово» ещё раз.`);
      return;
    }

    // Снимают единицы, которые уже отсканированы (штучный учёт) — строку
    // возвращаем к количеству брони.
    if (code === ADJUSTMENT_CONFLICTS_WITH_SCANS) {
      const d = isScanApiError(err)
        ? (err.details as { bookingItemId?: string } | null | undefined)
        : null;
      const item = d?.bookingItemId ? itemById.get(d.bookingItemId) : undefined;
      if (item) {
        const next = new Map(rows);
        next.set(item.bookingItemId, { ...rowOf(rows, item), qty: item.quantity });
        commitRows(next);
      }
      setSubmitError(message);
      return;
    }

    if (code === SCAN_ERROR.ADDON_OVER_STOCK) {
      const d = getScanErrorDetails(err, SCAN_ERROR.ADDON_OVER_STOCK);
      const item = d?.bookingItemId ? itemById.get(d.bookingItemId) : undefined;
      if (item) {
        // `addCap` в ответе — потолок, по которому строку проверяли: при
        // «под ответственность» это ackCap. Урезанное количество выше
        // свободного так и остаётся под ответственностью — иначе следующее
        // «Готово» уйдёт без флага и получит ADDON_CONFLICT.
        const cap = Math.max(0, Math.floor(Number(d?.addCap ?? 0)) || 0);
        const cur = rowOf(rows, item);
        const qty = Math.min(cur.qty, item.quantity + cap);
        const ack = cur.ack && qty > item.quantity + freeAddCap(item);
        const next = new Map(rows);
        next.set(item.bookingItemId, { ...cur, qty, ack, checked: qty === 0 ? false : cur.checked });
        commitRows(next);
        markRow(item.bookingItemId, {
          kind: "over-stock",
          text: `Столько на складе нет — количество уменьшено до ${qty}.`,
        });
        void refresh();
      }
      setSubmitError(message);
      return;
    }

    if (code === SCAN_ERROR.ADDON_CONFLICT) {
      const d = getScanErrorDetails(err, SCAN_ERROR.ADDON_CONFLICT);
      markRow(d?.bookingItemId, {
        kind: "conflict",
        text: "Сверх свободного выдать можно только под ответственность.",
        conflict: d ?? null,
      });
      void refresh();
      setSubmitError(message);
      return;
    }

    setSubmitError(message);
  }

  async function submitToComplete(opts: { force?: boolean } = {}) {
    if (phase === "submitting") return;
    setSubmitError(null);
    setRowProblem(null);
    setEarlyIssueMessage(null);
    setPhase("submitting");

    // Сначала дослать черновик: `/complete` сверит ревизию. `null` — сессию
    // закрыли или другое устройство сохранило позже прямо сейчас: экран уже
    // перезасеян, оператор должен увидеть свежую версию до выдачи.
    const pre = await draft.flushBeforeSubmit();
    if (!pre || closedForRef.current === sessionId) {
      setPhase("checklist");
      return;
    }
    const draftRevision = pre.draftRevision;

    const adjustments = buildIssuanceAdjustments();
    const payload = {
      ...(adjustments.length > 0 ? { issuanceAdjustments: adjustments } : {}),
      ...(current.itemsVersion ? { itemsVersion: current.itemsVersion } : {}),
      ...(draftRevision !== undefined ? { draftRevision } : {}),
      ...(opts.force ? { force: true } : {}),
    };
    try {
      const res = await scanApi.complete(sessionId, payload);
      draft.discard();
      setResult(res);
      setPhase("result");
      // Страница перезагружает списки — выданная бронь уходит из очереди.
      try {
        onCompleted?.();
      } catch {
        /* побочный эффект интерфейса — не мешает итогу */
      }
    } catch (err: unknown) {
      setPhase("checklist");
      handleCompleteError(err);
    }
  }

  function requestSubmit() {
    // Не все активные позиции отмечены «Выдано» — подтверждаем явно: на
    // длинном чек-листе легко нажать «Завершить», не догрузив стеллаж.
    if (activeChecked < activeTotal) {
      setConfirmOpen(true);
      return;
    }
    void submitToComplete();
  }

  // ── Итог ─────────────────────────────────────────────────────────────────
  if (phase === "result" && result) {
    return (
      <IssueResultView
        result={result}
        bookingId={current.bookingId}
        projectName={projectName}
        issuedCount={counts.issuedUnits}
        addonsCount={result.addonsAddedInSession ?? counts.addons}
        substitutedCount={result.substitutedItems?.length ?? 0}
        onDone={() => onComplete?.()}
      />
    );
  }

  const showBanner = resumed != null && !bannerHidden && restoreInfo !== null;
  const statusLabel = draft.statusLabel;

  // «Прервать выдачу»: на десктопе — в шапке списка, на мобильном — внизу
  // списка во всю ширину (в шапке рядом с «＋ Добор» ей тесно).
  const abortButton = (variant: "header" | "block") => (
    <AbortSessionButton
      sessionId={sessionId}
      operation="ISSUE"
      addonsInSession={counts.addonsInSession}
      onAborted={closeAfterSessionEnd}
      onSessionClosed={markClosed}
      disabled={phase === "submitting"}
      variant={variant}
    />
  );

  return (
    <div className="flex min-h-full flex-1 flex-col">
      {showBanner && (
        <ResumedSessionBanner
          operation="ISSUE"
          startedAt={current.session?.startedAt ?? resumed.startedAt ?? null}
          startedBy={current.session?.workerName ?? resumed.workerName ?? null}
          restored={restoreInfo.restored}
          draftSavedAt={current.draftSavedAt ?? null}
          draftSavedBy={current.draftSavedBy ?? null}
          partial={restoreInfo.partial}
          onDismiss={() => setBannerHidden(true)}
        />
      )}

      <div className="flex-1 px-3 pb-4 pt-3 lg:px-4">
        {/* Водители — заполняется в момент погрузки. */}
        <DriverPanel sessionId={sessionId} operation="ISSUE" />

        {startsLater && (
          <div className="mb-2 rounded-lg border border-amber-border bg-amber-soft px-3 py-2 text-[12px] leading-snug text-ink">
            <span aria-hidden="true">⚠ </span>
            Аренда начинается {startsLater} — до начала больше суток. Проверьте,
            что выдаёте нужную бронь.
          </div>
        )}

        <IssueChecklistHeading
          checked={activeChecked}
          total={activeTotal}
          statusLabel={statusLabel}
          statusWarn={draft.status === "offline" || draft.status === "failed"}
          onCheckAll={() => setAllChecked(true)}
          onUncheckAll={() => setAllChecked(false)}
          onAddon={() => setAddonOpen(true)}
          abortSlot={abortButton("header")}
        />

        {notice && (
          <div
            role="status"
            className="mb-2 flex items-start gap-2 rounded-lg border border-amber-border bg-amber-soft px-3 py-2 text-[12px] leading-snug text-ink"
          >
            <span className="flex-1">{notice}</span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              aria-label="Скрыть уведомление"
              className="-my-1 flex h-7 w-7 shrink-0 items-center justify-center rounded text-ink-3 transition-colors hover:bg-surface-muted"
            >
              <span aria-hidden="true">✕</span>
            </button>
          </div>
        )}

        {groups.map((group) => (
          <section key={group.category} className="mb-1">
            <p className="eyebrow px-1.5 pb-1 pt-2">{group.category}</p>
            <div className="space-y-1.5">
              {group.items.map((item) => (
                <IssueRow
                  key={item.bookingItemId}
                  item={item}
                  row={rowOf(rows, item)}
                  problem={
                    rowProblem?.bookingItemId === item.bookingItemId ? rowProblem.problem : null
                  }
                  onBump={(delta) => bumpRowQty(item.bookingItemId, delta)}
                  onSet={(value) => setRowQty(item.bookingItemId, value)}
                  onToggleCheck={() => toggleRowChecked(item.bookingItemId)}
                  onAck={(on) => setRowAck(item.bookingItemId, on)}
                />
              ))}
            </div>
          </section>
        ))}

        {/* Доборы «под ответственность» из поиска — чтобы аудит не был сюрпризом. */}
        {conflictAddons.size > 0 && (
          <div className="mt-3 rounded-lg border border-amber-border bg-amber-soft px-3 py-2 text-[12px] text-amber">
            <span aria-hidden="true">⚠ </span>
            {conflictAddons.size === 1
              ? "Один добор добавлен с конфликтом — зафиксируется в аудите."
              : `${conflictAddons.size} доборов добавлены с конфликтом — зафиксируются в аудите.`}
          </div>
        )}

        {submitError && (
          <div
            role="alert"
            className="mt-3 rounded-lg border border-rose-border bg-rose-soft px-3 py-2 text-[12px] text-rose"
          >
            Не получилось завершить выдачу: {submitError}
          </div>
        )}

        <div className="mt-4 lg:hidden">{abortButton("block")}</div>

        {addonOpen && (
          <AddonSearch
            sessionId={sessionId}
            bookingId={current.bookingId}
            bookingNo={current.bookingId ? displayNo(current.bookingId) : undefined}
            existingEquipmentIds={existingEquipmentIds}
            manualFinalAmount={current.booking?.manualFinalAmount ?? null}
            onAdded={handleAddonAdded}
            onClose={() => setAddonOpen(false)}
            onSessionClosed={(err) => {
              setAddonOpen(false);
              markClosed(err);
            }}
          />
        )}
      </div>

      {/*
        Живой блок финансов — прилипает к низу экрана (на мобильном — над
        нижней навигацией). Рисуется и при нулях, чтобы «Готово» было видно.
      */}
      <div className={`${STICKY_ABOVE_TAB_BAR} border-t border-border bg-surface px-3 py-3 lg:px-4`}>
        <LiveFinanceBlock
          finance={finance}
          onSubmit={requestSubmit}
          submitting={phase === "submitting"}
          checkedCount={activeChecked}
          totalCount={activeTotal}
        />
      </div>

      {confirmOpen && (
        <ConfirmPartialDialog
          checked={activeChecked}
          total={activeTotal}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => {
            setConfirmOpen(false);
            void submitToComplete();
          }}
        />
      )}

      {earlyIssueMessage && (
        <EarlyIssueDialog
          message={earlyIssueMessage}
          onCheck={() => setEarlyIssueMessage(null)}
          onForce={() => {
            setEarlyIssueMessage(null);
            void submitToComplete({ force: true });
          }}
        />
      )}
    </div>
  );
}
