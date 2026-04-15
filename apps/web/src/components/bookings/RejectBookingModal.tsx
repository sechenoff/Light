"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  open: boolean;
  bookingDisplayName: string;
  loading?: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void> | void;
};

export function RejectBookingModal({ open, bookingDisplayName, loading = false, onClose, onSubmit }: Props) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) {
      setReason("");
      setError(null);
    } else {
      // Фокус в textarea при открытии
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

  if (!open) return null;

  const trimmedLen = reason.trim().length;
  const disabled = loading || trimmedLen < 3;

  const handleSubmit = async () => {
    if (trimmedLen < 3) {
      setError("Укажите причину отклонения (минимум 3 символа)");
      return;
    }
    setError(null);
    try {
      await onSubmit(reason.trim());
    } catch (e: any) {
      setError(e?.message ?? "Не удалось отклонить бронь");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-1/50 px-4"
      onClick={() => !loading && onClose()}
    >
      <div
        className="w-full max-w-md rounded-lg bg-surface p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="eyebrow mb-2">Отклонение брони</div>
        <h2 className="mb-1 text-lg font-semibold text-ink-1">{bookingDisplayName}</h2>
        <p className="mb-4 text-sm text-ink-3">
          Бронь вернётся в черновик. Причина будет показана кладовщику и записана в журнал аудита.
        </p>

        <label htmlFor="reject-reason" className="mb-2 block text-sm text-ink-2">
          Причина отклонения <span className="text-rose">*</span>
        </label>
        <textarea
          id="reject-reason"
          ref={textareaRef}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={4}
          disabled={loading}
          className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-ink-1 focus:border-accent focus:outline-none"
          placeholder="Например: пересчитайте скидку, слишком высокая для этого клиента"
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
            className="rounded border border-border px-4 py-2 text-sm text-ink-2 hover:bg-surface-soft disabled:opacity-50"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={disabled}
            className="rounded bg-rose px-4 py-2 text-sm text-white hover:bg-rose/90 disabled:opacity-50"
          >
            {loading ? "Отклоняю…" : "Отклонить"}
          </button>
        </div>
      </div>
    </div>
  );
}
