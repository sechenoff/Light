"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api";
import { formatRub } from "../../lib/format";
import { toast } from "../ToastProvider";
import { VoidPaymentModal } from "./VoidPaymentModal";

interface Payment {
  id: string;
  amount: string;
  method: string | null;
  note: string | null;
  receivedAt: string | null;
  paymentDate: string | null;
  voidedAt: string | null;
}

interface ListResponse {
  items: Payment[];
  total: number;
}

interface BookingContext {
  projectName: string;
  clientName: string;
  amountOutstanding: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  bookingId: string;
  bookingContext: BookingContext;
  onChange?: () => void;
}

const METHOD_LABELS: Record<string, string> = {
  CASH: "Наличные",
  CARD: "Карта",
  BANK_TRANSFER: "Перевод",
  OTHER: "Другое",
};

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * Модалка «Платежи по брони».
 * Показывает список платежей INCOME, полученных по данной брони.
 * SA может аннулировать платёж через VoidPaymentModal.
 */
export function BookingPaymentsModal({ open, onClose, bookingId, bookingContext, onChange }: Props) {
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [voidPaymentId, setVoidPaymentId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // D8: track live outstanding, refreshed after each void
  const [liveOutstanding, setLiveOutstanding] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    apiFetch<ListResponse>(`/api/payments?bookingId=${encodeURIComponent(bookingId)}`)
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) toast.error("Не удалось загрузить платежи"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, bookingId, reloadKey]);

  // D8: fetch fresh amountOutstanding after each void so footer stays accurate
  useEffect(() => {
    if (!open || reloadKey === 0) return;
    let cancelled = false;
    apiFetch<{ amountOutstanding: string }>(`/api/bookings/${encodeURIComponent(bookingId)}`)
      .then((b) => { if (!cancelled) setLiveOutstanding(Number(b.amountOutstanding)); })
      .catch(() => { /* non-critical — fall back to prop */ });
    return () => { cancelled = true; };
  }, [open, bookingId, reloadKey]);

  // Esc to close
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const handleVoided = () => {
    setVoidPaymentId(null);
    setReloadKey((k) => k + 1);
    onChange?.();
  };

  if (!open) return null;

  const items = data?.items ?? [];
  const totalReceived = items
    .filter((p) => !p.voidedAt)
    .reduce((acc, p) => acc + Number(p.amount), 0);
  // D8: use live outstanding from a separate booking fetch, not the stale prop.
  // liveOutstanding is refreshed after each void via reloadKey.
  const outstanding = liveOutstanding ?? Number(bookingContext.amountOutstanding);

  return (
    <>
      <div
        className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div className="bg-surface rounded-lg border border-border shadow-xl w-full max-w-xl flex flex-col max-h-[90vh]">
          {/* Header */}
          <div className="flex items-start justify-between px-5 py-4 border-b border-border flex-shrink-0">
            <div>
              <h2 className="text-[15px] font-semibold text-ink">
                Платежи · {bookingContext.projectName}
              </h2>
              <p className="text-xs text-ink-2 mt-0.5">Клиент: {bookingContext.clientName}</p>
            </div>
            <button
              onClick={onClose}
              aria-label="Закрыть"
              className="text-ink-3 hover:text-ink text-xl leading-none ml-4 flex-shrink-0"
            >
              ×
            </button>
          </div>

          {/* Body */}
          <div className="overflow-y-auto flex-1 px-5 py-4">
            {loading ? (
              <p className="text-sm text-ink-3 text-center py-6">Загрузка…</p>
            ) : items.length === 0 ? (
              <p className="text-sm text-ink-3 text-center py-8">
                На эту бронь платежей не было.
              </p>
            ) : (
              <table className="w-full text-sm border-separate border-spacing-0">
                <thead>
                  <tr>
                    <th className="text-left text-[10px] uppercase tracking-wide text-ink-3 pb-2 font-semibold pr-3">Дата</th>
                    <th className="text-right text-[10px] uppercase tracking-wide text-ink-3 pb-2 font-semibold pr-3">Сумма</th>
                    <th className="text-left text-[10px] uppercase tracking-wide text-ink-3 pb-2 font-semibold pr-3">Метод</th>
                    <th className="text-left text-[10px] uppercase tracking-wide text-ink-3 pb-2 font-semibold">Заметка</th>
                    <th className="pb-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((p) => (
                    <tr
                      key={p.id}
                      className={`border-t border-border ${p.voidedAt ? "opacity-40" : ""}`}
                    >
                      <td className="py-2.5 pr-3 text-ink-2 whitespace-nowrap">
                        {formatDate(p.receivedAt ?? p.paymentDate)}
                      </td>
                      <td className="py-2.5 pr-3 text-right mono-num font-semibold text-ink whitespace-nowrap">
                        {formatRub(p.amount)}
                        {p.voidedAt && (
                          <span className="ml-1 text-[10px] text-rose">(аннул.)</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 text-ink-2 whitespace-nowrap">
                        {p.method ? (METHOD_LABELS[p.method] ?? p.method) : "—"}
                      </td>
                      <td className="py-2.5 text-ink-3 text-xs max-w-[140px] truncate">
                        {p.note ?? ""}
                      </td>
                      <td className="py-2.5 text-right pl-2">
                        {!p.voidedAt && (
                          <button
                            onClick={() => setVoidPaymentId(p.id)}
                            aria-label="Аннулировать платёж"
                            className="text-xs text-rose border border-rose-border bg-rose-soft px-2 py-0.5 rounded hover:opacity-80"
                          >
                            ⊘ Аннул.
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Footer totals */}
          <div className="border-t border-border px-5 py-3 flex items-center justify-between flex-shrink-0">
            <div className="text-xs text-ink-2">
              Получено:{" "}
              <span className="mono-num font-semibold text-ink">{formatRub(totalReceived)}</span>
            </div>
            <div className="text-xs text-ink-2">
              Остаток:{" "}
              <span className={`mono-num font-semibold ${outstanding > 0 ? "text-rose" : "text-emerald-dark"}`}>
                {formatRub(outstanding)}
              </span>
            </div>
            <button
              onClick={onClose}
              className="px-4 py-1.5 text-sm border border-border rounded text-ink-2 hover:bg-surface-subtle"
            >
              Закрыть
            </button>
          </div>
        </div>
      </div>

      <VoidPaymentModal
        open={!!voidPaymentId}
        paymentId={voidPaymentId}
        onClose={() => setVoidPaymentId(null)}
        onVoided={handleVoided}
      />
    </>
  );
}
