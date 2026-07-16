"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  open: boolean;
  /** Eyebrow-заголовок модалки, например «Возврат брони» */
  title: string;
  /** Название брони (дата · клиент · проект) */
  subtitle?: string;
  /** Текст-пояснение: что произойдёт и почему это важно */
  message: string;
  /** Подпись кнопки подтверждения, например «Вернуть» */
  confirmLabel: string;
  /** danger — красная кнопка (отмена брони), primary — акцентная */
  tone?: "danger" | "primary";
  /** Typed-confirmation: слово, которое нужно ввести дословно, чтобы
   *  разблокировать кнопку (например «УДАЛИТЬ» для необратимого purge). */
  requireTyped?: string;
  loading?: boolean;
  onClose: () => void;
  onConfirm: () => void;
};

/**
 * Лёгкая модалка подтверждения необратимых действий (стиль RejectBookingModal):
 * Esc и клик по фону закрывают, фокус на кнопке подтверждения.
 * Используется для «Вернуть» / «Отменить» в списке броней — RETURNED и
 * CANCELLED терминальны, пути назад через UI нет.
 */
export function ConfirmActionModal({
  open,
  title,
  subtitle,
  message,
  confirmLabel,
  tone = "danger",
  requireTyped,
  loading = false,
  onClose,
  onConfirm,
}: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [typed, setTyped] = useState("");
  const typedOk = !requireTyped || typed.trim() === requireTyped;

  useEffect(() => {
    if (open) {
      setTyped("");
      // Фокус: при typed-confirmation — на поле ввода, иначе на кнопке.
      setTimeout(() => {
        if (requireTyped) {
          (document.getElementById("confirm-typed-input") as HTMLInputElement | null)?.focus();
        } else {
          confirmRef.current?.focus();
        }
      }, 50);
    }
  }, [open, requireTyped]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !loading) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, loading, onClose]);

  if (!open) return null;

  const confirmClass =
    tone === "danger"
      ? "rounded bg-rose px-4 py-2 text-sm text-white hover:bg-rose/90 disabled:opacity-50"
      : "rounded bg-accent-bright px-4 py-2 text-sm text-white hover:bg-accent disabled:opacity-50";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 px-4"
      onClick={() => !loading && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="w-full max-w-md rounded-lg bg-surface p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="eyebrow mb-2">{title}</div>
        {subtitle && <h2 className="mb-1 text-lg font-semibold text-ink">{subtitle}</h2>}
        <p className={`mt-2 whitespace-pre-wrap text-sm text-ink-2 ${requireTyped ? "mb-3" : "mb-5"}`}>{message}</p>

        {requireTyped && (
          <div className="mb-5">
            <label htmlFor="confirm-typed-input" className="mb-1 block text-xs text-ink-3">
              Для подтверждения введите <span className="font-mono font-semibold text-ink">{requireTyped}</span>
            </label>
            <input
              id="confirm-typed-input"
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              disabled={loading}
              autoComplete="off"
              className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-rose focus:outline-none disabled:opacity-50"
            />
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="rounded border border-border px-4 py-2 text-sm text-ink-2 hover:bg-surface-soft disabled:opacity-50"
          >
            Отмена
          </button>
          <button
            type="button"
            ref={confirmRef}
            onClick={onConfirm}
            disabled={loading || !typedOk}
            className={confirmClass}
          >
            {loading ? "Выполняю…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
