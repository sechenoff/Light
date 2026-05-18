"use client";

import { useState, useRef } from "react";
import type { TaskComment } from "./useTaskDetail";

interface Props {
  comments: TaskComment[];
  currentUserId?: string;
  isSuperAdmin: boolean;
  onAdd: (body: string) => void | Promise<void>;
  onDelete: (commentId: string) => void | Promise<void>;
}

function fmt(iso: string): string {
  try {
    return new Date(iso).toLocaleString("ru-RU", {
      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
      timeZone: "Europe/Moscow",
    });
  } catch {
    return iso;
  }
}

export function TaskComments({ comments, currentUserId, isSuperAdmin, onAdd, onDelete }: Props) {
  const [draft, setDraft] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  function submit() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    void onAdd(trimmed);
    setDraft("");
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      submit();
    }
    if (e.key === "Escape") taRef.current?.blur();
  }

  return (
    <div className="space-y-3">
      <p className="eyebrow">Обсуждение</p>

      {comments.length === 0 && (
        <p className="text-[13px] text-ink-3">Пока нет комментариев</p>
      )}

      <ul className="space-y-2.5">
        {comments.map((c) => {
          const canDelete = isSuperAdmin || (currentUserId && c.authorId === currentUserId);
          return (
            <li key={c.id} className="group bg-surface-muted rounded-lg px-3 py-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13px] font-medium text-ink">
                  {c.authorUser?.username ?? "—"}
                </span>
                <span className="text-[11px] text-ink-3">{fmt(c.createdAt)}</span>
              </div>
              <p className="text-[13px] text-ink-2 mt-0.5 whitespace-pre-wrap break-words">
                {c.body}
              </p>
              {canDelete && (
                <button
                  onClick={() => void onDelete(c.id)}
                  aria-label="Удалить комментарий"
                  className="text-[11px] text-ink-3 hover:text-rose opacity-0 group-hover:opacity-100 transition-opacity mt-1"
                >
                  Удалить
                </button>
              )}
            </li>
          );
        })}
      </ul>

      <div className="border border-border rounded-lg bg-surface focus-within:border-accent transition-colors">
        <textarea
          ref={taRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKey}
          rows={2}
          placeholder="Написать комментарий…"
          className="w-full text-[13px] text-ink bg-transparent px-3 py-2 resize-none focus:outline-none"
        />
        <div className="flex items-center justify-between px-3 py-1.5 border-t border-border">
          <span className="text-[11px] text-ink-3">⌘+Enter — отправить</span>
          <button
            onClick={submit}
            disabled={!draft.trim()}
            className="text-[13px] font-medium px-3 py-1 rounded-md bg-accent-bright text-white disabled:opacity-40 hover:opacity-90 transition-opacity"
          >
            Отправить
          </button>
        </div>
      </div>
    </div>
  );
}
