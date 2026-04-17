"use client";

import { useState, useRef, forwardRef, useImperativeHandle } from "react";
import { toast } from "../ToastProvider";

// ── Типы ──────────────────────────────────────────────────────────────────────

interface QuickCaptureInput {
  title: string;
  urgent: boolean;
  dueDate: string | null;
  assignedTo: string | null;
}

export interface TaskQuickCaptureRef {
  focus: () => void;
}

interface AdminUserOption {
  id: string;
  username: string;
}

interface TaskQuickCaptureProps {
  onSubmit: (input: QuickCaptureInput) => void;
  assigneeOptions?: AdminUserOption[];
}

// ── Компонент ─────────────────────────────────────────────────────────────────

export const TaskQuickCapture = forwardRef<TaskQuickCaptureRef, TaskQuickCaptureProps>(
  function TaskQuickCapture({ onSubmit, assigneeOptions = [] }, ref) {
    const [title, setTitle] = useState("");
    const [urgent, setUrgent] = useState(false);
    const [dueDate, setDueDate] = useState<string | null>(null);
    const [assignedTo, setAssignedTo] = useState<string | null>(null);
    const [showDatePicker, setShowDatePicker] = useState(false);
    const [showAssigneePicker, setShowAssigneePicker] = useState(false);

    const inputRef = useRef<HTMLInputElement>(null);

    useImperativeHandle(ref, () => ({
      focus: () => inputRef.current?.focus(),
    }));

    function handleSubmit() {
      const trimmed = title.trim();
      if (!trimmed) {
        toast.info("Напиши что сделать");
        return;
      }
      onSubmit({ title: trimmed, urgent, dueDate, assignedTo });
      setTitle("");
      setUrgent(false);
      setDueDate(null);
      setAssignedTo(null);
      setShowDatePicker(false);
      setShowAssigneePicker(false);
    }

    function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
      if (e.key === "Enter") handleSubmit();
      if (e.key === "Escape") {
        setTitle("");
        inputRef.current?.blur();
      }
    }

    const assigneeName = assignedTo
      ? assigneeOptions.find((a) => a.id === assignedTo)?.username ?? "?"
      : null;

    // Отображаемая дата — только день/месяц
    function formatDate(d: string | null): string {
      if (!d) return "Срок";
      try {
        return new Date(d + "T00:00:00+03:00").toLocaleDateString("ru-RU", {
          day: "numeric",
          month: "short",
          timeZone: "Europe/Moscow",
        });
      } catch {
        return d;
      }
    }

    return (
      <div className="flex items-center gap-2 bg-surface border border-border rounded-lg px-3 py-2 shadow-xs">
        {/* Иконка плюс */}
        <span className="text-ink-3 text-sm shrink-0" aria-hidden="true">+</span>

        {/* Основное поле */}
        <input
          ref={inputRef}
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Что сделать? (конкретное действие)"
          className="flex-1 text-sm text-ink bg-transparent placeholder-ink-3 focus:outline-none min-w-0"
        />

        {/* Чипы справа */}
        <div className="flex items-center gap-1 shrink-0">
          {/* Дата */}
          <div className="relative">
            <button
              onClick={() => {
                setShowDatePicker((v) => !v);
                setShowAssigneePicker(false);
              }}
              aria-label="Установить срок"
              className={`px-2 py-1 rounded text-xs border transition-colors ${
                dueDate
                  ? "bg-accent-soft text-accent border-accent-border"
                  : "bg-surface text-ink-3 border-border hover:bg-surface-muted"
              }`}
            >
              📅 {dueDate ? formatDate(dueDate) : "Срок"}
            </button>
            {showDatePicker && (
              <div className="absolute right-0 top-8 z-50 bg-surface border border-border rounded-lg shadow-sm p-3 min-w-[200px]">
                <label className="text-xs text-ink-2 block mb-1">Дата (московское время)</label>
                <input
                  type="date"
                  value={dueDate ?? ""}
                  onChange={(e) => {
                    setDueDate(e.target.value || null);
                    setShowDatePicker(false);
                  }}
                  className="w-full text-sm border border-border rounded px-2 py-1 bg-surface text-ink focus:outline-none focus:ring-1 focus:ring-accent"
                />
                {dueDate && (
                  <button
                    onClick={() => {
                      setDueDate(null);
                      setShowDatePicker(false);
                    }}
                    className="mt-1 text-xs text-rose hover:underline"
                  >
                    Убрать срок
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Исполнитель */}
          {assigneeOptions.length > 0 && (
            <div className="relative">
              <button
                onClick={() => {
                  setShowAssigneePicker((v) => !v);
                  setShowDatePicker(false);
                }}
                aria-label="Назначить исполнителя"
                className={`px-2 py-1 rounded text-xs border transition-colors ${
                  assignedTo
                    ? "bg-accent-soft text-accent border-accent-border"
                    : "bg-surface text-ink-3 border-border hover:bg-surface-muted"
                }`}
              >
                👤 {assigneeName ?? "Кому"}
              </button>
              {showAssigneePicker && (
                <div className="absolute right-0 top-8 z-50 bg-surface border border-border rounded-lg shadow-sm py-1 min-w-[160px] max-h-48 overflow-y-auto">
                  <button
                    onClick={() => {
                      setAssignedTo(null);
                      setShowAssigneePicker(false);
                    }}
                    className="w-full text-left px-3 py-1.5 text-xs text-ink-2 hover:bg-surface-muted transition-colors"
                  >
                    — Никому
                  </button>
                  {assigneeOptions.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => {
                        setAssignedTo(a.id);
                        setShowAssigneePicker(false);
                      }}
                      className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-muted transition-colors ${
                        assignedTo === a.id ? "text-accent font-semibold" : "text-ink"
                      }`}
                    >
                      {a.username}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Срочность */}
          <button
            onClick={() => setUrgent((v) => !v)}
            aria-label={urgent ? "Снять срочность" : "Пометить срочным"}
            title={urgent ? "Срочно (нажми чтобы снять)" : "Пометить срочным"}
            className={`px-2 py-1 rounded text-xs border transition-colors ${
              urgent
                ? "bg-rose-soft text-rose border-rose-border"
                : "bg-surface text-ink-3 border-border hover:bg-surface-muted"
            }`}
          >
            ! {urgent ? "Срочно" : ""}
          </button>
        </div>
      </div>
    );
  },
);
