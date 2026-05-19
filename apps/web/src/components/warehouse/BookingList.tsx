"use client";

/**
 * Filter-less booking list for the warehouse-scan flow.
 *
 * NO tabs / NO search / NO status filter — by product decision the operator
 * sees every scannable booking, grouped by due date.
 *
 * Grouping: Moscow date-only buckets «Сегодня» / «Завтра» / «Позже»
 * (via src/lib/moscowDate.ts). Sort: `startDate` asc, then booking `id` asc
 * as a stable deterministic tie-breaker — within and across groups.
 * (The backend `GET /warehouse/bookings` does not expose `createdAt`, so id
 * is used as the stable proxy; see Task 5.2 deviation note.)
 *
 * Card visuals mirror mockup `03-issue-and-desktop.html` block 1 (mobile)
 * and block 4 left pane (desktop): colored 4px left border by bucket
 * (Сегодня=accent, Завтра=indigo, Позже=slate — semantic tokens),
 * display id = «#» + last 6 chars UPPERCASED, projectName, client name,
 * item count via `pluralize`. NEVER a barcode.
 *
 * Tap a card → `createSession(bookingId, operation)` → advance to checklist.
 */

import { useEffect, useMemo, useState } from "react";
import { scanApi } from "./api";
import type { BookingSummary, ScanApiError, ScanOperation } from "./types";
import {
  moscowTodayStart,
  toMoscowDateString,
  addDays,
} from "../../lib/moscowDate";
import { pluralize } from "../../lib/format";

type Bucket = "today" | "tomorrow" | "later";

interface BucketGroup {
  bucket: Bucket;
  label: string;
  bookings: BookingSummary[];
}

const BUCKET_BAR: Record<Bucket, string> = {
  today: "border-l-accent-bright",
  tomorrow: "border-l-indigo",
  later: "border-l-slate",
};

const BUCKET_DATE_TEXT: Record<Bucket, string> = {
  today: "text-accent-bright",
  tomorrow: "text-indigo",
  later: "text-slate",
};

function isScanApiError(value: unknown): value is ScanApiError {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    "message" in value
  );
}

/** «#» + последние 6 символов id брони, в верхнем регистре. */
function displayNo(id: string): string {
  return "#" + id.slice(-6).toUpperCase();
}

/** «21.05» — день.месяц по московскому времени. */
function shortDate(iso: string): string {
  const ymd = toMoscowDateString(new Date(iso)); // YYYY-MM-DD
  const [, m, d] = ymd.split("-");
  return `${d}.${m}`;
}

function MONTH_DAY(d: Date): string {
  return d.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    timeZone: "Europe/Moscow",
  });
}

/**
 * Buckets bookings into today / tomorrow / later by Moscow start date.
 * Stable sort: startDate asc, then id asc.
 */
function groupBookings(bookings: BookingSummary[]): BucketGroup[] {
  const todayStr = toMoscowDateString(moscowTodayStart());
  const tomorrowStr = toMoscowDateString(addDays(moscowTodayStart(), 1));

  const sorted = [...bookings].sort((a, b) => {
    const sa = toMoscowDateString(new Date(a.startDate));
    const sb = toMoscowDateString(new Date(b.startDate));
    if (sa !== sb) return sa < sb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const today: BookingSummary[] = [];
  const tomorrow: BookingSummary[] = [];
  const later: BookingSummary[] = [];

  for (const b of sorted) {
    const sd = toMoscowDateString(new Date(b.startDate));
    if (sd <= todayStr) today.push(b);
    else if (sd === tomorrowStr) tomorrow.push(b);
    else later.push(b);
  }

  const groups: BucketGroup[] = [];
  if (today.length > 0) {
    groups.push({
      bucket: "today",
      label: `Сегодня · ${MONTH_DAY(moscowTodayStart())}`,
      bookings: today,
    });
  }
  if (tomorrow.length > 0) {
    groups.push({
      bucket: "tomorrow",
      label: `Завтра · ${MONTH_DAY(addDays(moscowTodayStart(), 1))}`,
      bookings: tomorrow,
    });
  }
  if (later.length > 0) {
    groups.push({ bucket: "later", label: "Позже", bookings: later });
  }
  return groups;
}

export function BookingList({
  operation,
  onUnauth,
  onSelect,
}: {
  operation: ScanOperation;
  /** 401 handler — token expired / missing. */
  onUnauth: () => void;
  /** Called after a session is created for the tapped booking. */
  onSelect: (sessionId: string, booking: BookingSummary) => void;
}) {
  const [bookings, setBookings] = useState<BookingSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    scanApi
      .listBookings(operation)
      .then((list) => {
        if (!cancelled) setBookings(list);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (isScanApiError(err) && err.status === 401) {
          onUnauth();
          return;
        }
        setError(
          isScanApiError(err) ? err.message : "Ошибка загрузки бронирований",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [operation, onUnauth]);

  const groups = useMemo(() => groupBookings(bookings), [bookings]);

  async function handleSelect(b: BookingSummary) {
    if (creating) return;
    setCreating(b.id);
    setError(null);
    try {
      const session = await scanApi.createSession(b.id, operation);
      onSelect(session.id, b);
    } catch (err: unknown) {
      if (isScanApiError(err) && err.status === 401) {
        onUnauth();
        return;
      }
      setError(
        isScanApiError(err) ? err.message : "Ошибка создания сессии",
      );
    } finally {
      setCreating(null);
    }
  }

  return (
    <div className="py-2">
      {loading && (
        <div className="space-y-2 px-2.5 py-1">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-[68px] animate-pulse rounded-lg border border-border border-l-4 border-l-border-strong bg-surface"
            />
          ))}
        </div>
      )}

      {error && (
        <div className="mx-2.5 my-2 rounded-lg border border-rose-border bg-rose-soft px-3 py-2.5 text-sm text-rose">
          {error}
        </div>
      )}

      {!loading && !error && groups.length === 0 && (
        <div className="px-4 py-16 text-center text-sm text-ink-3">
          Нет доступных бронирований
        </div>
      )}

      {!loading &&
        !error &&
        groups.map((group) => (
          <section key={group.bucket}>
            <p className="eyebrow px-3.5 pb-1 pt-3">{group.label}</p>
            {group.bookings.map((b) => {
              const isBusy = creating === b.id;
              const count = b.items.length;
              return (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => handleSelect(b)}
                  disabled={!!creating}
                  aria-label={`Бронь ${displayNo(b.id)} — ${b.projectName || "Без названия"}`}
                  className={`mx-2.5 mb-1.5 block w-[calc(100%-1.25rem)] rounded-lg border border-border border-l-4 bg-surface px-3 py-2.5 text-left transition-colors hover:bg-surface-muted active:bg-surface-subtle disabled:opacity-60 ${BUCKET_BAR[group.bucket]}`}
                >
                  <div
                    className={`text-[11px] font-semibold ${BUCKET_DATE_TEXT[group.bucket]}`}
                  >
                    {shortDate(b.startDate)} · {displayNo(b.id)}
                  </div>
                  <div className="mt-0.5 truncate text-[13px] font-semibold text-ink">
                    {b.projectName || "Без названия"}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-ink-3">
                    {b.client?.name ?? "—"} · {count}{" "}
                    {pluralize(count, "единица", "единицы", "единиц")}
                    {isBusy && <span className="ml-1 text-ink-2">· …</span>}
                  </div>
                </button>
              );
            })}
          </section>
        ))}
    </div>
  );
}
