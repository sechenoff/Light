"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api";
import { toast } from "../ToastProvider";
import { toMoscowDateString } from "../../lib/moscowDate";

const METHOD_LABELS: Record<string, string> = {
  CASH: "Наличные",
  CARD: "Карта",
  BANK_TRANSFER: "Перевод",
  OTHER: "Другое",
};

interface Props {
  open: boolean;
  onClose: () => void;
  invoiceId?: string;
  paymentId?: string;
  bookingId?: string;
  onSuccess: () => void;
}

/**
 * Модалка «Оформить возврат».
 * POST /api/refunds
 */
export function RefundModal({ open, onClose, invoiceId, paymentId, bookingId, onSuccess }: Props) {
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("CASH");
  const [reason, setReason] = useState("");
  const [refundedAt, setRefundedAt] = useState(() => {
    const now = new Date();
    const datePart = toMoscowDateString(now);
    const mskNow = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    const hh = String(mskNow.getUTCHours()).padStart(2, "0");
    const mm = String(mskNow.getUTCMinutes()).padStart(2, "0");
    return `${datePart}T${hh}:${mm}`;
  });
  const [saving, setSaving] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setAmount("");
      setReason("");
      setTimeout(() => amountRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const trimmedReason = reason.trim();
  const isValid = Number(amount) > 0 && trimmedReason.length >= 3;

  const handleSubmit = async () => {
    if (!isValid) return;
    setSaving(true);
    try {
      await apiFetch("/api/refunds", {
        method: "POST",
        body: JSON.stringify({
          invoiceId,
          paymentId,
          bookingId,
          amount: Number(amount),
          method,
          reason: trimmedReason,
          refundedAt: refundedAt ? new Date(refundedAt).toISOString() : undefined,
        }),
      });
      toast.success("Возврат оформлен");
      onSuccess();
      onClose();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Ошибка оформления возврата");
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-surface rounded-lg border border-border shadow-xl w-full max-w-sm">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-[15px] font-semibold text-ink">Оформить возврат</h2>
          <button onClick={onClose} aria-label="Закрыть" className="text-ink-3 hover:text-ink text-lg leading-none">×</button>
        </div>

        <div className="px-5 py-4 space-y-3">
          {/* Amount */}
          <div>
            <label className="eyebrow block mb-1">Сумма возврата * (₽)</label>
            <input
              ref={amountRef}
              type="number"
              min="0.01"
              step="0.01"
              className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
            />
          </div>

          {/* Method */}
          <div>
            <label className="eyebrow block mb-1">Способ возврата *</label>
            <select
              className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
            >
              {Object.entries(METHOD_LABELS).map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>
          </div>

          {/* Reason */}
          <div>
            <label className="eyebrow block mb-1">
              Причина * <span className="text-ink-3 font-normal">({trimmedReason.length}/3 мин.)</span>
            </label>
            <textarea
              className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink resize-none"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Например: отмена брони по согласованию"
            />
          </div>

          {/* Date */}
          <div>
            <label className="eyebrow block mb-1">Дата возврата</label>
            <input
              type="datetime-local"
              className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
              value={refundedAt}
              onChange={(e) => setRefundedAt(e.target.value)}
            />
          </div>
        </div>

        <div className="flex gap-2 justify-end px-5 pb-5">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-border rounded text-ink-2 hover:bg-surface-subtle">
            Отмена
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving || !isValid}
            className="px-4 py-2 text-sm bg-amber text-white rounded hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Оформление…" : "Оформить возврат"}
          </button>
        </div>
      </div>
    </div>
  );
}
