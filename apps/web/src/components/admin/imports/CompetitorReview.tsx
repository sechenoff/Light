"use client";

import { useState } from "react";
import { UnmatchedSection } from "./UnmatchedSection";
import type { AnalyzeResultCompetitor, ComparisonRow, DeltaDirection } from "./types";

type Props = {
  result: AnalyzeResultCompetitor;
  competitorName: string;
  fileName: string;
  onRebind: (rowId: string) => void;
  onExport: () => void;
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

function getDeltaDirection(delta: number): DeltaDirection {
  if (delta < -5) return "cheaper";
  if (delta > 5) return "expensive";
  return "parity";
}

function DeltaChip({ delta }: { delta: number }) {
  const dir = getDeltaDirection(delta);
  const sign = delta > 0 ? "+" : "";
  const cls =
    dir === "cheaper"
      ? "border-ok-border bg-ok-soft text-ok"
      : dir === "expensive"
      ? "border-rose-border bg-rose-soft text-rose"
      : "border-border bg-surface text-ink-3";
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium mono-num ${cls}`}>
      {sign}{delta.toFixed(1)}%
    </span>
  );
}

type FilterValue = "all" | DeltaDirection;

const FILTER_LABELS: Record<FilterValue, string> = {
  all:       "Все",
  cheaper:   "Мы дешевле",
  expensive: "Мы дороже",
  parity:    "Паритет",
};

export function CompetitorReview({ result, competitorName, fileName, onRebind, onExport }: Props) {
  const [filter, setFilter] = useState<FilterValue>("all");
  const [search, setSearch] = useState("");

  const { matched, unmatched, kpis } = result.comparison;

  const filteredRows = matched.filter((row) => {
    if (filter !== "all" && getDeltaDirection(row.deltaPercent) !== filter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        row.equipmentName.toLowerCase().includes(q) ||
        row.sourceName.toLowerCase().includes(q) ||
        row.equipmentCategory.toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <div>
      {/* AI summary */}
      <div className="mb-6 rounded-lg border border-indigo-border bg-indigo-soft px-4 py-3">
        <div className="eyebrow mb-1 text-indigo">🤖 AI-анализ</div>
        <p className="text-sm text-ink-1">{result.summary}</p>
      </div>

      {/* KPI карточки */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-lg border border-accent-border bg-accent-soft px-4 py-3 text-center">
          <div className="eyebrow mb-1 text-accent">Сопоставлено</div>
          <div className="text-2xl font-semibold text-ink-1 mono-num">{kpis.matchedCount}</div>
          <div className="text-xs text-ink-3">из {kpis.totalCount}</div>
        </div>
        <div className="rounded-lg border border-ok-border bg-ok-soft px-4 py-3 text-center">
          <div className="eyebrow mb-1 text-ok">Мы дешевле</div>
          <div className="text-2xl font-semibold text-ink-1 mono-num">{kpis.cheaperCount}</div>
          <div className="text-xs text-ink-3">&gt;5%</div>
        </div>
        <div className="rounded-lg border border-rose-border bg-rose-soft px-4 py-3 text-center">
          <div className="eyebrow mb-1 text-rose">Мы дороже</div>
          <div className="text-2xl font-semibold text-ink-1 mono-num">{kpis.expensiveCount}</div>
          <div className="text-xs text-ink-3">&gt;5%</div>
        </div>
        <div className="rounded-lg border border-border bg-surface px-4 py-3 text-center">
          <div className="eyebrow mb-1 text-ink-3">Паритет ±5%</div>
          <div className="text-2xl font-semibold text-ink-1 mono-num">{kpis.parityCount}</div>
          <div className="text-xs text-ink-3">±5%</div>
        </div>
      </div>

      {/* Фильтры и поиск */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-1">
          {(Object.keys(FILTER_LABELS) as FilterValue[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                filter === f
                  ? "border-accent bg-accent text-white"
                  : "border-border bg-surface text-ink-2 hover:border-accent hover:bg-accent-soft hover:text-accent"
              }`}
            >
              {FILTER_LABELS[f]}
            </button>
          ))}
        </div>
        <div className="flex flex-1 items-center gap-2">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск..."
            className="min-w-0 flex-1 rounded border border-border bg-surface px-3 py-1.5 text-sm text-ink-1 focus:border-accent focus:outline-none"
          />
          <button
            type="button"
            onClick={onExport}
            className="shrink-0 rounded border border-border px-3 py-1.5 text-xs font-medium text-ink-2 hover:bg-surface-2"
          >
            Экспорт XLSX
          </button>
        </div>
      </div>

      {/* Таблица */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-surface-2">
            <tr>
              <th className="px-3 py-2.5 text-left text-xs font-medium text-ink-3">Наше оборудование</th>
              <th className="px-3 py-2.5 text-left text-xs font-medium text-ink-3">У конкурента</th>
              <th className="px-3 py-2.5 text-right text-xs font-medium text-ink-3">Наша цена</th>
              <th className="px-3 py-2.5 text-right text-xs font-medium text-ink-3">{competitorName}</th>
              <th className="px-3 py-2.5 text-right text-xs font-medium text-ink-3">Разница</th>
              <th className="px-3 py-2.5 text-left text-xs font-medium text-ink-3">Матчинг</th>
              <th className="w-8 px-3 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filteredRows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-sm text-ink-3">
                  Нет позиций по выбранным фильтрам
                </td>
              </tr>
            ) : (
              filteredRows.map((row: ComparisonRow) => (
                <tr key={row.id} className="bg-surface hover:bg-surface-2">
                  <td className="px-3 py-2.5">
                    <div className="font-medium text-ink-1">{row.equipmentName}</div>
                    <div className="text-xs text-ink-3">{row.equipmentCategory}</div>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="italic text-ink-2">{row.sourceName}</span>
                  </td>
                  <td className="px-3 py-2.5 text-right mono-num text-ink-1">{row.ourPrice} ₽</td>
                  <td className="px-3 py-2.5 text-right mono-num text-ink-2">{row.competitorPrice} ₽</td>
                  <td className="px-3 py-2.5 text-right">
                    <DeltaChip delta={row.deltaPercent} />
                  </td>
                  <td className="px-3 py-2.5">
                    {matchTag(row.matchSource)}
                    {row.matchConfidence !== null && (
                      <span className="ml-1 text-xs text-ink-3 mono-num">
                        {Math.round(row.matchConfidence * 100)}%
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <button
                      type="button"
                      onClick={() => onRebind(row.id)}
                      aria-label="Перепривязать"
                      className="text-ink-3 hover:text-accent"
                    >
                      ✎
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Несопоставленные */}
      <UnmatchedSection rows={unmatched} onRebind={onRebind} />

      {/* Footer */}
      <div className="mt-6 flex items-center justify-between border-t border-border pt-4 text-sm text-ink-2">
        <span>
          Сопоставлено:{" "}
          <span className="font-medium text-ink-1 mono-num">{kpis.matchedCount}</span> из{" "}
          <span className="mono-num">{kpis.totalCount}</span>
        </span>
        <span>
          Средняя разница:{" "}
          <span className={`font-medium mono-num ${kpis.avgDeltaPercent < 0 ? "text-ok" : kpis.avgDeltaPercent > 0 ? "text-rose" : "text-ink-2"}`}>
            {kpis.avgDeltaPercent > 0 ? "+" : ""}{kpis.avgDeltaPercent.toFixed(1)}%
          </span>
        </span>
      </div>
    </div>
  );
}
