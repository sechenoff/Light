"use client";

import { useState, useEffect, useRef } from "react";
import type { Task } from "./groupTasks";

// ── Типы ──────────────────────────────────────────────────────────────────────

interface AdminUserOption {
  id: string;
  username: string;
}

interface TaskEditModalProps {
  task: Task;
  assigneeOptions?: AdminUserOption[];
  onSave: (id: string, patch: Partial<Task>) => void;
  onClose: () => void;
}

// ── Компонент ─────────────────────────────────────────────────────────────────

export function TaskEditModal({
  task,
  assigneeOptions = [],
  onSave,
  onClose,
}: TaskEditModalProps) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [urgent, setUrgent] = useState(task.urgent);
  const [assignedTo, setAssignedTo] = useState<string | null>(task.assignedTo);
  const [dueDate, setDueDate] = useState<string>(() => {
    if (!task.dueDate) return "";
    // Конвертируем ISO → "YYYY-MM-DD" для <input type="date">
    try {
      const d = new Date(task.dueDate);
      return d.toLocaleDateString("en-CA", { timeZone: "Europe/Moscow" });
    } catch {
      return "";
    }
  });

  const titleRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Авто-фокус на заголовке
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  // Escape закрывает + focus trap (Tab циклится внутри модалки)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;

      const dialog = dialogRef.current;
      if (!dialog) return;

      // Собираем все focusable элементы внутри модалки
      const focusable = dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function handleSave() {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;

    const patch: Partial<Task> = {
      title: trimmedTitle,
      description: description.trim() || null,
      urgent,
      assignedTo,
      dueDate: dueDate ? new Date(`${dueDate}T00:00:00+03:00`).toISOString() : null,
    };

    onSave(task.id, patch);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Редактировать задачу"
    >
      <div
        ref={dialogRef}
        className="bg-surface border border-border rounded-xl shadow-lg w-full max-w-md space-y-4 p-6"
      >
        {/* Заголовок модалки */}
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">Редактировать задачу</h2>
          <button
            onClick={onClose}
            aria-label="Закрыть"
            className="text-ink-3 hover:text-ink transition-colors text-lg leading-none"
          >
            ✕
          </button>
        </div>

        {/* Заголовок задачи */}
        <div>
          <label className="eyebrow mb-1 block" htmlFor="edit-title">
            Заголовок
          </label>
          <textarea
            ref={titleRef}
            id="edit-title"
            rows={2}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full text-sm text-ink bg-surface-muted border border-border rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-accent resize-none"
          />
        </div>

        {/* Описание */}
        <div>
          <label className="eyebrow mb-1 block" htmlFor="edit-description">
            Описание
          </label>
          <textarea
            id="edit-description"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Добавить описание…"
            className="w-full text-sm text-ink bg-surface-muted border border-border rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-accent resize-none"
          />
        </div>

        {/* Срок */}
        <div>
          <label className="eyebrow mb-1 block" htmlFor="edit-duedate">
            Срок (московское время)
          </label>
          <input
            id="edit-duedate"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="w-full text-sm text-ink bg-surface-muted border border-border rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>

        {/* Исполнитель */}
        {assigneeOptions.length > 0 && (
          <div>
            <label className="eyebrow mb-1 block" htmlFor="edit-assignee">
              Исполнитель
            </label>
            <select
              id="edit-assignee"
              value={assignedTo ?? ""}
              onChange={(e) => setAssignedTo(e.target.value || null)}
              className="w-full text-sm text-ink bg-surface-muted border border-border rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-accent"
            >
              <option value="">— Никому</option>
              {assigneeOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.username}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Срочность */}
        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            id="edit-urgent"
            checked={urgent}
            onChange={(e) => setUrgent(e.target.checked)}
            className="w-4 h-4 rounded-sm accent-rose"
          />
          <label htmlFor="edit-urgent" className="text-sm text-ink cursor-pointer select-none">
            🔥 Срочно
          </label>
        </div>

        {/* Кнопки */}
        <div className="flex gap-3 justify-end pt-1">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-ink-2 border border-border rounded-lg hover:bg-surface-muted transition-colors"
          >
            Отмена
          </button>
          <button
            onClick={handleSave}
            disabled={!title.trim()}
            className="px-4 py-2 text-sm font-semibold bg-accent-bright text-white rounded-lg hover:bg-accent disabled:opacity-50 transition-colors"
          >
            Сохранить
          </button>
        </div>
      </div>
    </div>
  );
}
