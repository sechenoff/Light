"use client";

/**
 * Дебиторка по возрасту (AR aging) — сегментированная полоса + чипы-легенда.
 * Паттерн Xero «Invoices owed to you»: сколько долга не просрочено, сколько
 * висит 1–30 / 31–60 / 60+ дней, сколько без назначенного срока.
 * Бакеты считает backend по БРОНЯМ (не по счетам) — см. computeFinanceDashboard.
 * Клик по чипу ведёт на /finance/debts (просроченные — с фильтром).
 */

import Link from "next/link";
import { formatRub } from "../../lib/format";

export interface AgingData {
  current: string;
  d1to30: string;
  d31to60: string;
  over60: string;
  noDue: string;
}

const SEGMENTS: Array<{
  key: keyof AgingData;
  label: string;
  barClass: string;
  chipClass: string;
  href: string;
}> = [
  { key: "current", label: "Не просрочен", barClass: "bg-emerald", chipClass: "text-emerald", href: "/finance/debts" },
  { key: "d1to30", label: "1–30 дн", barClass: "bg-amber", chipClass: "text-amber", href: "/finance/debts?overdueOnly=true" },
  { key: "d31to60", label: "31–60 дн", barClass: "bg-rose/70", chipClass: "text-rose", href: "/finance/debts?overdueOnly=true" },
  { key: "over60", label: "60+ дн", barClass: "bg-rose", chipClass: "text-rose", href: "/finance/debts?overdueOnly=true" },
  { key: "noDue", label: "Без срока", barClass: "bg-slate", chipClass: "text-ink-2", href: "/finance/debts" },
];

export function AgingStrip({ aging }: { aging: AgingData }) {
  const values = SEGMENTS.map((s) => ({ ...s, value: Number(aging[s.key]) }));
  const total = values.reduce((acc, v) => acc + v.value, 0);
  if (total <= 0) return null;

  const visible = values.filter((v) => v.value > 0);

  return (
    <div className="bg-surface border border-border rounded-lg shadow-xs overflow-hidden">
      <div className="flex justify-between items-center px-4 py-3.5 border-b border-border">
        <h3 className="text-[13.5px] font-semibold text-ink">Долг по возрасту</h3>
        <Link href="/finance/debts" className="text-xs text-accent-bright font-medium hover:underline">
          Все долги →
        </Link>
      </div>
      <div className="px-4 pb-4 pt-4">
        {/* Полоса-распределение: ширина сегмента = доля бакета в общем долге */}
        <div className="flex h-4 w-full overflow-hidden rounded" role="img" aria-label={`Распределение долга по возрасту, всего ${formatRub(total)}`}>
          {visible.map((v) => (
            <div
              key={v.key}
              className={`${v.barClass} min-w-[3px]`}
              style={{ width: `${(v.value / total) * 100}%` }}
              title={`${v.label}: ${formatRub(v.value)}`}
            />
          ))}
        </div>
        {/* Чипы-легенда: значение + подпись, кликабельны */}
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
          {visible.map((v) => (
            <Link key={v.key} href={v.href} className="group flex items-baseline gap-1.5 hover:opacity-80 transition-opacity">
              <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-sm self-center ${v.barClass}`} />
              <span className="text-[11.5px] text-ink-2 group-hover:underline">{v.label}</span>
              <span className={`mono-num text-[12.5px] font-semibold ${v.chipClass}`}>{formatRub(v.value)}</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
