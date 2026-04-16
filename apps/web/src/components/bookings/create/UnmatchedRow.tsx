"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AvailabilityRow } from "./types";

type Props = {
  itemId: string;
  gafferPhrase: string;
  quantity: number;
  onSelectFromCatalog: (itemId: string, equipment: AvailabilityRow, saveAlias: boolean) => void;
  onQuantityChange: (itemId: string, qty: number) => void;
  onDelete: (itemId: string) => void;
  searchCatalog: (query: string) => Promise<AvailabilityRow[]>;
};

export function UnmatchedRow({
  itemId,
  gafferPhrase,
  quantity,
  onSelectFromCatalog,
  onQuantityChange,
  onDelete,
  searchCatalog,
}: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AvailabilityRow[]>([]);
  const [focusIdx, setFocusIdx] = useState(-1);
  const [saveAlias, setSaveAlias] = useState(true);
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

  const handleQueryChange = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSearch(value), 250);
  };

  const handleSelect = (row: AvailabilityRow) => {
    onSelectFromCatalog(itemId, row, saveAlias);
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
    <div className="border-b border-border last:border-b-0">
      {/* Main row */}
      <div className="grid grid-cols-[6px_1fr_72px_90px_104px_24px] items-center gap-x-2 py-2 pr-2">
        {/* Red left stripe */}
        <div className="h-full w-[6px] self-stretch rounded-sm bg-rose" aria-hidden="true" />

        {/* Name + subtitle */}
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-ink">«{gafferPhrase}»</div>
          <div className="text-xs text-rose">не в каталоге</div>
        </div>

        {/* Quantity input */}
        <input
          type="number"
          min={1}
          value={quantity}
          onChange={(e) => onQuantityChange(itemId, Number(e.target.value))}
          className="w-full rounded border border-border bg-surface px-2 py-1 text-sm text-ink focus:border-accent focus:outline-none"
        />

        {/* Price — dash */}
        <div className="text-right text-sm text-ink-3">—</div>

        {/* Total — dash */}
        <div className="text-right text-sm text-ink-3">—</div>

        {/* Delete */}
        <button
          type="button"
          aria-label="Удалить позицию"
          onClick={() => onDelete(itemId)}
          className="flex items-center justify-center rounded p-0.5 text-ink-3 hover:bg-rose-soft hover:text-rose"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Expansion row — catalog search */}
      <div className="grid grid-cols-[6px_1fr] pb-3">
        {/* Red stripe continuation */}
        <div className="h-full w-[6px] rounded-sm bg-rose" aria-hidden="true" />

        <div className="pl-2 pr-2">
          <div className="mb-2 text-xs font-semibold text-rose">Найдите позицию в каталоге</div>

          {/* Search input */}
          <div className="relative mb-2">
            <span
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-3 text-sm select-none"
              aria-hidden="true"
            >
              ⌕
            </span>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Поиск по каталогу…"
              className="w-full rounded border border-border bg-surface py-1.5 pl-7 pr-7 text-sm text-ink focus:border-accent focus:outline-none"
            />
            {query && (
              <button
                type="button"
                aria-label="Очистить поиск"
                onClick={() => {
                  setQuery("");
                  setResults([]);
                  setFocusIdx(-1);
                  inputRef.current?.focus();
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </div>

          {/* Results list */}
          {results.length > 0 && (
            <ul className="mb-2 max-h-48 overflow-y-auto rounded border border-border bg-surface shadow-xs">
              {results.map((row, idx) => (
                <li key={row.equipmentId}>
                  <button
                    type="button"
                    onClick={() => handleSelect(row)}
                    className={
                      idx === focusIdx
                        ? "flex w-full items-center justify-between gap-2 border-l-2 border-accent bg-accent-soft px-3 py-2 text-left text-sm"
                        : "flex w-full items-center justify-between gap-2 border-l-2 border-transparent px-3 py-2 text-left text-sm hover:bg-accent-soft hover:border-accent"
                    }
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-ink">{row.name}</span>
                      <span className="text-xs text-ink-3">
                        {row.category} · {row.availableQuantity} шт.
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-xs text-ink-2">
                      {row.rentalRatePerShift} ₽/день
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Footer: save-alias checkbox + keyboard hints */}
          <div className="flex items-center justify-between gap-2">
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-3">
              <input
                type="checkbox"
                checked={saveAlias}
                onChange={(e) => setSaveAlias(e.target.checked)}
                className="rounded border-border"
              />
              <span>
                Запомнить: «{gafferPhrase}»{" "}
                {results[focusIdx]
                  ? `→ ${results[focusIdx].name}`
                  : results.length > 0
                  ? `→ ...`
                  : ""}
              </span>
            </label>
            <span className="shrink-0 text-xs text-ink-3 hidden sm:block">
              <kbd className="rounded border border-border px-1 font-mono">↑↓</kbd>{" "}
              <kbd className="rounded border border-border px-1 font-mono">⏎</kbd>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
