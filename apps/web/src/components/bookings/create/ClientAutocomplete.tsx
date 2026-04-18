"use client";

import { useEffect, useRef, useState, useCallback, useId, useMemo } from "react";
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

/**
 * Case-insensitive, locale-aware normalisation for Russian client names.
 * SQLite's LIKE is case-sensitive for non-ASCII by default — we therefore
 * fetch a superset and filter on the client using `toLocaleLowerCase("ru")`
 * so that `АРТ` matches `арт-пикчерс`.
 */
function normalizeRu(s: string): string {
  return s.trim().toLocaleLowerCase("ru");
}

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
  // `selectedName` tracks the last name the user explicitly picked from the
  // dropdown. When `value` still matches, we show a "✓ существующий клиент"
  // hint. Changing the input resets this.
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const baseId = useId();
  const inputId = id ?? `${baseId}-input`;
  const listId = `${baseId}-list`;

  const fetchOptions = useCallback(async (query: string) => {
    const trimmed = query.trim();
    if (!trimmed) {
      setOptions([]);
      return;
    }
    // Cancel any in-flight request to avoid a late response clobbering a
    // fresher one (classic debounce race).
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      // Fetch a superset (limit=50) to compensate for case-sensitive LIKE on
      // SQLite. Server-side filtering still cuts down the network cost vs.
      // fetching the whole table.
      const data = await apiFetch<{ clients: Client[] }>(
        `/api/clients?search=${encodeURIComponent(trimmed)}&limit=50`,
        { signal: ctrl.signal }
      );
      if (ctrl.signal.aborted) return;
      setOptions(data.clients);
    } catch (e) {
      if (ctrl.signal.aborted) return;
      if (e instanceof DOMException && e.name === "AbortError") return;
      setOptions([]);
    }
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    onChange(v);
    // User typed something → this is no longer a selected existing client.
    setSelectedName(null);
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
    setSelectedName(name);
    setOpen(false);
    setActiveIndex(-1);
  };

  // Case-insensitive client-side filter over the fetched superset.
  const filteredOptions = useMemo(() => {
    const norm = normalizeRu(value);
    if (!norm) return [];
    return options
      .filter((c) => normalizeRu(c.name).includes(norm))
      .slice(0, 10);
  }, [options, value]);

  const hasExactMatch = useMemo(() => {
    const norm = normalizeRu(value);
    if (!norm) return false;
    return filteredOptions.some((o) => normalizeRu(o.name) === norm);
  }, [filteredOptions, value]);

  // Build display items: existing matches + optional "add new" item
  type DisplayItem =
    | { type: "existing"; client: Client; itemId: string }
    | { type: "add-new"; itemId: string };

  const displayItems: DisplayItem[] = useMemo(
    () => [
      ...filteredOptions.map((c, i) => ({
        type: "existing" as const,
        client: c,
        itemId: `${baseId}-opt-${i}`,
      })),
      ...(value.trim() && !hasExactMatch
        ? [{ type: "add-new" as const, itemId: `${baseId}-add` }]
        : []),
    ],
    [filteredOptions, hasExactMatch, value, baseId]
  );

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

  // Cleanup debounce + abort in-flight on unmount.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  const showDropdown = open && (displayItems.length > 0);

  // Hint shown below the input:
  //  - "✓ выбран существующий клиент"  — when the user explicitly picked one
  //    from the dropdown AND hasn't changed the value since.
  //  - "будет создан новый клиент"    — when the trimmed value has no exact
  //    match in the DB (case-insensitive) and the user hasn't just selected.
  //  - null                            — empty input, or name matches existing
  //    client but user is still typing without having selected.
  const trimmedValue = value.trim();
  const isSelectedExisting =
    selectedName !== null &&
    normalizeRu(selectedName) === normalizeRu(trimmedValue);
  const willCreateNew =
    !readOnly &&
    trimmedValue.length > 0 &&
    !isSelectedExisting &&
    !hasExactMatch;

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

      {isSelectedExisting && (
        <p className="mt-1 text-[11.5px] text-emerald" aria-live="polite">
          ✓ выбран существующий клиент
        </p>
      )}
      {willCreateNew && (
        <p className="mt-1 text-[11.5px] text-ink-3" aria-live="polite">
          Будет создан новый клиент
        </p>
      )}

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
