"use client";

import { useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../lib/api";
import { formatRub } from "../../lib/format";

type Props = {
  open: boolean;
  bookingId: string;
  projectName: string;
  clientName: string;
  /** Текущий остаток долга, строкой из API. */
  outstanding: string;
  onClose: () => void;
  onDone: () => void;
};

/** «600», «1 200,50», «1200.5» → число. NaN, если мусор. */
function parseAmount(raw: string): number {
  const normalized = raw.replace(/\s| /g, "").replace(",", ".");
  if (normalized === "") return NaN;
  return Number(normalized);
}

/**
 * Списание («прощение») остатка долга.
 *
 * Типовой случай — округлённая смета: клиент заплатил ровно, повис хвост в
 * несколько сотен рублей, взыскивать его никто не будет, а бронь держится в
 * дебиторке и мешает закрыть проект.
 *
 * Смету и платежи не трогаем: списание уменьшает только сумму к взысканию.
 * В карточке брони остаётся строка «прощено N ₽», отчёты сходятся.
 */
export function WriteOffDebtModal({
  open,
  bookingId,
  projectName,
  clientName,
  outstanding,
  onClose,
  onDone,
}: Props) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const outstandingNum = Number(outstanding);

  useEffect(() => {
    if (open) {
      // По умолчанию прощаем весь остаток — это и есть «закрыть хвост».
      setAmount(String(outstandingNum));
      setReason("");
      setError(null);
    }
  }, [open, outstandingNum]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, saving, onClose]);

  const parsed = useMemo(() => parseAmount(amount), [amount]);
  const amountValid =
    Number.isFinite(parsed) && parsed > 0 && parsed <= outstandingNum + 0.001;
  const isPartial = amountValid && parsed < outstandingNum - 0.001;

  if (!open) return null;

  const handleSubmit = async () => {
    if (!amountValid || saving) return;
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/api/bookings/${bookingId}/write-off`, {
        method: "POST",
        body: JSON.stringify({
          amount: parsed,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        }),
      });
      onDone();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось списать долг");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/50 px-4"
      onClick={() => !saving && onClose()}
    >
      <div
        className="w-full max-w-md rounded-lg bg-surface p-6 shadow-lg"
        role="dialog"
        aria-modal="true"
        aria-label="Списание долга"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="eyebrow mb-1">Списание долга</div>
        <h2 className="mb-1 text-lg font-semibold text-ink">{projectName}</h2>
        <p className="mb-4 text-sm text-ink-3">
          {clientName} · долг{" "}
          <span className="mono-num font-semibold text-ink-2">{formatRub(outstanding)}</span>
        </p>

        <label htmlFor="writeoff-amount" className="mb-1 block text-sm text-ink-2">
          Простить, ₽ <span className="text-rose">*</span>
        </label>
        <input
          id="writeoff-amount"
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && amountValid) {
              e.preventDefault();
              void handleSubmit();
            }
          }}
          disabled={saving}
          aria-invalid={amount.trim() !== "" && !amountValid}
          className="mono-num w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-lg font-semibold text-ink focus:border-accent-bright focus:outline-none"
        />
        <div className="mt-1 min-h-[1rem] text-xs">
          {amount.trim() !== "" && !amountValid ? (
            <span className="text-rose">
              Сумма должна быть от 0 до остатка ({formatRub(outstanding)})
            </span>
          ) : isPartial ? (
            <span className="text-amber">
              Останется долг {formatRub(String(outstandingNum - parsed))}
            </span>
          ) : amountValid ? (
            <span className="text-emerald">Долг закроется полностью, бронь уйдёт из дебиторки</span>
          ) : null}
        </div>

        <label htmlFor="writeoff-reason" className="mb-1 mt-3 block text-sm text-ink-2">
          Причина <span className="text-ink-3">· опционально</span>
        </label>
        <input
          id="writeoff-reason"
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={saving}
          placeholder="Округление сметы"
          maxLength={500}
          className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
        />

        <p className="mt-3 rounded border border-border bg-surface-muted px-3 py-2 text-xs text-ink-3">
          Смета и платежи не меняются. В карточке брони останется строка «прощено» —
          видно, сколько выставили, сколько получили и сколько простили. Списание
          можно отменить на карточке брони.
        </p>

        {error && (
          <p className="mt-3 rounded border border-rose-border bg-rose-soft px-3 py-2 text-sm text-rose">
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded border border-border px-4 py-2 text-sm text-ink-2 hover:bg-surface-muted disabled:opacity-50"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!amountValid || saving}
            className="rounded bg-accent-bright px-5 py-2 text-sm font-medium text-surface transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Списываю…" : "Простить долг"}
          </button>
        </div>
      </div>
    </div>
  );
}
