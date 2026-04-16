"use client";

import type { SlangAlias } from "./types";

type Props = {
  alias: SlangAlias;
  selected: boolean;
  onClick: () => void;
};

function SourcePill({ source }: { source: string }) {
  const map: Record<string, { cls: string; icon: string; label: string }> = {
    AUTO_LEARNED: { cls: "bg-teal-soft text-teal border-teal-border", icon: "🤖", label: "авто" },
    MANUAL_ADMIN: { cls: "bg-slate-soft text-slate border-slate-border", icon: "✋", label: "вручную" },
    SEED: { cls: "bg-accent-soft text-accent border-[#bfdbfe]", icon: "📦", label: "базовый" },
  };
  const m = map[source] ?? map.SEED;
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border ${m.cls}`}>
      {m.icon} {m.label}
    </span>
  );
}

function stripeClass(source: string) {
  if (source === "AUTO_LEARNED") return "bg-teal";
  if (source === "MANUAL_ADMIN") return "bg-slate";
  return "bg-accent";
}

export function AliasRow({ alias, selected, onClick }: Props) {
  return (
    <div
      onClick={onClick}
      className={[
        "grid gap-2 px-4 py-2.5 border-b border-border text-sm items-center cursor-pointer transition-colors",
        "grid-cols-[3px_1.4fr_20px_1.2fr_80px_90px_28px]",
        selected
          ? "bg-accent-soft shadow-[inset_2px_0_0_theme(colors.accent)]"
          : "hover:bg-surface-2",
      ].join(" ")}
    >
      <span className={`w-[3px] h-7 rounded-sm ${stripeClass(alias.source)}`} />
      <span className="font-mono text-[12.5px] text-ink truncate">{alias.phraseOriginal}</span>
      <span className="text-ink-3 text-center text-[13px]">→</span>
      <div className="min-w-0">
        <p className="font-medium text-ink truncate">{alias.equipment.name}</p>
        <p className="text-[11px] text-ink-3 truncate">{alias.equipment.category}</p>
      </div>
      <span className="mono-num text-xs text-ink-2 text-right">{alias.usageCount}×</span>
      <SourcePill source={alias.source} />
      <button
        onClick={(e) => e.stopPropagation()}
        aria-label="Действия с алиасом"
        className="text-ink-3 hover:text-ink text-base leading-none text-center"
      >
        ⋯
      </button>
    </div>
  );
}
