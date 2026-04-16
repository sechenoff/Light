"use client";

import type { SlangStats } from "./types";

type Props = { stats: SlangStats | null };

function KpiCard({
  eyebrow,
  value,
  hint,
  valueClassName = "",
  cardClassName = "",
}: {
  eyebrow: string;
  value: string | number;
  hint: string;
  valueClassName?: string;
  cardClassName?: string;
}) {
  return (
    <div className={`bg-surface border border-border rounded-lg p-3 ${cardClassName}`}>
      <p className="eyebrow">{eyebrow}</p>
      <p className={`mono-num text-xl font-medium mt-0.5 ${valueClassName || "text-ink"}`}>
        {value}
      </p>
      <p className="text-xs text-ink-2 mt-0.5">{hint}</p>
    </div>
  );
}

export function SlangKpiCards({ stats }: Props) {
  if (!stats) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="bg-surface border border-border rounded-lg p-3 animate-pulse">
            <div className="h-3 w-16 bg-surface-muted rounded mb-2" />
            <div className="h-6 w-10 bg-surface-muted rounded mb-1" />
            <div className="h-3 w-24 bg-surface-muted rounded" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
      <KpiCard eyebrow="Всего связей" value={stats.totalAliases} hint="фраз → оборудование" />
      <KpiCard
        eyebrow="Авто-обучение"
        value={`+${stats.autoLearnedThisWeek}`}
        hint="за последние 7 дней"
        valueClassName="text-teal"
      />
      <KpiCard
        eyebrow="На проверку"
        value={stats.pendingCount}
        hint="AI не уверен"
        cardClassName={stats.pendingCount > 0 ? "border-amber-border bg-amber-soft" : ""}
        valueClassName={stats.pendingCount > 0 ? "text-amber" : "text-ink"}
      />
      <KpiCard
        eyebrow="Точность"
        value={`${stats.accuracyPercent}%`}
        hint="фраз распознаётся сразу"
        valueClassName="text-emerald"
      />
    </div>
  );
}
