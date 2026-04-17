"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../../lib/api";

type EquipmentResult = {
  equipmentId: string;
  name: string;
  category: string;
  rentalRatePerShift: string;
  availableQuantity: number;
  totalQuantity: number;
};

type Props = {
  startISO: string;
  endISO: string;
  onSelect: (row: EquipmentResult) => void;
};

export function AddEquipmentSearch({ startISO, endISO, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<EquipmentResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounced search
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setOpen(false);
      return;
    }
    const timer = setTimeout(() => {
      let cancelled = false;
      setLoading(true);
      const params = new URLSearchParams({ start: startISO, end: endISO, search: query });
      apiFetch<{ rows: EquipmentResult[] }>(`/api/availability?${params}`)
        .then((res) => {
          if (!cancelled) {
            setResults(res.rows.slice(0, 8));
            setOpen(true);
          }
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      return () => { cancelled = true; };
    }, 300);
    return () => clearTimeout(timer);
  }, [query, startISO, endISO]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function handleSelect(row: EquipmentResult) {
    onSelect(row);
    setQuery("");
    setResults([]);
    setOpen(false);
    inputRef.current?.focus();
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-2 rounded border border-border bg-surface px-3 py-2 focus-within:border-accent">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0 text-ink-3"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Добавить позицию из каталога..."
          className="flex-1 bg-transparent text-sm text-ink placeholder-ink-3 outline-none"
        />
        {loading && (
          <span className="text-xs text-ink-3">Поиск...</span>
        )}
      </div>

      {open && results.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded border border-border bg-surface shadow-md">
          <ul className="divide-y divide-border">
            {results.map((row) => (
              <li key={row.equipmentId}>
                <button
                  type="button"
                  disabled={row.availableQuantity <= 0}
                  onClick={() => handleSelect(row)}
                  className={[
                    "w-full px-3 py-2 text-left text-sm transition-colors",
                    row.availableQuantity > 0
                      ? "hover:bg-surface-muted text-ink"
                      : "cursor-not-allowed text-ink-3",
                  ].join(" ")}
                >
                  <span className="font-medium">{row.name}</span>
                  <span className="ml-2 text-xs text-ink-3">
                    {row.category} · {row.rentalRatePerShift} ₽/день
                    {row.availableQuantity <= 0
                      ? " · нет в наличии"
                      : ` · ${row.availableQuantity} доступно`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {open && !loading && results.length === 0 && query.trim() && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded border border-border bg-surface px-3 py-2 text-sm text-ink-3 shadow-md">
          Ничего не найдено
        </div>
      )}
    </div>
  );
}
