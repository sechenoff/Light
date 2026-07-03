"use client";

import Link from "next/link";
import type { ReactNode } from "react";

export function DayKpiCard({
  eyebrow,
  value,
  sub,
  subTone = "muted",
  href,
}: {
  eyebrow: string;          // «Сегодня» / «Долги» / «Ремонт»
  value: ReactNode;         // «28 500 ₽» или «4 единиц»
  sub?: ReactNode;          // подпись под значением
  subTone?: "muted" | "rose" | "emerald" | "amber";
  href?: string;            // опционально: карточка становится ссылкой
}) {
  const subClass = {
    muted:    "text-ink-3",
    rose:     "text-rose",
    emerald:  "text-emerald",
    amber:    "text-amber",
  }[subTone];

  const content = (
    <>
      <p className="eyebrow">{eyebrow}</p>
      <p className="mono-num text-xl font-semibold text-ink mt-1">{value}</p>
      {sub && <p className={`text-xs mt-1 ${subClass}`}>{sub}</p>}
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        className="block bg-surface border border-border rounded-lg p-3 shadow-xs transition-colors hover:border-accent hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {content}
      </Link>
    );
  }

  return (
    <div className="bg-surface border border-border rounded-lg p-3 shadow-xs">
      {content}
    </div>
  );
}
