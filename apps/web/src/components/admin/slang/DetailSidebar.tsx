"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import type { SlangAlias } from "./types";
import { RebindModal } from "./RebindModal";

type Props = {
  alias: SlangAlias;
  onDelete: (id: string) => void;
  onRebind: (oldId: string, newEquipmentId: string, newEquipmentName: string) => void;
  onClose: () => void;
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function sourceLabel(source: string): { cls: string; icon: string; label: string } {
  const map: Record<string, { cls: string; icon: string; label: string }> = {
    AUTO_LEARNED: { cls: "bg-teal-soft text-teal border-teal-border", icon: "🤖", label: "авто" },
    MANUAL_ADMIN: { cls: "bg-slate-soft text-slate border-slate-border", icon: "✋", label: "вручную" },
    SEED: { cls: "bg-accent-soft text-accent border-[#bfdbfe]", icon: "📦", label: "базовый" },
  };
  return map[source] ?? map.SEED;
}

export function DetailSidebar({ alias, onDelete, onRebind, onClose }: Props) {
  const [deleting, setDeleting] = useState(false);
  const [showRebind, setShowRebind] = useState(false);

  async function handleDelete() {
    if (!confirm(`Удалить алиас «${alias.phraseOriginal}»?`)) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/admin/slang-learning/aliases/${alias.id}`, {
        method: "DELETE",
      });
      onDelete(alias.id);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Ошибка удаления");
    } finally {
      setDeleting(false);
    }
  }

  function handleRebindSelect(equipmentId: string, equipmentName: string) {
    setShowRebind(false);
    onRebind(alias.id, equipmentId, equipmentName);
  }

  const src = sourceLabel(alias.source);

  return (
    <>
      <div className="w-[340px] shrink-0 sticky top-5 self-start bg-surface border border-border rounded-lg p-5 space-y-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="eyebrow">Выбрано</p>
            <p className="font-mono text-[15px] font-medium text-ink mt-1">
              «{alias.phraseOriginal}»
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Закрыть панель"
            className="text-ink-3 hover:text-ink hover:bg-surface-2 w-6 h-6 rounded flex items-center justify-center text-lg leading-none"
          >
            ×
          </button>
        </div>

        {/* Linked equipment */}
        <div className="rounded-lg bg-surface-2 p-3 flex items-center gap-2.5">
          <span className="text-ink-3">→</span>
          <div>
            <p className="text-sm font-medium text-ink">{alias.equipment.name}</p>
            <p className="text-[11px] text-ink-3">{alias.equipment.category}</p>
          </div>
        </div>

        {/* Stats */}
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-ink-2">Использований</span>
            <span className="mono-num font-medium text-ink">{alias.usageCount} раз</span>
          </div>
          <div className="flex justify-between">
            <span className="text-ink-2">Последний раз</span>
            <span className="mono-num text-ink text-xs">{formatDate(alias.lastUsedAt)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-ink-2">Добавлено</span>
            <span className="mono-num text-ink text-xs">{formatDate(alias.createdAt)}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-ink-2">Источник</span>
            <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border ${src.cls}`}>
              {src.icon} {src.label}
            </span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-2 pt-4 border-t border-border">
          <button
            onClick={() => setShowRebind(true)}
            className="w-full px-3 py-2 text-sm font-medium border border-border rounded-lg bg-surface hover:bg-surface-2 text-ink transition-colors"
          >
            Изменить связь
          </button>
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="w-full px-3 py-2 text-sm font-medium border border-rose-border rounded-lg bg-rose-soft text-rose hover:opacity-85 transition-opacity disabled:opacity-50"
          >
            {deleting ? "Удаление…" : "Удалить"}
          </button>
        </div>
      </div>

      {showRebind && (
        <RebindModal
          phrase={alias.phraseOriginal}
          currentEquipmentId={alias.equipmentId}
          onRebind={handleRebindSelect}
          onClose={() => setShowRebind(false)}
        />
      )}
    </>
  );
}
