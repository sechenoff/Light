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
    <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-border border border-border rounded-lg bg-surface shadow-xs mb-5">
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
    <div className="px-5 py-4">
      <p className="eyebrow mb-1">{eyebrow}</p>
      <p className={`text-xl font-semibold mono-num ${valueClass}`}>{value}</p>
      {sub && <p className="text-xs text-ink-3 mt-0.5">{sub}</p>}
    </div>
  );
}
