"use client";

import { useState, useEffect, useRef } from "react";
import { apiFetch } from "@/lib/api";
import type { EquipmentSearchResult } from "./types";

type Props = {
  phrase: string;
  currentEquipmentId: string;
  onRebind: (equipmentId: string, equipmentName: string) => void;
  onClose: () => void;
};

export function RebindModal({ phrase, currentEquipmentId, onRebind, onClose }: Props) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<EquipmentSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const searchCounterRef = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!search.trim()) {
      setResults([]);
      return;
    }
    const requestId = ++searchCounterRef.current;
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        type EquipmentResponse = { items?: { id: string; name: string; category: string }[] };
        const data = await apiFetch<EquipmentResponse | { id: string; name: string; category: string }[]>(
          `/api/equipment?search=${encodeURIComponent(search.trim())}`
        );
        // Discard stale responses
        if (requestId !== searchCounterRef.current) return;
        const items = Array.isArray(data) ? data : (data as EquipmentResponse).items ?? [];
        setResults(items.map((e) => ({ id: e.id, name: e.name, category: e.category })));
      } catch {
        if (requestId === searchCounterRef.current) setResults([]);
      } finally {
        if (requestId === searchCounterRef.current) setLoading(false);
      }
    }, 300);

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [search]);

  async function handleSave() {
    if (!selectedId) return;
    const selected = results.find((r) => r.id === selectedId);
    if (!selected) return;
    setSaving(true);
    try {
      onRebind(selected.id, selected.name);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-surface rounded-xl w-[480px] max-h-[520px] shadow-lg overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h3 className="text-sm font-semibold text-ink">
            Изменить связь для «{phrase}»
          </h3>
          <button
            onClick={onClose}
            aria-label="Закрыть"
            className="text-ink-3 hover:text-ink text-lg leading-none"
          >
            ×
          </button>
        </div>

        {/* Search */}
        <div className="px-5 py-3 border-b border-border">
          <input
            ref={inputRef}
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Искать оборудование…"
            className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-ink placeholder-ink-3 focus:outline-none focus:border-accent-bright"
          />
        </div>

        {/* Results */}
        <div className="max-h-[340px] overflow-y-auto py-1">
          {loading && (
            <div className="py-8 text-center text-sm text-ink-3">Поиск…</div>
          )}
          {!loading && search.trim() && results.length === 0 && (
            <div className="py-8 text-center text-sm text-ink-3">Ничего не найдено</div>
          )}
          {!loading && !search.trim() && (
            <div className="py-8 text-center text-sm text-ink-3">Начните вводить название</div>
          )}
          {results.map((item) => {
            const isCurrent = item.id === currentEquipmentId;
            const isSelected = item.id === selectedId;
            return (
              <button
                key={item.id}
                onClick={() => setSelectedId(item.id)}
                className={`w-full flex items-center gap-3 px-5 py-2.5 text-left text-sm transition-colors ${
                  isCurrent ? "bg-emerald-soft" : isSelected ? "bg-accent-soft" : "hover:bg-surface-muted"
                }`}
              >
                <span
                  className={`w-4 h-4 rounded-full border-2 flex items-center justify-center text-[10px] shrink-0 ${
                    isSelected
                      ? "border-emerald bg-emerald text-white"
                      : "border-border"
                  }`}
                >
                  {isSelected && "✓"}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-ink truncate">{item.name}</p>
                  {isCurrent && (
                    <p className="text-[11px] text-ink-3">Текущая связь</p>
                  )}
                </div>
                <span className="text-[11px] text-ink-3 shrink-0">{item.category}</span>
              </button>
            );
          })}
        </div>

        {/* Footer */}
        {selectedId && selectedId !== currentEquipmentId && (
          <div className="px-5 py-3 border-t border-border">
            <button
              onClick={handleSave}
              disabled={saving}
              className="w-full px-4 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent-bright transition-colors disabled:opacity-50"
            >
              {saving ? "Сохраняем…" : "Сохранить"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
