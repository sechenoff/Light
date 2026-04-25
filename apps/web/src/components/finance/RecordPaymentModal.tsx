"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api";
import { formatRub } from "../../lib/format";
import { toast } from "../ToastProvider";
import { toMoscowDateString } from "../../lib/moscowDate";

const METHOD_LABELS: Record<string, string> = {
  CASH: "Наличные",
  CARD: "Карта",
  BANK_TRANSFER: "Перевод",
  OTHER: "Другое",
};

interface BookingOption {
  id: string;
  displayName?: string;
  projectName: string;
  finalAmount?: string;
  amountPaid?: string;
  amountOutstanding?: string;
  client: { name: string };
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Если задан — поле bookingId заблокировано */
  defaultBookingId?: string;
  defaultDirection?: "IN" | "OUT";
  defaultMethod?: string;
  /** Контекст брони для отображения сводки */
  bookingContext?: BookingOption;
  onCreated: () => void;
}

/**
 * Единая модалка «Записать платёж».
 * Используется на: /bookings/[id], /finance/payments, /warehouse/scan.
 * Заменяет quickAddPayment (prompt) и AddPaymentModal.
 */
export function RecordPaymentModal({
  open,
  onClose,
  defaultBookingId,
  defaultMethod = "CASH",
  bookingContext,
  onCreated,
}: Props) {
  const [bookingId, setBookingId] = useState(defaultBookingId ?? "");
  const [amount, setAmount] = useState(bookingContext?.amountOutstanding ?? "");
  const [method, setMethod] = useState(defaultMethod);
  // A3: Use Moscow TZ for default receivedAt — platform standardises on MSK.
  // Format YYYY-MM-DDTHH:mm for datetime-local input, computed in Moscow TZ.
  const [receivedAt, setReceivedAt] = useState(() => {
    const now = new Date();
    const datePart = toMoscowDateString(now); // YYYY-MM-DD in Moscow TZ
    // Hours and minutes in Moscow TZ (UTC+3)
    const mskNow = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    const hh = String(mskNow.getUTCHours()).padStart(2, "0");
    const mm = String(mskNow.getUTCMinutes()).padStart(2, "0");
    return `${datePart}T${hh}:${mm}`;
  });
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [bookings, setBookings] = useState<BookingOption[]>([]);
  const amountRef = useRef<HTMLInputElement>(null);

  // Auto-focus amount on open
  useEffect(() => {
    if (open) {
      amountRef.current?.focus();
      amountRef.current?.select();
    }
  }, [open]);

  // Esc to close
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Load bookings list when no defaultBookingId
  // C2: server Zod enum rejects comma-separated; fetch 3 separate requests and merge.
  useEffect(() => {
    if (!open || defaultBookingId) return;
    let cancelled = false;
    Promise.all([
      apiFetch<{ bookings: BookingOption[] }>("/api/bookings?status=CONFIRMED&limit=100"),
      apiFetch<{ bookings: BookingOption[] }>("/api/bookings?status=ISSUED&limit=100"),
      apiFetch<{ bookings: BookingOption[] }>("/api/bookings?status=RETURNED&limit=100"),
    ])
      .then(([c, i, r]) => {
        if (cancelled) return;
        const all = [
          ...(c.bookings ?? []),
          ...(i.bookings ?? []),
          ...(r.bookings ?? []),
        ];
        setBookings(all);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [open, defaultBookingId]);

  // Reset form on open
  useEffect(() => {
    if (open) {
      setBookingId(defaultBookingId ?? "");
      setAmount(bookingContext?.amountOutstanding ?? "");
      setMethod(defaultMethod);
      // A3: Moscow TZ default
      const now = new Date();
      const datePart = toMoscowDateString(now);
      const mskNow = new Date(now.getTime() + 3 * 60 * 60 * 1000);
      const hh = String(mskNow.getUTCHours()).padStart(2, "0");
      const mm = String(mskNow.getUTCMinutes()).padStart(2, "0");
      setReceivedAt(`${datePart}T${hh}:${mm}`);
      setNote("");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleSubmit = async () => {
    const bid = defaultBookingId ?? bookingId;
    if (!bid) { toast.error("Выберите бронирование"); return; }
    const amt = Number(amount);
    if (!amount || !Number.isFinite(amt) || amt <= 0) { toast.error("Введите корректную сумму"); return; }
    setSaving(true);
    try {
      await apiFetch("/api/payments", {
        method: "POST",
        body: JSON.stringify({
          bookingId: bid,
          amount: amt,
          method,
          receivedAt: new Date(receivedAt).toISOString(),
          note: note.trim() || undefined,
        }),
      });
      toast.success("Платёж зафиксирован");
      onCreated();
    } catch (e: unknown) {
      // Проверяем структурированный код из details.code
      const details = (e as any)?.details;
      const code = typeof details === "object" && details !== null ? (details as any).code : undefined;
      const field = typeof details === "object" && details !== null ? (details as any).field : undefined;
      if (code === "PAYMENT_LIMIT_EXCEEDED") {
        if (field === "amount") {
          toast.error("Сумма больше лимита 100 000 ₽");
        } else if (field === "method") {
          toast.error("Этот метод недоступен для вашей роли");
        } else if (field === "bookingStatus") {
          toast.error("Бронь не выдана — оплату принять нельзя");
        } else {
          toast.error("Превышен лимит платежа для кладовщика");
        }
      } else {
        toast.error(e instanceof Error ? e.message : "Ошибка сохранения");
      }
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
      <div className="bg-surface rounded-lg border border-border shadow-xl w-full max-w-md">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-[15px] font-semibold text-ink">Записать платёж</h2>
          <button
            onClick={onClose}
            aria-label="Закрыть"
            className="text-ink-3 hover:text-ink text-lg leading-none"
          >
            ×
          </button>
        </div>

        {/* Booking summary (if context provided) */}
        {bookingContext && (
          <div className="px-5 pt-4 pb-2 bg-surface-subtle border-b border-border">
            <p className="text-sm font-medium text-ink">{bookingContext.client.name}</p>
            <p className="text-xs text-ink-2 mt-0.5">{bookingContext.projectName}</p>
            {bookingContext.finalAmount && (
              <div className="flex gap-4 mt-2 text-xs text-ink-2">
                <span>Итого: <span className="mono-num font-medium text-ink">{formatRub(bookingContext.finalAmount)}</span></span>
                {bookingContext.amountPaid && (
                  <span>Оплачено: <span className="mono-num font-medium text-emerald">{formatRub(bookingContext.amountPaid)}</span></span>
                )}
                {bookingContext.amountOutstanding && (
                  <span>Остаток: <span className="mono-num font-medium text-rose">{formatRub(bookingContext.amountOutstanding)}</span></span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Form */}
        <div className="px-5 py-4 space-y-3">
          {/* Booking selector (only if no defaultBookingId) */}
          {!defaultBookingId && (
            <div>
              <label className="eyebrow block mb-1">Бронирование *</label>
              <select
                className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
                value={bookingId}
                onChange={(e) => setBookingId(e.target.value)}
              >
                <option value="">— выберите бронирование —</option>
                {bookings.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.client.name} — {b.projectName}
                    {b.amountOutstanding && ` — остаток ${formatRub(b.amountOutstanding)}`}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Amount */}
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

          {/* Method */}
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

          {/* Date */}
          <div>
            <label className="eyebrow block mb-1">Дата получения</label>
            <input
              type="datetime-local"
              className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
              value={receivedAt}
              onChange={(e) => setReceivedAt(e.target.value)}
            />
          </div>

          {/* Note */}
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
            {saving ? "Сохранение…" : "Записать платёж"}
          </button>
        </div>
      </div>
    </div>
  );
}
