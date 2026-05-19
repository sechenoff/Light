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
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { scanApi } from "./api";
import type { AddonConflict, AddonResult, ScanApiError } from "./types";
import { toMoscowDateString } from "../../lib/moscowDate";

const DEBOUNCE_MS = 300;
const ADDON_CONFLICT_CODE = "ADDON_CONFLICT";

function isScanApiError(value: unknown): value is ScanApiError {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    "message" in value
  );
}

/** «21.05» — день.месяц по московскому времени (как в BookingList). */
function shortDate(iso: string): string {
  const ymd = toMoscowDateString(new Date(iso)); // YYYY-MM-DD
  const [, m, d] = ymd.split("-");
  return `${d}.${m}`;
}

/**
 * Narrows a 409 ADDON_CONFLICT `details` payload to an `AddonConflict`.
 * The backend echoes the same shape it returns inside each search result.
 */
function conflictFromDetails(details: unknown): AddonConflict | null {
  if (typeof details !== "object" || details === null) return null;
  const d = details as Record<string, unknown>;
  if (
    typeof d.bookingNo === "string" &&
    typeof d.projectName === "string" &&
    typeof d.from === "string" &&
    typeof d.to === "string" &&
    typeof d.freeFrom === "string"
  ) {
    return {
      bookingId: typeof d.bookingId === "string" ? d.bookingId : "",
      bookingNo: d.bookingNo,
      projectName: d.projectName,
      from: d.from,
      to: d.to,
      freeFrom: d.freeFrom,
    };
  }
  return null;
}

function isAvailable(r: AddonResult): boolean {
  return r.availability !== "UNAVAILABLE" && r.availableQuantity > 0;
}

/** The red conflict warn card (mockup block 3 `.warn`). Pure & controlled. */
function ConflictWarning({
  name,
  conflict,
  busy,
  onCancel,
  onForce,
}: {
  name: string;
  conflict: AddonConflict;
  busy: boolean;
  onCancel: () => void;
  onForce: () => void;
}) {
  return (
    <div
      role="alert"
      className="mx-3 mb-3 rounded-lg border border-rose-border bg-rose-soft px-3 py-2.5"
    >
      <p className="text-[13px] font-semibold text-rose">
        <span aria-hidden="true">⚠ </span>
        {name} занят
      </p>
      <p className="mt-1 text-[11px] leading-snug text-rose">
        Бронь {conflict.bookingNo} «{conflict.projectName}» ·{" "}
        {shortDate(conflict.from)}–{shortDate(conflict.to)}. Свободно с{" "}
        {shortDate(conflict.freeFrom)}.
      </p>
      <div className="mt-2.5 flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          aria-label={`Отмена — не добавлять ${name}`}
          className="h-10 flex-1 rounded border border-border bg-surface text-[12px] font-medium text-ink-2 transition-colors hover:bg-surface-muted disabled:opacity-50"
        >
          Отмена
        </button>
        <button
          type="button"
          onClick={onForce}
          disabled={busy}
          aria-label={`Выдать ${name} под ответственность, несмотря на конфликт`}
          className="h-10 flex-[1.4] rounded bg-rose text-[12px] font-semibold text-white transition-colors hover:opacity-95 disabled:opacity-60"
        >
          {busy ? "…" : "Выдать под ответственность"}
        </button>
      </div>
      <p className="mt-1.5 text-[10px] text-rose/80">
        Конфликт зафиксируется в аудите
      </p>
    </div>
  );
}

interface ActiveConflict {
  equipmentId: string;
  name: string;
  conflict: AddonConflict;
}

export function AddonSearch({
  sessionId,
  bookingNo,
  onAdded,
  onClose,
}: {
  sessionId: string;
  /** Display id of the booking being augmented (header context). */
  bookingNo?: string;
  /** Called after an article is added so the checklist can refresh. */
  onAdded: () => void;
  /** Dismiss the sheet / inline panel. */
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [results, setResults] = useState<AddonResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  // The inline red warn card target (from a conflicted row OR a 409 race).
  const [active, setActive] = useState<ActiveConflict | null>(null);
  // equipmentId currently being POSTed (disables its row / warn buttons).
  const [adding, setAdding] = useState<string | null>(null);
  // Brief confirmation line after a successful add (keeps sheet open).
  const [addedName, setAddedName] = useState<string | null>(null);

  // Overlay a11y, matching the sibling pattern (RejectBookingModal /
  // TaskDetailPanel): Esc closes, initial focus moves into the search field.
  // NOTE: full focus-trap/scroll-lock tracked in Task 9.1 design-fidelity pass.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);

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

  // Shared POST: optional ack flag. On 409 ADDON_CONFLICT surface the SAME
  // red warn card built from `err.details` (covers the race where a row
  // looked free at search time but got booked before this add).
  const doAdd = useCallback(
    async (r: { equipmentId: string; name: string }, ack: boolean) => {
      if (adding) return;
      setAdding(r.equipmentId);
      setError(null);
      try {
        await scanApi.addItem(sessionId, r.equipmentId, 1, ack ? true : undefined);
        setActive(null);
        setAddedName(r.name);
        onAdded();
      } catch (err: unknown) {
        if (
          isScanApiError(err) &&
          err.status === 409 &&
          err.code === ADDON_CONFLICT_CODE
        ) {
          const conflict = conflictFromDetails(err.details);
          if (conflict) {
            setActive({ equipmentId: r.equipmentId, name: r.name, conflict });
            return;
          }
        }
        setError(
          isScanApiError(err) ? err.message : "Не удалось добавить артикул",
        );
      } finally {
        setAdding(null);
      }
    },
    [adding, sessionId, onAdded],
  );

  function handleRowTap(r: AddonResult) {
    setAddedName(null);
    // Conflicted (explicit conflict OR busy) → show the warn card, do NOT add.
    if (r.conflict || !isAvailable(r)) {
      if (r.conflict) {
        setActive({
          equipmentId: r.equipmentId,
          name: r.name,
          conflict: r.conflict,
        });
      } else {
        // Busy with no conflict block from the API — still soft-warn by
        // attempting the add; the backend returns the 409 with details,
        // which surfaces the same card.
        void doAdd({ equipmentId: r.equipmentId, name: r.name }, false);
      }
      return;
    }
    void doAdd({ equipmentId: r.equipmentId, name: r.name }, false);
  }

  return (
    <>
      {/* Scrim — mobile only; desktop inline panel has no scrim. */}
      <button
        type="button"
        aria-label="Закрыть поиск добора"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-ink/40 lg:hidden"
      />

      <section
        aria-label="Добор — поиск по каталогу с проверкой доступности"
        className={[
          // Mobile: bottom sheet.
          "fixed inset-x-0 bottom-0 z-50 flex max-h-[80vh] flex-col",
          "rounded-t-2xl border-t border-border bg-surface shadow-sm",
          "motion-safe:animate-slidein",
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
          {addedName && (
            <div className="mx-3 mb-2 rounded-lg border border-emerald-border bg-emerald-soft px-3 py-2 text-[12px] font-medium text-emerald">
              <span aria-hidden="true">✓ </span>
              {addedName} добавлен в выдачу
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
              conflict={active.conflict}
              busy={adding === active.equipmentId}
              onCancel={closeWarning}
              onForce={() =>
                void doAdd(
                  { equipmentId: active.equipmentId, name: active.name },
                  true,
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
            results.length === 0 &&
            !error && (
              <p className="px-4 py-8 text-center text-[12px] text-ink-3">
                Ничего не найдено
              </p>
            )}

          {!loading && results.length > 0 && (
            <ul className="px-3">
              {results.map((r) => {
                const free = isAvailable(r);
                const isAdding = adding === r.equipmentId;
                return (
                  <li key={r.equipmentId}>
                    <button
                      type="button"
                      onClick={() => handleRowTap(r)}
                      disabled={!!adding}
                      aria-label={
                        free
                          ? `${r.name} — свободно, добавить в выдачу`
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
                          занято
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
