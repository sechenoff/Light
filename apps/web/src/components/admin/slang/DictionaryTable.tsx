"use client";

import { useState } from "react";
import type { SlangAlias, SourceFilterKey } from "./types";
import { AliasRow } from "./AliasRow";

type Props = {
  aliases: SlangAlias[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
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

function filterAliases(aliases: SlangAlias[], filter: SourceFilterKey, search: string): SlangAlias[] {
  let result = aliases;
  if (filter !== "all") {
    result = result.filter((a) => SOURCE_MAP[a.source] === filter);
  }
  if (search.trim()) {
    const q = search.toLowerCase();
    result = result.filter(
      (a) =>
        a.phraseOriginal.toLowerCase().includes(q) ||
        a.phraseNormalized.toLowerCase().includes(q) ||
        a.equipment.name.toLowerCase().includes(q),
    );
  }
  return result;
}

export function DictionaryTable({ aliases, selectedId, onSelect, onExport }: Props) {
  const [filter, setFilter] = useState<SourceFilterKey>("all");
  const [search, setSearch] = useState("");

  const counts: Record<SourceFilterKey, number> = {
    all: aliases.length,
    auto: aliases.filter((a) => a.source === "AUTO_LEARNED").length,
    manual: aliases.filter((a) => a.source === "MANUAL_ADMIN").length,
    seed: aliases.filter((a) => a.source === "SEED").length,
  };

  const filtered = filterAliases(aliases, filter, search);

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-[15px] font-semibold text-ink">Словарь</h2>
      </div>

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3 mb-3 items-start justify-between">
        <div className="flex gap-1 p-1 bg-surface border border-border rounded-lg w-fit">
          {FILTERS.map(({ key, label, icon }) => {
            const active = filter === key;
            return (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={[
                  "px-3 py-1.5 text-xs rounded cursor-pointer flex items-center gap-1.5 transition-colors",
                  active
                    ? "bg-surface-2 text-ink font-medium shadow-xs"
                    : "text-ink-2 hover:text-ink",
                ].join(" ")}
              >
                {icon && <span>{icon}</span>}
                {label}
                <span
                  className={`mono-num text-[10px] px-1.5 py-0.5 rounded-full ${
                    active ? "bg-accent-soft text-accent" : "bg-surface-2 text-ink-3"
                  }`}
                >
                  {counts[key]}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по фразе или оборудованию…"
            className="border border-border rounded-lg px-3 py-1.5 text-sm text-ink bg-surface placeholder-ink-3 focus:outline-none focus:border-accent-bright w-64"
          />
          <button
            onClick={onExport}
            className="px-3 py-1.5 text-xs font-medium border border-border rounded-lg bg-surface text-ink-2 hover:text-ink hover:border-ink-3 transition-colors flex items-center gap-1.5"
          >
            ↓ Экспорт
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="bg-surface border border-border rounded-lg overflow-hidden">
        <div className="grid gap-2 px-4 py-2 border-b border-border bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3 font-semibold grid-cols-[3px_1.4fr_20px_1.2fr_80px_90px_28px]">
          <span />
          <span>Фраза</span>
          <span />
          <span>Оборудование</span>
          <span className="text-right">Исп.</span>
          <span>Источник</span>
          <span />
        </div>

        {filtered.length === 0 && (
          <div className="py-10 text-center text-sm text-ink-3">
            {search ? "Ничего не найдено" : "Словарь пуст"}
          </div>
        )}

        {filtered.map((alias) => (
          <AliasRow
            key={alias.id}
            alias={alias}
            selected={alias.id === selectedId}
            onClick={() => onSelect(alias.id === selectedId ? null : alias.id)}
          />
        ))}
      </div>

      {/* Legend */}
      <div className="flex gap-4 mt-3 text-[11px] text-ink-3">
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-teal" />
          Авто-обучение
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-slate" />
          Вручную
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-accent" />
          Базовый
        </div>
      </div>
    </div>
  );
}
