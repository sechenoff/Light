"use client";

/**
 * «В работе» — read-only details for one ISSUED booking.
 *
 * Pulls `GET /api/warehouse/in-work/:bookingId/details` and renders:
 *  - Header (displayNo · project · client + issued/expected dates).
 *  - Items list (no checkboxes, no scanning — this is a peek, not the
 *    checklist; the operator must explicitly «← Принять обратно» to enter
 *    the RETURN flow).
 *  - Finance panel mirroring `InWorkDetails.finance` byte-for-byte: the
 *    backend currently surfaces the SAME `finalAmount` for both «Согласовано»
 *    and «К оплате» — there's no separate pre-addon breakdown on this
 *    endpoint (см. T3 implementer's note), so we show «Согласовано» using
 *    `finalAmount` and only render «+ Доб-смета» as an informational line
 *    when `addonAmount > 0`. «Остаток» renders only when there's actually
 *    something outstanding (avoids the «0 ₽ задолженности» noise that
 *    confuses operators on fully-paid bookings).
 *
 * Action: `← Принять обратно` is the only mutation — parent transitions to
 * the RETURN flow with this booking pre-selected.
 */

import { useEffect, useState } from "react";
import { scanApi } from "./api";
import { isScanApiError } from "./types";
import { formatRub } from "../../lib/format";
import type { InWorkDetails as InWorkDetailsT } from "./types";

interface Props {
  bookingId: string;
  /** Tapped «← Принять обратно» — parent flips into RETURN with this booking. */
  onAcceptBack: (bookingId: string) => void;
  /** Tapped «← К списку» — parent goes back to `InWorkList`. */
  onBack: () => void;
}

/** «21.05.2026» — день.месяц.год из ISO datetime (локальное время браузера). */
function longDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
}

export function InWorkDetails({ bookingId, onAcceptBack, onBack }: Props) {
  const [data, setData] = useState<InWorkDetailsT | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setData(null);
    scanApi
      .getInWorkDetails(bookingId)
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          isScanApiError(err)
            ? err.message
            : "Не удалось загрузить детали брони",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [bookingId]);

  if (error) {
    return (
      <div className="mx-2.5 my-2 space-y-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="К списку «В работе»"
          className="text-[12px] text-accent hover:underline"
        >
          ← К списку «В работе»
        </button>
        <div
          role="alert"
          className="rounded-lg border border-rose-border bg-rose-soft px-3 py-2.5 text-sm text-rose"
        >
          {error}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mx-2.5 my-2 space-y-2">
        <div
          className="h-4 w-32 animate-pulse rounded bg-surface-muted"
          aria-hidden="true"
        />
        <div
          className="h-24 animate-pulse rounded-lg bg-surface-muted"
          aria-hidden="true"
        />
        <div
          className="h-48 animate-pulse rounded-lg bg-surface-muted"
          aria-hidden="true"
        />
      </div>
    );
  }

  const addon = Number(data.finance.addonAmount);
  const outstanding = Number(data.finance.outstanding);
  const itemsCount = data.items.length;

  return (
    <div className="mx-2.5 my-2 space-y-4">
      <button
        type="button"
        onClick={onBack}
        aria-label="К списку «В работе»"
        className="text-[12px] text-accent hover:underline"
      >
        ← К списку «В работе»
      </button>

      <header>
        <p className="eyebrow">{data.displayNo}</p>
        <h2 className="mt-1 text-lg font-semibold text-ink">
          {data.projectName || "Без названия"}
        </h2>
        <p className="text-[13px] text-ink-2">{data.clientName || "—"}</p>
        <p className="mt-2 text-[12px] text-ink-3">
          Выдано: {longDate(data.issuedAt)} · Ожидаемый возврат:{" "}
          {longDate(data.expectedReturnAt)}
        </p>
      </header>

      <section>
        <h3 className="mb-2 text-[13px] font-semibold text-ink">
          Оборудование ({itemsCount})
        </h3>
        <ul className="space-y-1">
          {data.items.map((it) => (
            <li
              key={it.bookingItemId}
              className="flex items-baseline justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
            >
              <span className="min-w-0 flex-1 truncate text-ink">
                {it.equipmentName}
              </span>
              <span className="mono-num shrink-0 text-ink-3">
                ×{it.quantity}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section
        aria-labelledby="in-work-finance"
        className="rounded-lg border border-border bg-surface-subtle p-3 text-[13px]"
      >
        <h3
          id="in-work-finance"
          className="mb-2 text-[12px] font-semibold text-ink"
        >
          Финансы
        </h3>
        <dl className="space-y-1">
          <div className="flex justify-between">
            <dt className="text-ink-2">Согласовано</dt>
            <dd className="mono-num">{formatRub(data.finance.finalAmount)}</dd>
          </div>
          {addon > 0 && (
            <div className="flex justify-between">
              <dt className="text-ink-2">+ Доб-смета</dt>
              <dd className="mono-num">
                {formatRub(data.finance.addonAmount)}
              </dd>
            </div>
          )}
          <div className="flex justify-between font-semibold">
            <dt>К оплате</dt>
            <dd className="mono-num">{formatRub(data.finance.finalAmount)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-2">Оплачено</dt>
            <dd className="mono-num">{formatRub(data.finance.amountPaid)}</dd>
          </div>
          {outstanding > 0 && (
            <div className="flex justify-between text-rose">
              <dt>Остаток</dt>
              <dd className="mono-num">
                {formatRub(data.finance.outstanding)}
              </dd>
            </div>
          )}
        </dl>
      </section>

      <button
        type="button"
        onClick={() => onAcceptBack(data.bookingId)}
        aria-label={`Принять обратно — ${data.projectName || "Бронь"}`}
        className="block w-full rounded-lg bg-accent px-4 py-3 text-center text-sm font-semibold text-white transition-colors hover:opacity-95"
      >
        <span aria-hidden="true">←</span> Принять обратно
      </button>
    </div>
  );
}
