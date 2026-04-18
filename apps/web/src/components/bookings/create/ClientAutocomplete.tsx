"use client";

import { useEffect, useRef, useState, useCallback, useId } from "react";
import { apiFetch } from "../../../lib/api";

type Client = {
  id: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  comment?: string | null;
  bookingCount?: number;
  createdAt?: string;
};

type Props = {
  value: string;
  onChange: (name: string) => void;
  readOnly?: boolean;
  placeholder?: string;
  id?: string;
  autoFocus?: boolean;
};

export function ClientAutocomplete({
  value,
  onChange,
  readOnly = false,
  placeholder = "Название компании / заказчика",
  id,
  autoFocus = false,
}: Props) {
  const [options, setOptions] = useState<Client[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const baseId = useId();
  const inputId = id ?? `${baseId}-input`;
  const listId = `${baseId}-list`;

  const fetchOptions = useCallback(async (query: string) => {
    if (!query.trim()) {
      setOptions([]);
      return;
    }
    try {
      const data = await apiFetch<{ clients: Client[] }>(
        `/api/clients?search=${encodeURIComponent(query)}&limit=10`
      );
      setOptions(data.clients);
    } catch {
      setOptions([]);
    }
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    onChange(v);
    setActiveIndex(-1);
    setOpen(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void fetchOptions(v);
    }, 200);
  };

  const handleFocus = () => {
    setOpen(true);
    if (value.trim()) {
      void fetchOptions(value);
    }
  };

  const selectOption = (name: string) => {
    onChange(name);
    setOpen(false);
    setActiveIndex(-1);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const visibleCount = displayItems.length;
    if (!open || visibleCount === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % visibleCount);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + visibleCount) % visibleCount);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex >= 0 && activeIndex < visibleCount) {
        const item = displayItems[activeIndex];
        if (item.type === "existing") {
          selectOption(item.client.name);
        } else {
          // "add new" — just close, keep value
          setOpen(false);
        }
      }
    } else if (e.key === "Escape") {
      setOpen(false);
      setActiveIndex(-1);
    } else if (e.key === "Tab") {
      setOpen(false);
      setActiveIndex(-1);
    }
  };

  // Click outside closes
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
        setActiveIndex(-1);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, []);

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Build display items: existing matches + optional "add new" item
  const hasExactMatch = options.some(
    (o) => o.name.toLowerCase() === value.trim().toLowerCase()
  );
  type DisplayItem =
    | { type: "existing"; client: Client; itemId: string }
    | { type: "add-new"; itemId: string };

  const displayItems: DisplayItem[] = [
    ...options.map((c, i) => ({ type: "existing" as const, client: c, itemId: `${baseId}-opt-${i}` })),
    ...(value.trim() && !hasExactMatch
      ? [{ type: "add-new" as const, itemId: `${baseId}-add` }]
      : []),
  ];

  const showDropdown = open && (displayItems.length > 0);

  if (readOnly) {
    return (
      <input
        id={inputId}
        type="text"
        value={value}
        disabled
        className="w-full rounded border border-border-strong px-3 py-2 text-[13.5px] text-ink bg-surface opacity-60 cursor-not-allowed"
        placeholder={placeholder}
      />
    );
  }

  const activeDescendant =
    activeIndex >= 0 && activeIndex < displayItems.length
      ? displayItems[activeIndex].itemId
      : undefined;

  return (
    <div ref={wrapperRef} className="relative">
      <input
        id={inputId}
        type="text"
        value={value}
        onChange={handleChange}
        onFocus={handleFocus}
        onKeyDown={handleKeyDown}
        autoFocus={autoFocus}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={showDropdown}
        aria-autocomplete="list"
        aria-controls={listId}
        aria-activedescendant={activeDescendant}
        className="w-full rounded border border-border-strong px-3 py-2 text-[13.5px] text-ink bg-surface focus:outline-none focus:border-accent-bright focus:ring-[3px] focus:ring-accent-soft"
      />

      {showDropdown && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-10 top-full left-0 right-0 mt-1 max-h-64 overflow-y-auto rounded-md border border-border bg-surface shadow-sm"
        >
          {displayItems.map((item, idx) => {
            const isActive = idx === activeIndex;
            if (item.type === "existing") {
              const c = item.client;
              return (
                <li
                  key={item.itemId}
                  id={item.itemId}
                  role="option"
                  aria-selected={isActive}
                  onMouseDown={() => selectOption(c.name)}
                  onMouseEnter={() => setActiveIndex(idx)}
                  className={`px-3 py-2 cursor-pointer text-[13px] ${
                    isActive ? "bg-accent-soft text-ink" : "text-ink hover:bg-surface-muted"
                  }`}
                >
                  <span className="font-medium">{c.name}</span>
                  {c.phone && (
                    <span className="text-ink-3 text-[11.5px] ml-1.5">· {c.phone}</span>
                  )}
                </li>
              );
            } else {
              // add-new item
              return (
                <li
                  key={item.itemId}
                  id={item.itemId}
                  role="option"
                  aria-selected={isActive}
                  onMouseDown={() => setOpen(false)}
                  onMouseEnter={() => setActiveIndex(idx)}
                  className={`px-3 py-2 cursor-pointer text-[13px] border-t border-border ${
                    isActive ? "bg-accent-soft text-ink" : "text-accent hover:bg-surface-muted"
                  }`}
                >
                  + Добавить нового клиента: «{value.trim()}»
                </li>
              );
            }
          })}
        </ul>
      )}
    </div>
  );
}
