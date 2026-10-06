"use client";

/**
 * RETURN checklist — the operator's per-unit «приёмка» (3-outcome) screen.
 *
 * Visual source of truth: docs/mockups/warehouse-scan/01-return-checklist.html
 *  - «✓ Принять всё разом» primary bar → category groups → per-unit row with
 *    the 3-segment control (✓ Принято / 🔧 Ремонт / ✗ Проблема) → inline
 *    expanded AMBER RepairPanel / ROSE ProblemPanel → sticky
 *    «Завершить приёмку →» footer. NEVER a barcode — name + «прибор N из M».
 *  - On success: a canon RESULT view (counts + a rose warning if anything
 *    failed) with a «Готово» action back to the bookings list.
 *
 * Data: `useScanSession` (operation RETURN). Loading/error/empty canon+Russian.
 *  - UNIT items: one row per unit. The outcome is local state OWNED here
 *    (`outcomes` map). ACCEPTED also marks the unit returned via the hook's
 *    optimistic `check` (server-authoritative, per-id in-flight guard — we do
 *    NOT bypass it). REPAIR/PROBLEM are sent in the single `/complete` POST.
 *  - COUNT items: a grid of slots per line (`UnitGridRow`), accept/repair/
 *    problem per physical piece, sent as COUNT-form entries in `/complete`.
 *  - Строки ×0 (позицию сняли степпером на выдаче) в приёмке не участвуют:
 *    их не рисуем и не требуем «Помечьте все 0 шт» — иначе приёмку нельзя
 *    завершить ничем, кроме кнопки на карточке брони.
 *
 * Черновик (P6): исходы, сетки, комментарии и пробег машин уходят на сервер
 * (`useChecklistDraft`, 800 мс) и восстанавливаются при следующем открытии
 * (`returnChecklistDraft.ts`) — смена раздела, «←», перезагрузка и второй
 * планшет работу больше не теряют. Сервер защищает «Завершить» ревизией
 * черновика и отпечатком состава брони (`draftRevision`, `itemsVersion`):
 *  - `CHECKLIST_OUTDATED` — состав брони поменялся: перечитываем чек-лист и
 *    переносим свои отметки на новый состав;
 *  - `DRAFT_OUTDATED` — другое устройство сохранило позже: показываем его
 *    версию;
 *  - `SESSION_*` — приёмку уже завершили, прервали или бронь приняли на
 *    карточке: `SessionClosedNotice` вместо чек-листа.
 *
 * ⚠ expectedBackDate WIRE-FORMAT TRAP: ProblemPanel emits a bare
 * `YYYY-MM-DD`; the backend Zod (`z.string().datetime()`) needs ISO-8601.
 * THIS component owns the conversion (`toIsoDatetime`), only for
 * `LEFT_ON_SITE` with a date present.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useScanSession } from "./useScanSession";
import { scanApi } from "./api";
import { DriverPanel } from "./DriverPanel";
import type { UnitSlot } from "./UnitGridRow";
import { ReturnResultView } from "./ReturnResultView";
import { STICKY_ABOVE_TAB_BAR } from "./WorkstationShell";
import { VehicleMileagePanel } from "./VehicleMileagePanel";
import { ReturnItemRows, type ReturnRowHandlers } from "./ReturnChecklistRows";
import { SessionClosedNotice } from "./SessionClosedNotice";
import { AbortSessionButton } from "./AbortSessionButton";
import { ResumedSessionBanner } from "./ResumedSessionBanner";
import { useChecklistDraft } from "./useChecklistDraft";
import { PlannedStaysBlock } from "./PlannedStaysBlock";
import { KioskStayEditor, StayTerms } from "./KioskStayEditor";
import { ContinuationPriceBlock } from "../bookings/ContinuationPriceBlock";
import type { KioskStay } from "./kioskStays";
import { useKioskStays } from "./useKioskStays";
import {
  buildReturnCompletePayload,
  computeAcceptedCount,
  computeReturnRowErrors,
  cycleStatus,
  returnUnitIds,
} from "./returnChecklistPayload";
import {
  buildReturnDraft,
  emptySlots,
  hydrateReturnDraft,
  mileageEntries,
  returnableItems,
  type HydratedReturn,
  type MileageMap,
  type OutcomeMap,
} from "./returnChecklistDraft";
import {
  SCAN_ERROR,
  getScanErrorDetails,
  isScanApiError,
  isSessionClosedError,
  scanErrorCode,
} from "./types";
import type {
  ChecklistDraftV1,
  ChecklistSessionProps,
  ChecklistItem,
  ChecklistState,
  CompleteResult,
  DraftOutdatedDetails,
  ProblemDraft,
  ReturnOutcome,
  ScanApiError,
  VehicleMileageEntry,
} from "./types";
import { pluralize } from "../../lib/format";
import { groupByCategory } from "../../lib/groupByCategory";

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Восстановление черновика — до того, как экран станет кликабельным: иначе
 * отметка, поставленная между отрисовкой и обычным эффектом, затёрлась бы
 * восстановленным состоянием. На сервере (SSR) layout-эффект не нужен.
 */
const useHydrationEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

const RESET_ROW_NOTICE =
  "Количество в брони изменилось — отметки по этой строке сброшены, отметьте заново";
const OTHER_DEVICE_NOTICE =
  "Чек-лист изменили на другом устройстве — загружена свежая версия";
const CHECKLIST_OUTDATED_NOTICE =
  "Состав брони изменился, пока был открыт чек-лист — список обновлён, проверьте строки";

/** Состав брони поменялся — перенести свои отметки на новый состав. */
interface PendingRebase {
  draft: ChecklistDraftV1;
  fromVersion: string | undefined;
}

/**
 * Строки «по плану», по которым уже есть отметки (черновик, другой планшет или
 * сервер): их начали принимать — место им в чек-листе, а не в продолжении.
 */
function markedPlannedIds(state: { plannedStays?: { bookingItemId: string }[]; items: ChecklistState["items"] }, h: HydratedReturn): string[] {
  return (state.plannedStays ?? [])
    .filter((p) => {
      if (h.unitGrids.has(p.bookingItemId)) return true;
      const item = state.items.find((i) => i.bookingItemId === p.bookingItemId);
      return (item?.units ?? []).some((u) => u.checked || h.outcomes[u.unitId] != null);
    })
    .map((p) => p.bookingItemId);
}

/** Полная сетка COUNT-строки — по количеству в брони (хранится и уходит в черновик). */
function fitSlots(slots: UnitSlot[] | undefined, qty: number): UnitSlot[] {
  if (!slots) return emptySlots(qty);
  if (slots.length === qty) return slots;
  if (slots.length > qty) return slots.slice(0, qty);
  return [...slots, ...emptySlots(qty).slice(slots.length)];
}

const FLAGGED = (s: UnitSlot) => s.status === "REPAIR" || s.status === "PROBLEM";

/**
 * Что из полной сетки видно в чек-листе, когда часть штук остаётся у клиента:
 * скрываются ячейки с конца — сначала пустые, потом принятые. Ремонт и
 * «Потеряшки» не скрываются никогда (потолок «остаётся» их не трогает).
 * Номера ячеек остаются прежними: по ним правки попадают в полную сетку.
 */
function visibleSlots(full: UnitSlot[], qty: number): UnitSlot[] {
  let drop = full.length - qty;
  if (drop <= 0) return full;
  const hidden = new Set<number>();
  for (const status of ["PENDING", "ACCEPTED"] as const) {
    for (let i = full.length - 1; i >= 0 && drop > 0; i -= 1) {
      if (full[i].status === status && !hidden.has(i)) {
        hidden.add(i);
        drop -= 1;
      }
    }
  }
  return full.filter((_, i) => !hidden.has(i));
}

// ── Component ────────────────────────────────────────────────────────────────

export function ReturnChecklist({
  sessionId,
  projectName,
  onBack,
  onDone,
  onCompleted,
  onSessionClosed,
  leaveRef,
  resumed,
}: ChecklistSessionProps & {
  sessionId: string;
  projectName: string;
  onBack: () => void;
  /** Back to the bookings list after a completed приёмка («Готово»). */
  onDone?: () => void;
  /**
   * Fires the moment a successful /complete response arrives — BEFORE the
   * operator sees the result screen (the parent refetches the booking lists).
   */
  onCompleted?: () => void;
}) {
  const session = useScanSession();
  const { state, loading, error, openSession, check, uncheck, refresh } = session;

  // Per-unit outcome map — OWNED here (panels are controlled).
  const [outcomes, setOutcomes] = useState<OutcomeMap>({});
  // COUNT rows: bookingItemId → one slot per physical piece.
  const [unitGrids, setUnitGrids] = useState<Map<string, UnitSlot[]>>(new Map());
  // Строки, чьи отметки из черновика сброшены: количество в брони изменилось.
  const [resetRows, setResetRows] = useState<ReadonlySet<string>>(new Set());
  const [restoredMileages, setRestoredMileages] = useState<MileageMap | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Жёлтое пояснение: чек-лист перечитан или загружен с другого устройства.
  const [notice, setNotice] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [validationSummary, setValidationSummary] = useState<string | null>(null);
  const [result, setResult] = useState<CompleteResult | null>(null);
  // Сессия закрыта (SESSION_*): вместо чек-листа — уведомление.
  const [closedError, setClosedError] = useState<ScanApiError | null>(null);
  // Что восстановлено при открытии — для плашки продолженной сессии.
  const [restoreInfo, setRestoreInfo] = useState<{ restored: boolean; partial: boolean } | null>(
    null,
  );
  const [bannerDismissed, setBannerDismissed] = useState(false);
  // Позиции «по плану у клиента», которые всё-таки привезли сейчас: они уходят
  // в обычный чек-лист, остальные «по плану» — в продолжение по «Завершить».
  const [returnNow, setReturnNow] = useState<ReadonlySet<string>>(new Set());

  // Пробег машин: entries из VehicleMileagePanel + валидность. Пока панель
  // не загрузила машины (`mileagesReported`), черновик несёт восстановленный
  // пробег, а не пустоту.
  const [vehicleMileages, setVehicleMileages] = useState<VehicleMileageEntry[]>([]);
  const [mileagesReported, setMileagesReported] = useState(false);
  const [vehicleMileagesValid, setVehicleMileagesValid] = useState<boolean>(true);
  const [attemptedSubmit, setAttemptedSubmit] = useState<boolean>(false);

  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // Черновик: для какой сессии уже восстановлен, была ли правка оператора.
  const hydratedFor = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const pendingRebase = useRef<PendingRebase | null>(null);

  const planned = useMemo(() => state?.plannedStays ?? [], [state]);
  // Строки чек-листа до «остаётся у клиента»: по ним рисуются группы и
  // редакторы «Остаётся у клиента…».
  const baseItems = useMemo(() => {
    if (!state) return [];
    const plannedIds = new Set(planned.map((p) => p.bookingItemId));
    return returnableItems(state.items).filter(
      (i) => !plannedIds.has(i.bookingItemId) || returnNow.has(i.bookingItemId),
    );
  }, [state, planned, returnNow]);
  // «Остаётся у клиента» (этап 15): строки за вычетом оставленного, stays,
  // превью доплаты и держателей.
  const {
    plannedTerms,
    extraStays,
    adjustedById,
    items,
    allStays,
    paidThroughOf,
    previewLoading: staysPreviewLoading,
    previewLineFor,
    conflictFor,
    previewDiscount,
    unacknowledgedConflicts,
    anyExtraStaying,
    setExtraStay,
    setPlannedTerm,
    refreshPreview: refreshStaysPreview,
    applyServerConflicts,
    preview: staysPreview,
    draftStays,
    restoreStays,
  } = useKioskStays({ sessionId, state, baseItems, planned, returnNow });

  const applyHydration = useCallback(
    (h: HydratedReturn, opts: { markDirty: boolean }) => {
      // Отмеченные строки «по плану» — в чек-лист; иначе чужие отметки ушли бы
      // в продолжение, а принятые приборы — к клиенту.
      if (state) {
        const marked = markedPlannedIds(state, h);
        if (marked.length > 0) setReturnNow((prev) => new Set([...prev, ...marked]));
      }
      setOutcomes(h.outcomes);
      setUnitGrids(h.unitGrids);
      restoreStays(h.stays);
      setResetRows(new Set(h.resetRowIds));
      setRestoredMileages(Object.keys(h.mileages).length > 0 ? { ...h.mileages } : null);
      setRowErrors({});
      setValidationSummary(null);
      dirtyRef.current = opts.markDirty;
      for (const id of h.toCheck) void check(id).catch(() => undefined);
      for (const id of h.toUncheck) void uncheck(id).catch(() => undefined);
    },
    [check, uncheck, state, restoreStays],
  );

  // Другое устройство сохранило черновик позже: показываем его версию.
  const handleDraftOutdated = useCallback(
    (fresh: DraftOutdatedDetails) => {
      if (!state) return;
      applyHydration(hydrateReturnDraft(state.items, fresh.draft), { markDirty: false });
      setNotice(OTHER_DEVICE_NOTICE);
    },
    [state, applyHydration],
  );

  const draft = useChecklistDraft({
    sessionId,
    serverRevision: state?.draftRevision,
    serverSavedAt: state?.draftSavedAt ?? null,
    serverSavedBy: state?.draftSavedBy ?? null,
    serverDraft: state?.draft ?? null,
    onOutdated: handleDraftOutdated,
    onSessionClosed: setClosedError,
    leaveRef,
  });
  const { schedule: scheduleDraft, discard: discardDraft } = draft;

  // Bind the hook to the upstream-opened session.
  useEffect(() => {
    void openSession(sessionId, "RETURN");
  }, [sessionId, openSession]);

  // Восстановление: один раз на сессию из `state.draft`; после 409
  // CHECKLIST_OUTDATED — из своих отметок, перенесённых на новый состав.
  useHydrationEffect(() => {
    if (!state) return;
    const rebase = pendingRebase.current;
    if (rebase && state.itemsVersion !== rebase.fromVersion) {
      pendingRebase.current = null;
      hydratedFor.current = state.sessionId;
      applyHydration(hydrateReturnDraft(state.items, rebase.draft), { markDirty: true });
      return;
    }
    if (hydratedFor.current === state.sessionId) return;
    hydratedFor.current = state.sessionId;
    const h = hydrateReturnDraft(state.items, state.draft ?? null);
    setReturnNow(new Set(markedPlannedIds(state, h)));
    setRestoreInfo({
      restored: h.restoredAny,
      partial: h.resetRowIds.length > 0 || h.unmatchedGrids > 0,
    });
    applyHydration(h, { markDirty: false });
  }, [state, applyHydration]);

  // Сессию закрыли, пока чек-лист открывался (/state → SESSION_*): черновик
  // досылать некуда.
  const loadClosed = session.closedError ?? (isSessionClosedError(error) ? error : null);
  useEffect(() => {
    if (loadClosed) discardDraft();
  }, [loadClosed, discardDraft]);

  const draftMileages = useMemo(
    () => (mileagesReported ? vehicleMileages : mileageEntries(restoredMileages)),
    [mileagesReported, vehicleMileages, restoredMileages],
  );

  // Правка оператора → черновик на сервер (хук сам копит 800 мс).
  useEffect(() => {
    if (!dirtyRef.current || result || closedError) return;
    scheduleDraft(buildReturnDraft({ items: baseItems, outcomes, unitGrids, mileages: draftMileages, stays: draftStays }));
  }, [baseItems, outcomes, unitGrids, draftMileages, draftStays, result, closedError, scheduleDraft]);

  // Пробег — правка, только когда кладовщик сам меняет поле: подстановка из
  // черновика и загрузка списка машин черновик не переписывают.
  const handleMileagesChange = useCallback((entries: VehicleMileageEntry[]) => {
    setVehicleMileages(entries);
    setMileagesReported(true);
  }, []);
  const handleMileageEdit = useCallback(() => {
    dirtyRef.current = true;
  }, []);

  // Группы категорий в порядке первого появления: порядок строк задаёт сервер.
  const groups = useMemo(() => groupByCategory(baseItems, (item) => item.category), [baseItems]);
  // Сетки COUNT-строк под их текущее количество (часть штук могла остаться у клиента).
  const baseQtyById = useMemo(() => new Map(baseItems.map((i) => [i.bookingItemId, i.quantity])), [baseItems]);
  const effectiveGrids = useMemo(() => {
    const m = new Map<string, UnitSlot[]>();
    for (const it of items) {
      const g = unitGrids.get(it.bookingItemId);
      if (g && it.trackingMode !== "UNIT") {
        m.set(it.bookingItemId, visibleSlots(fitSlots(g, baseQtyById.get(it.bookingItemId) ?? it.quantity), it.quantity));
      } else if (g) m.set(it.bookingItemId, g);
    }
    return m;
  }, [items, unitGrids, baseQtyById]);


  const unitIds = useMemo(() => returnUnitIds(items), [items]);

  // unitId → «SkyPanel S60 — прибор 2 из 3» для экрана результата: сырые id
  // оператору не показываем.
  const unitNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const item of state?.items ?? []) {
      if (item.trackingMode !== "UNIT" || !item.units) continue;
      const total = item.units.length;
      item.units.forEach((u, idx) => {
        m.set(u.unitId, total > 1 ? `${item.equipmentName} — прибор ${idx + 1} из ${total}` : item.equipmentName);
      });
    }
    return m;
  }, [state]);

  // ── Outcome mutations (каждая — правка оператора → черновик) ──────────────

  function touch(rowId: string) {
    dirtyRef.current = true;
    setRowErrors((prev) => {
      if (!(rowId in prev)) return prev;
      const next = { ...prev };
      delete next[rowId];
      return next;
    });
  }

  function isUnitCheckedOnServer(unitId: string): boolean {
    for (const item of items) {
      const u = item.units?.find((x) => x.unitId === unitId);
      if (u) return u.checked;
    }
    return false;
  }

  function setUnitOutcome(unitId: string, next: ReturnOutcome) {
    touch(unitId);
    const wasAccepted = outcomes[unitId]?.outcome === "ACCEPTED" || isUnitCheckedOnServer(unitId);
    setOutcomes((prev) => {
      const existing = prev[unitId];
      if (next === "REPAIR") {
        return { ...prev, [unitId]: { outcome: "REPAIR", repairComment: existing?.repairComment ?? "" } };
      }
      if (next === "PROBLEM") {
        const problem: ProblemDraft = existing?.problem ?? { reason: null, comment: "", expectedBackDate: null };
        return { ...prev, [unitId]: { outcome: "PROBLEM", problem } };
      }
      return { ...prev, [unitId]: { outcome: "ACCEPTED" } };
    });
    // ACCEPTED also marks the unit returned through the hook's optimistic
    // `check`; changing mind after «Принято» removes the server mark.
    if (next === "ACCEPTED") void check(unitId).catch(() => undefined);
    else if (wasAccepted) void uncheck(unitId).catch(() => undefined);
  }

  function setRepairComment(unitId: string, comment: string) {
    touch(unitId);
    setOutcomes((prev) => {
      const ex = prev[unitId];
      if (!ex || ex.outcome !== "REPAIR") return prev;
      return { ...prev, [unitId]: { ...ex, repairComment: comment } };
    });
  }

  function patchProblem(unitId: string, patch: Partial<ProblemDraft>) {
    touch(unitId);
    setOutcomes((prev) => {
      const ex = prev[unitId];
      if (!ex || ex.outcome !== "PROBLEM") return prev;
      const base: ProblemDraft = ex.problem ?? { reason: null, comment: "", expectedBackDate: null };
      return { ...prev, [unitId]: { ...ex, problem: { ...base, ...patch } } };
    });
  }

  /** Grid of a COUNT row, lazily all-PENDING. */
  function slotsOf(bookingItemId: string, qty: number): UnitSlot[] {
    return visibleSlots(fitSlots(unitGrids.get(bookingItemId), baseQtyById.get(bookingItemId) ?? qty), qty);
  }

  // Правки — в полную сетку строки: скрытые ячейки (оставленное у клиента)
  // сохраняют свои отметки на случай «Не остаётся».
  function updateGrid(bookingItemId: string, visibleQty: number, map: (slots: UnitSlot[]) => UnitSlot[]) {
    const qty = baseQtyById.get(bookingItemId) ?? visibleQty;
    touch(bookingItemId);
    setResetRows((prev) => {
      if (!prev.has(bookingItemId)) return prev;
      const next = new Set(prev);
      next.delete(bookingItemId);
      return next;
    });
    setUnitGrids((prev) => {
      const updated = new Map(prev);
      updated.set(bookingItemId, map(fitSlots(prev.get(bookingItemId), qty)));
      return updated;
    });
  }

  const handlers: ReturnRowHandlers = {
    setUnitOutcome,
    setRepairComment,
    patchProblem,
    cycleSlot: (biId, index, qty) =>
      updateGrid(biId, qty, (slots) =>
        slots.map((s) => (s.index === index ? { ...s, status: cycleStatus(s.status) } : s)),
      ),
    // «Все» — только видимые ячейки: скрытое остаётся у клиента.
    acceptRow: (biId, qty) => {
      const visible = new Set(slotsOf(biId, qty).map((s) => s.index));
      updateGrid(biId, qty, (slots) => slots.map((s) => (visible.has(s.index) ? { ...s, status: "ACCEPTED" as const } : s)));
    },
    setSlotRepairComment: (biId, index, comment, qty) =>
      updateGrid(biId, qty, (slots) =>
        slots.map((s) => (s.index === index ? { ...s, repairComment: comment } : s)),
      ),
    patchSlotProblem: (biId, index, patch, qty) =>
      updateGrid(biId, qty, (slots) =>
        slots.map((s) => (s.index === index ? { ...s, problem: { ...s.problem, ...patch } } : s)),
      ),
  };

  /** «Вернули сейчас» ⇄ «остаётся по плану». Обратно — отметки строки снимаются. */
  function toggleReturnNow(bookingItemId: string) {
    dirtyRef.current = true;
    if (!returnNow.has(bookingItemId)) {
      setReturnNow((prev) => new Set(prev).add(bookingItemId));
      return;
    }
    const item = state?.items.find((i) => i.bookingItemId === bookingItemId);
    const unitIdsOfLine = (item?.units ?? []).map((u) => u.unitId);
    // Отметка «принято» на сервере осталась бы — снимаем её: единица уходит
    // в продолжение, на полку её ставить нельзя.
    for (const u of item?.units ?? []) {
      if (u.checked || outcomes[u.unitId]?.outcome === "ACCEPTED") void uncheck(u.unitId).catch(() => undefined);
    }
    setOutcomes((prev) => {
      const next = { ...prev };
      for (const id of unitIdsOfLine) delete next[id];
      return next;
    });
    setUnitGrids((prev) => {
      if (!prev.has(bookingItemId)) return prev;
      const next = new Map(prev);
      next.delete(bookingItemId);
      return next;
    });
    setReturnNow((prev) => {
      const next = new Set(prev);
      next.delete(bookingItemId);
      return next;
    });
  }

  /**
   * «Остаётся у клиента…» у обычной строки. Единицы, которые теперь остаются,
   * снимаются с «принято»: на полку их ставить нельзя.
   */
  function changeExtraStay(item: ChecklistItem, next: KioskStay | null) {
    dirtyRef.current = true;
    const prev = extraStays.get(item.bookingItemId);
    const nowKept = new Set(next?.unitIds ?? []);
    const added = (item.units ?? []).filter((u) => nowKept.has(u.unitId) && !(prev?.unitIds ?? []).includes(u.unitId));
    for (const u of added) {
      if (u.checked || outcomes[u.unitId]?.outcome === "ACCEPTED") void uncheck(u.unitId).catch(() => undefined);
    }
    if (added.length > 0) {
      // Ремонт и «Потеряшки» оставить нельзя (кнопка единицы закрыта) —
      // снимается только «Принято».
      setOutcomes((o) => {
        const n = { ...o };
        for (const u of added) if (n[u.unitId]?.outcome === "ACCEPTED") delete n[u.unitId];
        return n;
      });
    }
    // Строка поменялась — старые подсказки «Помечьте все N шт» к ней больше не относятся.
    setRowErrors((errs) => {
      const ids = new Set([item.bookingItemId, ...(item.units ?? []).map((u) => u.unitId)]);
      if (!Object.keys(errs).some((k) => ids.has(k))) return errs;
      return Object.fromEntries(Object.entries(errs).filter(([k]) => !ids.has(k)));
    });
    setExtraStay(item.bookingItemId, next);
  }

  // «Принять всё разом»: every UNIT unit ACCEPTED (hook guard dedupes) and
  // every COUNT slot ACCEPTED. Строки ×0 не трогаем — их в приёмке нет.
  async function acceptAll() {
    if (!state || bulkBusy || submitting) return;
    setBulkBusy(true);
    dirtyRef.current = true;
    try {
      const nextGrids = new Map<string, UnitSlot[]>();
      for (const item of items) {
        if (item.trackingMode !== "UNIT" || !item.units) {
          nextGrids.set(
            item.bookingItemId,
            emptySlots(item.quantity).map((s) => ({ ...s, status: "ACCEPTED" as const })),
          );
        }
      }
      setUnitGrids(nextGrids);
      setResetRows(new Set());
      setOutcomes((prev) => {
        const next: OutcomeMap = { ...prev };
        for (const id of unitIds) next[id] = { outcome: "ACCEPTED" };
        return next;
      });
      setRowErrors({});
      setValidationSummary(null);

      const pending: Promise<void>[] = [];
      for (const item of items) {
        for (const u of item.units ?? []) {
          if (!u.checked) pending.push(check(u.unitId).catch(() => undefined));
        }
      }
      await Promise.all(pending);
    } finally {
      setBulkBusy(false);
    }
  }

  // ── Validation + completion ────────────────────────────────────────────────

  /** Commit row + summary errors; returns them (empty ⇒ valid). */
  function validate(): Record<string, string> {
    const errs = computeReturnRowErrors(items, outcomes, effectiveGrids);
    setRowErrors(errs);
    const count = Object.keys(errs).length;
    const messages: string[] = [];
    if (count > 0) {
      messages.push(
        `Не заполнено ${count} ${pluralize(count, "позиция", "позиции", "позиций")} — проверьте отмеченные строки`,
      );
    }
    if (!vehicleMileagesValid) messages.push("Введите пробег для каждой машины брони");
    setValidationSummary(messages.length > 0 ? messages.join(". ") : null);
    return errs;
  }

  /** Scroll + focus the FIRST errored row (render order) into view. */
  function focusFirstError(errs: Record<string, string>) {
    let firstId: string | undefined;
    for (const item of items) {
      const ids = item.trackingMode === "UNIT" && item.units
        ? item.units.map((u) => u.unitId)
        : [item.bookingItemId];
      firstId = ids.find((id) => id in errs);
      if (firstId) break;
    }
    if (!firstId) return;
    const target = firstId;
    requestAnimationFrame(() => {
      const node = rowRefs.current.get(target);
      if (!node) return;
      if (typeof node.scrollIntoView === "function") {
        node.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      node.focus();
    });
  }

  function registerRow(rowId: string, node: HTMLDivElement | null) {
    if (node) rowRefs.current.set(rowId, node);
    else rowRefs.current.delete(rowId);
  }

  /** Ответ «Завершить» с кодом: разобрать по таблице кодов киоска. */
  async function handleCompleteError(err: unknown): Promise<void> {
    if (isSessionClosedError(err)) {
      draft.discard();
      setClosedError(err);
      return;
    }
    const code = scanErrorCode(err);
    if (code === SCAN_ERROR.CHECKLIST_OUTDATED && state) {
      // Состав брони поменялся: перечитываем чек-лист и переносим свои
      // отметки на новый состав, как только придёт новый отпечаток состава.
      const rebase: PendingRebase = {
        draft: buildReturnDraft({ items: baseItems, outcomes, unitGrids, mileages: draftMileages, stays: draftStays }),
        fromVersion: state.itemsVersion,
      };
      pendingRebase.current = rebase;
      setNotice(isScanApiError(err) ? err.message : CHECKLIST_OUTDATED_NOTICE);
      const fresh = await refresh();
      // Состав на сервере тот же — переносить нечего, отметки остаются как есть.
      if (fresh && fresh.itemsVersion === rebase.fromVersion && pendingRebase.current === rebase) {
        pendingRebase.current = null;
      }
      return;
    }
    if (code === SCAN_ERROR.DRAFT_OUTDATED && state) {
      // Другое устройство сохранило позже: берём его версию (и ревизию) как
      // исходную точку — следующее «Завершить» уйдёт уже от неё.
      const fresh = getScanErrorDetails(err, SCAN_ERROR.DRAFT_OUTDATED);
      if (fresh && typeof fresh.revision === "number") {
        draft.adoptOutdated(fresh);
        applyHydration(hydrateReturnDraft(state.items, fresh.draft), { markDirty: false });
      }
      setNotice(isScanApiError(err) ? err.message : OTHER_DEVICE_NOTICE);
      return;
    }
    if (code === "CONTINUATION_CONFLICT") {
      // Оставленное заняли, пока шла приёмка: карточки держателей — сразу из
      // ответа (превью может и не ответить), заодно пересчитать.
      const conflicts = (err as { details?: { conflicts?: unknown } }).details?.conflicts;
      if (Array.isArray(conflicts)) applyServerConflicts(conflicts as Parameters<typeof applyServerConflicts>[0]);
      else refreshStaysPreview();
    }
    setSubmitError(
      isScanApiError(err) ? err.message : "Не удалось завершить приёмку — попробуйте ещё раз",
    );
  }

  async function handleComplete() {
    if (submitting || bulkBusy) return;
    setSubmitError(null);
    setNotice(null);
    setAttemptedSubmit(true);
    const errs = validate();
    if (Object.keys(errs).length > 0) {
      focusFirstError(errs);
      return;
    }
    if (unacknowledgedConflicts.length > 0) return;
    // Пробег: per-row подсветка панели включится через attemptedSubmit.
    if (!vehicleMileagesValid) return;
    setSubmitting(true);
    try {
      // Сначала дослать свой черновик: «Завершить» сверяет его ревизию.
      const pre = await draft.flushBeforeSubmit();
      if (!pre) return;
      const payload = buildReturnCompletePayload({
        items,
        outcomes,
        unitGrids: effectiveGrids,
        mileages: vehicleMileages,
      });
      if (state?.itemsVersion) payload.itemsVersion = state.itemsVersion;
      if (pre.draftRevision !== undefined) payload.draftRevision = pre.draftRevision;
      // Новый сервер знает позиции «по плану»: что не вернули сейчас — в
      // продолжение (пустой список — «вернули всё»). Старый поля не шлёт.
      if (state?.plannedStays) {
        payload.stays = allStays;
        if (typeof state.splitRevision === "number") payload.expectedSplitRevision = state.splitRevision;
      }
      const res = await scanApi.complete(sessionId, payload);
      draft.discard();
      setResult(res);
      // Parent refetches booking lists so the returned booking drops off now.
      try {
        onCompleted?.();
      } catch {
        /* UX side-effect only */
      }
    } catch (err: unknown) {
      await handleCompleteError(err);
    } finally {
      setSubmitting(false);
    }
  }

  const closeAfterSessionEnd = () => (onSessionClosed ?? onDone ?? onBack)();

  // ── RESULT view ────────────────────────────────────────────────────────────

  if (result) {
    return (
      <ReturnResultView
        result={result}
        projectName={projectName}
        acceptedCount={computeAcceptedCount(items, outcomes, effectiveGrids)}
        unitNames={unitNameById}
        onDone={() => (onDone ? onDone() : onBack())}
      />
    );
  }

  // ── Сессия закрыта (оформлена, прервана, устарела) ────────────────────────

  const sessionClosed: ScanApiError | null = closedError ?? loadClosed;
  if (sessionClosed) {
    return (
      <SessionClosedNotice
        error={sessionClosed}
        operation="RETURN"
        onBack={closeAfterSessionEnd}
      />
    );
  }

  // ── Loading / error / empty ────────────────────────────────────────────────

  if (loading && !state) {
    return (
      <div className="space-y-2 px-3 py-3">
        <div className="h-[46px] animate-pulse rounded-lg bg-surface-subtle" />
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-[52px] animate-pulse rounded-lg border border-border bg-surface" />
        ))}
      </div>
    );
  }

  if (error && !state) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-12">
        <div className="w-full max-w-[420px] rounded-lg border border-rose-border bg-rose-soft px-4 py-3 text-center text-sm text-rose">
          {error.message || "Не удалось загрузить чек-лист приёмки"}
        </div>
        <BackToListButton onClick={onBack} />
      </div>
    );
  }

  if (state && baseItems.length === 0 && planned.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-16 text-center">
        <p className="text-sm text-ink-3">В этой брони нет позиций для приёмки</p>
        {/* Все строки сняли на выдаче (×0): принимать в киоске нечего, а
            бронь всё ещё «Выдана» — закрыть её можно только на карточке. */}
        <p className="mt-1 max-w-[360px] text-[12px] text-ink-3">
          Если бронь нужно закрыть, отметьте возврат кнопкой «Вернуть» на карточке брони.
        </p>
        <BackToListButton onClick={onBack} />
      </div>
    );
  }

  if (!state) return null;

  const interactionsDisabled = bulkBusy || submitting;
  const anyStaying = planned.some((p) => !returnNow.has(p.bookingItemId)) || anyExtraStaying;
  // Ремонт и «Потеряшки» у клиента не остаются: потолок «Остаётся у клиента».
  const lockedUnitsOf = (it: ChecklistItem) =>
    (it.units ?? [])
      .filter((u) => outcomes[u.unitId]?.outcome === "REPAIR" || outcomes[u.unitId]?.outcome === "PROBLEM")
      .map((u) => u.unitId);
  const keepCapOf = (it: ChecklistItem) =>
    it.trackingMode === "UNIT" && it.units
      ? it.units.length - lockedUnitsOf(it).length
      : it.quantity - fitSlots(unitGrids.get(it.bookingItemId), it.quantity).filter(FLAGGED).length;
  // Итог для футера (мокап M3, экран 2): сколько принимаем и что остаётся.
  const acceptUnits = items.reduce((n, it) => n + (it.trackingMode === "UNIT" && it.units ? it.units.length : it.quantity), 0);
  const keptUnits = allStays.reduce((n, st) => n + st.quantity, 0);
  const keptLines = new Set(allStays.filter((st) => st.quantity > 0).map((st) => st.bookingItemId)).size;
  const ackNames = allStays
    .filter((st) => st.acknowledgedConflict)
    .map((st) => baseItems.find((i) => i.bookingItemId === st.bookingItemId)?.equipmentName)
    .filter((n): n is string => Boolean(n));
  const continuationDoc = staysPreview?.continuations[0]?.docNumber ?? null;
  const draftOffline = draft.status === "offline" || draft.status === "failed";
  // Плашка «Продолжена приёмка»: страница передаёт ответ createSession только
  // для продолженной сессии; честно пишем, восстановлено ли что-то.
  const showResumed =
    !bannerDismissed && restoreInfo !== null && resumed != null && resumed.resumed !== false;

  // ── Main checklist ─────────────────────────────────────────────────────────

  return (
    <div className="flex min-h-full flex-1 flex-col">
      {showResumed && (
        <ResumedSessionBanner
          operation="RETURN"
          startedAt={resumed?.startedAt ?? state.session?.startedAt ?? null}
          startedBy={resumed?.workerName ?? state.session?.workerName ?? null}
          restored={restoreInfo.restored}
          partial={restoreInfo.partial}
          draftSavedAt={state.draftSavedAt ?? null}
          draftSavedBy={state.draftSavedBy ?? null}
          onDismiss={() => setBannerDismissed(true)}
        />
      )}
      <div className="flex-1 px-3 pb-4 pt-3 lg:px-4">
        {/* Водители — при разгрузке пишем, кто привёз. */}
        <DriverPanel sessionId={sessionId} operation="RETURN" />

        {/* Шапка чек-листа: заголовок (десктоп), сохранение черновика, «Прервать». */}
        <div className="mb-2 flex min-h-[40px] items-center gap-3 px-1">
          <h2 className="hidden text-[15px] font-semibold text-ink lg:block">Чек-лист приёмки</h2>
          {draft.statusLabel && (
            <p
              role="status"
              className={`text-[11px] ${draftOffline ? "font-medium text-rose" : "text-ink-3"}`}
            >
              {draft.statusLabel}
            </p>
          )}
          <div className="ml-auto">
            <AbortSessionButton
              sessionId={sessionId}
              operation="RETURN"
              disabled={interactionsDisabled}
              onAborted={closeAfterSessionEnd}
              onSessionClosed={setClosedError}
            />
          </div>
        </div>

        <PlannedStaysBlock
          stays={planned}
          items={state.items}
          returnNow={returnNow}
          onToggle={toggleReturnNow}
          disabled={interactionsDisabled}
          renderTerms={
            state.linePaidThrough
              ? (p) => {
                  const terms = plannedTerms.get(p.bookingItemId) ?? {
                    quantity: p.quantity,
                    unitIds: p.unitIds,
                    choice: "paid" as const,
                    until: p.until,
                  };
                  return (
                    <StayTerms
                      label={state.items.find((i) => i.bookingItemId === p.bookingItemId)?.equipmentName ?? "Позиция"}
                      paidThrough={state.linePaidThrough?.[p.bookingItemId] ?? p.until}
                      stay={terms}
                      previewLine={previewLineFor(p.bookingItemId)}
                      conflict={conflictFor(p.bookingItemId)}
                      discountPercent={previewDiscount}
                      previewLoading={staysPreviewLoading}
                      disabled={interactionsDisabled}
                      onChange={(next) => {
                        dirtyRef.current = true;
                        setPlannedTerm(p.bookingItemId, next);
                      }}
                    />
                  );
                }
              : undefined
          }
        />

        {/* «Принять всё разом» — primary bar (mockup .ph-acceptall). */}
        {/* Всё осталось у клиента по плану — принимать в чек-листе нечего. */}
        {items.length > 0 && (
          <button
            type="button"
            onClick={acceptAll}
            disabled={interactionsDisabled}
            aria-label={
              anyStaying
                ? "Принять всё, кроме оставленного у клиента, — отметить остальные позиции принятыми"
                : "Принять всё разом — отметить все позиции принятыми"
            }
            className="mb-3 block w-full rounded-lg bg-accent-bright px-4 py-3 text-center text-sm font-semibold text-surface transition-colors hover:opacity-95 disabled:opacity-60"
          >
            {anyStaying ? "✓ Принять всё, кроме оставленного" : "✓ Принять всё разом"}
          </button>
        )}

        {groups.map((group) => (
          <section key={group.category} className="mb-1">
            <p className="eyebrow px-1.5 pb-1 pt-2">{group.category}</p>
            <div className="space-y-1.5">
              {group.items.map((base) => {
                const item = adjustedById.get(base.bookingItemId) ?? null;
                const isPlanned = planned.some((p) => p.bookingItemId === base.bookingItemId);
                return (
                  <div key={base.bookingItemId} className="space-y-1">
                    {item ? (
                      <ReturnItemRows
                        item={item}
                        sessionId={sessionId}
                        outcomes={outcomes}
                        slots={slotsOf(item.bookingItemId, item.quantity)}
                        rowErrors={rowErrors}
                        resetNotice={resetRows.has(item.bookingItemId) ? RESET_ROW_NOTICE : null}
                        disabled={interactionsDisabled}
                        handlers={handlers}
                        registerRow={registerRow}
                      />
                    ) : (
                      <p className="rounded-lg border border-teal-border bg-surface px-3 py-2.5 text-[14px] font-medium text-ink">
                        {base.equipmentName} <span className="text-[12px] font-normal text-teal">· всё остаётся у клиента</span>
                      </p>
                    )}
                    {!isPlanned && state.linePaidThrough && (
                      <KioskStayEditor
                        item={base}
                        stay={extraStays.get(base.bookingItemId)}
                        paidThrough={state.linePaidThrough[base.bookingItemId]}
                        previewLine={previewLineFor(base.bookingItemId)}
                        conflict={conflictFor(base.bookingItemId)}
                        discountPercent={previewDiscount}
                        previewLoading={staysPreviewLoading}
                        disabled={interactionsDisabled}
                        onChange={(next) => changeExtraStay(base, next)}
                        maxKeep={keepCapOf(base)}
                        lockedUnitIds={lockedUnitsOf(base)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      {/* Дополнительная смета оставленного сверх оплаченного (мокап M3, экран 2). */}
      {staysPreview && (
        <div className="px-3 pb-3 lg:px-4">
          <ContinuationPriceBlock preview={staysPreview} loading={staysPreviewLoading} />
        </div>
      )}

      {/* Блок «Пробег машин» — вне липкого футера; без машин не рендерится. */}
      <div className="px-3 lg:px-4">
        <VehicleMileagePanel
          sessionId={sessionId}
          attemptedSubmit={attemptedSubmit}
          onChange={handleMileagesChange}
          onValidityChange={setVehicleMileagesValid}
          initialMileages={restoredMileages}
          onEdit={handleMileageEdit}
        />
      </div>

      {/* Sticky «Завершить приёмку →» footer (mockup .ph-bottom). */}
      <div className={`${STICKY_ABOVE_TAB_BAR} border-t border-border bg-surface px-3 py-3 lg:px-4`}>
        {notice && (
          <p
            role="status"
            className="mb-2 rounded-md border border-amber-border bg-amber-soft px-3 py-2 text-[12px] text-amber"
          >
            {notice}
          </p>
        )}
        {validationSummary && (
          <p role="alert" className="mb-2 rounded-md border border-rose-border bg-rose-soft px-3 py-2 text-[12px] text-rose">
            {validationSummary}
          </p>
        )}
        {/* Живое, а не из последней проверки: пропадает, как только решили по держателю. */}
        {attemptedSubmit && unacknowledgedConflicts.length > 0 && (
          <p role="alert" className="mb-2 rounded-md border border-amber-border bg-amber-soft px-3 py-2 text-[12px] text-amber">
            Нужно другой брони: {unacknowledgedConflicts.map((c) => `«${c.name}»`).join(", ")} — оставьте под ответственность или
            сократите срок
          </p>
        )}
        {anyStaying && (
          <div className="mb-2 text-[12.5px]" data-testid="return-footer-summary">
            <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5">
              <dt className="text-ink-2">Принимаем на склад</dt>
              <dd className="mono-num text-right font-semibold text-ink">{acceptUnits} ед.</dd>
              <dt className="text-ink-2">Остаются у клиента</dt>
              <dd className="mono-num text-right font-semibold text-teal">
                {keptUnits} ед. · {keptLines} {pluralize(keptLines, "позиция", "позиции", "позиций")}
              </dd>
              {ackNames.length > 0 && (
                <>
                  <dt className="text-ink-2">Оставлено под ответственность</dt>
                  <dd className="text-right text-amber">{ackNames.join(", ")}</dd>
                </>
              )}
            </dl>
            <p className="mt-1 text-[11.5px] leading-snug text-ink-3">
              Основная бронь закроется как «Возвращена частично». Оставленное перейдёт в продолжение{" "}
              {continuationDoc ? <span className="font-medium text-ink-2">{continuationDoc}</span> : "брони"}.
            </p>
          </div>
        )}
        {submitError && (
          <p role="alert" className="mb-2 rounded-md border border-rose-border bg-rose-soft px-3 py-2 text-[12px] text-rose">
            {submitError}
          </p>
        )}
        <button
          type="button"
          onClick={handleComplete}
          disabled={interactionsDisabled}
          aria-label={
            anyStaying
              ? `Принять ${acceptUnits} ед. — Завершить приёмку «${projectName || "бронь"}»`
              : `Завершить приёмку — ${projectName || "бронь"}`
          }
          className="block w-full rounded-lg bg-accent px-4 py-3 text-center text-sm font-semibold text-surface transition-colors hover:opacity-95 disabled:opacity-60"
        >
          {submitting ? "Завершаем…" : anyStaying ? `Принять ${acceptUnits} ед.` : "Завершить приёмку →"}
        </button>
      </div>
    </div>
  );
}

function BackToListButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-4 rounded border border-border bg-surface px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-surface-muted"
    >
      ← К списку броней
    </button>
  );
}
