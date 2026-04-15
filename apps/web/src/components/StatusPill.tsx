"use client";

export type StatusPillVariant =
  | "full"
  | "edit"
  | "view"
  | "limited"
  | "own"
  | "none"
  | "ok"
  | "warn"
  | "info"
  | "alert";

const VARIANT_CLASSES: Record<StatusPillVariant, string> = {
  full:    "bg-emerald-soft text-emerald border-emerald-border",
  edit:    "bg-teal-soft text-teal border-teal-border",
  view:    "bg-slate-soft text-slate border-slate-border",
  limited: "bg-amber-soft text-amber border-amber-border",
  own:     "bg-indigo-soft text-indigo border-indigo-border",
  none:    "bg-surface text-ink-3 border-border",
  ok:      "bg-ok-soft text-ok border-emerald-border",
  warn:    "bg-warn-soft text-warn border-amber-border",
  info:    "bg-accent-soft text-accent border-accent-border",
  alert:   "bg-rose-soft text-rose border-rose-border",
};

export function StatusPill({
  variant,
  label,
  className = "",
}: {
  variant: StatusPillVariant;
  label: string;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-semibold ${VARIANT_CLASSES[variant]} ${className}`}
    >
      {label}
    </span>
  );
}
