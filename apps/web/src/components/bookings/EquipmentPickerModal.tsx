"use client";

/**
 * Простая модалка-выбор оборудования. Используется в retro-edit броне для
 * добавления новой позиции в RETURNED-бронь. По дизайн-канону:
 *  • Esc / backdrop click — закрытие
 *  • focus trap (Tab/Shift+Tab циклятся внутри модалки — фокус не утекает на фон)
 *  • debounce 200ms на поиск
 *
 * Контракт:
 *  open — управляет видимостью
 *  onPick — выбран элемент (модалка закрывается через onClose родителем)
 *  onClose — пользователь отменил
 */

import { useEffect, useRef, useState } from "react";

import { apiFetch } from "../../lib/api";

export interface PickerEquipment {
  id: string;
  name: string;
  category: string;
  brand?: string | null;
  model?: string | null;
  totalQuantity?: number;
}

interface Props {
  open: boolean;
  onPick: (eq: PickerEquipment) => void;
  onClose: () => void;
}

export function EquipmentPickerModal({ open, onPick, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<PickerEquipment[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Auto-focus search field when modal opens.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Debounced search. При закрытии модалки сбрасываем query — следующий раз
  // открывается с чистым state.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setItems(null);
      setError(null);
      return;
    }
    const controller = new AbortController();
    const t = setTimeout(async () => {
      const trimmed = query.trim();
      if (trimmed.length < 2) {
        // Не загружаем весь каталог — заставляем ввести 2+ символа.
        setItems(null);
        setError(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const data = await apiFetch<{ equipments: PickerEquipment[] }>(
          `/api/equipment?search=${encodeURIComponent(trimmed)}`,
          { signal: controller.signal },
        );
        // Top-50 — для UI достаточно.
        setItems(data.equipments.slice(0, 50));
      } catch (e: unknown) {
        const err = e as { name?: string; message?: string };
        const isAbort = err?.name === "AbortError";
        if (!isAbort) {
          setError(err?.message ?? "Не удалось загрузить оборудование");
          setItems([]);
        }
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [query, open]);

  // Esc → close; Tab/Shift+Tab — focus trap внутри модалки.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !root.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 flex items-start justify-center pt-[10vh] px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Добавить позицию"
        className="w-full max-w-2xl bg-surface rounded-lg border border-border shadow-xl overflow-hidden flex flex-col max-h-[70vh]"
      >
        <header className="p-4 border-b border-border flex items-center justify-between">
          <div>
            <p className="eyebrow">Добавить позицию</p>
            <p className="text-xs text-ink-3 mt-0.5">Введите название, бренд или модель</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-3 hover:text-ink text-lg"
            aria-label="Закрыть"
          >
            ✕
          </button>
        </header>
        <div className="p-3 border-b border-border">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="SkyPanel, ARRI, Газель…"
            className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
        <div className="flex-1 overflow-auto">
          {query.trim().length < 2 ? (
            <p className="p-6 text-center text-sm text-ink-3">
              Введите минимум 2 символа.
            </p>
          ) : loading ? (
            <p className="p-6 text-center text-sm text-ink-3">Загрузка…</p>
          ) : error ? (
            <p className="p-6 text-center text-sm text-rose">{error}</p>
          ) : items && items.length === 0 ? (
            <p className="p-6 text-center text-sm text-ink-3">
              Ничего не нашлось по «{query.trim()}».
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {items?.map((eq) => (
                <li key={eq.id}>
                  <button
                    type="button"
                    onClick={() => onPick(eq)}
                    className="w-full text-left px-4 py-2.5 hover:bg-surface-muted transition-colors"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-ink truncate">{eq.name}</div>
                        <div className="text-xs text-ink-3 truncate">
                          {eq.category}
                          {eq.brand ? ` · ${eq.brand}` : ""}
                          {eq.model ? ` · ${eq.model}` : ""}
                        </div>
                      </div>
                      {typeof eq.totalQuantity === "number" && (
                        <span className="text-xs text-ink-3 mono-num shrink-0">
                          {eq.totalQuantity} шт. в парке
                        </span>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
