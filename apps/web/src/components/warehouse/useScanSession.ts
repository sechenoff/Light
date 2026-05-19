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
 * UI is intentionally NOT implemented here.
 */

import { useCallback, useRef, useState } from "react";
import { scanApi } from "./api";
import { isScanApiError } from "./types";
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

// ── Hook ─────────────────────────────────────────────────────────────────────

export interface UseScanSessionResult {
  step: ScanStep;
  sessionId: string | null;
  operation: ScanOperation;
  state: ChecklistState | null;
  loading: boolean;
  error: ScanApiError | null;

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
  /** Re-fetch checklist state (skipped while a mutation is in flight). */
  refresh: () => Promise<void>;

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

  const loadState = useCallback(async (id: string): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const next = await scanApi.getState(id);
      if (sessionRef.current !== id) return;
      setState(next);
      setOperationState(next.operation);
    } catch (err: unknown) {
      if (sessionRef.current !== id) return;
      const e: ScanApiError = isScanApiError(err)
        ? err
        : { status: 0, code: null, message: errorMessage(err, "Ошибка загрузки"), details: null };
      setError(e);
    } finally {
      if (sessionRef.current === id) setLoading(false);
    }
  }, []);

  const openSession = useCallback(
    async (id: string | null, op?: ScanOperation): Promise<void> => {
      sessionRef.current = id;
      setSessionId(id);
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

  const refresh = useCallback(async (): Promise<void> => {
    const id = sessionRef.current;
    if (!id) return;
    if (refreshBlocked.current) return;
    await loadState(id);
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
          const fresh = await scanApi.getState(id);
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
    goStep,
    setOperation,
    openSession,
    refresh,
    check,
    uncheck,
    isMutating,
  };
}
