"use client";

import type { ImportSession } from "./types";

const STATUS_BADGES: Record<string, { label: string; cls: string }> = {
  PARSING:   { label: "Загружен",    cls: "bg-amber-soft text-amber border-amber-border" },
  MATCHING:  { label: "Анализ",      cls: "bg-accent-soft text-accent border-accent-border" },
  REVIEW:    { label: "На проверке", cls: "bg-accent-soft text-accent border-accent-border" },
  APPLYING:  { label: "Применяется", cls: "bg-amber-soft text-amber border-amber-border" },
  COMPLETED: { label: "Завершён",    cls: "bg-ok-soft text-ok border-emerald-border" },
  EXPIRED:   { label: "Истёк",       cls: "bg-surface-2 text-ink-3 border-border" },
};

function statusBadge(status: string) {
  const entry = STATUS_BADGES[status] ?? { label: status, cls: "bg-surface-2 text-ink-3 border-border" };
  return (
    <span className={`inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-medium ${entry.cls}`}>
      {entry.label}
    </span>
  );
}

function typeIcon(type: string) {
  return type === "COMPETITOR_IMPORT" ? "📊" : "📦";
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type Props = {
  sessions: ImportSession[];
  onSelect: (session: ImportSession) => void;
};

export function SessionHistory({ sessions, onSelect }: Props) {
  if (sessions.length === 0) return null;

  return (
    <div>
      <h2 className="text-sm font-semibold text-ink mb-3">История импортов</h2>
      <div className="rounded-xl border border-border bg-surface overflow-hidden">
        <div className="divide-y divide-border">
          {sessions.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelect(s)}
              className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface-2 transition-colors"
            >
              {/* Icon */}
              <span className="shrink-0 text-base" aria-hidden="true">
                {typeIcon(s.type)}
              </span>

              {/* Main info */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-ink truncate">{s.fileName}</span>
                  {statusBadge(s.status)}
                </div>
                <div className="mt-0.5 text-xs text-ink-3 flex items-center gap-2 flex-wrap">
                  <span>{formatDate(s.createdAt)}</span>
                  {s.competitorName && (
                    <>
                      <span className="text-border">·</span>
                      <span>{s.competitorName}</span>
                    </>
                  )}
                  <span className="text-border">·</span>
                  <span>{s.totalRows} строк</span>
                  {s.appliedCount > 0 && (
                    <>
                      <span className="text-border">·</span>
                      <span className="text-ok">{s.appliedCount} применено</span>
                    </>
                  )}
                </div>
              </div>

              {/* Arrow */}
              <span className="shrink-0 text-ink-3 text-sm" aria-hidden="true">→</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
