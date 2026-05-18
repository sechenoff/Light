"use client";

import { useEffect } from "react";
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

  // Esc closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Auto-close if the task was deleted elsewhere (polled 404)
  useEffect(() => {
    if (notFound) onClose();
  }, [notFound, onClose]);

  const isCreator = task ? task.createdBy === currentUserId : false;
  const isAssignee = task ? task.assignedTo === currentUserId : false;
  const canEdit = isSuperAdmin || isCreator;
  const canToggle = isSuperAdmin || isCreator || isAssignee;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} aria-hidden />
      <div className="relative w-full max-w-[480px] h-full bg-surface shadow-xl overflow-y-auto animate-[slidein_180ms_ease-out]">
        <style>{`@keyframes slidein{from{transform:translateX(24px);opacity:.6}to{transform:translateX(0);opacity:1}}`}</style>

        {/* Header */}
        <div className="sticky top-0 bg-surface border-b border-border px-5 py-4 flex items-start justify-between gap-3 z-10">
          <div className="min-w-0">
            <p className="eyebrow">Задача</p>
            <h2 className="text-[17px] font-semibold text-ink mt-0.5 leading-snug break-words">
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
      </div>
    </div>
  );
}
