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

interface InvoiceOption {
  id: string;
  number: string | null;
  kind: string;
  total: string;
  paidAmount: string;
  dueDate: string | null;
  status: string;
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
  /**
   * D2: Если false — бронь post-cutoff, показываем селектор счетов.
   * Если true или undefined — легаси-режим, селектор скрыт.
   */
  legacyFinance?: boolean;
  onCreated: () => void;
}

const KIND_LABELS: Record<string, string> = {
  FULL: "Полный",
  DEPOSIT: "Предоплата",
  BALANCE: "Остаток",
  CORRECTION: "Корректировка",
};

/**
 * Единая модалка «Записать платёж».
 * Используется на: /bookings/[id], /finance/payments, /warehouse/scan.
 * Заменяет quickAddPayment (prompt) и AddPaymentModal.
 *
 * D2: Добавлен селектор счёта для post-cutoff броней (legacyFinance===false).
 * При выборе счёта invoiceId включается в POST /api/payments, что запускает
 * recomputeInvoiceStatus и обновляет статус счёта.
 */
export function RecordPaymentModal({
  open,
  onClose,
  defaultBookingId,
  defaultMethod = "CASH",
  bookingContext,
  legacyFinance,
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

  // D2: Invoice selector state
  const [invoices, setInvoices] = useState<InvoiceOption[]>([]);
  const [invoiceId, setInvoiceId] = useState<string>("");
  const [invoicesLoading, setInvoicesLoading] = useState(false);

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

  // D2: Load open invoices for the booking when post-cutoff mode
  const effectiveBookingId = defaultBookingId ?? bookingId;
  useEffect(() => {
    // Only fetch invoices for post-cutoff bookings (legacyFinance===false)
    if (!open || legacyFinance !== false || !effectiveBookingId) {
      setInvoices([]);
      setInvoiceId("");
      return;
    }
    let cancelled = false;
    setInvoicesLoading(true);
    apiFetch<{ items: InvoiceOption[] }>(
      `/api/invoices?bookingId=${effectiveBookingId}&status=DRAFT,ISSUED,PARTIAL_PAID,OVERDUE&limit=50`
    )
      .then((d) => {
        if (cancelled) return;
        const openInvoices = (d.items ?? []).filter((inv) => inv.status !== "VOID");
        setInvoices(openInvoices);
        // Default: earliest unpaid (first by createdAt asc — server returns desc, so last item)
        // Actually server returns desc, so the "oldest" is the last. Pick first non-paid as default.
        const defaultInv = openInvoices.find(
          (inv) => inv.status !== "PAID"
        );
        setInvoiceId(defaultInv?.id ?? "");
      })
      .catch(() => { if (!cancelled) setInvoices([]); })
      .finally(() => { if (!cancelled) setInvoicesLoading(false); });
    return () => { cancelled = true; };
  }, [open, legacyFinance, effectiveBookingId]);

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
      // D2: include invoiceId when available (post-cutoff mode)
      const payload: Record<string, unknown> = {
        bookingId: bid,
        amount: amt,
        method,
        receivedAt: new Date(receivedAt).toISOString(),
        note: note.trim() || undefined,
      };
      if (legacyFinance === false && invoiceId) {
        payload.invoiceId = invoiceId;
      }
      await apiFetch("/api/payments", {
        method: "POST",
        body: JSON.stringify(payload),
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

  // D2: determine if we should show invoice selector
  const showInvoiceSelector = legacyFinance === false && !!effectiveBookingId;

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

          {/* D2: Invoice selector for post-cutoff bookings */}
          {showInvoiceSelector && (
            <div>
              <label className="eyebrow block mb-1">Счёт</label>
              {invoicesLoading ? (
                <p className="text-xs text-ink-3">Загрузка счетов…</p>
              ) : invoices.length === 0 ? (
                <p className="text-xs text-amber">
                  У брони нет открытых счетов —{" "}
                  <a href={`/finance/invoices`} className="underline text-accent">перейти к счетам</a>
                </p>
              ) : (
                <select
                  className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
                  value={invoiceId}
                  onChange={(e) => setInvoiceId(e.target.value)}
                >
                  <option value="">— Без счёта —</option>
                  {invoices.map((inv) => {
                    const remaining = Number(inv.total) - Number(inv.paidAmount);
                    const kindLabel = KIND_LABELS[inv.kind] ?? inv.kind;
                    const numLabel = inv.number ?? "Черновик";
                    return (
                      <option key={inv.id} value={inv.id}>
                        {numLabel} · {kindLabel} · {formatRub(remaining.toFixed(2))} остаток
                      </option>
                    );
                  })}
                </select>
              )}
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
