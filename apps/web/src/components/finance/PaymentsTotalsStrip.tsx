"use client";

import { formatRub } from "../../lib/format";

interface Props {
  billed: string;
  paid: string;
  outstanding: string;
  averageAmount: string;
  count: number;
}

// TODO(phase2): B1 — add per-method chips (Наличные / Карта / Перевод / Онлайн) with running totals.
// Each chip should filter the PaymentsTable by method. API needs to expose per-method totals
// in the /api/finance/payments-overview response (add methodBreakdown: { method, total }[]).

export function PaymentsTotalsStrip({ billed, paid, outstanding, averageAmount, count }: Props) {
  return (
    // Разделители — фон bg-border сквозь gap-px: без двойной линии у третьей
    // ячейки в сетке 2×2 и с линией между рядами (divide-x её не даёт).
    <div className="mb-5 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border shadow-xs xl:grid-cols-4">
      <TotalsCell
        eyebrow="Начислено"
        value={formatRub(billed)}
        sub={`${count} ${count === 1 ? "бронь" : count >= 2 && count <= 4 ? "брони" : "броней"}`}
      />
      <TotalsCell
        eyebrow="Оплачено"
        value={formatRub(paid)}
        valueClass="text-emerald"
      />
      <TotalsCell
        eyebrow="К получению"
        value={formatRub(outstanding)}
        valueClass={Number(outstanding) > 0 ? "text-rose" : "text-ink"}
      />
      <TotalsCell
        eyebrow="Средний чек"
        value={formatRub(averageAmount)}
      />
    </div>
  );
}

function TotalsCell({
  eyebrow,
  value,
  sub,
  valueClass = "text-ink",
}: {
  eyebrow: string;
  value: string;
  sub?: string;
  valueClass?: string;
}) {
  return (
    <div className="min-w-0 bg-surface px-3 py-3 sm:px-4 sm:py-4 xl:px-5">
      <p className="eyebrow mb-1">{eyebrow}</p>
      <p className={`text-base font-semibold mono-num whitespace-nowrap sm:text-lg xl:text-xl ${valueClass}`}>{value}</p>
      {sub && <p className="text-xs text-ink-3 mt-0.5">{sub}</p>}
    </div>
  );
}
