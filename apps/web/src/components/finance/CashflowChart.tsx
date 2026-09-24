"use client";

/**
 * Денежный поток по месяцам — парные CSS-бары «получено» (emerald) /
 * «расходы» (slate) на реальных платежах (единая нетто-семантика backend).
 * Заменяет на сводке вечно пустой invoice-прогноз в роли главного графика:
 * история living-данных вместо прогноза по неиспользуемым счетам.
 *
 * Паттерн CSS-баров — как в ForecastWidget (динамические высоты через style).
 */

import { formatRub } from "../../lib/format";

export interface TrendEntry {
  month: string; // "YYYY-MM"
  earned: string;
  spent: string;
  net: string;
}

const MONTH_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

function monthLabel(ym: string): string {
  const [, m] = ym.split("-").map(Number);
  return MONTH_SHORT[(m ?? 1) - 1] ?? ym;
}

export function CashflowChart({ trend, monthsToShow = 6 }: { trend: TrendEntry[]; monthsToShow?: number }) {
  const months = trend.slice(-monthsToShow);
  const max = Math.max(...months.map((m) => Math.max(Number(m.earned), Number(m.spent))), 0);

  if (max === 0) return null; // ни поступлений, ни расходов — нечего рисовать

  const barH = 96; // px, высота зоны баров

  return (
    <div className="bg-surface border border-border rounded-lg shadow-xs overflow-hidden">
      <div className="flex justify-between items-center px-4 py-3.5 border-b border-border">
        <h3 className="text-[13.5px] font-semibold text-ink">Денежный поток</h3>
        <div className="flex items-center gap-3 text-[11px] text-ink-2">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block h-2 w-2 rounded-sm bg-emerald" />
            Получено
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block h-2 w-2 rounded-sm bg-slate" />
            Расходы
          </span>
        </div>
      </div>
      <div className="px-4 pb-3 pt-4">
        <div className="flex items-end gap-2" style={{ height: `${barH + 34}px` }}>
          {months.map((m, i) => {
            // На телефоне колонка уже подписи, и крайняя по центру уходила бы под
            // обрез карточки — прижимаем её к краю; с sm колонки шире, центрируем
            const labelPos =
              i === 0
                ? "left-0 sm:left-1/2 sm:-translate-x-1/2"
                : i === months.length - 1
                  ? "right-0 sm:right-auto sm:left-1/2 sm:-translate-x-1/2"
                  : "left-1/2 -translate-x-1/2";
            const earned = Number(m.earned);
            const spent = Number(m.spent);
            const eh = max > 0 ? Math.round((earned / max) * barH) : 0;
            const sh = max > 0 ? Math.round((spent / max) * barH) : 0;
            return (
              <div key={m.month} className="flex-1 flex flex-col items-center justify-end gap-1 group relative min-w-0" title={`${monthLabel(m.month)}: получено ${formatRub(m.earned)}, расходы ${formatRub(m.spent)}`}>
                {/* Сумма вне потока: невидимая nowrap-подпись иначе задаёт колонке
                    min-content ~72 px, и шесть месяцев не влезают в карточку на телефоне */}
                <span className={`pointer-events-none absolute bottom-full ${labelPos} mb-0.5 mono-num text-[10px] text-ink-3 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap`}>
                  {earned > 0 ? formatRub(earned) : ""}
                </span>
                <div className="flex items-end gap-1" style={{ height: `${barH}px` }}>
                  <div
                    className="w-4 rounded-t-sm bg-emerald transition-[height] duration-300"
                    style={{ height: `${Math.max(eh, earned > 0 ? 2 : 0)}px` }}
                  />
                  <div
                    className="w-4 rounded-t-sm bg-slate transition-[height] duration-300"
                    style={{ height: `${Math.max(sh, spent > 0 ? 2 : 0)}px` }}
                  />
                </div>
                <span className="text-[11px] text-ink-3">{monthLabel(m.month)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
