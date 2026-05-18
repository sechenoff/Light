"use client";

import { useEffect, useRef } from "react";
import { useTaskDetail } from "./useTaskDetail";
import { TaskComments } from "./TaskComments";
import { TaskChecklist } from "./TaskChecklist";
import { TaskAssigneePill } from "./TaskAssigneePill";
import { StatusPill } from "../StatusPill";

interface Props {
  taskId: string;
  currentUserId?: string;
  isSuperAdmin: boolean;
  onClose: () => void;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "без срока";
  try {
    return new Date(iso).toLocaleDateString("ru-RU", {
      day: "numeric", month: "long", timeZone: "Europe/Moscow",
    });
  } catch {
    return iso;
  }
}

export function TaskDetailPanel({ taskId, currentUserId, isSuperAdmin, onClose }: Props) {
  const {
    task, loading, notFound,
    addComment, deleteComment,
    addChecklistItem, toggleChecklistItem, deleteChecklistItem,
  } = useTaskDetail(taskId);

  const panelRef = useRef<HTMLDivElement>(null);

  // Esc closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Auto-focus the panel on open; restore focus on unmount (spec §6 focus trap)
  useEffect(() => {
    const prevFocused = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => panelRef.current?.focus(), 50);
    return () => {
      clearTimeout(t);
      prevFocused?.focus?.();
    };
  }, []);

  function handleTrapKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab" || !panelRef.current) return;
    const focusables = panelRef.current.querySelectorAll<HTMLElement>(
      'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && (active === first || active === panelRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // Auto-close if the task was deleted elsewhere (polled 404)
  useEffect(() => {
    if (notFound) onClose();
  }, [notFound, onClose]);

  const isCreator = task ? task.createdBy === currentUserId : false;
  const isAssignee = task ? task.assignedTo === currentUserId : false;
  const canEdit = isSuperAdmin || isCreator;
  const canToggle = isSuperAdmin || isCreator || isAssignee;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-labelledby="task-detail-title"
    >
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={handleTrapKey}
        className="relative w-full max-w-[480px] h-full bg-surface shadow-xl overflow-y-auto animate-slidein"
      >
        {/* Header */}
        <div className="sticky top-0 bg-surface border-b border-border px-5 py-4 flex items-start justify-between gap-3 z-10">
          <div className="min-w-0">
            <p className="eyebrow">Задача</p>
            <h2 id="task-detail-title" className="text-[17px] font-semibold text-ink mt-0.5 leading-snug break-words">
              {task?.title ?? (loading ? "Загрузка…" : "—")}
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Закрыть"
            className="text-ink-3 hover:text-ink text-xl leading-none shrink-0"
          >
            ✕
          </button>
        </div>

        {task && (
          <div className="p-5 space-y-6">
            {/* Meta */}
            <div className="flex flex-wrap items-center gap-2.5">
              <StatusPill
                variant={task.status === "DONE" ? "ok" : "info"}
                label={task.status === "DONE" ? "Выполнена" : "В работе"}
              />
              {task.urgent && <StatusPill variant="alert" label="🔥 Срочно" />}
              <TaskAssigneePill user={task.assignedToUser} />
              <span className="text-[12px] text-ink-3">срок: {fmtDate(task.dueDate)}</span>
            </div>

            {/* Description */}
            {task.description?.trim() && (
              <p className="text-[14px] text-ink-2 whitespace-pre-wrap leading-relaxed">
                {task.description}
              </p>
            )}

            {/* Checklist */}
            <TaskChecklist
              items={task.checklist}
              canEdit={canEdit}
              canToggle={canToggle}
              onAdd={addChecklistItem}
              onToggle={toggleChecklistItem}
              onDelete={deleteChecklistItem}
            />

            <div className="border-t border-border" />

            {/* Comments */}
            <TaskComments
              comments={task.comments}
              currentUserId={currentUserId}
              isSuperAdmin={isSuperAdmin}
              onAdd={addComment}
              onDelete={deleteComment}
            />
          </div>
        )}

        {!task && !loading && !notFound && (
          <div className="p-5 text-[13px] text-ink-3">Не удалось загрузить задачу</div>
        )}
        {!task && loading && (
          <div className="p-5 text-[13px] text-ink-3">Загрузка…</div>
        )}
      </div>
    </div>
  );
}
