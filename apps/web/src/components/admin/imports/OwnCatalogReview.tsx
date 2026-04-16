"use client";

import { useState } from "react";
import { ChangeCard } from "./ChangeCard";
import type { AnalyzeResultOwn, ChangeGroup, ImportRow } from "./types";

type GroupType = ChangeGroup["type"];

const GROUP_META: Record<GroupType, { icon: string; label: string }> = {
  PRICE_CHANGE:  { icon: "💰", label: "Ценовые изменения" },
  QTY_CHANGE:    { icon: "📦", label: "Изменения количества" },
  NEW_ITEM:      { icon: "✨", label: "Новые позиции" },
  REMOVED_ITEM:  { icon: "🗑", label: "Удалённые позиции" },
};

type Props = {
  result: AnalyzeResultOwn;
  fileName: string;
  onAccept: (rowId: string) => void;
  onReject: (rowId: string) => void;
  onRebind: (rowId: string) => void;
  onBulkAccept: (action?: GroupType) => void;
  onBulkReject: (action?: GroupType) => void;
  onApply: () => void;
  onExport: () => void;
  applying: boolean;
};

export function OwnCatalogReview({
  result,
  fileName,
  onAccept,
  onReject,
  onRebind,
  onBulkAccept,
  onBulkReject,
  onApply,
  onExport,
  applying,
}: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const allRows = result.groups.flatMap((g) => g.rows);
  const acceptedCount = allRows.filter((r) => r.status === "ACCEPTED").length;
  const rejectedCount = allRows.filter((r) => r.status === "REJECTED").length;
  const pendingCount = allRows.length - acceptedCount - rejectedCount;

  const toggleGroup = (type: string) =>
    setCollapsed((prev) => ({ ...prev, [type]: !prev[type] }));

  return (
    <div>
      {/* AI summary */}
      <div className="mb-6 rounded-lg border border-indigo-border bg-indigo-soft px-4 py-3">
        <div className="eyebrow mb-1 text-indigo">🤖 AI-анализ</div>
        <p className="text-sm text-ink-1">{result.summary}</p>
      </div>

      {/* Итоговые чипсы по группам */}
      <div className="mb-5 flex flex-wrap gap-2">
        {result.groups.map((g) => {
          const meta = GROUP_META[g.type];
          return (
            <span
              key={g.type}
              className="inline-flex items-center gap-1.5 rounded border border-border bg-surface px-3 py-1 text-sm text-ink-2"
            >
              {meta.icon} {meta.label}
              <span className="ml-1 rounded bg-surface-2 px-1.5 text-xs font-medium text-ink-1">
                {g.count}
              </span>
            </span>
          );
        })}
        {result.noChangeCount > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded border border-border bg-surface px-3 py-1 text-sm text-ink-3">
            ≡ Без изменений
            <span className="ml-1 rounded bg-surface-2 px-1.5 text-xs font-medium text-ink-2">
              {result.noChangeCount}
            </span>
          </span>
        )}
      </div>

      {/* Панель действий */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3">
        <div className="flex items-center gap-4 text-sm">
          <span className="text-ok">
            <span className="font-medium">{acceptedCount}</span> принято
          </span>
          <span className="text-rose">
            <span className="font-medium">{rejectedCount}</span> отклонено
          </span>
          <span className="text-ink-3">
            <span className="font-medium">{pendingCount}</span> ожидает
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onBulkAccept()}
            className="rounded border border-ok-border bg-ok-soft px-3 py-1.5 text-xs font-medium text-ok hover:bg-ok hover:text-white"
          >
            Принять все
          </button>
          <button
            type="button"
            onClick={() => onBulkReject()}
            className="rounded border border-rose-border bg-rose-soft px-3 py-1.5 text-xs font-medium text-rose hover:bg-rose hover:text-white"
          >
            Отклонить все
          </button>
          <button
            type="button"
            onClick={onExport}
            className="rounded border border-border px-3 py-1.5 text-xs font-medium text-ink-2 hover:bg-surface-2"
          >
            Экспорт XLSX
          </button>
        </div>
      </div>

      {/* Группы */}
      <div className="space-y-4">
        {result.groups.map((group) => {
          const meta = GROUP_META[group.type];
          const isCollapsed = collapsed[group.type];
          return (
            <div key={group.type} className="rounded-lg border border-border">
              {/* Заголовок группы */}
              <div className="flex items-center justify-between px-4 py-3">
                <button
                  type="button"
                  onClick={() => toggleGroup(group.type)}
                  className="flex items-center gap-2 text-sm font-medium text-ink-1"
                >
                  <span className={`transition-transform ${isCollapsed ? "" : "rotate-90"}`}>▶</span>
                  {meta.icon} {meta.label}
                  <span className="rounded bg-surface-2 px-2 py-0.5 text-xs font-medium text-ink-2">
                    {group.count}
                  </span>
                </button>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => onBulkAccept(group.type)}
                    className="rounded border border-ok-border px-2 py-1 text-xs text-ok hover:bg-ok-soft"
                  >
                    Принять все
                  </button>
                  <button
                    type="button"
                    onClick={() => onBulkReject(group.type)}
                    className="rounded border border-rose-border px-2 py-1 text-xs text-rose hover:bg-rose-soft"
                  >
                    Отклонить все
                  </button>
                </div>
              </div>

              {/* Строки */}
              {!isCollapsed && (
                <div className="space-y-2 border-t border-border px-4 py-3">
                  {group.rows.map((row) => (
                    <ChangeCard
                      key={row.id}
                      row={row}
                      onAccept={() => onAccept(row.id)}
                      onReject={() => onReject(row.id)}
                      onRebind={() => onRebind(row.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="mt-6 flex items-center justify-between border-t border-border pt-4">
        <span className="text-sm text-ink-2">
          Принято: <span className="font-medium text-ink-1">{acceptedCount}</span> из{" "}
          {allRows.length} позиций
        </span>
        <button
          type="button"
          onClick={onApply}
          disabled={applying || acceptedCount === 0}
          className="rounded bg-accent px-5 py-2.5 text-sm font-medium text-white hover:bg-accent-bright disabled:opacity-50"
        >
          {applying ? "Применяем..." : `Применить ${acceptedCount} изменений →`}
        </button>
      </div>
    </div>
  );
}
