"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api";
import { formatRub } from "../../lib/format";
import { toast } from "../ToastProvider";

const METHOD_LABELS: Record<string, string> = {
  CASH: "Наличные",
  BANK_TRANSFER: "Перевод",
  CARD: "Карта",
  OTHER: "Другое",
};

interface Booking {
  id: string;
  displayName: string;
  projectName: string;
  finalAmount: string;
  amountPaid: string;
  amountOutstanding: string;
  client: { name: string };
}

interface Props {
  booking: Booking;
  onClose: () => void;
  onSaved: () => void;
}

export function QuickPaymentModal({ booking, onClose, onSaved }: Props) {
  const [amount, setAmount] = useState(booking.amountOutstanding);
  const [method, setMethod] = useState("CASH");
  const [receivedAt, setReceivedAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);

  // Auto-focus on mount
  useEffect(() => {
    amountRef.current?.focus();
    amountRef.current?.select();
  }, []);

  // Close on Esc
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleSubmit = async () => {
    if (!amount || Number(amount) <= 0) {
      toast.error("Введите сумму платежа");
      return;
    }
    setSaving(true);
    try {
      await apiFetch("/api/payments", {
        method: "POST",
        body: JSON.stringify({
          bookingId: booking.id,
          amount: Number(amount),
          method,
          receivedAt: new Date(`${receivedAt}T12:00:00.000Z`).toISOString(),
          note: note.trim() || undefined,
        }),
      });
      toast.success("Платёж зафиксирован");
      onSaved();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Ошибка сохранения платежа");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-surface rounded-lg border border-border shadow-xl w-full max-w-md">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-[15px] font-semibold text-ink">Зафиксировать платёж</h2>
          <button
            onClick={onClose}
            aria-label="Закрыть"
            className="text-ink-3 hover:text-ink text-lg leading-none"
          >
            ×
          </button>
        </div>

        {/* Booking info */}
        <div className="px-5 pt-4 pb-2 bg-surface-subtle border-b border-border">
          <p className="text-sm font-medium text-ink">{booking.client.name}</p>
          <p className="text-xs text-ink-2 mt-0.5">{booking.projectName}</p>
          <div className="flex gap-4 mt-2 text-xs text-ink-2">
            <span>Итого: <span className="mono-num font-medium text-ink">{formatRub(booking.finalAmount)}</span></span>
            <span>Оплачено: <span className="mono-num font-medium text-emerald">{formatRub(booking.amountPaid)}</span></span>
            <span>Остаток: <span className="mono-num font-medium text-rose">{formatRub(booking.amountOutstanding)}</span></span>
          </div>
        </div>

        {/* Form */}
        <div className="px-5 py-4 space-y-3">
          <div>
            <label className="eyebrow block mb-1">Сумма *</label>
            <input
              ref={amountRef}
              type="number"
              className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              min="0"
            />
          </div>
          <div>
            <label className="eyebrow block mb-1">Способ оплаты</label>
            <select
              className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
            >
              {Object.entries(METHOD_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="eyebrow block mb-1">Дата получения</label>
            <input
              type="date"
              className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
              value={receivedAt}
              onChange={(e) => setReceivedAt(e.target.value)}
            />
          </div>
          <div>
            <label className="eyebrow block mb-1">Примечание</label>
            <textarea
              className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink resize-none"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Необязательно"
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2 justify-end px-5 pb-5">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm border border-border rounded text-ink-2 hover:bg-surface-subtle"
          >
            Отмена
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent-bright disabled:opacity-50"
          >
            {saving ? "Сохранение…" : "Сохранить платёж"}
          </button>
        </div>
      </div>
    </div>
  );
}
