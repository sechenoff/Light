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
    description?: string | null;
  }) => Promise<void> | void;
  onClose: () => void;
  assigneeOptions: Array<{ id: string; username: string }>;
}

type DatePill = "none" | "today" | "tomorrow" | "dayAfter" | "custom";

// ── Детерминированные цвета аватарок ─────────────────────────────────────────
const AVATAR_COLORS = [
  "bg-teal",
  "bg-amber",
  "bg-indigo",
  "bg-rose",
  "bg-emerald",
];
function avatarColorFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) & 0xffff;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

// ── TaskCreateModal ───────────────────────────────────────────────────────────

export function TaskCreateModal({
  onSubmit,
  onClose,
  assigneeOptions,
}: TaskCreateModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [showDescription, setShowDescription] = useState(false);
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
        description: showDescription && description.trim() ? description.trim() : null,
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

  function datePillClass(active: boolean): string {
    return [
      "px-3 py-1.5 text-[13px] rounded-full border transition-colors cursor-pointer",
      active
        ? "bg-accent-soft text-accent-bright border-accent font-semibold"
        : "bg-surface text-ink-2 border-border hover:border-border-strong",
    ].join(" ");
  }

  function assigneePillClass(active: boolean): string {
    return [
      "inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-[13px] transition-colors cursor-pointer",
      active
        ? "bg-accent-soft border-accent text-accent-bright font-semibold"
        : "bg-surface text-ink-2 border-border hover:border-border-strong",
    ].join(" ");
  }

  const trimmedTitle = title.trim();
  const canSubmit = trimmedTitle.length > 0 && !submitting;

  // Форматирование кастомной даты
  function formatCustomDate(val: string): string {
    if (!val) return "";
    const d = new Date(val + "T00:00:00");
    return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 backdrop-blur-sm px-4"
      onClick={() => !submitting && onClose()}
    >
      <div
        className="w-[560px] max-w-full bg-surface border border-border rounded-[14px] shadow-[0_24px_48px_rgba(0,0,0,0.18)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Шапка */}
        <div className="flex justify-between items-center px-6 pt-5 pb-2">
          <h2 className="text-[18px] font-semibold text-ink">Новая задача</h2>
          <button
            onClick={onClose}
            disabled={submitting}
            aria-label="Закрыть модалку"
            className="w-8 h-8 rounded-lg flex items-center justify-center text-ink-3 hover:bg-surface-muted hover:text-ink transition-colors disabled:opacity-50 text-lg"
          >
            ×
          </button>
        </div>

        <div className="px-6 pb-5">
          {/* Секция: Что сделать? */}
          <div className="mt-3">
            <div className="flex items-center justify-between mb-2">
              <label className="text-[10px] font-mono uppercase tracking-[0.07em] text-ink-3 font-medium">
                Что сделать?
              </label>
              <span className="text-[11px] text-ink-3">{title.length}/500</span>
            </div>
            <textarea
              ref={textareaRef}
              value={title}
              onChange={(e) => setTitle(e.target.value.slice(0, 500))}
              onKeyDown={handleKeyDown}
              rows={2}
              placeholder='Например: "Починить машину" или "Позвонить клиенту"'
              className="w-full resize-none rounded-lg border-2 border-border bg-surface px-4 py-3.5 text-[17px] font-medium text-ink placeholder-ink-3 focus:border-accent focus:outline-none focus:ring-4 focus:ring-accent-soft transition-shadow min-h-[56px]"
              disabled={submitting}
              maxLength={500}
            />
            {!showDescription && (
              <button
                type="button"
                onClick={() => setShowDescription(true)}
                className="mt-2 text-xs text-accent-bright hover:underline"
              >
                + Добавить описание
              </button>
            )}
            {showDescription && (
              <div className="mt-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-mono uppercase tracking-[0.07em] text-ink-3 font-medium">
                    Описание
                    <span className="ml-1.5 text-ink-3 text-[11px] font-normal normal-case tracking-normal font-sans">необязательно</span>
                  </span>
                  <span className="text-[11px] text-ink-3">{description.length}/2000</span>
                </div>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value.slice(0, 2000))}
                  rows={3}
                  placeholder="Дополнительные детали…"
                  className="w-full resize-none rounded-lg border border-border bg-surface px-3 py-2.5 text-sm text-ink placeholder-ink-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft transition-shadow"
                  disabled={submitting}
                  maxLength={2000}
                />
              </div>
            )}
          </div>

          {/* Разделитель */}
          <hr className="border-border my-5" />

          {/* Срок */}
          <div>
            <p className="text-[10px] font-mono uppercase tracking-[0.07em] text-ink-3 font-medium mb-2.5">
              Срок
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={datePillClass(datePill === "none")}
                onClick={() => setDatePill("none")}
              >
                Без даты
              </button>
              <button
                type="button"
                className={datePillClass(datePill === "today")}
                onClick={() => setDatePill("today")}
              >
                Сегодня
              </button>
              <button
                type="button"
                className={datePillClass(datePill === "tomorrow")}
                onClick={() => setDatePill("tomorrow")}
              >
                Завтра
              </button>
              <button
                type="button"
                className={datePillClass(datePill === "dayAfter")}
                onClick={() => setDatePill("dayAfter")}
              >
                Послезавтра
              </button>
              <button
                type="button"
                className={datePillClass(datePill === "custom")}
                onClick={() => setDatePill("custom")}
              >
                {datePill === "custom" && customDate
                  ? `📅 ${formatCustomDate(customDate)}`
                  : "📅 Другая дата"}
              </button>
            </div>

            {/* Inline date picker для custom */}
            {datePill === "custom" && (
              <div className="mt-3 p-3 bg-accent-soft rounded-lg border border-accent-border">
                <input
                  type="date"
                  value={customDate}
                  onChange={(e) => setCustomDate(e.target.value)}
                  className="rounded border border-border bg-surface px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none"
                  disabled={submitting}
                />
              </div>
            )}
          </div>

          {/* Кому */}
          {assigneeOptions.length > 0 && (
            <div className="mt-5">
              <p className="text-[10px] font-mono uppercase tracking-[0.07em] text-ink-3 font-medium mb-2.5">
                Кому
              </p>
              <div className="flex flex-wrap gap-2">
                {/* Никому */}
                <button
                  type="button"
                  onClick={() => setAssignedTo("")}
                  className={assigneePillClass(assignedTo === "")}
                >
                  <span className="w-5 h-5 rounded-full bg-slate text-white text-[10px] font-semibold flex items-center justify-center shrink-0">
                    ?
                  </span>
                  — Никому
                </button>
                {assigneeOptions.map((a) => {
                  const colorClass = avatarColorFor(a.id);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => setAssignedTo(a.id)}
                      className={assigneePillClass(assignedTo === a.id)}
                    >
                      <span
                        className={`w-5 h-5 rounded-full text-white text-[10px] font-semibold flex items-center justify-center shrink-0 ${colorClass}`}
                      >
                        {a.username.charAt(0).toUpperCase()}
                      </span>
                      {a.username}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Срочность */}
          <div className="mt-5">
            <button
              type="button"
              onClick={() => setUrgent((v) => !v)}
              aria-label={urgent ? "Снять срочность" : "Пометить срочным"}
              className={`w-full flex items-center justify-between px-4 py-3 rounded-lg border text-sm transition-colors ${
                urgent
                  ? "bg-rose-soft text-rose border-rose font-semibold"
                  : "bg-surface text-ink-2 border-border hover:border-border-strong"
              }`}
            >
              <span>🔥 {urgent ? "Срочная задача" : "Пометить срочным"}</span>
              {!urgent && (
                <span className="text-xs text-ink-3">красная левая граница на главной</span>
              )}
            </button>
          </div>

          {/* Футер */}
          <div className="mt-5 flex justify-between items-center gap-3">
            <span className="text-xs text-ink-3 hidden sm:block">
              <kbd className="px-1.5 py-0.5 bg-surface-muted border border-border rounded text-[10px] font-mono">⌘+Enter</kbd>
              {" "}создать{" · "}
              <kbd className="px-1.5 py-0.5 bg-surface-muted border border-border rounded text-[10px] font-mono">Esc</kbd>
              {" "}отмена
            </span>
            <div className="flex gap-2 ml-auto">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="rounded-lg border border-border px-4 py-2 text-sm text-ink-2 hover:bg-surface-muted disabled:opacity-50 transition-colors"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={!canSubmit}
                className="rounded-lg bg-accent-bright text-white px-5 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                {submitting ? "Создаю…" : "Создать задачу"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
