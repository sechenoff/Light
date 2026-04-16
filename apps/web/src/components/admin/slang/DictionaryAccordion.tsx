"use client";

import { useState } from "react";
import type { DictionaryGroup, SourceFilterKey } from "./types";
import { EquipmentRow } from "./EquipmentRow";

type Props = {
  groups: DictionaryGroup[];
  onDelete: (aliasId: string) => void;
  onRebind: (oldId: string, newEqId: string, newEqName: string) => void;
  onExport: () => void;
};

const FILTERS: { key: SourceFilterKey; label: string; icon: string }[] = [
  { key: "all", label: "Все", icon: "" },
  { key: "auto", label: "Авто", icon: "🤖" },
  { key: "manual", label: "Вручную", icon: "✋" },
  { key: "seed", label: "Базовый", icon: "📦" },
];

const SOURCE_MAP: Record<string, SourceFilterKey> = {
  AUTO_LEARNED: "auto",
  MANUAL_ADMIN: "manual",
  SEED: "seed",
};

function groupMatchesSource(group: DictionaryGroup, filter: SourceFilterKey): boolean {
  if (filter === "all") return true;
  return group.aliases.some((a) => SOURCE_MAP[a.source] === filter);
}

function groupMatchesSearch(group: DictionaryGroup, q: string): boolean {
  if (!q) return true;
  const lower = q.toLowerCase();
  if (group.equipment.name.toLowerCase().includes(lower)) return true;
  return group.aliases.some(
    (a) =>
      a.phraseOriginal.toLowerCase().includes(lower) ||
      a.phraseNormalized.toLowerCase().includes(lower),
  );
}

export function DictionaryAccordion({ groups, onDelete, onRebind, onExport }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilterKey>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("");

  // Unique categories
  const categories = Array.from(new Set(groups.map((g) => g.equipment.category))).sort();

  // Source filter counts — count groups (not aliases) that have at least one alias of that source
  const sourceCounts: Record<SourceFilterKey, number> = {
    all: groups.length,
    auto: groups.filter((g) => groupMatchesSource(g, "auto")).length,
    manual: groups.filter((g) => groupMatchesSource(g, "manual")).length,
    seed: groups.filter((g) => groupMatchesSource(g, "seed")).length,
  };

  const filtered = groups.filter((g) => {
    if (!groupMatchesSource(g, sourceFilter)) return false;
    if (categoryFilter && g.equipment.category !== categoryFilter) return false;
    if (!groupMatchesSearch(g, search.trim())) return false;
    return true;
  });

  function handleToggle(id: string) {
    setExpandedId((prev) => (prev === id ? null : id));
  }

  const searchActive = search.trim().length > 0;

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-wrap gap-2.5 mb-3 items-center">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Поиск по прибору или фразе…"
          className="flex-1 min-w-[220px] h-9 px-3 border border-border rounded-lg text-sm text-ink bg-surface placeholder-ink-3 focus:outline-none focus:border-accent-bright"
        />

        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="h-9 px-3 border border-border rounded-lg text-[12.5px] text-ink bg-surface cursor-pointer focus:outline-none focus:border-accent-bright"
        >
          <option value="">Все категории</option>
          {categories.map((cat) => (
            <option key={cat} value={cat}>
              {cat}
            </option>
          ))}
        </select>

        {/* Source filter */}
        <div className="flex gap-px p-0.5 bg-surface-muted border border-border rounded-lg">
          {FILTERS.map(({ key, label, icon }) => {
            const active = sourceFilter === key;
            const count = sourceCounts[key];
            return (
              <button
                key={key}
                onClick={() => setSourceFilter(key)}
                className={[
                  "px-3 py-1.5 text-xs rounded cursor-pointer flex items-center gap-1 transition-colors",
                  active
                    ? "bg-surface text-ink font-semibold shadow-xs"
                    : "text-ink-2 hover:text-ink",
                ].join(" ")}
              >
                {icon && <span>{icon}</span>}
                {label}
                {count > 0 && (
                  <span
                    className={`font-mono text-[10px] ${
                      active ? "text-accent" : "text-ink-3"
                    }`}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <button
          onClick={onExport}
          className="px-3 py-1.5 text-xs font-medium border border-border rounded-lg bg-surface text-ink-2 hover:text-ink hover:border-ink-3 transition-colors flex items-center gap-1.5"
        >
          ↓ Экспорт
        </button>
      </div>

      {/* Results info */}
      <div className="text-[12px] text-ink-2 mb-2.5 flex justify-between items-center">
        {searchActive ? (
          <span>
            Найдено <span className="font-mono text-ink">{filtered.length}</span> приборов по запросу «{search.trim()}»
          </span>
        ) : (
          <span>
            Показано <span className="font-mono text-ink">{filtered.length}</span> приборов · отсортировано по количеству фраз
          </span>
        )}
      </div>

      {/* Table */}
      <div className="bg-surface border border-border rounded-lg overflow-hidden">
        {/* Table header */}
        <div
          className="grid gap-3 px-4 py-2 bg-surface-muted border-b border-border eyebrow text-ink-3"
          style={{ gridTemplateColumns: "minmax(0,1fr) 120px 80px 80px 36px" }}
        >
          <span>Прибор</span>
          <span>Категория</span>
          <span className="text-right">Фраз</span>
          <span className="text-right">Исп.</span>
          <span />
        </div>

        {/* Empty state */}
        {groups.length === 0 && (
          <div className="py-10 text-center text-sm text-ink-3">Словарь пуст</div>
        )}
        {groups.length > 0 && filtered.length === 0 && (
          <div className="py-10 text-center text-sm text-ink-3">Ничего не найдено</div>
        )}

        {/* Rows */}
        {filtered.map((group) => (
          <EquipmentRow
            key={group.equipment.id}
            group={group}
            expanded={expandedId === group.equipment.id}
            onToggle={() => handleToggle(group.equipment.id)}
            onDeletePhrase={onDelete}
            onRebindPhrase={onRebind}
          />
        ))}

        {/* Footer */}
        <div className="px-4 py-2.5 border-t border-border bg-surface-muted flex justify-between items-center text-[11.5px] text-ink-3">
          <span>
            Показано {filtered.length} из {groups.length}
          </span>
          <div className="flex gap-3.5">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-accent" />
              Базовый
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-teal" />
              Авто
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-slate" />
              Вручную
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
