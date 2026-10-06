"use client";

/**
 * «Разнести по продолжениям» в окне «Записать платёж» (мокап
 * docs/mockups/line-shifts-continuation/m5-booking-family.html, раздел 6).
 *
 * Клиент платит одним переводом за основную бронь и её продолжения. Сервер
 * раскладывает сумму от старшей брони к младшей, остаток — переплатой на
 * бронь, где вводили платёж. Здесь — превью этой разбивки той же функцией
 * (GET /api/payments/family-preview), чтобы человек видел, какая бронь
 * закроется, до того как нажмёт «Записать».
 *
 * Панель видна только у брони, у которой есть продолжения (или которая сама
 * продолжение). Переключатель включён по умолчанию, если долг есть ещё у
 * какой-то брони семьи, — пока человек сам его не трогал.
 */
import { useEffect, useRef, useState } from "react";

import { apiFetch } from "../../lib/api";
import { formatRub } from "../../lib/format";

export type FamilyPreviewRow = {
  bookingId: string;
  docNumber: string | null;
  isContinuation: boolean;
  expectedPaymentDate: string | null;
  debt: string;
  payment: string;
  remaining: string;
};

type Preview = { members: number; rows: FamilyPreviewRow[] };

const PREVIEW_DEBOUNCE_MS = 300;

/** «16 окт.» — срок оплаты брони. */
function formatDue(iso: string): string {
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "Europe/Moscow" }).format(new Date(iso));
}

const whole = (v: string) => formatRub(v).replace(/\s*₽$/, "");

type Props = {
  bookingId: string;
  /** Введённая сумма; не число или ≤ 0 — превью не спрашиваем. */
  amount: number;
  enabled: boolean;
  onEnabledChange: (next: boolean) => void;
  /** У брони есть семья (продолжения) — родитель решает, слать ли флаг. */
  onFamilyKnown: (hasFamily: boolean) => void;
};

export function FamilySpreadPanel({ bookingId, amount, enabled, onEnabledChange, onFamilyKnown }: Props) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const touchedRef = useRef(false);
  const decidedRef = useRef(false);
  const amountOk = Number.isFinite(amount) && amount > 0;

  useEffect(() => {
    touchedRef.current = false;
    decidedRef.current = false;
    setPreview(null);
  }, [bookingId]);

  useEffect(() => {
    if (!bookingId || !amountOk) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ bookingId, amount: String(amount) });
      apiFetch<Preview>(`/api/payments/family-preview?${params}`)
        .then((p) => {
          if (cancelled) return;
          setPreview(p);
          const hasFamily = p.members > 1;
          onFamilyKnown(hasFamily);
          // По умолчанию — один раз, по первому ответу и только если человек
          // ещё не трогал переключатель: долг есть у другой брони семьи.
          if (!decidedRef.current && !touchedRef.current) {
            decidedRef.current = true;
            const othersOwe = p.rows.some((r) => r.bookingId !== bookingId && Number(r.debt) > 0);
            onEnabledChange(hasFamily && othersOwe);
          }
        })
        // Без превью платёж просто пишется на эту бронь, как раньше.
        .catch(() => {
          if (!cancelled) onFamilyKnown(false);
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Колбэки родителя — не повод перезапрашивать превью.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId, amount, amountOk]);

  if (!preview || preview.members <= 1) return null;

  const target = preview.rows.find((r) => r.bookingId === bookingId);
  const overpay = preview.rows.reduce((acc, r) => acc + Math.max(0, Number(r.payment) - Number(r.debt)), 0);
  const totalDebt = preview.rows.reduce((acc, r) => acc + Number(r.debt), 0);
  const totalPayment = preview.rows.reduce((acc, r) => acc + Number(r.payment), 0);
  const totalRemaining = preview.rows.reduce((acc, r) => acc + Number(r.remaining), 0);
  const targetDebt = target ? Number(target.debt) : 0;
  const offOverpay = Math.max(0, amount - targetDebt);

  return (
    <div className="rounded-lg border border-accent-border bg-accent-soft/50 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-ink">Разнести по продолжениям</p>
          <p className="text-[12px] text-ink-2">Сначала основная бронь, затем продолжения по порядку</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Разнести по продолжениям"
          onClick={() => {
            touchedRef.current = true;
            onEnabledChange(!enabled);
          }}
          className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-bright ${enabled ? "bg-accent-bright" : "bg-border-strong"}`}
        >
          <span
            aria-hidden="true"
            className={`absolute h-5 w-5 rounded-full bg-surface shadow-sm transition-transform ${enabled ? "translate-x-6" : "translate-x-1"}`}
          />
        </button>
      </div>

      {enabled ? (
        <>
          <div className="mt-3 overflow-x-auto rounded border border-border bg-surface">
            <table className="w-full min-w-[360px] text-[12.5px]">
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className="eyebrow px-3 py-1.5 text-left">Бронь</th>
                  <th scope="col" className="eyebrow px-2 py-1.5 text-right">Долг</th>
                  <th scope="col" className="eyebrow px-2 py-1.5 text-right">Платёж</th>
                  <th scope="col" className="eyebrow px-3 py-1.5 text-right">Останется</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {preview.rows.map((r, i) => {
                  const closed = Number(r.debt) > 0 && Number(r.remaining) === 0;
                  return (
                    <tr key={r.bookingId}>
                      <td className="px-3 py-2">
                        <span className="text-ink-3">{i + 1}.</span> {r.docNumber ?? "Бронь"}
                        <span className="block text-[11px] text-ink-3">
                          {r.isContinuation ? "продолжение" : "основная"}
                          {r.expectedPaymentDate ? ` · срок ${formatDue(r.expectedPaymentDate)}` : ""}
                        </span>
                      </td>
                      <td className="mono-num px-2 py-2 text-right text-ink-2">{whole(r.debt)}</td>
                      <td className="mono-num px-2 py-2 text-right font-semibold text-ink">{whole(r.payment)}</td>
                      <td className="px-3 py-2 text-right">
                        {closed ? (
                          <span className="text-[12px] font-medium text-emerald">0 · закрыта</span>
                        ) : (
                          <span className={`mono-num ${Number(r.remaining) > 0 ? "text-rose" : "text-ink-3"}`}>{whole(r.remaining)}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-border bg-surface-subtle">
                  <td className="px-3 py-1.5 font-semibold text-ink">Всего</td>
                  <td className="mono-num px-2 py-1.5 text-right text-ink-2">{whole(totalDebt.toFixed(2))}</td>
                  <td className="mono-num px-2 py-1.5 text-right font-bold text-ink">{whole(totalPayment.toFixed(2))}</td>
                  <td className={`mono-num px-3 py-1.5 text-right ${totalRemaining > 0 ? "text-rose" : "text-ink-3"}`}>
                    {whole(totalRemaining.toFixed(2))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="mt-2 text-[11.5px] text-ink-3">
            {overpay > 0
              ? `Долги семьи закроются, ${formatRub(overpay.toFixed(2))} станут переплатой по ${target?.docNumber ?? "этой брони"}.`
              : offOverpay > 0
                ? `Выключено — весь платёж ляжет на ${target?.docNumber ?? "эту бронь"}, и ${formatRub(offOverpay.toFixed(2))} станут переплатой по ней.`
                : `Выключено — весь платёж ляжет на ${target?.docNumber ?? "эту бронь"}.`}
          </p>
        </>
      ) : (
        <p className="mt-2 text-[11.5px] text-ink-3">
          Весь платёж ляжет на {target?.docNumber ?? "эту бронь"}
          {offOverpay > 0 ? `, ${formatRub(offOverpay.toFixed(2))} станут переплатой по ней` : ""}. Долги продолжений не изменятся.
        </p>
      )}
    </div>
  );
}
