"use client";

/**
 * Добор — quick-add an article that is NOT on the booking, with a SOFT
 * availability warning.
 *
 * Product rule (Phase 6): добор is never hard-blocked. If the article is busy
 * for the booking dates the operator sees a red conflict card and may always
 * «Выдать под ответственность» — the backend then logs
 * `BOOKING_ITEM_ADDED_WITH_CONFLICT` to the audit.
 *
 * Visual source of truth: docs/mockups/warehouse-scan/03-issue-and-desktop.html
 *  - block 3 (mobile): a bottom sheet — «Доступность на даты брони» header,
 *    search field, result rows with an availability pill
 *    («свободно ×K» emerald / «занято» rose), and the red conflict warn card
 *    (⚠ title, «бронь №… проект … даты», «Свободно с …», buttons
 *    «Отмена» / «Выдать под ответственность», sub-note
 *    «Конфликт зафиксируется в аудите»).
 *  - block 4 (desktop, `lg:`): the SAME thing as an inline panel inside the
 *    issue-checklist area — NOT a modal, NO scrim.
 *
 * One component does both via Tailwind responsive prefixes:
 *  - default (mobile): fixed bottom sheet + scrim, slides up, internal scroll.
 *  - `lg:`           : static inline card, scrim hidden, no fixed positioning.
 *
 * Never renders a barcode (product rule: hidden barcode IDs). Real
 * <button>/<input> semantics; Russian aria-labels; emoji aria-hidden;
 * touch targets ≥ 40px.
 *
 * PR «Выдача и приёмка»:
 *  - потолок один для поиска, `/items` и степпера (P4): выбор количества идёт
 *    до `ackCap`, сверх свободного (`addCap`) сервер отвечает конфликтом, и
 *    карточка «под ответственность» даёт выбрать количество, а не только 1;
 *  - держатель назван по-человечески — «у клиента с …», «возврат не отмечен»,
 *    «пока на складе»; «Свободно с …» только при известной дате (P26);
 *  - 409 ADDON_OVER_STOCK — текст сервера как есть (он называет позицию);
 *  - договорной итог брони — предупреждение, что сумма к оплате не изменится
 *    (P22); в PIN-киоске вместо ссылки на PDF — подсказка (P17).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { scanApi } from "./api";
import type { AddonConflict, AddonResult, ScanApiError } from "./types";
import {
  getScanErrorDetails,
  isScanApiError,
  isSessionClosedError,
  SCAN_ERROR,
} from "./types";
import { NEGOTIATED_TOTAL_ADDON_NOTE } from "./addonConflictText";
import { ConflictWarning } from "./AddonConflictCard";

const DEBOUNCE_MS = 300;

/**
 * Разбор `details` 409 ADDON_CONFLICT в `AddonConflict`. Сервер присылает ту же
 * форму, что в строках поиска; `freeFrom` бывает `null` (держатель выдан и не
 * вернул в срок) — карточка при этом всё равно нужна.
 */
function conflictFromError(err: unknown): AddonConflict | null {
  const d = getScanErrorDetails(err, SCAN_ERROR.ADDON_CONFLICT);
  if (!d) return null;
  if (
    typeof d.bookingNo !== "string" ||
    typeof d.projectName !== "string" ||
    typeof d.from !== "string" ||
    typeof d.to !== "string"
  ) {
    return null;
  }
  return {
    ...d,
    bookingId: typeof d.bookingId === "string" ? d.bookingId : "",
    freeFrom: typeof d.freeFrom === "string" ? d.freeFrom : null,
  };
}

function isAvailable(r: AddonResult): boolean {
  return r.availability !== "UNAVAILABLE" && r.addCap > 0;
}

/**
 * Потолок «под ответственность»: сервер v2 присылает `ackCap` в строке и в
 * держателе; старый сервер — нет, тогда разрешаем ровно то, что уже выбрано.
 */
function resolveAckCap(
  conflict: AddonConflict | null,
  rowAckCap: number | undefined,
  fallback: number,
): number {
  const cap = conflict?.ackCap ?? rowAckCap;
  return typeof cap === "number" && Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : fallback;
}

interface ActiveConflict {
  equipmentId: string;
  name: string;
  qty: number;
  /** Потолок «под ответственность» (`ackCap`). */
  maxQty: number;
  conflict: AddonConflict;
}

interface PickingTarget {
  equipmentId: string;
  name: string;
  qty: number;
  /**
   * Верхняя граница поля количества: `ackCap` строки — сколько можно добрать
   * вообще, включая «под ответственность» (старый сервер без `ackCap` —
   * `addCap`). Не ниже 1, чтобы поле оставалось в [1, max]; строка с нулём
   * выбор количества не открывает.
   */
  availableMax: number;
  /** Свободно без конфликта (`addCap`). Выше — только под ответственность. */
  freeMax: number;
  /** `ackCap` строки — перенести в карточку конфликта после 409. */
  rowAckCap: number | undefined;
}

export function AddonSearch({
  sessionId,
  bookingId,
  bookingNo,
  existingEquipmentIds,
  manualFinalAmount = null,
  pinMode,
  onAdded,
  onClose,
  onSessionClosed,
}: {
  sessionId: string;
  /**
   * Booking id of the brons being augmented — used to build the
   * «Открыть PDF доб-сметы» link surfaced in the success-line after each add.
   */
  bookingId: string;
  /** Display id of the booking being augmented (header context). */
  bookingNo?: string;
  /**
   * Equipment ids that are already on this booking — the picker hides those
   * rows so the operator can't re-add a position they should be editing via
   * the checklist's stepper instead. Optional (undefined ⇒ no filtering),
   * which keeps existing callers working without a forced rewrite.
   *
   * Carries «Уже в брони — измените количество в чек-листе» as a sub-label
   * when ≥1 result was hidden, so the operator understands WHY a familiar
   * item is missing.
   */
  existingEquipmentIds?: ReadonlySet<string>;
  /**
   * Called after an article is added so the checklist can refresh.
   * `hadConflict=true` ⇔ the operator pressed «Выдать под ответственность» —
   * IssueChecklist marks the new bookingItemId as a conflict добор so the
   * audit reflects the override.
   */
  onAdded: (bookingItemId: string, hadConflict: boolean) => void;
  /** Dismiss the sheet / inline panel. */
  onClose: () => void;
  /**
   * Договорной итог брони (`ChecklistState.booking.manualFinalAmount`). Задан —
   * добор не меняет сумму к оплате, и кладовщик должен об этом знать (P22).
   */
  manualFinalAmount?: string | null;
  /**
   * PIN-киоск без входа в CRM: ссылка на PDF там отвечает 401, поэтому вместо
   * неё — подсказка (P17). По умолчанию — есть ли PIN-токен в sessionStorage.
   */
  pinMode?: boolean;
  /**
   * Сессию закрыли, пока был открыт поиск (коды `SESSION_*`): добирать в неё
   * больше нельзя, чек-лист показывает `SessionClosedNotice`.
   */
  onSessionClosed?: (err: ScanApiError) => void;
}) {
  const [isPinMode] = useState<boolean>(
    () => pinMode ?? scanApi.getWarehouseToken() != null,
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  // Колбэк чек-листа приходит новой стрелкой на каждый рендер — через ref,
  // чтобы эффект поиска не перезапускался от перерисовки родителя.
  const onSessionCloseRef = useRef(onSessionClosed);
  onSessionCloseRef.current = onSessionClosed;
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [results, setResults] = useState<AddonResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  // The inline red warn card target (from a conflicted row OR a 409 race).
  const [active, setActive] = useState<ActiveConflict | null>(null);
  // Free-row tap opens an inline qty picker for THIS row (− N + → Добавить N).
  // null when no picker is open; set to a row to enter «picking N» mode.
  const [picking, setPicking] = useState<PickingTarget | null>(null);
  // equipmentId currently being POSTed (disables its row / warn buttons).
  const [adding, setAdding] = useState<string | null>(null);
  // Brief confirmation line after a successful add (keeps sheet open).
  const [addedName, setAddedName] = useState<string | null>(null);

  // Overlay a11y, matching the established overlay canon
  // (TaskDetailPanel): Esc closes, initial focus moves into the search
  // field, focus is trapped within the sheet while open, and focus
  // returns to the trigger on close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Initial focus into the search input; restore focus to whatever was
  // focused before open (the trigger) on unmount — same approach as
  // TaskDetailPanel (spec §6 focus trap).
  useEffect(() => {
    const prevFocused = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => {
      clearTimeout(t);
      prevFocused?.focus?.();
    };
  }, []);

  // Body scroll lock — gated to the MOBILE bottom-sheet presentation only.
  // On desktop (Tailwind `lg:` ≥ 1024px) this component renders as a static
  // INLINE panel (no scrim, no fixed positioning), so locking page scroll
  // there would be wrong. `window.matchMedia` is absent in jsdom → treated
  // as mobile (lock engaged), which keeps the behaviour testable; real
  // browsers get correct desktop detection.
  useEffect(() => {
    const isDesktopInline =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(min-width: 1024px)").matches;
    if (isDesktopInline) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  // Minimal dependency-free focus trap: Tab / Shift+Tab cycle within the
  // sheet only (first ↔ last focusable). Mirrors TaskDetailPanel.
  function handleTrapKey(e: React.KeyboardEvent<HTMLElement>) {
    if (e.key !== "Tab" || !sheetRef.current) return;
    const focusables = sheetRef.current.querySelectorAll<HTMLElement>(
      'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const activeEl = document.activeElement as HTMLElement | null;
    if (e.shiftKey && (activeEl === first || activeEl === sheetRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && activeEl === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // Debounce the query (cleaned-up timer; min 1 char).
  useEffect(() => {
    const q = query.trim();
    if (q.length < 1) {
      setDebounced("");
      return;
    }
    const t = setTimeout(() => setDebounced(q), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  // Run the search; ignore stale responses (cancellation pattern, as in
  // BookingList). An empty debounced query clears the list.
  useEffect(() => {
    if (debounced.length < 1) {
      setResults([]);
      setSearched(false);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    scanApi
      .addonSearch(sessionId, debounced)
      .then((list) => {
        if (cancelled) return;
        setResults(list);
        setSearched(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Сессию закрыли (оформили на другом планшете, прервали на карточке) —
        // искать добор некуда: чек-лист покажет уведомление.
        if (isSessionClosedError(err) && onSessionCloseRef.current) {
          onSessionCloseRef.current(err);
          return;
        }
        setResults([]);
        setSearched(true);
        setError(
          isScanApiError(err) ? err.message : "Ошибка поиска по каталогу",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, debounced]);

  const closeWarning = useCallback(() => setActive(null), []);
  const closePicker = useCallback(() => setPicking(null), []);

  // Filter out results whose equipmentId is already on this booking — the
  // operator should use the checklist's stepper instead. We compute both the
  // visible list AND how many got hidden so we can render an explainer sublabel
  // («Уже в брони — измените количество в чек-листе») only when relevant.
  const visibleResults =
    existingEquipmentIds && existingEquipmentIds.size > 0
      ? results.filter((r) => !existingEquipmentIds.has(r.equipmentId))
      : results;
  const hiddenInBookingCount = results.length - visibleResults.length;

  // Общий POST: количество (≥ 1) и флаг «под ответственность». На 409
  // ADDON_CONFLICT — та же красная карточка из `err.details` с сохранённым
  // количеством, чтобы «Выдать N под ответственность» повторил ровно N.
  const doAdd = useCallback(
    async (
      r: { equipmentId: string; name: string; rowAckCap?: number },
      ack: boolean,
      qty: number,
    ) => {
      if (adding) return;
      const safeQty = Math.max(1, Math.floor(Number.isFinite(qty) ? qty : 1));
      setAdding(r.equipmentId);
      setError(null);
      try {
        const added = await scanApi.addItem(
          sessionId,
          r.equipmentId,
          safeQty,
          ack ? true : undefined,
        );
        setActive(null);
        setPicking(null);
        setAddedName(safeQty > 1 ? `${r.name} ×${safeQty}` : r.name);
        onAdded(added.bookingItemId, ack);
      } catch (err: unknown) {
        if (isSessionClosedError(err) && onSessionClosed) {
          setActive(null);
          setPicking(null);
          onSessionClosed(err);
          return;
        }
        const conflict = conflictFromError(err);
        if (conflict) {
          // Карточка конфликта с тем же количеством (не больше потолка).
          const maxQty = resolveAckCap(conflict, r.rowAckCap, safeQty);
          setActive({
            equipmentId: r.equipmentId,
            name: r.name,
            qty: maxQty > 0 ? Math.min(safeQty, maxQty) : safeQty,
            maxQty,
            conflict,
          });
          setPicking(null);
          return;
        }
        // Остальное (ADDON_OVER_STOCK, ADDON_ONLY_ON_ISSUE, сеть) — текст
        // сервера как есть: он по-русски и называет позицию и остаток.
        if (isScanApiError(err) && err.code === SCAN_ERROR.ADDON_OVER_STOCK) {
          setPicking(null);
          setActive(null);
        }
        setError(
          isScanApiError(err) ? err.message : "Не удалось добавить артикул",
        );
      } finally {
        setAdding(null);
      }
    },
    [adding, sessionId, onAdded, onSessionClosed],
  );

  function handleRowTap(r: AddonResult) {
    setAddedName(null);
    // Занятая строка (есть держатель) — сразу карточка конфликта; количество
    // в ней выбирается до `ackCap`.
    if (r.conflict || !isAvailable(r)) {
      if (r.conflict) {
        setActive({
          equipmentId: r.equipmentId,
          name: r.name,
          qty: 1,
          maxQty: resolveAckCap(r.conflict, r.ackCap, 1),
          conflict: r.conflict,
        });
      } else {
        // Занята, но держателя в строке нет — пробуем добавить: сервер вернёт
        // 409 с деталями, и появится та же карточка.
        void doAdd(
          { equipmentId: r.equipmentId, name: r.name, rowAckCap: r.ackCap },
          false,
          1,
        );
      }
      return;
    }
    // Свободная строка → выбор количества. Потолок — `ackCap` (включая «под
    // ответственность»); сверх свободного сервер ответит конфликтом, и
    // появится карточка с выбранным количеством.
    const freeMax = Math.max(1, r.addCap);
    setPicking({
      equipmentId: r.equipmentId,
      name: r.name,
      qty: 1,
      availableMax: Math.max(freeMax, r.ackCap ?? 0),
      freeMax,
      rowAckCap: r.ackCap,
    });
  }

  /** Stepper helpers — clamped to [1, availableMax]. */
  function bumpPickQty(delta: number) {
    setPicking((p) => {
      if (!p) return p;
      const next = Math.min(p.availableMax, Math.max(1, p.qty + delta));
      return next === p.qty ? p : { ...p, qty: next };
    });
  }
  function setPickQty(raw: string) {
    setPicking((p) => {
      if (!p) return p;
      const n = Number(raw);
      if (!Number.isFinite(n)) return p;
      const clamped = Math.min(p.availableMax, Math.max(1, Math.floor(n)));
      return { ...p, qty: clamped };
    });
  }

  function setActiveQty(next: number) {
    setActive((a) => (a && a.qty !== next ? { ...a, qty: next } : a));
  }

  return (
    <>
      {/* Scrim — mobile only; desktop inline panel has no scrim. */}
      <button
        type="button"
        aria-label="Закрыть поиск добора"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-scrim/40 lg:hidden"
      />

      <section
        ref={sheetRef}
        onKeyDown={handleTrapKey}
        aria-label="Добор — поиск по каталогу с проверкой доступности"
        className={[
          // Mobile: bottom sheet — must slide UP (vertical), not sideways.
          "fixed inset-x-0 bottom-0 z-50 flex max-h-[80vh] flex-col",
          "rounded-t-2xl border-t border-border bg-surface shadow-sm",
          "motion-safe:animate-slideup",
          // Desktop: static inline panel within the checklist area.
          "lg:static lg:inset-auto lg:z-auto lg:mt-3 lg:max-h-none",
          "lg:rounded-lg lg:border lg:shadow-xs lg:animate-none",
        ].join(" ")}
      >
        {/* Sheet header (mockup `.sheet .sh`). */}
        <div className="flex items-center gap-2 border-b border-border bg-surface-subtle px-3.5 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="eyebrow">
              {bookingNo ? `Добор в бронь ${bookingNo}` : "Добор"}
            </p>
            <p className="text-[13px] font-semibold text-ink">
              Доступность на даты брони
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть поиск добора"
            className="-mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded text-lg leading-none text-ink-3 transition-colors hover:bg-surface-muted hover:text-ink"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>

        {/* Search field. */}
        <div className="px-3.5 pb-2 pt-3">
          <label className="sr-only" htmlFor="addon-search-input">
            Поиск артикула по каталогу
          </label>
          <div className="flex items-center gap-2 rounded-lg border border-border-strong bg-surface px-3 focus-within:border-accent-bright">
            <span aria-hidden="true" className="text-ink-3">
              🔎
            </span>
            <input
              ref={inputRef}
              id="addon-search-input"
              type="text"
              inputMode="search"
              autoComplete="off"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Название артикула…"
              aria-label="Поиск артикула по каталогу"
              className="h-10 min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Очистить поле поиска"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-ink-3 transition-colors hover:bg-surface-muted hover:text-ink"
              >
                <span aria-hidden="true">✕</span>
              </button>
            )}
          </div>
        </div>

        {/* Results / states — internal scroll on mobile. */}
        <div className="min-h-0 flex-1 overflow-y-auto pb-3">
          {manualFinalAmount != null && (
            <p className="mx-3 mb-2 rounded-lg border border-amber-border bg-amber-soft px-3 py-2 text-[11px] leading-snug text-ink">
              {NEGOTIATED_TOTAL_ADDON_NOTE}
            </p>
          )}

          {addedName && (
            <div className="mx-3 mb-2 rounded-lg border border-emerald-border bg-emerald-soft px-3 py-2 text-[12px] font-medium text-emerald">
              <span aria-hidden="true">✓ </span>
              {addedName} добавлен в выдачу
              <div className="mt-1 text-[11px] text-emerald/85">
                Доб-смета обновлена ·{" "}
                {isPinMode ? (
                  // PIN-киоск: у PDF-маршрута нет PIN-токена, ссылка открыла бы
                  // JSON «Требуется авторизация».
                  "PDF — в карточке брони в CRM"
                ) : (
                  <a
                    href={`/api/addon-estimates/${bookingId}/export/pdf`}
                    target="_blank"
                    rel="noreferrer"
                    className="underline hover:no-underline"
                  >
                    Открыть PDF →
                  </a>
                )}
              </div>
            </div>
          )}

          {error && (
            <div className="mx-3 mb-2 rounded-lg border border-rose-border bg-rose-soft px-3 py-2 text-[12px] text-rose">
              {error}
            </div>
          )}

          {active && (
            <ConflictWarning
              name={active.name}
              qty={active.qty}
              maxQty={active.maxQty}
              conflict={active.conflict}
              busy={adding === active.equipmentId}
              onQty={setActiveQty}
              onCancel={closeWarning}
              onForce={() =>
                void doAdd(
                  {
                    equipmentId: active.equipmentId,
                    name: active.name,
                    rowAckCap: active.maxQty,
                  },
                  true,
                  active.qty,
                )
              }
            />
          )}

          {loading && (
            <div className="space-y-1.5 px-3">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-[44px] animate-pulse rounded-lg border border-border bg-surface"
                />
              ))}
            </div>
          )}

          {!loading && query.trim().length < 1 && !active && (
            <p className="px-4 py-8 text-center text-[12px] text-ink-3">
              Начните вводить название артикула
            </p>
          )}

          {!loading &&
            query.trim().length >= 1 &&
            searched &&
            visibleResults.length === 0 &&
            !error && (
              <p className="px-4 py-8 text-center text-[12px] text-ink-3">
                {hiddenInBookingCount > 0
                  ? "Все совпадения уже в брони — измените количество в чек-листе"
                  : "Ничего не найдено"}
              </p>
            )}

          {!loading && hiddenInBookingCount > 0 && visibleResults.length > 0 && (
            <p className="px-4 pb-1.5 pt-1 text-[11px] text-ink-3">
              {hiddenInBookingCount === 1 ? "1 совпадение скрыто" : `${hiddenInBookingCount} совпадений скрыто`}
              {" — уже в брони, измените количество в чек-листе"}
            </p>
          )}

          {!loading && visibleResults.length > 0 && (
            <ul className="px-3">
              {visibleResults.map((r) => {
                const free = isAvailable(r);
                // «Capped» = warehouse сам по себе свободен, но на этой брони
                // уже добран до предела (`addCap=0` без блокирующего
                // конфликта). Это «информационный» disabled-state — оператор
                // видит, почему нельзя добавить, но кнопка не делает POST.
                const capped =
                  !free &&
                  r.availability !== "UNAVAILABLE" &&
                  !r.conflict &&
                  r.addCap === 0;
                const isAdding = adding === r.equipmentId;
                const isPicking = picking?.equipmentId === r.equipmentId;
                // Вещь физически у клиента — подпись «у клиента», а не
                // «занято»: кладовщик не путает её с резервом на полке (P26).
                const atClient = r.conflict?.holderStatus === "ISSUED";

                // Inline qty picker for THIS row — replaces the regular row
                // tap-target while the operator is choosing N. «Добавить N»
                // confirms; «Отмена» backs out without touching state.
                if (isPicking && picking) {
                  return (
                    <li key={r.equipmentId}>
                      <div className="flex flex-wrap items-center gap-2 border-t border-surface-subtle bg-accent-soft/40 px-1 py-2.5 first:border-t-0">
                        <span className="min-w-0 flex-1 basis-full md:basis-auto">
                          <span className="block truncate text-[13px] font-medium text-ink">
                            {r.name}
                          </span>
                          <span className="eyebrow mt-0.5 block truncate text-ink-3">
                            свободно ×{r.availableQuantity}
                          </span>
                        </span>
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={() => bumpPickQty(-1)}
                            disabled={picking.qty <= 1 || !!adding}
                            aria-label="Уменьшить количество"
                            className="flex h-10 w-10 items-center justify-center rounded border border-border bg-surface text-lg font-semibold leading-none text-ink-2 transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            −
                          </button>
                          <input
                            type="number"
                            inputMode="numeric"
                            min={1}
                            max={picking.availableMax}
                            value={picking.qty}
                            onChange={(e) => setPickQty(e.target.value)}
                            aria-label="Количество для добавления"
                            className="h-10 w-14 rounded border border-border-strong bg-surface text-center text-[13px] font-semibold text-ink outline-none focus:border-accent-bright"
                          />
                          <button
                            type="button"
                            onClick={() => bumpPickQty(+1)}
                            disabled={
                              picking.qty >= picking.availableMax || !!adding
                            }
                            aria-label="Увеличить количество"
                            className="flex h-10 w-10 items-center justify-center rounded border border-border bg-surface text-lg font-semibold leading-none text-ink-2 transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            +
                          </button>
                        </div>
                        {picking.qty > picking.freeMax && (
                          <span className="basis-full text-[11px] leading-snug text-amber">
                            Свободно {picking.freeMax} — остальное только под
                            ответственность: после «Добавить» покажем, у кого
                            занято.
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() =>
                            void doAdd(
                              {
                                equipmentId: r.equipmentId,
                                name: r.name,
                                rowAckCap: picking.rowAckCap,
                              },
                              false,
                              picking.qty,
                            )
                          }
                          disabled={!!adding}
                          aria-label={`Добавить ${picking.qty} шт ${r.name} в выдачу`}
                          className="h-10 shrink-0 rounded bg-accent-bright px-3 text-[12px] font-semibold text-surface transition-colors hover:opacity-95 disabled:opacity-60"
                        >
                          {isAdding ? "…" : `Добавить ${picking.qty}`}
                        </button>
                        <button
                          type="button"
                          onClick={closePicker}
                          disabled={!!adding}
                          aria-label="Отмена — закрыть выбор количества"
                          className="flex h-10 w-10 shrink-0 items-center justify-center rounded border border-border bg-surface text-[16px] leading-none text-ink-3 transition-colors hover:bg-surface-muted disabled:opacity-50"
                        >
                          <span aria-hidden="true">✕</span>
                        </button>
                      </div>
                    </li>
                  );
                }

                return (
                  <li key={r.equipmentId}>
                    <button
                      type="button"
                      onClick={() => handleRowTap(r)}
                      disabled={!!adding || capped}
                      aria-label={
                        capped
                          ? `${r.name} — уже добран максимум на даты, нельзя добавить`
                          : free
                            ? `${r.name} — свободно, выбрать количество и добавить в выдачу`
                            : atClient
                              ? `${r.name} — у клиента по другой брони, открыть предупреждение о доборе`
                              : `${r.name} — занят, открыть предупреждение о доборе`
                      }
                      className="flex w-full items-center gap-2 border-t border-surface-subtle px-1 py-2.5 text-left transition-colors first:border-t-0 hover:bg-surface-muted disabled:opacity-60"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-ink">
                          {r.name}
                        </span>
                        <span className="eyebrow mt-0.5 block truncate">
                          {r.category}
                        </span>
                      </span>
                      {free ? (
                        <span className="shrink-0 rounded-full bg-emerald-soft px-2 py-0.5 text-[10px] font-semibold text-emerald">
                          свободно ×{r.availableQuantity}
                        </span>
                      ) : (
                        <span className="shrink-0 rounded-full bg-rose-soft px-2 py-0.5 text-[10px] font-semibold text-rose">
                          {atClient ? "у клиента" : "занято"}
                        </span>
                      )}
                      {isAdding && (
                        <span
                          aria-hidden="true"
                          className="shrink-0 text-[11px] text-ink-3"
                        >
                          …
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </>
  );
}
