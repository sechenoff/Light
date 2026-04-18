"use client";

import { formatRub, pluralize } from "../../lib/format";
import type { OverviewItem } from "./PaymentsTable";

export const BOOKING_STATUS_LABELS: Record<string, string> = {
  DRAFT: "Черновик",
  PENDING_APPROVAL: "На согласовании",
  CONFIRMED: "Подтверждена",
  ISSUED: "Выдана",
  RETURNED: "Возвращена",
  CANCELLED: "Отменена",
};

interface Props {
  item: OverviewItem;
  onPay: () => void;
}

export function StatusCell({ item, onPay }: Props) {
  const isPaid = item.paymentStatus === "PAID";
  const isPartial = item.paymentStatus === "PARTIALLY_PAID";
  const isUnpaid = !isPaid && !isPartial;
  const isOverdue = item.overdueDays > 0;

  const stripeColor = isPaid ? "bg-emerald" : isPartial ? "bg-amber" : "bg-rose";
  const labelColor = isPaid ? "text-emerald" : isPartial ? "text-amber" : "text-rose";
  const labelText = isPaid ? "✓ Оплачено" : isPartial ? "◐ Частично" : "● Не оплачено";

  return (
    <div className="relative pl-3 py-0.5 flex flex-col gap-1">
      {/* Left stripe — absolute-positioned 3px rail */}
      <span
        className={`absolute left-0 top-1 bottom-1 w-[3px] rounded ${stripeColor}`}
        aria-hidden="true"
      />

      {/* Top row: status label + overdue chip (if any) */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-sm font-medium ${labelColor}`}>{labelText}</span>
        {isOverdue && (
          <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide px-2 py-0.5 rounded bg-rose-soft text-rose border border-rose-border">
            просрочено {item.overdueDays} {pluralize(item.overdueDays, "день", "дня", "дней")}
          </span>
        )}
      </div>

      {/* Amount info */}
      <span className="text-[11px] text-ink-3 mono-num">
        {isPaid && <>{formatRub(item.finalAmount)} — принят</>}
        {isPartial && (
          <>
            осталось <b className="text-ink font-medium">{formatRub(item.amountOutstanding)}</b>{" "}
            из {formatRub(item.finalAmount)}
          </>
        )}
        {isUnpaid && (
          <>
            ожидается <b className="text-ink font-medium">{formatRub(item.finalAmount)}</b>
          </>
        )}
      </span>

      {/* Action link — hyperlink style, not button */}
      {!isPaid && (
        <button
          onClick={onPay}
          className="self-start text-xs text-accent hover:text-accent-bright hover:underline font-medium inline-flex items-center gap-1"
        >
          {isPartial ? "Внести остаток" : "Принять оплату"} →
        </button>
      )}
      {isPaid && (
        <span className="self-start text-xs text-ink-3 inline-flex items-center gap-1">
          Платёж зафиксирован
        </span>
      )}

      {/* Business state — muted uppercase subtle line */}
      <span className="text-[10px] text-ink-3 uppercase tracking-wide">
        {BOOKING_STATUS_LABELS[item.status] ?? item.status}
      </span>
    </div>
  );
}
