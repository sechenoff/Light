"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatMoneyRub } from "../../../lib/format";
import type { AvailabilityRow } from "./types";

type QuickSearchBarProps = {
  searchCatalog: (query: string) => Promise<AvailabilityRow[]>;
  onSelect: (equipment: AvailabilityRow) => void;
  disabled?: boolean;
};

export function QuickSearchBar({ searchCatalog, onSelect, disabled }: QuickSearchBarProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AvailabilityRow[]>([]);
  const [focusIdx, setFocusIdx] = useState(-1);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const runSearch = useCallback(
    (q: string) => {
      if (!q.trim()) {
        setResults([]);
        setFocusIdx(-1);
        return;
      }
      searchCatalog(q).then((rows) => {
        setResults(rows);
        setFocusIdx(-1);
      });
    },
    [searchCatalog],
  );

  const handleChange = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSearch(value), 300);
  };

  const handleSelect = (row: AvailabilityRow) => {
    onSelect(row);
    setQuery("");
    setResults([]);
    setFocusIdx(-1);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusIdx((prev) => Math.min(prev + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusIdx((prev) => Math.max(prev - 1, -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (focusIdx >= 0 && focusIdx < results.length) {
        handleSelect(results[focusIdx]);
      }
    } else if (e.key === "Escape") {
      setQuery("");
      setResults([]);
      setFocusIdx(-1);
    }
  };

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return (
    <div className="relative">
      <div className="relative">
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3 text-sm select-none opacity-40" aria-hidden="true">
          🔍
        </span>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Найти и добавить прибор..."
          disabled={disabled}
          className="w-full rounded-md border border-border bg-surface py-2 pl-8 pr-3 text-xs text-ink placeholder:text-ink-3 focus:border-accent-bright focus:outline-none disabled:opacity-50"
        />
      </div>

      {results.length > 0 && (
        <ul className="absolute left-0 right-0 z-20 mt-1 max-h-48 overflow-y-auto rounded-md border border-border bg-surface shadow-xs">
          {results.map((row, idx) => (
            <li key={row.equipmentId}>
              <button
                type="button"
                onClick={() => handleSelect(row)}
                className={
                  idx === focusIdx
                    ? "flex w-full items-center justify-between gap-2 border-l-2 border-accent-bright bg-accent-soft px-3 py-2 text-left text-xs"
                    : "flex w-full items-center justify-between gap-2 border-l-2 border-transparent px-3 py-2 text-left text-xs hover:bg-accent-soft hover:border-accent-bright"
                }
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-ink">{row.name}</span>
                  <span className="text-[10.5px] text-ink-3">
                    {row.category} · {row.availableQuantity} шт.
                  </span>
                </span>
                <span className="shrink-0 font-mono text-[11px] text-ink-2">
                  {formatMoneyRub(row.rentalRatePerShift)} ₽/день
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {query.trim() && results.length === 0 && (
        <div className="absolute left-0 right-0 z-20 mt-1 rounded-md border border-border bg-surface px-3 py-3 text-center text-xs text-ink-3 shadow-xs">
          Ничего не найдено
        </div>
      )}
    </div>
  );
}
