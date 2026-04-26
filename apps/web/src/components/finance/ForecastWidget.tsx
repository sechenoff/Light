"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";
import { formatRub } from "../../lib/format";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ForecastMonth {
  month: string; // YYYY-MM
  confirmed: string;
  potential: string;
  bookingsPipeline: string;
}

interface ForecastResult {
  months: ForecastMonth[];
  totals: {
    confirmed: string;
    potential: string;
    bookingsPipeline: string;
  };
  horizon: { from: string; to: string };
}

// ── Month label helpers ───────────────────────────────────────────────────────

const MONTH_SHORT_RU: Record<string, string> = {
  "01": "янв", "02": "фев", "03": "мар", "04": "апр",
  "05": "май", "06": "июн", "07": "июл", "08": "авг",
  "09": "сен", "10": "окт", "11": "ноя", "12": "дек",
};

function monthLabel(yyyyMM: string): string {
  const [year, month] = yyyyMM.split("-");
  const m = MONTH_SHORT_RU[month] ?? month;
  return `${m} ${year}`;
}

// ── Bar chart (pure CSS) ──────────────────────────────────────────────────────

interface BarProps {
  entry: ForecastMonth;
  maxValue: number;
  /** px height of the full bar area */
  barHeight: number;
}

function ForecastBar({ entry, maxValue, barHeight }: BarProps) {
  const confirmed = Number(entry.confirmed);
  const potential = Number(entry.potential);
  const pipeline = Number(entry.bookingsPipeline);
  const total = confirmed + potential + pipeline;
  const safeMax = maxValue === 0 ? 1 : maxValue;

  const confirmedH = Math.max(total > 0 ? Math.round((confirmed / safeMax) * barHeight) : 0, confirmed > 0 ? 3 : 0);
  const potentialH = Math.max(total > 0 ? Math.round((potential / safeMax) * barHeight) : 0, potential > 0 ? 3 : 0);
  const pipelineH = Math.max(total > 0 ? Math.round((pipeline / safeMax) * barHeight) : 0, pipeline > 0 ? 3 : 0);

  const label = monthLabel(entry.month);

  const tooltipLines = [
    `Подтверждённый: ${formatRub(confirmed)}`,
    `Возможный: ${formatRub(potential)}`,
    `По броням: ${formatRub(pipeline)}`,
  ].join("\n");

  return (
    <div className="flex flex-col items-center gap-1 min-w-[52px]">
      {/* Total label */}
      <span className="mono-num text-[10.5px] text-ink-3 font-medium leading-tight h-[14px] flex items-center">
        {total > 0 ? formatRub(total) : ""}
      </span>
      {/* Stacked bar */}
      <div
        className="w-9 flex flex-col justify-end"
        style={{ height: `${barHeight}px` }}
        title={tooltipLines}
      >
        {/* Segments bottom-to-top: confirmed, potential, pipeline */}
        <div className="w-full flex flex-col gap-px justify-end" style={{ height: `${barHeight}px` }}>
          {pipelineH > 0 && (
            <div
              className="w-full rounded-t-sm bg-slate-400"
              style={{ height: `${pipelineH}px`, backgroundColor: "var(--color-slate, #64748b)" }}
            />
          )}
          {potentialH > 0 && (
            <div
              className="w-full"
              style={{
                height: `${potentialH}px`,
                backgroundColor: "var(--color-amber, #d97706)",
                borderRadius: pipelineH > 0 ? "0" : "2px 2px 0 0",
              }}
            />
          )}
          {confirmedH > 0 && (
            <div
              className="w-full"
              style={{
                height: `${confirmedH}px`,
                backgroundColor: "var(--color-emerald, #059669)",
                borderRadius:
                  pipelineH === 0 && potentialH === 0 ? "2px 2px 0 0" : "0",
              }}
            />
          )}
          {total === 0 && (
            <div
              className="w-full rounded-sm"
              style={{ height: "3px", backgroundColor: "var(--color-border, #e2e8f0)" }}
            />
          )}
        </div>
      </div>
      {/* Month label */}
      <span
        className="text-[10px] text-ink-3 font-medium uppercase tracking-wider text-center"
        style={{ fontFamily: "IBM Plex Sans Condensed, sans-serif" }}
      >
        {label}
      </span>
    </div>
  );
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function ForecastSkeleton() {
  return (
    <div role="status" aria-label="Загрузка прогноза" className="animate-pulse">
      <div className="flex items-end gap-3 h-[120px] px-2">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="flex flex-col items-center gap-1 flex-1">
            <div className="w-9 bg-slate-100 rounded-t" style={{ height: `${60 + i * 10}px` }} />
            <div className="h-3 w-8 bg-slate-100 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ForecastWidget({ months = 6 }: { months?: number }) {
  const [data, setData] = useState<ForecastResult | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch<ForecastResult>(`/api/finance/forecast?months=${months}`)
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => { /* non-fatal — widget hides gracefully */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [months]);

  if (loading) {
    return (
      <div className="bg-surface border border-border rounded-[6px] overflow-hidden shadow-xs mb-5">
        <div className="flex justify-between items-center px-4 py-3.5 border-b border-border">
          <h3 className="text-[13.5px] font-semibold text-ink">Прогноз поступлений</h3>
        </div>
        <div className="px-5 py-4">
          <ForecastSkeleton />
        </div>
      </div>
    );
  }

  if (!data) return null;

  const allZero = data.months.every(
    (m) => Number(m.confirmed) === 0 && Number(m.potential) === 0 && Number(m.bookingsPipeline) === 0
  );

  const BAR_HEIGHT = 100;
  const maxValue = data.months.reduce((max, m) => {
    const total = Number(m.confirmed) + Number(m.potential) + Number(m.bookingsPipeline);
    return Math.max(max, total);
  }, 0);

  return (
    <div className="bg-surface border border-border rounded-[6px] overflow-hidden shadow-xs mb-5">
      <div className="flex justify-between items-center px-4 py-3.5 border-b border-border">
        <h3 className="text-[13.5px] font-semibold text-ink">Прогноз поступлений</h3>
        <span className="text-[11px] text-ink-3">{months} мес.</span>
      </div>

      {allZero ? (
        <div className="px-5 py-10 text-center">
          <p className="text-[14px] font-medium text-ink mb-1">Нет прогноза по invoice&apos;ам</p>
          <p className="text-sm text-ink-2">Создайте счета с датой оплаты, чтобы увидеть прогноз</p>
        </div>
      ) : (
        <div className="px-5 pb-4 pt-4">
          {/* Bars — horizontal scroll on mobile */}
          <div className="overflow-x-auto">
            <div
              className="flex items-end gap-4 pb-2"
              style={{ minWidth: `${data.months.length * 68}px` }}
            >
              {data.months.map((entry) => (
                <ForecastBar
                  key={entry.month}
                  entry={entry}
                  maxValue={maxValue}
                  barHeight={BAR_HEIGHT}
                />
              ))}
            </div>
          </div>

          {/* Legend */}
          <div className="flex gap-5 text-[11.5px] text-ink-2 mt-3 flex-wrap">
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block w-2.5 h-2.5 rounded-sm"
                style={{ backgroundColor: "var(--color-emerald, #059669)" }}
              />
              Подтверждённый
            </span>
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block w-2.5 h-2.5 rounded-sm"
                style={{ backgroundColor: "var(--color-amber, #d97706)" }}
              />
              Возможный
            </span>
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block w-2.5 h-2.5 rounded-sm"
                style={{ backgroundColor: "var(--color-slate, #64748b)" }}
              />
              По броням
            </span>
          </div>

          {/* Totals row */}
          <div className="mt-3 pt-3 border-t border-border text-[11.5px] text-ink-2 flex flex-wrap gap-4">
            <span>
              Подтверждённый pipeline:{" "}
              <strong className="mono-num text-emerald">{formatRub(data.totals.confirmed)}</strong>
            </span>
            <span>
              Возможный:{" "}
              <strong className="mono-num text-amber">{formatRub(data.totals.potential)}</strong>
            </span>
            <span>
              По броням:{" "}
              <strong className="mono-num text-ink">{formatRub(data.totals.bookingsPipeline)}</strong>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
