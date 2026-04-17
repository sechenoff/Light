"use client";

import { useEffect, useRef, useState } from "react";
import { toMoscowDateString, addDays } from "../../lib/moscowDate";

// ── Типы ──────────────────────────────────────────────────────────────────────

export interface TaskCreateModalProps {
  onSubmit: (input: {
    title: string;
    urgent: boolean;
    dueDate: string | null;
    assignedTo: string | null;
  }) => Promise<void> | void;
  onClose: () => void;
  assigneeOptions: Array<{ id: string; username: string }>;
}

type DatePill = "none" | "today" | "tomorrow" | "dayAfter" | "custom";

// ── TaskCreateModal ───────────────────────────────────────────────────────────

export function TaskCreateModal({
  onSubmit,
  onClose,
  assigneeOptions,
}: TaskCreateModalProps) {
  const [title, setTitle] = useState("");
  const [urgent, setUrgent] = useState(false);
  const [datePill, setDatePill] = useState<DatePill>("none");
  const [customDate, setCustomDate] = useState<string>("");
  const [assignedTo, setAssignedTo] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Autofocus при монтировании
  useEffect(() => {
    const t = setTimeout(() => textareaRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);

  // Esc закрывает модалку
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [submitting, onClose]);

  // ── Вычисление dueDate по выбранному pill ────────────────────────────────

  function resolvedDueDate(): string | null {
    const now = new Date();
    switch (datePill) {
      case "today":
        return toMoscowDateString(now);
      case "tomorrow":
        return toMoscowDateString(addDays(now, 1));
      case "dayAfter":
        return toMoscowDateString(addDays(now, 2));
      case "custom":
        return customDate || null;
      case "none":
      default:
        return null;
    }
  }

  // ── Submit ───────────────────────────────────────────────────────────────

  async function handleSubmit() {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;
    setSubmitting(true);
    try {
      await onSubmit({
        title: trimmedTitle,
        urgent,
        dueDate: resolvedDueDate(),
        assignedTo: assignedTo || null,
      });
    } finally {
      setSubmitting(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      void handleSubmit();
    }
  }

  // ── Стили для pill-кнопок ────────────────────────────────────────────────

  function pillClass(active: boolean): string {
    return [
      "px-3 py-1 text-xs rounded-full border transition-colors cursor-pointer",
      active
        ? "bg-accent-soft text-accent border-accent-border font-medium"
        : "bg-surface text-ink-3 border-border hover:bg-surface-muted",
    ].join(" ");
  }

  const trimmedTitle = title.trim();
  const canSubmit = trimmedTitle.length > 0 && !submitting;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 backdrop-blur-sm px-4"
      onClick={() => !submitting && onClose()}
    >
      <div
        className="w-full max-w-md bg-surface border border-border rounded-lg shadow-lg p-5"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Заголовок */}
        <h2 className="text-lg font-semibold text-ink mb-4">Создать задачу</h2>

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
          placeholder="Что сделать? Например, «починить машину»"
          className="w-full resize-none rounded border border-border bg-surface px-3 py-2 text-sm text-ink placeholder-ink-3 focus:border-accent focus:outline-none"
          disabled={submitting}
        />

        {/* Срок */}
        <div className="mt-4">
          <p className="eyebrow mb-2">Срок</p>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              className={pillClass(datePill === "none")}
              onClick={() => setDatePill("none")}
            >
              Долгосрочная задача
            </button>
            <button
              type="button"
              className={pillClass(datePill === "today")}
              onClick={() => setDatePill("today")}
            >
              Сегодня
            </button>
            <button
              type="button"
              className={pillClass(datePill === "tomorrow")}
              onClick={() => setDatePill("tomorrow")}
            >
              Завтра
            </button>
            <button
              type="button"
              className={pillClass(datePill === "dayAfter")}
              onClick={() => setDatePill("dayAfter")}
            >
              Послезавтра
            </button>
            <button
              type="button"
              className={pillClass(datePill === "custom")}
              onClick={() => setDatePill("custom")}
            >
              {datePill === "custom" && customDate
                ? `Другая дата: ${new Date(customDate + "T00:00:00").toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })}`
                : "Выбрать дату…"}
            </button>
          </div>

          {/* Скрытый date input для выбора конкретной даты */}
          {datePill === "custom" && (
            <input
              type="date"
              value={customDate}
              onChange={(e) => setCustomDate(e.target.value)}
              className="mt-2 rounded border border-border bg-surface px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none"
              disabled={submitting}
            />
          )}
        </div>

        {/* Кому */}
        {assigneeOptions.length > 0 && (
          <div className="mt-4">
            <p className="eyebrow mb-2">Кому</p>
            <select
              value={assignedTo}
              onChange={(e) => setAssignedTo(e.target.value)}
              className="w-full rounded border border-border bg-surface px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none"
              disabled={submitting}
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

        {/* Срочно */}
        <div className="mt-4">
          <button
            type="button"
            className={pillClass(urgent)}
            onClick={() => setUrgent((v) => !v)}
            aria-label={urgent ? "Снять срочность" : "Пометить срочным"}
          >
            🔥 {urgent ? "Срочно" : "Срочно?"}
          </button>
        </div>

        {/* Футер */}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded border border-border px-4 py-1.5 text-sm text-ink-2 hover:bg-surface-muted disabled:opacity-50 transition-colors"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            className="rounded bg-accent-bright text-white px-4 py-1.5 text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {submitting ? "Создаю…" : "Создать"}
          </button>
        </div>
      </div>
    </div>
  );
}
