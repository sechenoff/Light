"use client";

/**
 * «Дополнительная смета» в окне «Принять возврат» (мокап M4): что клиент
 * заплатит за оставленное сверх оплаченного. Цифры — из превью сервера той же
 * записью, что при приёмке, поэтому совпадут с продолжением.
 */
import { formatRub } from "@/lib/format";
import type { ReturnPreview } from "./returnDialogState";

const shiftsWord = (n: number) =>
  n % 10 === 1 && n % 100 !== 11 ? "смена" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "смены" : "смен";
const whole = (v: string) => formatRub(v).replace(/\s*₽$/, "");

export function ContinuationPriceBlock({ preview, loading }: { preview: ReturnPreview; loading: boolean }) {
  const paid = preview.continuations.filter((c) => Number(c.total) > 0 || Number(c.subtotal) > 0);
  if (paid.length === 0) return null;
  return (
    <div className={`space-y-3 transition-opacity ${loading ? "opacity-60" : ""}`} aria-busy={loading}>
      {paid.map((c) => (
        <section key={`${c.until}-${c.docNumber}`} className="overflow-hidden rounded-lg border border-border" aria-label="Дополнительная смета">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border bg-surface-subtle px-3 py-2">
            <p className="text-[13px] font-semibold text-ink">
              Дополнительная смета {c.docNumber && <span className="whitespace-nowrap">{c.docNumber}</span>}
            </p>
            <p className="text-[11.5px] text-ink-3">{loading ? "пересчитываем…" : "считается сейчас"}</p>
          </div>
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 px-3 py-2.5 text-[12.5px]">
            {c.lines.map((l, i) => (
              <div key={`${l.name}-${i}`} className="contents">
                <dt className="text-ink-2">
                  {l.name} · {l.quantity} шт
                  {l.billedShifts > 0 ? ` × ${l.billedShifts} ${shiftsWord(l.billedShifts)}` : " · оплачено"}
                  {l.negotiated ? " · договорная" : ""}
                </dt>
                <dd className={`mono-num text-right ${Number(l.lineSum) > 0 ? "text-ink" : "text-ink-3"}`}>{whole(l.lineSum)}</dd>
              </div>
            ))}
            {Number(c.discountAmount) > 0 && (
              <>
                <dt className="text-ink-2">Скидка брони {Number(c.discountPercent).toLocaleString("ru-RU")} %</dt>
                <dd className="mono-num text-right text-rose">−{whole(c.discountAmount)}</dd>
              </>
            )}
            {Number(c.surchargeAmount) > 0 && (
              <>
                <dt className="text-ink-2">Безналичный расчёт</dt>
                <dd className="mono-num text-right text-ink">{whole(c.surchargeAmount)}</dd>
              </>
            )}
            <dt className="border-t border-border pt-2 font-semibold text-ink">К оплате</dt>
            <dd className="mono-num border-t border-border pt-2 text-right text-[15px] font-bold text-ink">{formatRub(c.total)}</dd>
          </dl>
          {preview.parentNegotiatedTotal && (
            <p className="border-t border-amber-border bg-amber-soft px-3 py-2 text-[12px] text-amber">
              У брони договорной итог {formatRub(preview.parentNegotiatedTotal)} — дополнительная смета оплачивается отдельно.
            </p>
          )}
        </section>
      ))}
    </div>
  );
}
