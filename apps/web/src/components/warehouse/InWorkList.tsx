"use client";

/**
 * «В работе» tab — active (ISSUED) bookings.
 *
 * Read-only card list. Pulls from `GET /api/warehouse/in-work` (server-sorted
 * by `endDate ASC`, so overdue cards naturally bubble to the top). Each card
 * is a `<button>` — tap → `onSelect(bookingId)` lets the parent flip into
 * `InWorkDetails`. The list itself never mutates state.
 *
 * Visual contract:
 *  - Overdue cards get a rose-tinted rail + a red «просрочка N день/дня/дней»
 *    pill. Non-overdue cards keep the neutral surface + an amber «до DD.MM»
 *    pill (deadline still in the future).
 *  - Item count uses the same `pluralize("позиция","позиции","позиций")`
 *    rendering as `BookingList`.
 *  - Display id is the backend-supplied `displayNo` (`#ABCDEF`, last 6 chars
 *    upper-cased) — NEVER a barcode.
 */

import { useEffect, useState } from "react";
import { scanApi } from "./api";
import { isScanApiError } from "./types";
import type { InWorkBooking } from "./types";
import { pluralize } from "../../lib/format";

/** «21.05» — день.месяц из ISO datetime (локальное время браузера). */
function shortDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function InWorkList({
  onSelect,
  version,
}: {
  /** Tap-handler — called with the booking id when the user picks a card. */
  onSelect: (bookingId: string) => void;
  /**
   * Monotonic counter — bump after «Принять обратно» commits a RETURN so the
   * list re-fetches and the just-returned booking disappears. Mirrors the
   * `version` prop pattern on BookingList.
   */
  version?: number;
}) {
  const [bookings, setBookings] = useState<InWorkBooking[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setBookings(null);   // show skeleton while refetching after a version bump
    scanApi
      .listInWork()
      .then((r) => {
        if (!cancelled) setBookings(r.bookings);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          isScanApiError(err)
            ? err.message
            : "Не удалось загрузить «В работе»",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  if (error) {
    return (
      <div
        role="alert"
        className="mx-2.5 my-2 rounded-lg border border-rose-border bg-rose-soft px-3 py-2.5 text-sm text-rose"
      >
        {error}
      </div>
    );
  }

  if (bookings === null) {
    return (
      <div className="space-y-2 px-2.5 py-1">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-[72px] animate-pulse rounded-lg border border-border border-l-4 border-l-border-strong bg-surface"
            aria-hidden="true"
          />
        ))}
      </div>
    );
  }

  if (bookings.length === 0) {
    return (
      <p className="px-4 py-16 text-center text-sm text-ink-3">
        Нет активных выдач
      </p>
    );
  }

  return (
    <div className="py-2">
      {bookings.map((b) => {
        const itemCount = b.itemsCount;
        return (
          <button
            key={b.bookingId}
            type="button"
            onClick={() => onSelect(b.bookingId)}
            aria-label={`Бронь ${b.displayNo} — ${b.projectName || "Без названия"}`}
            className={`mx-2.5 mb-1.5 block w-[calc(100%-1.25rem)] rounded-lg border border-l-4 px-3 py-2.5 text-left transition-colors active:bg-surface-subtle ${
              b.isOverdue
                ? "border-rose-border border-l-rose bg-rose-soft/30 hover:bg-rose-soft/50"
                : "border-border border-l-amber bg-surface hover:bg-surface-muted"
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div
                  className={`text-[11px] font-semibold uppercase tracking-wide ${
                    b.isOverdue ? "text-rose" : "text-ink-3"
                  }`}
                >
                  {b.displayNo}
                  {b.issuedAt ? ` · взято ${shortDate(b.issuedAt)}` : ""}
                </div>
                <div className="mt-0.5 truncate text-[13px] font-semibold text-ink">
                  {b.projectName || "Без названия"}
                </div>
                <div className="mt-0.5 truncate text-[11px] text-ink-3">
                  {b.clientName || "—"}
                </div>
              </div>
              <span
                className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                  b.isOverdue
                    ? "bg-rose text-white"
                    : "bg-amber-soft text-amber"
                }`}
              >
                {b.isOverdue
                  ? `просрочка ${b.overdueDays} ${pluralize(
                      b.overdueDays,
                      "день",
                      "дня",
                      "дней",
                    )}`
                  : `до ${shortDate(b.expectedReturnAt)}`}
              </span>
            </div>
            <div className="mt-1.5 text-[12px] text-ink-3">
              {itemCount}{" "}
              {pluralize(itemCount, "позиция", "позиции", "позиций")}
            </div>
          </button>
        );
      })}
    </div>
  );
}
