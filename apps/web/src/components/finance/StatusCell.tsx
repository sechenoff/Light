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

  const borderClass = isPaid
    ? "border-emerald-border"
    : isPartial
    ? "border-amber-border"
    : "border-rose-border";

  const labelClass = isPaid
    ? "text-emerald"
    : isPartial
    ? "text-amber"
    : "text-rose";

  const labelText = isPaid
    ? "✓ Оплачено"
    : isPartial
    ? "◐ Частично"
    : "● Не оплачено";

  const ctaAmount = isPaid ? null : item.amountOutstanding;

  const ctaButtonClass = isPartial
    ? "bg-amber text-white hover:opacity-90"
    : "bg-accent-bright text-white hover:bg-accent";

  return (
    <div
      className={`bg-surface border rounded-lg px-3 py-2.5 grid grid-cols-[1fr_auto] gap-3 items-stretch ${borderClass}`}
    >
      {/* LEFT — metadata */}
      <div className="flex flex-col justify-center gap-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-sm font-semibold ${labelClass}`}>{labelText}</span>
          {isOverdue && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-rose text-white">
              просрочено {item.overdueDays}{" "}
              {pluralize(item.overdueDays, "день", "дня", "дней")}
            </span>
          )}
        </div>
        <span className="text-[11px] text-ink-2 mono-num">
          {isPaid && <>{formatRub(item.finalAmount)} · принят</>}
          {isPartial && (
            <>
              оплачено{" "}
              <b className="text-ink font-semibold">{formatRub(item.amountPaid)}</b>{" "}
              из {formatRub(item.finalAmount)}
            </>
          )}
          {isUnpaid && (
            <>
              ожидается{" "}
              <b className="text-ink font-semibold">{formatRub(item.finalAmount)}</b>
            </>
          )}
        </span>
        <span className="text-[10px] text-ink-3 uppercase tracking-wide">
          {BOOKING_STATUS_LABELS[item.status] ?? item.status}
        </span>
      </div>

      {/* RIGHT — CTA */}
      <div className="flex items-center justify-center">
        {isPaid ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald border border-dashed border-emerald-border rounded-md px-3 py-2">
            <span>✓</span> Зафиксирован
          </span>
        ) : (
          <button
            onClick={onPay}
            className={`flex flex-col items-center justify-center leading-tight min-w-[130px] px-3 py-2 rounded-md ${ctaButtonClass}`}
          >
            <span className="text-[10px] font-medium uppercase tracking-wide opacity-90">
              {isPartial ? "+ Внести остаток" : "+ Принять оплату"}
            </span>
            <span className="text-[13px] font-semibold mono-num mt-0.5">
              {formatRub(ctaAmount!)}
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
