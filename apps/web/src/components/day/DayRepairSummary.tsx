"use client";

/**
 * Сводка мастерской на «Мой день» для кладовщика и техника.
 *
 * До этого мастерская была видна только руководителю (KPI «Ремонт» на его
 * экране) — кладовщик и техник узнавали о ней, только зайдя в раздел. При этом
 * именно им она нужна раньше всех: кладовщику — что чинится (и не будет выдано)
 * и что уже починили, но лежит на верстаке; технику — что срывает ближайшую
 * бронь и по каким карточкам он молчит.
 *
 * Денег здесь нет сознательно: `GET /api/dashboard/repair-stats` отдаёт
 * `spent*` и `pendingExpenses` как `null` всем, кроме руководителя, — компонент
 * не пытается их показать даже когда они пришли.
 */

import Link from "next/link";
import { pluralize } from "../../lib/format";
import { formatDayMonth, QUIET_DAYS } from "../repair/types";
import type { RepairStats } from "../repair/types";

type Variant = "warehouse" | "technician";

/** Крупная цифра со подписью. Тон — только когда есть о чём тревожиться. */
function RepairChip({
  value,
  label,
  tone = "muted",
}: {
  value: number;
  label: string;
  tone?: "muted" | "rose" | "amber";
}) {
  const active = value > 0 && tone !== "muted";
  const box = active
    ? tone === "rose"
      ? "border-rose-border bg-rose-soft"
      : "border-amber-border bg-amber-soft"
    : "border-border bg-surface";
  const num = active ? (tone === "rose" ? "text-rose" : "text-amber") : "text-ink";
  return (
    <div className={`rounded-lg border px-3 py-2 ${box}`}>
      <p className={`mono-num text-[20px] font-semibold leading-tight ${num}`}>{value}</p>
      <p className="text-[11px] leading-snug text-ink-3">{label}</p>
    </div>
  );
}

export function DayRepairSummary({
  stats,
  variant,
}: {
  stats: RepairStats | null;
  variant: Variant;
}) {
  if (!stats) return null;

  const ready = stats.readyForPickup ?? [];
  // Кладовщику нечего показывать, если мастерская пуста и с верстака ничего
  // не забирать: пустой блок только отнимает первый экран.
  if (variant === "warehouse" && stats.openCount === 0 && ready.length === 0) return null;

  return (
    <div className="bg-surface border border-border rounded-lg p-3">
      <div className="flex justify-between items-baseline mb-2">
        <p className="text-sm font-semibold text-ink">🔧 Мастерская</p>
        <Link href="/repair" className="text-xs text-accent hover:underline">
          Открыть →
        </Link>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <RepairChip value={stats.openCount} label="в ремонте сейчас" />
        <RepairChip value={stats.atRiskCount} label="срывают брони" tone="rose" />
        {variant === "warehouse" ? (
          <RepairChip value={stats.newCount} label="ждут оценки" tone="amber" />
        ) : (
          <RepairChip value={stats.noEtaCount} label="без срока возврата" tone="amber" />
        )}
      </div>

      {variant === "technician" && stats.quietCount > 0 && (
        <p className="mt-2 text-xs text-amber">
          {stats.quietCount} {pluralize(stats.quietCount, "карточка", "карточки", "карточек")} без
          записей больше {QUIET_DAYS} дней — по ним никто не поймёт, что происходит.
        </p>
      )}

      {variant === "warehouse" && ready.length > 0 && (
        <div className="mt-2 rounded border border-emerald-border bg-emerald-soft px-3 py-2">
          <p className="text-xs font-semibold text-emerald">
            Починено — вернуть на полку: {ready.length}
          </p>
          <ul className="mt-1 space-y-0.5">
            {ready.slice(0, 3).map((r) => (
              <li key={r.repairId} className="flex justify-between gap-2 text-xs text-ink-2">
                <span className="truncate">{r.title}</span>
                <span className="shrink-0 text-ink-3">{formatDayMonth(r.closedAt)}</span>
              </li>
            ))}
          </ul>
          {ready.length > 3 && (
            <p className="mt-1 text-[11px] text-ink-3">
              и ещё {ready.length - 3} — весь список на экране «Смена»
            </p>
          )}
        </div>
      )}
    </div>
  );
}
