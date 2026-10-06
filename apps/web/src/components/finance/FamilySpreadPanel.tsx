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
 * продолжение). Включать ли переключатель по умолчанию, решает окно оплаты
 * (`defaultSpreadOn`): панель только сообщает, что показало превью.
 */
import { useEffect, useState } from "react";

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

/** Что показало превью — окно оплаты по этому решает, включать ли разнесение. */
export type FamilyPreviewInfo = {
  hasFamily: boolean;
  /** Долг есть у другой брони семьи. */
  othersOwe: boolean;
  /** Бронь, где вводят платёж, — старшая в семье: деньги сначала лягут на неё. */
  targetIsOldest: boolean;
  /** Долг брони, где вводят платёж. */
  targetDebt: number;
};

/**
 * Включать ли разнесение по умолчанию. Только если долг есть у другой брони и
 * платёж не уйдёт мимо брони, где его вводят: у продолжения деньги сначала
 * лягут на основную, поэтому — лишь когда сумма больше её собственного долга.
 * Выбран счёт — выключено: платёж по счёту не разносится, и привязка к счёту
 * не должна пропадать молча.
 */
export function defaultSpreadOn(info: FamilyPreviewInfo | null, amount: number, invoiceChosen: boolean): boolean {
  if (!info || !info.hasFamily || !info.othersOwe || invoiceChosen) return false;
  return info.targetIsOldest || amount > info.targetDebt;
}

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
  /** Человек нажал переключатель. */
  onToggle: (next: boolean) => void;
  /** Превью пришло (или пропало — null: сбой, смена брони, пустая сумма). */
  onPreview: (info: FamilyPreviewInfo | null) => void;
  /** У брони есть счёт к оплате: при разнесении привязка к нему снимается. */
  invoiceAvailable?: boolean;
};

export function FamilySpreadPanel({ bookingId, amount, enabled, onToggle, onPreview, invoiceAvailable = false }: Props) {
  const [preview, setPreview] = useState<Preview | null>(null);
  /** Сумма, для которой посчитано показанное превью. */
  const [previewAmount, setPreviewAmount] = useState<number | null>(null);
  const amountOk = Number.isFinite(amount) && amount > 0;

  useEffect(() => {
    setPreview(null);
    setPreviewAmount(null);
    onPreview(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId]);

  useEffect(() => {
    if (!bookingId || !amountOk) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ bookingId, amount: String(amount) });
      apiFetch<Preview>(`/api/payments/family-preview?${params}`)
        .then((p) => {
          if (cancelled) return;
          const rows = Array.isArray(p?.rows) ? p.rows : [];
          const members = typeof p?.members === "number" ? p.members : rows.length;
          const safe = { members, rows };
          setPreview(safe);
          setPreviewAmount(amount);
          const target = rows.find((r) => r.bookingId === bookingId);
          onPreview({
            hasFamily: members > 1,
            othersOwe: rows.some((r) => r.bookingId !== bookingId && Number(r.debt) > 0),
            targetIsOldest: rows[0]?.bookingId === bookingId,
            targetDebt: target ? Number(target.debt) : 0,
          });
        })
        // Без превью разносить вслепую нельзя: панель уходит, платёж пишется
        // на эту бронь, как раньше.
        .catch(() => {
          if (cancelled) return;
          setPreview(null);
          setPreviewAmount(null);
          onPreview(null);
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
  const targetName = target?.docNumber ?? "этой броне";
  const stale = previewAmount !== amount;
  const overpay = preview.rows.reduce((acc, r) => acc + Math.max(0, Number(r.payment) - Number(r.debt)), 0);
  const totalDebt = preview.rows.reduce((acc, r) => acc + Number(r.debt), 0);
  const totalPayment = preview.rows.reduce((acc, r) => acc + Number(r.payment), 0);
  const totalRemaining = preview.rows.reduce((acc, r) => acc + Number(r.remaining), 0);
  const targetDebt = target ? Number(target.debt) : 0;
  const offOverpay = amountOk ? Math.max(0, amount - targetDebt) : 0;
  const offText = `весь платёж ляжет на ${target?.docNumber ?? "эту бронь"}${
    offOverpay > 0 ? `, и ${formatRub(offOverpay.toFixed(2))} станут переплатой по ней` : ""
  }`;

  return (
    <div className="rounded-lg border border-accent-border bg-accent-soft/50 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p id="family-spread-title" className="text-[13px] font-semibold text-ink">
            Разнести по продолжениям
          </p>
          <p id="family-spread-hint" className="text-[12px] text-ink-2">
            Сначала основная бронь, затем продолжения по порядку
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-labelledby="family-spread-title"
          aria-describedby="family-spread-hint"
          onClick={() => onToggle(!enabled)}
          className={`relative inline-flex h-8 w-14 shrink-0 items-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-bright ${enabled ? "bg-accent-bright" : "bg-border-strong"}`}
        >
          <span
            aria-hidden="true"
            className={`absolute h-6 w-6 rounded-full bg-surface shadow-sm transition-transform ${enabled ? "translate-x-7" : "translate-x-1"}`}
          />
        </button>
      </div>

      {enabled ? (
        <>
          <div
            className={`mt-3 overflow-x-auto rounded border border-border bg-surface transition-opacity ${stale ? "opacity-60" : ""}`}
            role="region"
            aria-label="Разбивка платежа по броням"
            aria-busy={stale}
            tabIndex={0}
          >
            <table className="w-full text-[12px] sm:text-[12.5px]">
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className="eyebrow px-2 py-1.5 text-left sm:px-3">Бронь</th>
                  <th scope="col" className="eyebrow px-1.5 py-1.5 text-right sm:px-2">Долг</th>
                  <th scope="col" className="eyebrow px-1.5 py-1.5 text-right sm:px-2">Платёж</th>
                  <th scope="col" className="eyebrow px-2 py-1.5 text-right sm:px-3">Останется</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {preview.rows.map((r, i) => {
                  const closed = Number(r.debt) > 0 && Number(r.remaining) === 0;
                  return (
                    <tr key={r.bookingId}>
                      <td className="px-2 py-2 sm:px-3">
                        <span className="text-ink-3">{i + 1}.</span> <span className="break-all">{r.docNumber ?? "Бронь"}</span>
                        <span className="block text-[11px] text-ink-3">
                          {r.isContinuation ? "продолжение" : "основная"}
                          {r.expectedPaymentDate ? ` · срок ${formatDue(r.expectedPaymentDate)}` : ""}
                        </span>
                      </td>
                      <td className="mono-num px-1.5 py-2 text-right text-ink-2 sm:px-2">{whole(r.debt)}</td>
                      <td className="mono-num px-1.5 py-2 text-right font-semibold text-ink sm:px-2">{whole(r.payment)}</td>
                      <td className="px-2 py-2 text-right sm:px-3">
                        {closed ? (
                          <span className="whitespace-nowrap text-[12px] font-medium text-emerald">0 · закрыта</span>
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
                  <td className="px-2 py-1.5 font-semibold text-ink sm:px-3">Всего</td>
                  <td className="mono-num px-1.5 py-1.5 text-right text-ink-2 sm:px-2">{whole(totalDebt.toFixed(2))}</td>
                  <td className="mono-num px-1.5 py-1.5 text-right font-bold text-ink sm:px-2">{whole(totalPayment.toFixed(2))}</td>
                  <td className={`mono-num px-2 py-1.5 text-right sm:px-3 ${totalRemaining > 0 ? "text-rose" : "text-ink-3"}`}>
                    {whole(totalRemaining.toFixed(2))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="mt-2 text-[11.5px] text-ink-3">
            {overpay > 0
              ? `Долги семьи закроются, ${formatRub(overpay.toFixed(2))} станут переплатой по ${targetName}. `
              : ""}
            Если выключить — {offText}.
          </p>
          {invoiceAvailable && (
            <p className="mt-1.5 text-[11.5px] text-amber">
              Платёж по счёту не разносится: при разнесении привязки к счёту не будет. Чтобы оплатить счёт, выключите разнесение.
            </p>
          )}
        </>
      ) : (
        <p className="mt-2 text-[11.5px] text-ink-3">
          Выключено — {offText}. Долги продолжений не изменятся.
        </p>
      )}
    </div>
  );
}
