"use client";

/**
 * Scan-session state hook.
 *
 * Owns: current step, session id, operation, checklist state, loading/error.
 * Exposes optimistic `check`/`uncheck` that mirror the discipline in
 * `apps/web/src/components/tasks/useTasksQuery.ts`:
 *   snapshot → optimistic local apply → server call → reconcile via getState()
 *   → rollback on failure, with a per-unit-id in-flight `useRef<Set<string>>`
 *   guard so a concurrent refresh cannot clobber an in-flight mutation.
 *
 * Черновик чек-листа (P6): перед чтением `/state` хук ждёт, пока уляжется
 * досылка черновика этой сессии (`awaitDraftSettled`), — чек-лист,
 * вернувшийся после смены раздела, иначе прочитал бы черновик раньше, чем
 * дойдёт последняя правка. Если правка не ушла (нет связи) и сервер с тех пор
 * ничего нового не получил, в `state.draft` подкладывается она.
 *
 * Закрытая сессия (`SESSION_*` из любого вызова) попадает в `closedError` —
 * чек-лист показывает `SessionClosedNotice` вместо устаревшего экрана.
 *
 * UI is intentionally NOT implemented here.
 */

import { useCallback, useRef, useState } from "react";
import { scanApi } from "./api";
import { awaitDraftSettled, peekUnsavedDraft } from "./useChecklistDraft";
import { isScanApiError, isSessionClosedError } from "./types";
import type {
  ChecklistItem,
  ChecklistState,
  ScanApiError,
  ScanOperation,
  ScanStep,
} from "./types";

// ── Helpers ──────────────────────────────────────────────────────────────────

function errorMessage(err: unknown, fallback: string): string {
  if (isScanApiError(err)) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

/**
 * Immutably flips a single unit's `checked` flag inside a ChecklistState,
 * recomputing the owning item's `checkedQty`. Returns the same reference when
 * nothing changed (the unit was not found).
 */
export function applyUnitChecked(
  state: ChecklistState,
  unitId: string,
  checked: boolean,
): ChecklistState {
  let touched = false;
  const items: ChecklistItem[] = state.items.map((item) => {
    if (!item.units) return item;
    if (!item.units.some((u) => u.unitId === unitId)) return item;
    touched = true;
    const units = item.units.map((u) =>
      u.unitId === unitId ? { ...u, checked } : u,
    );
    return {
      ...item,
      units,
      checkedQty: units.filter((u) => u.checked).length,
    };
  });
  if (!touched) return state;
  return { ...state, items };
}

/**
 * Подложить несохранённый черновик (связи не было) вместо серверного, если
 * сервер с тех пор не получил новой ревизии. Иначе — ответ сервера как есть.
 */
export function withUnsavedDraft(state: ChecklistState): ChecklistState {
  const local = peekUnsavedDraft(state.sessionId);
  if (!local) return state;
  if (local.baseRevision !== (state.draftRevision ?? 0)) return state;
  return { ...state, draft: local.draft };
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export interface UseScanSessionResult {
  step: ScanStep;
  sessionId: string | null;
  operation: ScanOperation;
  state: ChecklistState | null;
  loading: boolean;
  error: ScanApiError | null;
  /**
   * Сессию закрыли (`SESSION_ALREADY_COMPLETED` / `SESSION_CANCELLED` /
   * `SESSION_STALE` / `SESSION_NOT_FOUND`) — работать с ней дальше нельзя.
   * Чек-лист показывает `SessionClosedNotice`. Сбрасывается при `openSession`.
   */
  closedError: ScanApiError | null;

  goStep: (step: ScanStep) => void;
  setOperation: (operation: ScanOperation) => void;
  /**
   * Bind the hook to a session and load its checklist state.
   * Pass `null` to detach (e.g. after complete/cancel).
   */
  openSession: (
    sessionId: string | null,
    operation?: ScanOperation,
  ) => Promise<void>;
  /**
   * Перечитать чек-лист. Возвращает свежий `ChecklistState` — по нему экран
   * заново применяет черновик (например, после 409 `CHECKLIST_OUTDATED`).
   * `null` — не прочитали: идёт отметка единицы, сессия другая или ошибка
   * (она в `error` / `closedError`). `void` в типе — только для совместимости
   * со старыми моками в тестах.
   */
  refresh: () => Promise<ChecklistState | null | void>;

  check: (unitId: string) => Promise<void>;
  uncheck: (unitId: string) => Promise<void>;

  /** True while any check/uncheck network call is outstanding. */
  isMutating: () => boolean;
}

export function useScanSession(
  initialStep: ScanStep = "login",
): UseScanSessionResult {
  const [step, setStep] = useState<ScanStep>(initialStep);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [operation, setOperationState] = useState<ScanOperation>("ISSUE");
  const [state, setState] = useState<ChecklistState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ScanApiError | null>(null);
  const [closedError, setClosedError] = useState<ScanApiError | null>(null);

  // Per-unit-id in-flight guard — useRef avoids re-render churn / stale closures.
  const inFlight = useRef<Set<string>>(new Set());
  // Suppresses refresh()'s blind setState while any optimistic mutation's
  // network request is outstanding — otherwise the reconcile would no-op and
  // the poll could resurrect a stale snapshot. Mirrors useTasksQuery.
  const refreshBlocked = useRef(false);
  // Latest bound session id, read inside async closures without re-creating
  // callbacks (avoids reconciling a session the user already left).
  const sessionRef = useRef<string | null>(null);

  const goStep = useCallback((next: ScanStep) => {
    setStep(next);
  }, []);

  const setOperation = useCallback((next: ScanOperation) => {
    setOperationState(next);
  }, []);

  const loadState = useCallback(async (id: string): Promise<ChecklistState | null> => {
    setLoading(true);
    setError(null);
    try {
      await awaitDraftSettled(id);
      if (sessionRef.current !== id) return null;
      const next = withUnsavedDraft(await scanApi.getState(id));
      if (sessionRef.current !== id) return null;
      setState(next);
      setOperationState(next.operation);
      return next;
    } catch (err: unknown) {
      if (sessionRef.current !== id) return null;
      const e: ScanApiError = isScanApiError(err)
        ? err
        : { status: 0, code: null, message: errorMessage(err, "Ошибка загрузки"), details: null };
      setError(e);
      if (isSessionClosedError(e)) setClosedError(e);
      return null;
    } finally {
      if (sessionRef.current === id) setLoading(false);
    }
  }, []);

  const openSession = useCallback(
    async (id: string | null, op?: ScanOperation): Promise<void> => {
      sessionRef.current = id;
      setSessionId(id);
      setClosedError(null);
      if (op) setOperationState(op);
      if (!id) {
        setState(null);
        setError(null);
        setLoading(false);
        return;
      }
      await loadState(id);
    },
    [loadState],
  );

  const refresh = useCallback(async (): Promise<ChecklistState | null> => {
    const id = sessionRef.current;
    if (!id) return null;
    if (refreshBlocked.current) return null;
    return loadState(id);
  }, [loadState]);

  // ── Optimistic check / uncheck ─────────────────────────────────────────────

  const toggleUnit = useCallback(
    async (unitId: string, nextChecked: boolean): Promise<void> => {
      const id = sessionRef.current;
      if (!id) return;

      const guardKey = `toggle-${unitId}`;
      if (inFlight.current.has(guardKey)) return;
      inFlight.current.add(guardKey);
      refreshBlocked.current = true;

      // Whole-state snapshot for rollback (the previous ChecklistState
      // reference is captured and restored verbatim on failure).
      let snapshot: ChecklistState | null = null;
      setState((prev) => {
        if (!prev) return prev;
        snapshot = prev;
        return applyUnitChecked(prev, unitId, nextChecked);
      });

      try {
        if (nextChecked) {
          await scanApi.check(id, unitId);
        } else {
          await scanApi.uncheck(id, unitId);
        }
        // Reconcile from the server (authoritative on tap-confirm).
        if (sessionRef.current === id) {
          const fresh = withUnsavedDraft(await scanApi.getState(id));
          if (sessionRef.current === id) {
            setState(fresh);
            setOperationState(fresh.operation);
          }
        }
      } catch (err: unknown) {
        // Rollback to the whole-state pre-mutation snapshot.
        if (snapshot !== null) {
          const snap: ChecklistState = snapshot;
          setState((prev) => (prev ? snap : prev));
        }
        const e: ScanApiError = isScanApiError(err)
          ? err
          : { status: 0, code: null, message: errorMessage(err, "Ошибка при отметке"), details: null };
        setError(e);
        if (sessionRef.current === id && isSessionClosedError(e)) setClosedError(e);
        throw e;
      } finally {
        inFlight.current.delete(guardKey);
        if (inFlight.current.size === 0) refreshBlocked.current = false;
      }
    },
    [],
  );

  const check = useCallback(
    (unitId: string) => toggleUnit(unitId, true),
    [toggleUnit],
  );

  const uncheck = useCallback(
    (unitId: string) => toggleUnit(unitId, false),
    [toggleUnit],
  );

  const isMutating = useCallback(() => inFlight.current.size > 0, []);

  return {
    step,
    sessionId,
    operation,
    state,
    loading,
    error,
    closedError,
    goStep,
    setOperation,
    openSession,
    refresh,
    check,
    uncheck,
    isMutating,
  };
}
