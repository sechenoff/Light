"use client";

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const normalized = status.toUpperCase();
  const cls =
    normalized === "PAID" || normalized === "RECEIVED" || normalized === "RETURNED" || normalized === "CONFIRMED"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : normalized === "PARTIALLY_PAID" || normalized === "PLANNED" || normalized === "ISSUED" || normalized === "DRAFT"
        ? "bg-amber-50 text-amber-700 border-amber-200"
        : normalized === "OVERDUE" || normalized === "CANCELLED"
          ? "bg-rose-50 text-rose-700 border-rose-200"
          : "bg-slate-50 text-slate-700 border-slate-200";
  return <span className={`inline-flex items-center rounded border px-2 py-0.5 text-xs ${cls}`}>{label ?? status}</span>;
}
