"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";
import { formatRub } from "../../lib/format";
import { toast } from "../ToastProvider";
import { toMoscowDateString } from "../../lib/moscowDate";

type Branch = "refund" | "credit" | "forfeit";

interface Props {
  open: boolean;
  onClose: () => void;
  bookingId: string;
  bookingDisplayName: string;
  clientId: string;
  clientName: string;
  depositTotal: number;
  onCancelled: () => void;
}

/**
 * Мастер «Отменить бронь с депозитом» — 3-шаговый wizard.
 * Шаг 1: выбор ветки (возврат / кредит / штраф)
 * Шаг 2: детали выбранной ветки
 * Шаг 3: подтверждение
 */
export function CancelWithDepositModal({
  open,
  onClose,
  bookingId,
  bookingDisplayName,
  clientId,
  clientName,
  depositTotal,
  onCancelled,
}: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [branch, setBranch] = useState<Branch>("refund");
  const [saving, setSaving] = useState(false);

  // Refund fields
  const [refundAmount, setRefundAmount] = useState(String(depositTotal));
  const [refundMethod, setRefundMethod] = useState("CASH");
  const [refundReason, setRefundReason] = useState("");

  // Credit note fields
  const [creditAmount, setCreditAmount] = useState(String(depositTotal));
  const [creditReason, setCreditReason] = useState("");
  const [creditExpires, setCreditExpires] = useState(() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 1);
    return toMoscowDateString(d);
  });

  // Forfeit — no extra fields

  useEffect(() => {
    if (open) {
      setStep(1);
      setBranch("refund");
      setRefundAmount(String(depositTotal));
      setRefundReason("");
      setCreditAmount(String(depositTotal));
      setCreditReason("");
    }
  }, [open, depositTotal]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  async function handleCommit() {
    setSaving(true);
    try {
      // H5: Единый атомарный endpoint вместо 2-3 последовательных вызовов.
      // Всё выполняется в одной DB-транзакции на сервере.
      if (branch === "refund" && refundReason.trim().length < 3) {
        toast.error("Укажите причину возврата (минимум 3 символа)");
        setSaving(false);
        return;
      }
      if (branch === "credit" && creditReason.trim().length < 3) {
        toast.error("Укажите причину кредит-ноты (минимум 3 символа)");
        setSaving(false);
        return;
      }

      await apiFetch(`/api/bookings/${bookingId}/cancel-with-deposit`, {
        method: "POST",
        body: JSON.stringify({
          disposition: branch.toUpperCase(),
          ...(branch === "refund"
            ? {
                refund: {
                  amount: Number(refundAmount),
                  method: refundMethod,
                  reason: refundReason.trim(),
                },
              }
            : {}),
          ...(branch === "credit"
            ? {
                credit: {
                  contactClientId: clientId,
                  amount: Number(creditAmount),
                  reason: creditReason.trim(),
                  expiresAt: creditExpires ? new Date(creditExpires).toISOString() : undefined,
                },
              }
            : {}),
        }),
      });

      toast.success(
        branch === "refund"
          ? "Бронь отменена, возврат оформлен"
          : branch === "credit"
          ? "Бронь отменена, кредит-нота создана"
          : "Бронь отменена, депозит удержан как штраф"
      );
      onCancelled();
      onClose();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Ошибка отмены брони");
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  const methodLabels: Record<string, string> = {
    CASH: "Наличные",
    CARD: "Карта",
    BANK_TRANSFER: "Перевод",
    OTHER: "Другое",
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-surface rounded-lg border border-border shadow-xl w-full max-w-md">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <h2 className="text-[15px] font-semibold text-ink">Отмена брони</h2>
            <p className="text-xs text-ink-3 mt-0.5">{bookingDisplayName} · {clientName}</p>
          </div>
          <button onClick={onClose} aria-label="Закрыть" className="text-ink-3 hover:text-ink text-lg leading-none">×</button>
        </div>

        {/* Step indicator */}
        <div className="flex gap-1.5 px-5 pt-3">
          {[1, 2, 3].map((s) => (
            <div
              key={s}
              className={`flex-1 h-1 rounded-full transition-colors ${s <= step ? "bg-accent-bright" : "bg-border"}`}
            />
          ))}
        </div>

        {/* Body */}
        <div className="px-5 py-4">
          {step === 1 && (
            <>
              <p className="text-sm text-ink-2 mb-4">
                По этой броне получено <strong className="mono-num">{formatRub(depositTotal)}</strong>.
                Что делаем с деньгами?
              </p>

              {/* Branch selection */}
              {(["refund", "credit", "forfeit"] as Branch[]).map((b) => (
                <button
                  key={b}
                  type="button"
                  onClick={() => setBranch(b)}
                  className={`w-full text-left flex gap-3 p-3 border rounded-lg mb-2 transition-colors ${
                    branch === b
                      ? "border-accent-bright bg-accent-soft"
                      : "border-border hover:bg-surface-2"
                  }`}
                >
                  <div className={`w-4 h-4 mt-0.5 rounded-full border-2 flex-shrink-0 ${
                    branch === b
                      ? "border-accent-bright bg-accent-bright shadow-[inset_0_0_0_3px_white]"
                      : "border-ink-3"
                  }`} />
                  <div>
                    <div className="font-medium text-sm text-ink">
                      {b === "refund" ? "Полный возврат клиенту" : b === "credit" ? "Удержать как кредит на следующую бронь" : "Удержать как штраф"}
                    </div>
                    <div className="text-xs text-ink-3 mt-0.5">
                      {b === "refund" && `${formatRub(depositTotal)} возвращаются клиенту. Запись Refund + аудит.`}
                      {b === "credit" && "Деньги остаются. Создаётся кредит-нота — применить при новой броне."}
                      {b === "forfeit" && "Платёж становится «удержанным». Бронь → CANCELLED."}
                    </div>
                  </div>
                </button>
              ))}
            </>
          )}

          {step === 2 && branch === "refund" && (
            <div className="space-y-3">
              <p className="text-sm text-ink-2 mb-3">Детали возврата</p>
              <div>
                <label className="eyebrow block mb-1">Сумма (₽)</label>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
                  value={refundAmount}
                  onChange={(e) => setRefundAmount(e.target.value)}
                />
              </div>
              <div>
                <label className="eyebrow block mb-1">Способ возврата</label>
                <select
                  className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
                  value={refundMethod}
                  onChange={(e) => setRefundMethod(e.target.value)}
                >
                  {Object.entries(methodLabels).map(([k, label]) => (
                    <option key={k} value={k}>{label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="eyebrow block mb-1">
                  Причина * <span className="text-ink-3 font-normal">({refundReason.trim().length}/3 мин.)</span>
                </label>
                <textarea
                  className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink resize-none"
                  rows={2}
                  value={refundReason}
                  onChange={(e) => setRefundReason(e.target.value)}
                  placeholder="Отмена съёмки клиентом"
                />
              </div>
            </div>
          )}

          {step === 2 && branch === "credit" && (
            <div className="space-y-3">
              <p className="text-sm text-ink-2 mb-3">Параметры кредит-ноты</p>
              <div>
                <label className="eyebrow block mb-1">Клиент</label>
                <input
                  type="text"
                  className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink-3"
                  value={clientName}
                  disabled
                />
              </div>
              <div>
                <label className="eyebrow block mb-1">Сумма (₽)</label>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
                  value={creditAmount}
                  onChange={(e) => setCreditAmount(e.target.value)}
                />
              </div>
              <div>
                <label className="eyebrow block mb-1">
                  Причина * <span className="text-ink-3 font-normal">({creditReason.trim().length}/3 мин.)</span>
                </label>
                <textarea
                  className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink resize-none"
                  rows={2}
                  value={creditReason}
                  onChange={(e) => setCreditReason(e.target.value)}
                  placeholder="Депозит при отмене брони"
                />
              </div>
              <div>
                <label className="eyebrow block mb-1">Действует до</label>
                <input
                  type="date"
                  className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
                  value={creditExpires}
                  onChange={(e) => setCreditExpires(e.target.value)}
                />
              </div>
            </div>
          )}

          {step === 2 && branch === "forfeit" && (
            <div className="space-y-3">
              <p className="text-sm text-ink-2 mb-3">Подтвердите удержание штрафа</p>
              <div className="p-3 bg-rose-soft border border-rose-border rounded text-sm text-rose">
                Депозит <strong className="mono-num">{formatRub(depositTotal)}</strong> будет удержан.
                Клиент не получает деньги обратно. Бронь перейдёт в статус ОТМЕНЕНА.
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-3">
              <p className="text-sm font-medium text-ink mb-3">Подтверждение</p>
              <div className="p-3 bg-surface-2 rounded border border-border text-sm space-y-1">
                <div className="flex justify-between">
                  <span className="text-ink-2">Бронь</span>
                  <span className="text-ink font-medium">{bookingDisplayName}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-2">Клиент</span>
                  <span className="text-ink">{clientName}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-2">Депозит</span>
                  <span className="mono-num font-medium">{formatRub(depositTotal)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-2">Действие</span>
                  <span className="text-ink font-medium">
                    {branch === "refund" ? `Возврат ${formatRub(Number(refundAmount))}` : branch === "credit" ? `Кредит-нота ${formatRub(Number(creditAmount))}` : "Удержан как штраф"}
                  </span>
                </div>
              </div>
              <p className="text-xs text-ink-3">
                После подтверждения бронь будет отменена и выполнено выбранное действие с депозитом.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-between gap-2 px-5 pb-5">
          <button
            onClick={step === 1 ? onClose : () => setStep((s) => (s - 1) as 1 | 2 | 3)}
            className="px-4 py-2 text-sm border border-border rounded text-ink-2 hover:bg-surface-subtle"
          >
            {step === 1 ? "Закрыть" : "Назад"}
          </button>
          {step < 3 ? (
            <button
              onClick={() => setStep((s) => (s + 1) as 1 | 2 | 3)}
              className="px-4 py-2 text-sm bg-accent-bright text-white rounded hover:opacity-90"
            >
              Далее →
            </button>
          ) : (
            <button
              onClick={handleCommit}
              disabled={saving}
              className="px-4 py-2 text-sm bg-rose text-white rounded hover:opacity-90 disabled:opacity-50"
            >
              {saving ? "Выполнение…" : "Подтвердить отмену"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
