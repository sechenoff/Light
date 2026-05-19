"use client";

/**
 * Shared canon "в разработке" panel used by the Task 5.2 step placeholders
 * (IssueChecklist / ReturnChecklist / SummaryStep). Real implementations land
 * in Tasks 6/7 — this only keeps the build green and the flow navigable.
 */

export function PlaceholderPanel({
  eyebrow,
  title,
  note,
  onBack,
  backLabel = "Назад",
}: {
  eyebrow: string;
  title: string;
  note: string;
  onBack: () => void;
  backLabel?: string;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-[420px] rounded-lg border border-dashed border-border-strong bg-surface p-6 text-center shadow-xs">
        <p className="eyebrow mb-1">{eyebrow}</p>
        <h2 className="text-[17px] font-semibold tracking-tight text-ink">
          {title}
        </h2>
        <p className="mt-2 text-sm text-ink-2">{note}</p>
        <div className="mt-3 inline-flex items-center rounded border border-amber-border bg-amber-soft px-2.5 py-1 text-xs font-semibold text-amber">
          В разработке
        </div>
        <div className="mt-6">
          <button
            type="button"
            onClick={onBack}
            className="rounded border border-border bg-surface px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-surface-muted"
          >
            ← {backLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
