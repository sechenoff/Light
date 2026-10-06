"use client";

/**
 * Плашка семьи броней на карточке (мокап
 * docs/mockups/line-shifts-continuation/m5-booking-family.html):
 *  - у основной брони — «Возвращена частично · продолжение № … · N шт до …» и
 *    «Принять остаток» (окно приёмки продолжения);
 *  - у продолжения — «Продолжение брони № …» со ссылкой на основную.
 */
import Link from "next/link";
import { formatRub } from "@/lib/format";
import { formatWhen } from "./returnDialogState";

export type BookingFamily = {
  parent: { id: string; docNumber: string | null } | null;
  root: { id: string; docNumber: string | null } | null;
  continuations: Array<{
    id: string;
    docNumber: string | null;
    status: string;
    startDate: string;
    endDate: string;
    quantity: number;
    finalAmount: string;
    amountOutstanding: string;
  }>;
  partiallyReturned: boolean;
  totals: { finalAmount: string; amountPaid: string; amountOutstanding: string } | null;
};

type Props = {
  family: BookingFamily;
  /** Открыть приёмку продолжения прямо с карточки основной брони. */
  onAcceptRest: (continuation: BookingFamily["continuations"][number]) => void;
  /**
   * Эта бронь — выданное продолжение, а смотрит руководитель: можно отменить
   * продолжение, оформленное по ошибке. Не передан — кнопки нет.
   */
  onCancelContinuation?: () => void;
};

export function BookingFamilyBanner({ family, onAcceptRest, onCancelContinuation }: Props) {
  const out = family.continuations.filter((c) => c.status === "ISSUED");
  return (
    <div className="space-y-2">
      {family.parent && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-teal-border bg-teal-soft px-4 py-2.5 text-sm">
          <span className="text-teal">
            <span className="font-semibold">Продолжение брони{family.parent.docNumber ? ` ${family.parent.docNumber}` : ""}</span>
            {" · "}часть оборудования осталась у клиента после приёмки основной брони
          </span>
          <span className="flex flex-wrap items-center gap-3">
            {onCancelContinuation && (
              <button
                type="button"
                onClick={onCancelContinuation}
                className="min-h-11 rounded border border-rose-border bg-surface px-3 text-sm text-rose hover:bg-rose-soft sm:min-h-9"
              >
                Отменить продолжение
              </button>
            )}
            <Link href={`/bookings/${family.parent.id}`} className="font-medium text-accent hover:underline">
              Открыть основную →
            </Link>
          </span>
        </div>
      )}
      {out.map((c) => (
        <div
          key={c.id}
          className="flex flex-wrap items-center justify-between gap-2 rounded border border-teal-border bg-teal-soft px-4 py-2.5 text-sm"
          data-testid="family-continuation-out"
        >
          <span className="text-teal">
            <span className="font-semibold">Возвращена частично</span>
            {" · "}продолжение {c.docNumber ?? ""} · {c.quantity} шт у клиента до {formatWhen(c.endDate)}
            {" · "}
            {Number(c.amountOutstanding) > 0 ? `к оплате ${formatRub(c.amountOutstanding)}` : "оплачено"}
          </span>
          <span className="flex items-center gap-3">
            <Link href={`/bookings/${c.id}`} className="font-medium text-accent hover:underline">
              Открыть продолжение
            </Link>
            <button
              type="button"
              className="min-h-11 rounded border border-teal bg-teal px-3 text-sm font-semibold text-surface hover:opacity-90 sm:min-h-10"
              onClick={() => onAcceptRest(c)}
            >
              Принять остаток
            </button>
          </span>
        </div>
      ))}
      {family.totals && (
        <p className="text-xs text-ink-3">
          Вместе с продолжениями: итог <span className="mono-num text-ink-2">{formatRub(family.totals.finalAmount)}</span> · оплачено{" "}
          <span className="mono-num text-ink-2">{formatRub(family.totals.amountPaid)}</span> · остаток{" "}
          <span className="mono-num text-ink-2">{formatRub(family.totals.amountOutstanding)}</span>
        </p>
      )}
    </div>
  );
}
