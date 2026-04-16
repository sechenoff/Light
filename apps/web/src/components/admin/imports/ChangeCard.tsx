"use client";

import type { ImportRow } from "./types";

type Props = {
  row: ImportRow;
  onAccept: () => void;
  onReject: () => void;
  onRebind: () => void;
};

function matchTag(source: string | null): React.ReactNode {
  if (!source) return null;
  const map: Record<string, { label: string; cls: string }> = {
    exact:         { label: "точное", cls: "bg-ok-soft text-ok border-emerald-border" },
    slang:         { label: "слэнг",  cls: "bg-accent-soft text-accent border-accent-border" },
    fuzzy:         { label: "похожее", cls: "bg-amber-soft text-amber border-amber-border" },
    gemini:        { label: "AI",      cls: "bg-indigo-soft text-indigo border-indigo-border" },
    manual_rebind: { label: "вручную", cls: "bg-ok-soft text-ok border-emerald-border" },
  };
  const entry = map[source] ?? { label: source, cls: "bg-surface text-ink-3 border-border" };
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium ${entry.cls}`}
    >
      {entry.label}
    </span>
  );
}

function deltaChip(row: ImportRow): React.ReactNode {
  if (row.action === "NEW_ITEM") {
    return (
      <span className="inline-flex items-center rounded border border-ok-border bg-ok-soft px-1.5 py-0.5 text-xs font-medium text-ok">
        новая
      </span>
    );
  }
  if (row.action === "REMOVED_ITEM") {
    return (
      <span className="inline-flex items-center rounded border border-rose-border bg-rose-soft px-1.5 py-0.5 text-xs font-medium text-rose">
        удалена
      </span>
    );
  }
  if (row.action === "QTY_CHANGE" && row.oldQty !== null && row.sourceQty !== null) {
    return (
      <span className="inline-flex items-center rounded border border-amber-border bg-amber-soft px-1.5 py-0.5 text-xs font-medium text-amber mono-num">
        {row.oldQty}&nbsp;→&nbsp;{row.sourceQty} шт.
      </span>
    );
  }
  if (row.priceDelta) {
    const delta = parseFloat(row.priceDelta);
    const isPositive = delta > 0;
    const cls = isPositive
      ? "border-rose-border bg-rose-soft text-rose"
      : "border-ok-border bg-ok-soft text-ok";
    const sign = isPositive ? "+" : "";
    const hasAbsolute = row.oldPrice !== null && row.sourcePrice !== null;
    return (
      <span className="inline-flex items-center gap-1.5 flex-wrap">
        {hasAbsolute && (
          <span className="inline-flex items-center text-xs text-ink-2 mono-num">
            {row.oldPrice}&nbsp;₽&nbsp;→&nbsp;{row.sourcePrice}&nbsp;₽
          </span>
        )}
        <span
          className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium mono-num ${cls}`}
        >
          {sign}{row.priceDelta}%
        </span>
      </span>
    );
  }
  return null;
}

export function ChangeCard({ row, onAccept, onReject, onRebind }: Props) {
  const accepted = row.status === "ACCEPTED";
  const rejected = row.status === "REJECTED";

  const bg = accepted
    ? "bg-ok-soft border-emerald-border"
    : rejected
    ? "bg-rose-soft border-rose-border opacity-60"
    : "bg-surface border-border";

  return (
    <div className={`rounded-lg border px-4 py-3 transition-colors ${bg}`}>
      <div className="flex items-start gap-3">
        {/* Основной контент */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-ink">
              {row.equipmentName ?? row.sourceName}
            </span>
            {deltaChip(row)}
            {matchTag(row.matchMethod)}
          </div>
          {row.sourceName !== row.equipmentName && row.equipmentName && (
            <div className="mt-0.5 text-xs text-ink-3">
              Источник: {row.sourceName}
            </div>
          )}
          {row.aiDescription && (
            <div className="mt-1 text-xs text-ink-2">{row.aiDescription}</div>
          )}
        </div>

        {/* Кнопки действий */}
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onAccept}
            aria-label="Принять"
            className={`rounded px-2 py-1 text-sm transition-colors ${
              accepted
                ? "bg-ok text-white"
                : "border border-border text-ink-2 hover:border-ok hover:bg-ok-soft hover:text-ok"
            }`}
          >
            ✓
          </button>
          <button
            type="button"
            onClick={onReject}
            aria-label="Отклонить"
            className={`rounded px-2 py-1 text-sm transition-colors ${
              rejected
                ? "bg-rose text-white"
                : "border border-border text-ink-2 hover:border-rose hover:bg-rose-soft hover:text-rose"
            }`}
          >
            ✕
          </button>
          <button
            type="button"
            onClick={onRebind}
            aria-label="Перепривязать"
            className="rounded border border-border px-2 py-1 text-sm text-ink-3 hover:border-accent hover:bg-accent-soft hover:text-accent"
          >
            ✎
          </button>
        </div>
      </div>
    </div>
  );
}
