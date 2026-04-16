"use client";

import { useState } from "react";
import type { SlangAlias } from "./types";
import { RebindModal } from "./RebindModal";

const INITIAL_VISIBLE = 7;

type Props = {
  aliases: SlangAlias[];
  equipmentId: string;
  onDelete: (aliasId: string) => void;
  onRebind: (oldId: string, newEqId: string, newEqName: string) => void;
};

function sourceBadge(source: SlangAlias["source"]) {
  if (source === "SEED") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-accent-soft text-accent border border-accent-border">
        📦 базовый
      </span>
    );
  }
  if (source === "AUTO_LEARNED") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-teal-soft text-teal border border-teal-border">
        🤖 авто
      </span>
    );
  }
  // MANUAL_ADMIN
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-soft text-slate border border-slate-border">
      ✋ вручную
    </span>
  );
}

export function PhraseList({ aliases, equipmentId, onDelete, onRebind }: Props) {
  const [showAll, setShowAll] = useState(false);
  const [rebindAlias, setRebindAlias] = useState<SlangAlias | null>(null);

  const sorted = [...aliases].sort((a, b) => {
    if (b.usageCount !== a.usageCount) return b.usageCount - a.usageCount;
    return b.createdAt.localeCompare(a.createdAt);
  });

  const visible = showAll ? sorted : sorted.slice(0, INITIAL_VISIBLE);
  const hiddenCount = sorted.length - INITIAL_VISIBLE;

  function handleDelete(alias: SlangAlias) {
    if (window.confirm(`Удалить фразу «${alias.phraseOriginal}»?`)) {
      onDelete(alias.id);
    }
  }

  return (
    <div className="bg-surface-muted border-t border-border">
      <div className="mx-4 my-2.5">
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-3.5 py-2 border-b border-border bg-surface-muted">
            <span className="eyebrow text-ink-3">{sorted.length} сленговых фраз</span>
            <button
              title="Скоро"
              className="text-[11px] text-ink-3 cursor-default"
            >
              + Добавить фразу
            </button>
          </div>

          {/* Phrase rows */}
          {visible.map((alias) => (
            <div
              key={alias.id}
              className="grid gap-2.5 px-3.5 py-2 border-t border-surface-muted first:border-t-0 hover:bg-surface-muted transition-colors items-center"
              style={{ gridTemplateColumns: "1fr 80px 90px 70px" }}
            >
              <span className="font-mono text-[12.5px] text-ink font-medium truncate">
                {alias.phraseOriginal}
              </span>
              {sourceBadge(alias.source)}
              <span className="font-mono text-[11.5px] text-ink-2 text-right">
                {alias.usageCount} исп.
              </span>
              <div className="flex gap-1 justify-end">
                <button
                  aria-label="Переподвязать"
                  title="Переподвязать"
                  onClick={() => setRebindAlias(alias)}
                  className="w-7 h-7 flex items-center justify-center rounded text-ink-3 hover:bg-accent-soft hover:text-accent transition-colors text-[13px]"
                >
                  ✎
                </button>
                <button
                  aria-label="Удалить фразу"
                  title="Удалить"
                  onClick={() => handleDelete(alias)}
                  className="w-7 h-7 flex items-center justify-center rounded text-ink-3 hover:bg-rose-soft hover:text-rose transition-colors text-[13px]"
                >
                  ×
                </button>
              </div>
            </div>
          ))}

          {/* Show more */}
          {!showAll && hiddenCount > 0 && (
            <div className="px-3.5 py-2 border-t border-border text-center">
              <button
                onClick={() => setShowAll(true)}
                className="text-[12px] text-accent hover:text-accent-bright transition-colors"
              >
                + ещё {hiddenCount} фраз — показать все
              </button>
            </div>
          )}
          {showAll && sorted.length > INITIAL_VISIBLE && (
            <div className="px-3.5 py-2 border-t border-border text-center">
              <button
                onClick={() => setShowAll(false)}
                className="text-[12px] text-ink-3 hover:text-ink-2 transition-colors"
              >
                Свернуть
              </button>
            </div>
          )}
        </div>
      </div>

      {/* RebindModal */}
      {rebindAlias && (
        <RebindModal
          phrase={rebindAlias.phraseOriginal}
          currentEquipmentId={equipmentId}
          onClose={() => setRebindAlias(null)}
          onRebind={(newEqId, newEqName) => {
            onRebind(rebindAlias.id, newEqId, newEqName);
            setRebindAlias(null);
          }}
        />
      )}
    </div>
  );
}
