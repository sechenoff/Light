"use client";

/**
 * «Отменить продолжение» — продолжение оформили по ошибке: оставленное вернули
 * вместе с основной бронью. Причина обязательна (журнал), единицы встают на
 * склад, долг по продолжению исчезает. Только руководитель.
 */
import { useState } from "react";

import { apiFetch } from "@/lib/api";
import { useDialog } from "@/hooks/useDialog";
import { toast } from "../ToastProvider";

type Props = {
  bookingId: string;
  docNumber: string | null;
  onClose: () => void;
  onDone: () => void;
};

const MIN_REASON = 3;

export function CancelContinuationModal({ bookingId, docNumber, onClose, onDone }: Props) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useDialog<HTMLDivElement>(true, () => !busy && onClose());
  const ok = reason.trim().length >= MIN_REASON;

  async function submit() {
    if (!ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/bookings/${bookingId}/cancel-continuation`, {
        method: "POST",
        body: JSON.stringify({ reason: reason.trim() }),
      });
      toast.success("Продолжение отменено — оборудование снова на складе");
      onDone();
      onClose();
    } catch (e: any) {
      setError(e?.message ?? "Не удалось отменить продолжение");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-scrim/50 sm:items-center sm:px-4" onClick={() => !busy && onClose()}>
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cancel-continuation-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full rounded-t-xl border border-border bg-surface p-5 shadow-xl outline-none sm:max-w-[440px] sm:rounded-lg"
      >
        <p className="eyebrow">Продолжение{docNumber ? ` · ${docNumber}` : ""}</p>
        <h2 id="cancel-continuation-title" className="mt-1 text-[16px] font-semibold text-ink">
          Отменить продолжение?
        </h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
          Значит, оставленное на самом деле вернули вместе с основной бронью. Оборудование снова станет свободным на складе,
          а сумма продолжения уйдёт из долгов клиента.
        </p>
        <label className="mt-3 block">
          <span className="eyebrow mb-1 block">Почему отменяете</span>
          <textarea
            autoFocus
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={busy}
            placeholder="Например: всё привезли вместе с основной, продолжение оформили по ошибке"
            className="w-full resize-none rounded border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
          />
        </label>
        {error && <p role="alert" className="mt-2 text-[12.5px] text-rose">{error}</p>}
        <div className="mt-4 flex flex-col-reverse gap-2 pb-[env(safe-area-inset-bottom)] sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="min-h-11 rounded border border-border bg-surface px-4 text-sm text-ink-2 hover:bg-surface-subtle sm:min-h-10"
          >
            Не отменять
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!ok || busy}
            className="min-h-11 rounded border border-rose-border bg-rose-soft px-4 text-sm font-semibold text-rose hover:bg-rose hover:text-surface disabled:opacity-50 sm:min-h-10"
          >
            {busy ? "Отменяем…" : "Отменить продолжение"}
          </button>
        </div>
      </div>
    </div>
  );
}
