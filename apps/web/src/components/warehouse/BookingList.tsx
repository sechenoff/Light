"use client";

/**
 * Booking list for the warehouse-scan flow.
 *
 * Группировка по московской дате ОПЕРАЦИИ (аудит киоска 2026-07):
 *  - ISSUE  → startDate (когда выдавать);
 *  - RETURN → endDate   (когда ждём оборудование назад) — раньше возвраты
 *    группировались по startDate, и «когда вернут» из списка не читалось.
 * Бакеты: «Просрочено» (rose, дата < сегодня) / «Сегодня» / «Завтра» /
 * «Позже». Просрочка больше не растворяется в «Сегодня».
 *
 * Поиск по клиенту/проекту появляется при длинном списке (> SEARCH_THRESHOLD).
 * Кнопка «Обновить» — киоск живёт открытым весь день, менеджер добавляет
 * брони из офиса; раньше увидеть их можно было только пере-заходом в шаг.
 *
 * Card visuals mirror mockup `03-issue-and-desktop.html`: colored 4px left
 * border by bucket, display id = «#» + last 6 chars UPPERCASED, projectName,
 * client name, item count via `pluralize`. NEVER a barcode.
 *
 * Tap a card → `createSession(bookingId, operation)` → advance to checklist.
 */

import { useEffect, useMemo, useState } from "react";
import { scanApi } from "./api";
import { isScanApiError } from "./types";
import type {
  BookingSummary,
  ScanOperation,
  ScanSessionInfo,
} from "./types";
import {
  moscowTodayStart,
  toMoscowDateString,
  addDays,
} from "../../lib/moscowDate";
import { pluralize } from "../../lib/format";

type Bucket = "overdue" | "today" | "tomorrow" | "later";

interface BucketGroup {
  bucket: Bucket;
  label: string;
  bookings: BookingSummary[];
}

const BUCKET_BAR: Record<Bucket, string> = {
  overdue: "border-l-rose",
  today: "border-l-accent-bright",
  tomorrow: "border-l-indigo",
  later: "border-l-slate",
};

const BUCKET_DATE_TEXT: Record<Bucket, string> = {
  overdue: "text-rose",
  today: "text-accent-bright",
  tomorrow: "text-indigo",
  later: "text-slate",
};

/** Поиск показывается только когда список длинный — короткий охватывается взглядом. */
const SEARCH_THRESHOLD = 8;

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

function monthDay(d: Date): string {
  return d.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    timeZone: "Europe/Moscow",
  });
}

/** Дата, по которой живёт операция: выдача — startDate, возврат — endDate. */
function operationDate(b: BookingSummary, operation: ScanOperation): string {
  return operation === "RETURN" ? b.endDate : b.startDate;
}

/**
 * Buckets bookings into overdue / today / tomorrow / later by Moscow
 * operation date. Stable sort: date asc, then id asc.
 */
function groupBookings(
  bookings: BookingSummary[],
  operation: ScanOperation,
): BucketGroup[] {
  const todayStr = toMoscowDateString(moscowTodayStart());
  const tomorrowStr = toMoscowDateString(addDays(moscowTodayStart(), 1));

  const sorted = [...bookings].sort((a, b) => {
    const sa = toMoscowDateString(new Date(operationDate(a, operation)));
    const sb = toMoscowDateString(new Date(operationDate(b, operation)));
    if (sa !== sb) return sa < sb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const byBucket: Record<Bucket, BookingSummary[]> = {
    overdue: [],
    today: [],
    tomorrow: [],
    later: [],
  };

  for (const b of sorted) {
    const sd = toMoscowDateString(new Date(operationDate(b, operation)));
    if (sd < todayStr) byBucket.overdue.push(b);
    else if (sd === todayStr) byBucket.today.push(b);
    else if (sd === tomorrowStr) byBucket.tomorrow.push(b);
    else byBucket.later.push(b);
  }

  const overdueLabel =
    operation === "RETURN" ? "Просрочен возврат" : "Просрочена выдача";

  const groups: BucketGroup[] = [];
  if (byBucket.overdue.length > 0) {
    groups.push({ bucket: "overdue", label: overdueLabel, bookings: byBucket.overdue });
  }
  if (byBucket.today.length > 0) {
    groups.push({
      bucket: "today",
      label: `Сегодня · ${monthDay(moscowTodayStart())}`,
      bookings: byBucket.today,
    });
  }
  if (byBucket.tomorrow.length > 0) {
    groups.push({
      bucket: "tomorrow",
      label: `Завтра · ${monthDay(addDays(moscowTodayStart(), 1))}`,
      bookings: byBucket.tomorrow,
    });
  }
  if (byBucket.later.length > 0) {
    groups.push({ bucket: "later", label: "Позже", bookings: byBucket.later });
  }
  return groups;
}

export function BookingList({
  operation,
  version = 0,
  activeBookingId = null,
  onUnauth,
  onSelect,
}: {
  operation: ScanOperation;
  /**
   * Monotonic refetch trigger. The parent bumps this after a successful
   * `complete` so the list re-fetches and the just-handled booking
   * disappears from the current operation's list. Optional — defaults to
   * 0 so existing tests / callers don't need to thread it through.
   */
  version?: number;
  /** Бронь активной сессии — подсвечивается в desktop-панели на шаге чек-листа. */
  activeBookingId?: string | null;
  /** 401 handler — token expired / missing. */
  onUnauth: () => void;
  /**
   * Called after a session is created for the tapped booking. `session`
   * carries `resumed`/`startedAt`, чтобы страница показала плашку
   * «Продолжена незавершённая сессия».
   */
  onSelect: (
    sessionId: string,
    booking: BookingSummary,
    session?: ScanSessionInfo,
  ) => void;
}) {
  const [bookings, setBookings] = useState<BookingSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  // Локальный триггер «Обновить» — киоск живёт открытым весь день,
  // новые брони появляются без пере-захода в шаг.
  const [reloadKey, setReloadKey] = useState(0);
  const [search, setSearch] = useState("");

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
    // `version` is a dependency on purpose — bumping it re-runs the effect
    // and re-fetches /bookings (refetch after a successful complete).
    // `reloadKey` — то же для ручной кнопки «Обновить».
  }, [operation, onUnauth, version, reloadKey]);

  const filtered = useMemo(() => {
    const q = search.trim().toLocaleLowerCase("ru-RU");
    if (!q) return bookings;
    return bookings.filter((b) =>
      `${b.projectName} ${b.client?.name ?? ""}`
        .toLocaleLowerCase("ru-RU")
        .includes(q),
    );
  }, [bookings, search]);

  const groups = useMemo(
    () => groupBookings(filtered, operation),
    [filtered, operation],
  );

  async function handleSelect(b: BookingSummary) {
    if (creating) return;
    setCreating(b.id);
    setError(null);
    try {
      const session = await scanApi.createSession(b.id, operation);
      onSelect(session.id, b, session);
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

  const emptyText =
    operation === "ISSUE"
      ? "Нет броней, готовых к выдаче.\nК выдаче попадают подтверждённые брони — проверьте статус в списке броней."
      : "Возвращать нечего — нет выданного оборудования.";

  return (
    <div className="py-2">
      {/* Шапка списка: счётчик + «Обновить». */}
      <div className="flex items-center justify-between px-3.5 pb-1 pt-1.5">
        <span className="text-[11px] text-ink-3">
          {loading
            ? "Загрузка…"
            : `${bookings.length} ${pluralize(bookings.length, "бронь", "брони", "броней")}`}
        </span>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          disabled={loading}
          aria-label="Обновить список броней"
          className="flex h-8 items-center gap-1 rounded px-2 text-[11px] font-medium text-ink-3 transition-colors hover:bg-surface-subtle hover:text-ink disabled:opacity-40"
        >
          <span aria-hidden="true" className={loading ? "inline-block animate-spin" : ""}>⟳</span>
          Обновить
        </button>
      </div>

      {/* Поиск — только когда список длинный. */}
      {bookings.length > SEARCH_THRESHOLD && (
        <div className="px-2.5 pb-1.5">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Клиент или проект…"
            aria-label="Поиск по клиенту или проекту"
            className="h-10 w-full rounded-lg border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-accent-bright"
          />
        </div>
      )}

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
          <p>{error}</p>
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="mt-1.5 rounded border border-rose-border bg-surface px-2.5 py-1 text-xs font-medium text-rose hover:bg-rose-soft"
          >
            Повторить
          </button>
        </div>
      )}

      {!loading && !error && groups.length === 0 && (
        <div className="whitespace-pre-line px-4 py-16 text-center text-sm leading-relaxed text-ink-3">
          {search.trim() ? "Ничего не найдено." : emptyText}
        </div>
      )}

      {!loading &&
        !error &&
        groups.map((group) => (
          <section key={group.bucket}>
            <p
              className={`eyebrow px-3.5 pb-1 pt-3 ${group.bucket === "overdue" ? "!text-rose" : ""}`}
            >
              {group.label}
            </p>
            {group.bookings.map((b) => {
              const isBusy = creating === b.id;
              const isActive = activeBookingId === b.id;
              const count = b.items.length;
              return (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => handleSelect(b)}
                  disabled={!!creating}
                  aria-label={`Бронь ${displayNo(b.id)} — ${b.projectName || "Без названия"}`}
                  aria-current={isActive ? "true" : undefined}
                  className={`mx-2.5 mb-1.5 block w-[calc(100%-1.25rem)] rounded-lg border border-l-4 px-3 py-2.5 text-left transition-colors disabled:opacity-60 ${BUCKET_BAR[group.bucket]} ${
                    isActive
                      ? "border-accent-border bg-accent-soft"
                      : "border-border bg-surface hover:bg-surface-muted active:bg-surface-subtle"
                  }`}
                >
                  <div
                    className={`text-[11px] font-semibold ${BUCKET_DATE_TEXT[group.bucket]}`}
                  >
                    {shortDate(operationDate(b, operation))} · {displayNo(b.id)}
                  </div>
                  <div className="mt-0.5 truncate text-[13px] font-semibold text-ink">
                    {b.projectName || "Без названия"}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-ink-3">
                    {b.client?.name ?? "—"} · {count}{" "}
                    {pluralize(count, "позиция", "позиции", "позиций")}
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
