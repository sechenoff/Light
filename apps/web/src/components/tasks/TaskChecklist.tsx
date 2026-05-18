"use client";

import { useState } from "react";
import type { ChecklistItem } from "./useTaskDetail";

interface Props {
  items: ChecklistItem[];
  canEdit: boolean;       // creator/SA — add/delete
  canToggle: boolean;     // creator/assignee/SA — toggle done
  onAdd: (text: string) => void | Promise<void>;
  onToggle: (itemId: string, done: boolean) => void | Promise<void>;
  onDelete: (itemId: string) => void | Promise<void>;
}

export function TaskChecklist({ items, canEdit, canToggle, onAdd, onToggle, onDelete }: Props) {
  const [draft, setDraft] = useState("");
  const done = items.filter((i) => i.done).length;
  const total = items.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  function add() {
    const t = draft.trim();
    if (!t) return;
    void onAdd(t);
    setDraft("");
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="eyebrow">Чеклист</p>
        {total > 0 && (
          <span className="text-[12px] text-ink-3 mono-num">{done}/{total}</span>
        )}
      </div>

      {total > 0 && (
        <div className="h-1.5 rounded-full bg-surface-muted overflow-hidden">
          <div
            className="h-full bg-teal transition-all"
            style={{ width: `${pct}%` }}
            aria-hidden
          />
        </div>
      )}

      <ul className="space-y-1.5">
        {items.map((i) => (
          <li key={i.id} className="group flex items-center gap-2.5">
            <button
              role="checkbox"
              aria-checked={i.done}
              aria-label={i.done ? "Снять отметку" : "Отметить выполненным"}
              disabled={!canToggle}
              onClick={() => onToggle(i.id, !i.done)}
              className={`w-[18px] h-[18px] rounded-[5px] border-2 flex items-center justify-center shrink-0 transition-colors ${
                i.done ? "bg-teal border-teal text-white" : "bg-surface border-border-strong hover:border-teal"
              } ${canToggle ? "cursor-pointer" : "cursor-default opacity-70"}`}
            >
              {i.done && (
                <svg width="10" height="8" viewBox="0 0 12 10" fill="none" aria-hidden>
                  <path d="M1 5l3.5 3.5L11 1" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
            <span className={`text-[13px] flex-1 ${i.done ? "line-through text-ink-3" : "text-ink-2"}`}>
              {i.text}
            </span>
            {canEdit && (
              <button
                onClick={() => void onDelete(i.id)}
                aria-label="Удалить пункт"
                className="text-[12px] text-ink-3 hover:text-rose opacity-0 group-hover:opacity-100 transition-opacity"
              >
                ✕
              </button>
            )}
          </li>
        ))}
      </ul>

      {canEdit && (
        <div className="flex items-center gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            placeholder="Добавить пункт…"
            className="flex-1 text-[13px] px-2.5 py-1.5 border border-border rounded-md bg-surface text-ink focus:outline-none focus:border-accent"
          />
          <button
            onClick={add}
            disabled={!draft.trim()}
            className="text-[13px] font-medium px-3 py-1.5 rounded-md border border-border-strong text-ink hover:bg-surface-muted disabled:opacity-40"
          >
            +
          </button>
        </div>
      )}
    </div>
  );
}
