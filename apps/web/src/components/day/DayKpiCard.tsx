"use client";

import type { ReactNode } from "react";

export function DayKpiCard({
  eyebrow,
  value,
  sub,
  subTone = "muted",
}: {
  eyebrow: string;          // «Сегодня» / «Долги» / «Ремонт»
  value: ReactNode;         // «28 500 ₽» или «4 единиц»
  sub?: ReactNode;          // подпись под значением
  subTone?: "muted" | "rose" | "emerald" | "amber";
}) {
  const subClass = {
    muted:    "text-ink-3",
    rose:     "text-rose",
    emerald:  "text-emerald",
    amber:    "text-amber",
  }[subTone];

  return (
    <div className="bg-surface border border-border rounded-lg p-3 shadow-xs">
      <p className="eyebrow">{eyebrow}</p>
      <p className="mono-num text-xl font-semibold text-ink mt-1">{value}</p>
      {sub && <p className={`text-xs mt-1 ${subClass}`}>{sub}</p>}
    </div>
  );
}
