"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../../lib/api";
import type { AvailabilityRow } from "./types";

type Props = {
  pickupISO: string;
  returnISO: string;
  placeholder?: string;
  initialQuery?: string;
  onSelect: (row: AvailabilityRow) => void;
  onClose: () => void;
};

export function CatalogSearchPopover({
  pickupISO,
  returnISO,
  placeholder = "Поиск в каталоге...",
  initialQuery = "",
  onSelect,
  onClose,
}: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<AvailabilityRow[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Trigger search on initial query
  useEffect(() => {
    if (initialQuery) {
      doSearch(initialQuery);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced search
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      doSearch(query);
    }, 300);
    return () => clearTimeout(timer);
  }, [query, pickupISO, returnISO]);

  function doSearch(q: string) {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({ start: pickupISO, end: returnISO, search: q });
    apiFetch<{ rows: AvailabilityRow[] }>(`/api/availability?${params}`)
      .then((res) => {
        if (!cancelled) setResults(res.rows.slice(0, 8));
      })
      .catch(() => {
        if (!cancelled) setResults([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }

  return (
    <div className="rounded-md border border-border bg-surface shadow-xs">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          className="flex-1 bg-transparent text-[13px] text-ink placeholder-ink-3 outline-none"
        />
        <button
          type="button"
          onClick={onClose}
          className="text-[12px] text-ink-3 hover:text-ink"
        >
          Закрыть
        </button>
      </div>

      {loading && (
        <div className="px-3 py-2 text-[12px] text-ink-3">Поиск...</div>
      )}

      {!loading && results.length === 0 && query.trim() && (
        <div className="px-3 py-2 text-[12px] text-ink-3">Ничего не найдено</div>
      )}

      {results.length > 0 && (
        <ul className="divide-y divide-border">
          {results.map((row) => (
            <li key={row.equipmentId}>
              <button
                type="button"
                disabled={row.availableQuantity <= 0}
                onClick={() => onSelect(row)}
                className={[
                  "w-full px-3 py-2 text-left text-[13px] transition-colors",
                  row.availableQuantity > 0
                    ? "hover:bg-surface-muted text-ink"
                    : "text-ink-3 cursor-not-allowed",
                ].join(" ")}
              >
                <span className="font-medium">{row.name}</span>
                <span className="ml-2 text-[11px] text-ink-3">
                  {row.category} · {row.rentalRatePerShift} ₽/день
                  {row.availableQuantity <= 0 ? " · нет в наличии" : ` · ${row.availableQuantity} доступно`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
