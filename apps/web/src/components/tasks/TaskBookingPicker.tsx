"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api";
import type { RelatedBookingRef } from "./groupTasks";

// ── Типы ──────────────────────────────────────────────────────────────────────

interface TaskBookingPickerProps {
  /** Текущая привязанная бронь (для отображения выбранного). */
  value: RelatedBookingRef | null;
  /** Вызывается при выборе брони или снятии привязки (null). */
  onChange: (booking: RelatedBookingRef | null) => void;
  disabled?: boolean;
}

interface BookingSearchResponse {
  bookings: RelatedBookingRef[];
}

const SEARCH_DEBOUNCE_MS = 300;
const MIN_QUERY_LEN = 2;

// ── Компонент ─────────────────────────────────────────────────────────────────

/**
 * Опциональная привязка задачи к брони: поиск по названию проекта / имени
 * клиента, выпадающий список, чип выбранной брони с крестиком для снятия.
 * Питается от GET /api/tasks/booking-search (лёгкий lookup, без barcode).
 */
export function TaskBookingPicker({ value, onChange, disabled }: TaskBookingPickerProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RelatedBookingRef[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);

  // Debounced поиск
  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_QUERY_LEN) {
      setResults([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      apiFetch<BookingSearchResponse>(`/api/tasks/booking-search?q=${encodeURIComponent(q)}`)
        .then((data) => {
          if (!cancelled) {
            setResults(data.bookings ?? []);
            setOpen(true);
          }
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  // Закрытие списка по клику вне
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  function handleSelect(booking: RelatedBookingRef) {
    onChange(booking);
    setQuery("");
    setResults([]);
    setOpen(false);
  }

  // Выбранная бронь — показываем чип
  if (value) {
    return (
      <div className="inline-flex items-center gap-2 rounded-md border border-accent-border bg-accent-soft px-2.5 py-1.5 text-[13px] text-accent-bright max-w-full">
        <span aria-hidden>📋</span>
        <span className="truncate">
          {value.projectName} · {value.clientName}
        </span>
        {!disabled && (
          <button
            type="button"
            onClick={() => onChange(null)}
            aria-label="Снять привязку к брони"
            className="text-accent-bright hover:text-rose transition-colors leading-none"
          >
            ✕
          </button>
        )}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        disabled={disabled}
        placeholder="Найти бронь по проекту или клиенту…"
        className="w-full text-[13px] px-3 py-2 border border-border rounded-md bg-surface text-ink placeholder-ink-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft disabled:opacity-50"
      />
      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 bg-surface border border-border rounded-lg shadow-sm max-h-56 overflow-y-auto">
          {loading ? (
            <p className="px-3 py-2 text-[13px] text-ink-3">Поиск…</p>
          ) : results.length === 0 ? (
            <p className="px-3 py-2 text-[13px] text-ink-3 italic">Ничего не найдено</p>
          ) : (
            results.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => handleSelect(b)}
                className="w-full text-left px-3 py-2 hover:bg-surface-muted transition-colors border-b border-border last:border-0"
              >
                <span className="block text-[13px] text-ink font-medium truncate">
                  {b.projectName}
                </span>
                <span className="block text-[11px] text-ink-3 truncate">{b.clientName}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
