"use client";

/**
 * «В работе» — активные (ISSUED) выдачи со сроками (v2, сцена 2 мокапа).
 *
 * Апгрейд к первой версии:
 *  - фильтры-пилюли: Просрочено N · Сегодня N · Завтра N · Все N
 *    (при наличии просрочки список стартует с фильтра «Просрочено»);
 *  - в карточке: телефон клиента (tel:) и инлайн-кнопки
 *    «Принять возврат» / «Позвонить» — без прохода через детали;
 *  - тап по телу карточки по-прежнему открывает InWorkDetails.
 *
 * Данные: GET /api/warehouse/in-work (endDate ASC, просрочка сверху).
 */

import { useEffect, useMemo, useState } from "react";
import { scanApi } from "./api";
import { isScanApiError } from "./types";
import type { InWorkBooking } from "./types";
import { pluralize } from "../../lib/format";
import { IconPhone, IconReturn } from "./workstationIcons";

type DeadlineFilter = "overdue" | "today" | "tomorrow" | "all";

/** «21.05» — день.месяц из ISO datetime (локальное время браузера). */
function shortDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function isSameLocalDay(iso: string, offsetDays: number): boolean {
  const d = new Date(iso);
  const target = new Date();
  target.setDate(target.getDate() + offsetDays);
  return (
    d.getFullYear() === target.getFullYear() &&
    d.getMonth() === target.getMonth() &&
    d.getDate() === target.getDate()
  );
}

export function InWorkList({
  onSelect,
  onAcceptBack,
  version,
  initialFilter,
}: {
  /** Тап по карточке — открыть детали брони. */
  onSelect: (bookingId: string) => void;
  /** «Принять возврат» прямо из карточки — сразу RETURN-сессия. */
  onAcceptBack?: (bookingId: string) => void;
  /** Монотонный счётчик — bump после приёмки, чтобы список перезагрузился. */
  version?: number;
  /** Стартовый фильтр (например, «overdue» при переходе из алерта Смены). */
  initialFilter?: DeadlineFilter;
}) {
  const [bookings, setBookings] = useState<InWorkBooking[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<DeadlineFilter | null>(initialFilter ?? null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setBookings(null);
    scanApi
      .listInWork()
      .then((r) => {
        if (!cancelled) setBookings(r.bookings);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          isScanApiError(err) ? err.message : "Не удалось загрузить «В работе»",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  const counts = useMemo(() => {
    const list = bookings ?? [];
    return {
      overdue: list.filter((b) => b.isOverdue).length,
      today: list.filter((b) => !b.isOverdue && isSameLocalDay(b.expectedReturnAt, 0)).length,
      tomorrow: list.filter((b) => !b.isOverdue && isSameLocalDay(b.expectedReturnAt, 1)).length,
      all: list.length,
    };
  }, [bookings]);

  // Дефолтный фильтр после загрузки: просрочка есть → «Просрочено», иначе «Все».
  const activeFilter: DeadlineFilter =
    filter ?? (counts.overdue > 0 ? "overdue" : "all");

  const visible = useMemo(() => {
    const list = bookings ?? [];
    switch (activeFilter) {
      case "overdue":
        return list.filter((b) => b.isOverdue);
      case "today":
        return list.filter((b) => !b.isOverdue && isSameLocalDay(b.expectedReturnAt, 0));
      case "tomorrow":
        return list.filter((b) => !b.isOverdue && isSameLocalDay(b.expectedReturnAt, 1));
      default:
        return list;
    }
  }, [bookings, activeFilter]);

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
      <div className="space-y-2 px-2.5 py-2">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-[92px] animate-pulse rounded-lg border border-border bg-surface"
            aria-hidden="true"
          />
        ))}
      </div>
    );
  }

  if (bookings.length === 0) {
    return (
      <p className="px-4 py-16 text-center text-sm text-ink-3">
        Нет активных выдач — всё оборудование на складе.
      </p>
    );
  }

  const pills: Array<{ key: DeadlineFilter; label: string; count: number; rose?: boolean }> = [
    { key: "overdue", label: "Просрочено", count: counts.overdue, rose: true },
    { key: "today", label: "Сегодня", count: counts.today },
    { key: "tomorrow", label: "Завтра", count: counts.tomorrow },
    { key: "all", label: "Все", count: counts.all },
  ];

  return (
    <div className="pb-2">
      {/* Фильтры-пилюли */}
      <div className="flex flex-wrap gap-1.5 px-2.5 py-2.5" role="tablist" aria-label="Фильтр по сроку">
        {pills.map((p) => {
          const on = activeFilter === p.key;
          return (
            <button
              key={p.key}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setFilter(p.key)}
              className={`min-h-[30px] rounded-full border px-3 py-1 text-[11.5px] font-semibold transition-colors ${
                on
                  ? p.rose
                    ? "border-rose bg-rose text-white"
                    : "border-ink bg-ink text-white"
                  : p.rose && p.count > 0
                    ? "border-rose-border bg-surface text-rose hover:bg-rose-soft"
                    : "border-border bg-surface text-ink-2 hover:bg-surface-muted"
              }`}
            >
              {p.label} {p.count}
            </button>
          );
        })}
      </div>

      {visible.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-ink-3">
          {activeFilter === "overdue"
            ? "Просроченных нет — отлично."
            : "В этом фильтре пусто."}
        </p>
      ) : (
        visible.map((b) => {
          const itemCount = b.itemsCount;
          return (
            <div
              key={b.bookingId}
              className={`relative mx-2.5 mb-1.5 overflow-hidden rounded-lg border px-3 py-2.5 transition-colors ${
                b.isOverdue
                  ? "border-rose-border bg-gradient-to-r from-rose-soft/60 to-surface"
                  : "border-border bg-surface"
              }`}
            >
              {b.isOverdue && (
                <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-rose" />
              )}
              <button
                type="button"
                onClick={() => onSelect(b.bookingId)}
                aria-label={`Бронь ${b.displayNo} — ${b.projectName || "Без названия"}, открыть детали`}
                className="block w-full text-left"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-semibold text-ink">
                      {b.clientName || "—"} · {b.projectName || "Без названия"}
                    </div>
                    <div className="mt-0.5 truncate text-[11.5px] text-ink-2">
                      {b.displayNo}
                      {b.issuedAt ? ` · взято ${shortDate(b.issuedAt)}` : ""}
                      {` · ${itemCount} ${pluralize(itemCount, "позиция", "позиции", "позиций")}`}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div
                      className={`mono-num text-[12.5px] font-semibold ${
                        b.isOverdue ? "text-rose" : "text-ink"
                      }`}
                    >
                      {shortDate(b.expectedReturnAt)}
                    </div>
                    <div
                      className={`text-[10.5px] ${b.isOverdue ? "font-semibold text-rose" : "text-ink-3"}`}
                    >
                      {b.isOverdue
                        ? `просрочен на ${b.overdueDays} ${pluralize(b.overdueDays, "день", "дня", "дней")}`
                        : "плановый возврат"}
                    </div>
                  </div>
                </div>
              </button>
              <div className="mt-2 flex gap-1.5">
                {onAcceptBack && (
                  <button
                    type="button"
                    onClick={() => onAcceptBack(b.bookingId)}
                    className="inline-flex min-h-[32px] items-center gap-1.5 rounded bg-teal px-3 py-1.5 text-[11.5px] font-semibold text-white transition-colors hover:opacity-90"
                  >
                    <IconReturn className="h-[13px] w-[13px]" strokeWidth={2.2} />
                    Принять возврат
                  </button>
                )}
                {b.clientPhone && (
                  <a
                    href={`tel:${b.clientPhone}`}
                    className="inline-flex min-h-[32px] items-center gap-1.5 rounded border border-border-strong bg-surface px-3 py-1.5 text-[11.5px] font-semibold text-ink transition-colors hover:bg-surface-muted"
                  >
                    <IconPhone className="h-[13px] w-[13px]" strokeWidth={2.2} />
                    Позвонить
                  </a>
                )}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
