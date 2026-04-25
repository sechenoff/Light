"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api";
import { toast } from "../ToastProvider";
import { toMoscowDateString } from "../../lib/moscowDate";

const KIND_LABELS: Record<string, string> = {
  FULL: "Полный",
  DEPOSIT: "Предоплата",
  BALANCE: "Остаток",
  CORRECTION: "Корректировка",
};

interface Props {
  open: boolean;
  onClose: () => void;
  /** Если задан — бронь зафиксирована */
  defaultBookingId?: string;
  /** Сумма брони (авто-заполнение для FULL/BALANCE) */
  defaultTotal?: string;
  onCreated: () => void;
}

/**
 * Модалка «Создать счёт» — создаёт Invoice в статусе DRAFT.
 * POST /api/invoices.
 */
export function CreateInvoiceModal({
  open,
  onClose,
  defaultBookingId,
  defaultTotal,
  onCreated,
}: Props) {
  const [bookingId, setBookingId] = useState(defaultBookingId ?? "");
  const [kind, setKind] = useState("FULL");
  const [total, setTotal] = useState(defaultTotal ?? "");
  const [dueDate, setDueDate] = useState(() => {
    // default today + 14 days
    const d = new Date();
    d.setDate(d.getDate() + 14);
    return toMoscowDateString(d);
  });
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const bookingRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setBookingId(defaultBookingId ?? "");
      setKind("FULL");
      setTotal(defaultTotal ?? "");
      setNotes("");
      if (!defaultBookingId) {
        setTimeout(() => bookingRef.current?.focus(), 50);
      }
    }
  }, [open, defaultBookingId, defaultTotal]);

  // Esc to close
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const isValid = bookingId.trim().length > 0 && Number(total) > 0 && dueDate.length > 0;

  const handleSubmit = async () => {
    if (!isValid) return;
    setSaving(true);
    try {
      await apiFetch("/api/invoices", {
        method: "POST",
        body: JSON.stringify({
          bookingId: bookingId.trim(),
          kind,
          total: Number(total),
          dueDate: dueDate ? new Date(dueDate).toISOString() : undefined,
          notes: notes.trim() || undefined,
        }),
      });
      toast.success("Счёт создан");
      onCreated();
      onClose();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Ошибка создания счёта");
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
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-[15px] font-semibold text-ink">Создать счёт</h2>
          <button
            onClick={onClose}
            aria-label="Закрыть"
            className="text-ink-3 hover:text-ink text-lg leading-none"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-3">
          {/* Booking ID */}
          <div>
            <label className="eyebrow block mb-1">ID брони *</label>
            <input
              ref={bookingRef}
              type="text"
              className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
              placeholder="Введите ID брони"
              value={bookingId}
              onChange={(e) => setBookingId(e.target.value)}
              disabled={!!defaultBookingId}
            />
          </div>

          {/* Kind */}
          <div>
            <label className="eyebrow block mb-1">Тип счёта *</label>
            <select
              className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              {Object.entries(KIND_LABELS).map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>
          </div>

          {/* Total */}
          <div>
            <label className="eyebrow block mb-1">Сумма * (₽)</label>
            <input
              type="number"
              min="0"
              step="0.01"
              className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
              value={total}
              onChange={(e) => setTotal(e.target.value)}
              placeholder="0.00"
            />
          </div>

          {/* Due date */}
          <div>
            <label className="eyebrow block mb-1">Срок оплаты *</label>
            <input
              type="date"
              className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </div>

          {/* Notes */}
          <div>
            <label className="eyebrow block mb-1">Примечание</label>
            <textarea
              className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink resize-none"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
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
            disabled={saving || !isValid}
            className="px-4 py-2 text-sm bg-accent-bright text-white rounded hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Создание…" : "Создать"}
          </button>
        </div>
      </div>
    </div>
  );
}
