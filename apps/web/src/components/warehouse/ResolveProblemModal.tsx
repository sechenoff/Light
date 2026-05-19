"use client";

/**
 * ResolveProblemModal — обязательная заметка при ручном разборе карточки
 * «Потеряшки» (исход FOUND / NOT_FOUND).
 *
 * Паттерн зеркалит src/components/bookings/RejectBookingModal.tsx +
 * overlay-канон src/components/tasks/TaskDetailPanel.tsx:
 *  - Esc / клик по backdrop закрывают (если не идёт отправка),
 *  - авто-фокус в textarea при открытии,
 *  - фокус-ловушка (Tab/Shift+Tab циклятся внутри диалога),
 *  - возврат фокуса на элемент-триггер при закрытии,
 *  - body-scroll-lock пока открыта,
 *  - обязательная заметка (min 3 символа после trim) + счётчик,
 *  - русские подписи и сообщения об ошибке.
 *
 * Никаких сетевых вызовов внутри — submit делегируется наверх через onSubmit.
 */

import { useEffect, useRef, useState } from "react";

export type ResolveOutcome = "FOUND" | "NOT_FOUND";

type Props = {
  open: boolean;
  outcome: ResolveOutcome;
  equipmentName: string;
  loading?: boolean;
  onClose: () => void;
  onSubmit: (note: string) => Promise<void> | void;
};

const OUTCOME_TITLE: Record<ResolveOutcome, string> = {
  FOUND: "Единица найдена",
  NOT_FOUND: "Единица не найдена",
};

const OUTCOME_HINT: Record<ResolveOutcome, string> = {
  FOUND: "Единица вернётся в оборот (статус «Доступна»). Заметка попадёт в журнал.",
  NOT_FOUND: "Карточка закроется без возврата единицы. Заметка попадёт в журнал.",
};

export function ResolveProblemModal({
  open,
  outcome,
  equipmentName,
  loading = false,
  onClose,
  onSubmit,
}: Props) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setNote("");
      setError(null);
    } else {
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !loading) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, loading, onClose]);

  // Restore focus to the element that opened the modal (the trigger) when
  // it closes, and lock body scroll while open — overlay canon, same
  // approach as TaskDetailPanel.
  useEffect(() => {
    if (!open) return;
    const prevFocused = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
      prevFocused?.focus?.();
    };
  }, [open]);

  // Minimal dependency-free focus trap: Tab / Shift+Tab cycle within the
  // dialog only (first ↔ last focusable). Mirrors TaskDetailPanel.
  function handleTrapKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab" || !dialogRef.current) return;
    const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
      'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const activeEl = document.activeElement as HTMLElement | null;
    if (e.shiftKey && (activeEl === first || activeEl === dialogRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && activeEl === last) {
      e.preventDefault();
      first.focus();
    }
  }

  if (!open) return null;

  const trimmedLen = note.trim().length;
  const disabled = loading || trimmedLen < 3;

  const handleSubmit = async () => {
    if (trimmedLen < 3) {
      setError("Укажите заметку (минимум 3 символа)");
      return;
    }
    setError(null);
    try {
      await onSubmit(note.trim());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить разбор");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 px-4"
      onClick={() => !loading && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={OUTCOME_TITLE[outcome]}
        className="w-full max-w-md rounded-lg bg-surface p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleTrapKey}
      >
        <div className="eyebrow mb-2">Разбор карточки</div>
        <h2 className="mb-1 text-lg font-semibold text-ink">{OUTCOME_TITLE[outcome]}</h2>
        <p className="mb-1 text-sm text-ink-2">{equipmentName}</p>
        <p className="mb-4 text-sm text-ink-3">{OUTCOME_HINT[outcome]}</p>

        <label htmlFor="resolve-note" className="mb-2 block text-sm text-ink-2">
          Заметка <span className="text-rose">*</span>
        </label>
        <textarea
          id="resolve-note"
          ref={textareaRef}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={4}
          disabled={loading}
          className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none disabled:opacity-50"
          placeholder={
            outcome === "FOUND"
              ? "Например: нашёлся на складе, был в соседней кофре"
              : "Например: не вернули со смены, клиент не выходит на связь"
          }
          maxLength={2000}
        />
        <div className="mt-1 flex items-center justify-between text-xs text-ink-3">
          <span>{trimmedLen} / 2000</span>
          {error && <span className="text-rose">{error}</span>}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="rounded border border-border px-4 py-2 text-sm text-ink-2 hover:bg-surface-muted disabled:opacity-50"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={disabled}
            className={`rounded px-4 py-2 text-sm text-white disabled:opacity-50 ${
              outcome === "FOUND"
                ? "bg-emerald hover:bg-emerald/90"
                : "bg-rose hover:bg-rose/90"
            }`}
          >
            {loading
              ? "Сохраняю…"
              : outcome === "FOUND"
                ? "Подтвердить «Найдено»"
                : "Подтвердить «Не найдено»"}
          </button>
        </div>
      </div>
    </div>
  );
}
