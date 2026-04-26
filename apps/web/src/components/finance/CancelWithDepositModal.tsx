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

const BRANCH_CONFIG = {
  refund: {
    icon: "↩",
    title: "Полный возврат клиенту",
    desc: (amount: string) => `${amount} возвращаются клиенту. Запись Refund + аудит.`,
    accentClass: "border-emerald",
    bgClass: "bg-emerald-soft",
    textClass: "text-emerald",
  },
  credit: {
    icon: "💳",
    title: "Удержать как кредит на следующую бронь",
    desc: () => "Деньги остаются у нас. Создаётся кредит-нота — применить при новой броне.",
    accentClass: "border-accent-bright",
    bgClass: "bg-accent-soft",
    textClass: "text-accent-bright",
  },
  forfeit: {
    icon: "⚠",
    title: "Удержать как штраф",
    desc: () => "Платёж помечается «удержанным». Бронь → ОТМЕНЕНА.",
    accentClass: "border-rose",
    bgClass: "bg-rose-soft",
    textClass: "text-rose",
  },
} as const;

const METHOD_LABELS: Record<string, string> = {
  CASH: "💵 Наличные",
  CARD: "💳 Карта",
  BANK_TRANSFER: "🏦 Перевод",
  OTHER: "Другое",
};

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

  // Forfeit fields
  const [forfeitReason, setForfeitReason] = useState("");

  useEffect(() => {
    if (open) {
      setStep(1);
      setBranch("refund");
      setRefundAmount(String(depositTotal));
      setRefundReason("");
      setCreditAmount(String(depositTotal));
      setCreditReason("");
      setForfeitReason("");
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
    // Validate reasons
    if (branch === "refund" && refundReason.trim().length < 3) {
      toast.error("Укажите причину возврата (минимум 3 символа)");
      return;
    }
    if (branch === "credit" && creditReason.trim().length < 3) {
      toast.error("Укажите причину кредит-ноты (минимум 3 символа)");
      return;
    }
    if (branch === "forfeit" && forfeitReason.trim().length < 3) {
      toast.error("Укажите причину удержания (минимум 3 символа)");
      return;
    }

    setSaving(true);
    try {
      // H5: Единый атомарный endpoint вместо 2-3 последовательных вызовов.
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
          ...(branch === "forfeit"
            ? { reason: forfeitReason.trim() }
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

  const cfg = BRANCH_CONFIG[branch];
  const depositFormatted = formatRub(depositTotal);

  const stepLabels = ["Выбор", "Детали", "Подтверждение"];

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-surface rounded-xl border border-border shadow-xl w-full max-w-md max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-border shrink-0">
          <div>
            <p className="eyebrow text-ink-3 mb-0.5">Отмена брони</p>
            <h2 className="text-[15px] font-semibold text-ink leading-tight">{bookingDisplayName}</h2>
            <p className="text-xs text-ink-3 mt-0.5">{clientName}</p>
          </div>
          <button onClick={onClose} aria-label="Закрыть" className="text-ink-3 hover:text-ink text-xl leading-none mt-0.5">×</button>
        </div>

        {/* Step indicator */}
        <div className="px-5 pt-3 pb-1 shrink-0">
          <div className="flex gap-1.5 mb-2">
            {[1, 2, 3].map((s) => (
              <div
                key={s}
                className={`flex-1 h-1 rounded-full transition-colors ${s <= step ? "bg-accent-bright" : "bg-border"}`}
              />
            ))}
          </div>
          <p className="text-xs text-ink-3">{stepLabels[step - 1]}</p>
        </div>

        {/* Body — scrollable */}
        <div className="px-5 py-4 overflow-y-auto flex-1">

          {/* ── Step 1: выбор ветки ── */}
          {step === 1 && (
            <>
              <p className="text-sm text-ink-2 mb-4">
                По этой броне получено <strong className="mono-num text-ink">{depositFormatted}</strong>.
                Что делаем с деньгами?
              </p>

              <div className="space-y-2">
                {(["refund", "credit", "forfeit"] as Branch[]).map((b) => {
                  const c = BRANCH_CONFIG[b];
                  const isActive = branch === b;
                  return (
                    <button
                      key={b}
                      type="button"
                      onClick={() => setBranch(b)}
                      className={`w-full text-left flex gap-3 p-3.5 border rounded-lg transition-colors ${
                        isActive
                          ? `${c.accentClass} ${c.bgClass}`
                          : "border-border hover:bg-surface-2"
                      }`}
                    >
                      {/* Radio dot */}
                      <div className={`w-4 h-4 mt-0.5 rounded-full border-2 flex-shrink-0 transition-all ${
                        isActive
                          ? `${c.accentClass.replace("border-", "border-")} bg-current shadow-[inset_0_0_0_3px_white] ${c.textClass}`
                          : "border-ink-3"
                      }`} />
                      <div>
                        <div className={`font-medium text-sm ${isActive ? c.textClass : "text-ink"}`}>
                          <span className="mr-1.5">{c.icon}</span>
                          {c.title}
                        </div>
                        <div className="text-xs text-ink-3 mt-0.5">
                          {b === "refund" ? c.desc(depositFormatted) : (c.desc as () => string)()}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {/* ── Step 2: детали ── */}
          {step === 2 && branch === "refund" && (
            <div className="space-y-3">
              <p className="text-sm font-medium text-ink mb-1">Детали возврата</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="eyebrow block mb-1">Сумма (₽)</label>
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-surface text-ink mono-num focus:outline-none focus:border-accent-bright"
                    value={refundAmount}
                    onChange={(e) => setRefundAmount(e.target.value)}
                  />
                </div>
                <div>
                  <label className="eyebrow block mb-1">Способ</label>
                  <select
                    className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-surface text-ink focus:outline-none focus:border-accent-bright"
                    value={refundMethod}
                    onChange={(e) => setRefundMethod(e.target.value)}
                  >
                    {Object.entries(METHOD_LABELS).map(([k, label]) => (
                      <option key={k} value={k}>{label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="eyebrow block mb-1">
                  Причина <span className="text-rose">*</span>{" "}
                  <span className="text-ink-3 font-normal normal-case">({refundReason.trim().length}/3 мин.)</span>
                </label>
                <textarea
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-surface text-ink resize-none focus:outline-none focus:border-accent-bright"
                  rows={3}
                  value={refundReason}
                  onChange={(e) => setRefundReason(e.target.value)}
                  placeholder="Отмена съёмки клиентом"
                  autoFocus
                />
              </div>
            </div>
          )}

          {step === 2 && branch === "credit" && (
            <div className="space-y-3">
              <p className="text-sm font-medium text-ink mb-1">Параметры кредит-ноты</p>
              <div>
                <label className="eyebrow block mb-1">Клиент</label>
                <input
                  type="text"
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-surface-2 text-ink-3 cursor-not-allowed"
                  value={clientName}
                  disabled
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="eyebrow block mb-1">Сумма (₽)</label>
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-surface text-ink mono-num focus:outline-none focus:border-accent-bright"
                    value={creditAmount}
                    onChange={(e) => setCreditAmount(e.target.value)}
                  />
                </div>
                <div>
                  <label className="eyebrow block mb-1">Действует до</label>
                  <input
                    type="date"
                    className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-surface text-ink focus:outline-none focus:border-accent-bright"
                    value={creditExpires}
                    onChange={(e) => setCreditExpires(e.target.value)}
                  />
                </div>
              </div>
              <div>
                <label className="eyebrow block mb-1">
                  Причина <span className="text-rose">*</span>{" "}
                  <span className="text-ink-3 font-normal normal-case">({creditReason.trim().length}/3 мин.)</span>
                </label>
                <textarea
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-surface text-ink resize-none focus:outline-none focus:border-accent-bright"
                  rows={3}
                  value={creditReason}
                  onChange={(e) => setCreditReason(e.target.value)}
                  placeholder="Депозит при переносе съёмки"
                  autoFocus
                />
              </div>
            </div>
          )}

          {step === 2 && branch === "forfeit" && (
            <div className="space-y-3">
              <p className="text-sm font-medium text-ink mb-1">⚠ Удержание штрафа — подтверждение</p>
              <div className="p-3 bg-rose-soft border border-rose-border rounded-lg text-sm text-rose">
                Депозит <strong className="mono-num">{depositFormatted}</strong> будет удержан.
                Клиент не получает возврат. Бронь перейдёт в статус ОТМЕНЕНА.
              </div>
              <div>
                <label className="eyebrow block mb-1">
                  Причина удержания <span className="text-rose">*</span>{" "}
                  <span className="text-ink-3 font-normal normal-case">({forfeitReason.trim().length}/3 мин.)</span>
                </label>
                <textarea
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-surface text-ink resize-none focus:outline-none focus:border-rose"
                  rows={3}
                  value={forfeitReason}
                  onChange={(e) => setForfeitReason(e.target.value)}
                  placeholder="Отмена за 1 день до съёмки, согласно договору"
                  autoFocus
                />
              </div>
            </div>
          )}

          {/* ── Step 3: подтверждение ── */}
          {step === 3 && (
            <div className="space-y-3">
              <p className="text-sm font-medium text-ink">Подтвердите операцию</p>
              <div className="p-4 bg-surface-2 rounded-lg border border-border text-sm space-y-2">
                <div className="flex justify-between">
                  <span className="text-ink-3">Бронь</span>
                  <span className="text-ink font-medium">{bookingDisplayName}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-3">Клиент</span>
                  <span className="text-ink">{clientName}</span>
                </div>
                <div className="flex justify-between pt-2 border-t border-border">
                  <span className="text-ink-3">Депозит</span>
                  <span className="mono-num font-semibold">{depositFormatted}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-3">Действие</span>
                  <span className={`font-medium ${cfg.textClass}`}>
                    {branch === "refund"
                      ? `↩ Возврат ${formatRub(Number(refundAmount))}`
                      : branch === "credit"
                      ? `💳 Кредит-нота ${formatRub(Number(creditAmount))}`
                      : "⚠ Удержать как штраф"}
                  </span>
                </div>
                {branch === "refund" && refundReason && (
                  <div className="flex justify-between">
                    <span className="text-ink-3">Причина</span>
                    <span className="text-ink text-right max-w-[60%]">{refundReason}</span>
                  </div>
                )}
                {branch === "credit" && creditReason && (
                  <div className="flex justify-between">
                    <span className="text-ink-3">Причина</span>
                    <span className="text-ink text-right max-w-[60%]">{creditReason}</span>
                  </div>
                )}
                {branch === "forfeit" && forfeitReason && (
                  <div className="flex justify-between">
                    <span className="text-ink-3">Причина</span>
                    <span className="text-ink text-right max-w-[60%]">{forfeitReason}</span>
                  </div>
                )}
              </div>
              <p className="text-xs text-ink-3">
                После подтверждения бронь будет отменена и выполнено выбранное действие с депозитом.
                Операция необратима.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-between gap-2 px-5 py-4 border-t border-border shrink-0">
          <button
            onClick={step === 1 ? onClose : () => setStep((s) => (s - 1) as 1 | 2 | 3)}
            className="px-4 py-2 text-sm border border-border rounded-lg text-ink-2 hover:bg-surface-2 transition-colors"
          >
            {step === 1 ? "Закрыть" : "Назад"}
          </button>
          {step < 3 ? (
            <button
              onClick={() => setStep((s) => (s + 1) as 1 | 2 | 3)}
              className="px-5 py-2 text-sm bg-accent-bright text-white rounded-lg hover:opacity-90 transition-opacity font-medium"
            >
              Далее →
            </button>
          ) : (
            <button
              onClick={handleCommit}
              disabled={saving}
              className={`px-5 py-2 text-sm text-white rounded-lg font-medium hover:opacity-90 transition-opacity disabled:opacity-50 ${
                branch === "refund" ? "bg-emerald" : branch === "credit" ? "bg-accent-bright" : "bg-rose"
              }`}
            >
              {saving ? "Выполнение…" : "Подтвердить отмену"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
