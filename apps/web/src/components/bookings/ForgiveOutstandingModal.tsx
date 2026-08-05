"use client";

import { useEffect, useRef, useState } from "react";
import { formatMoneyRub } from "../../lib/format";

/**
 * Модалка «Простить остаток» (SUPER_ADMIN, ISSUED|RETURNED, долг > 0).
 *
 * Сценарий владельца: клиент недоплатил, долг прощён — итог брони фиксируется
 * по фактически полученной сумме (manualFinalAmount = amountPaid), долг
 * обнуляется. Причина обязательна: уходит в аудит и хронологию денег.
 * Паттерн модалки — RejectBookingModal (Esc, backdrop, автофокус, min 3).
 */
export function ForgiveOutstandingModal({
  open,
  bookingLabel,
  outstanding,
  amountPaid,
  loading,
  onClose,
  onSubmit,
}: {
  open: boolean;
  bookingLabel: string;
  /** Сумма долга, которая будет прощена (строка Decimal). */
  outstanding: string;
  /** Фактически получено — станет итогом брони. */
  amountPaid: string;
  loading: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setReason("");
      setError(null);
      // Автофокус после маунта контента модалки.
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !loading) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, loading, onClose]);

  if (!open) return null;

  const trimmed = reason.trim();
  const canSubmit = trimmed.length >= 3 && !loading;

  async function submit() {
    if (!canSubmit) return;
    setError(null);
    try {
      await onSubmit(trimmed);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось простить остаток");
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/50 p-4"
      onClick={() => {
        if (!loading) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Простить остаток долга"
        className="w-full max-w-[440px] rounded-lg border border-border bg-surface p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="eyebrow mb-1 text-rose">Простить остаток</p>
        <h2 className="text-[15px] font-semibold text-ink">{bookingLabel}</h2>

        <div className="mt-3 space-y-1.5 rounded-lg bg-surface-muted px-3 py-2.5 text-sm">
          <div className="flex justify-between">
            <span className="text-ink-2">Долг к прощению</span>
            <span className="mono-num font-semibold text-rose">
              −{formatMoneyRub(outstanding)}
            </span>
          </div>
          <div className="flex justify-between border-t border-border pt-1.5">
            <span className="text-ink-2">Итог брони станет</span>
            <span className="mono-num font-semibold text-ink">
              {formatMoneyRub(amountPaid)}
            </span>
          </div>
          <p className="pt-0.5 text-xs text-ink-3">
            Итог фиксируется по фактически полученной сумме, долг обнуляется.
            Действие попадёт в аудит и хронологию денег.
          </p>
        </div>

        <label className="mt-3 block">
          <span className="mb-1 block text-xs font-medium text-ink-2">
            Причина <span className="text-rose">*</span>
          </span>
          <textarea
            ref={textareaRef}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            disabled={loading}
            placeholder="Например: договорились о скидке по итогам смены"
            className="w-full rounded border border-border bg-surface px-3 py-2 text-sm focus:border-accent-bright focus:outline-none disabled:opacity-60"
          />
          <span className="mt-0.5 block text-right text-[11px] text-ink-3">
            {trimmed.length < 3 ? `минимум 3 символа` : `${trimmed.length} симв.`}
          </span>
        </label>

        {error && (
          <p role="alert" className="mt-2 rounded border border-rose-border bg-rose-soft px-3 py-2 text-sm text-rose">
            {error}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="rounded border border-border px-4 py-2 text-sm hover:bg-surface-muted disabled:opacity-50"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            className="rounded bg-rose px-4 py-2 text-sm font-semibold text-surface hover:opacity-90 disabled:opacity-50"
          >
            {loading ? "Прощаю…" : `Простить ${formatMoneyRub(outstanding)}`}
          </button>
        </div>
      </div>
    </div>
  );
}
