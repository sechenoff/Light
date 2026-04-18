"use client";

import { useState } from "react";
import { StatusPill } from "../StatusPill";
import type { StatusPillVariant } from "../StatusPill";
import { formatRub } from "../../lib/format";
import { QuickPaymentModal } from "./QuickPaymentModal";

export interface OverviewItem {
  id: string;
  startDate: string;
  endDate: string;
  client: { id: string; name: string };
  projectName: string;
  displayName: string;
  finalAmount: string;
  amountPaid: string;
  amountOutstanding: string;
  paymentStatus: string;
  status: string;
  overdueDays: number;
}

const PAYMENT_STATUS_LABELS: Record<string, string> = {
  PAID: "Оплачено",
  PARTIALLY_PAID: "Частично",
  NOT_PAID: "Не оплачено",
  OVERDUE: "Просрочено",
};

const PAYMENT_STATUS_VARIANT: Record<string, StatusPillVariant> = {
  PAID: "ok",
  PARTIALLY_PAID: "warn",
  NOT_PAID: "none",
  OVERDUE: "alert",
};

const BOOKING_STATUS_LABELS: Record<string, string> = {
  DRAFT: "Черновик",
  PENDING_APPROVAL: "На согласовании",
  CONFIRMED: "Подтверждена",
  ISSUED: "Выдана",
  RETURNED: "Возвращена",
  CANCELLED: "Отменена",
};

/**
 * Progress bar using 5-bucket approximation to avoid inline style.
 * pct → 0 / 25 / 50 / 75 / 100
 */
function ProgressBar({ amountPaid, finalAmount }: { amountPaid: string; finalAmount: string }) {
  const paid = Number(amountPaid);
  const total = Number(finalAmount);
  const rawPct = total > 0 ? (paid / total) * 100 : 0;
  // Round to nearest 25 for Tailwind JIT-safe class
  const bucket = Math.round(rawPct / 25) * 25;

  const widthClass =
    bucket === 100 ? "w-full" :
    bucket === 75  ? "w-3/4" :
    bucket === 50  ? "w-1/2" :
    bucket === 25  ? "w-1/4" :
    "w-0";

  const fillColor =
    bucket === 100 ? "bg-emerald" :
    bucket > 0     ? "bg-amber" :
    "bg-rose-soft";

  return (
    <div className="h-1.5 bg-surface-subtle rounded-full overflow-hidden w-24">
      <div className={`h-full rounded-full ${widthClass} ${fillColor}`} />
    </div>
  );
}

interface Props {
  items: OverviewItem[];
  loading: boolean;
  onLoadMore: (() => void) | null;
  onRefresh: () => void;
}

export function PaymentsTable({ items, loading, onLoadMore, onRefresh }: Props) {
  const [payingBooking, setPayingBooking] = useState<OverviewItem | null>(null);

  if (loading && items.length === 0) {
    return (
      <div className="py-12 text-center text-ink-3 text-sm">Загрузка…</div>
    );
  }

  if (!loading && items.length === 0) {
    return (
      <div className="py-12 text-center text-ink-3 text-sm">Нет броней по выбранным фильтрам</div>
    );
  }

  return (
    <>
      <div className="border border-border rounded-lg overflow-hidden shadow-xs">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-subtle">
              <th className="text-left px-4 py-3 eyebrow">Дата</th>
              <th className="text-left px-4 py-3 eyebrow">Период</th>
              <th className="text-left px-4 py-3 eyebrow">Клиент</th>
              <th className="text-left px-4 py-3 eyebrow">Проект</th>
              <th className="text-right px-4 py-3 eyebrow">Сумма</th>
              <th className="px-4 py-3 eyebrow">Оплата</th>
              <th className="px-4 py-3 eyebrow">Статус</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-b border-border last:border-0 hover:bg-surface-subtle">
                {/* Start date */}
                <td className="px-4 py-3 text-ink-2 mono-num text-xs whitespace-nowrap">
                  {new Date(item.startDate).toLocaleDateString("ru-RU")}
                </td>
                {/* Period */}
                <td className="px-4 py-3 text-ink-2 text-xs whitespace-nowrap">
                  {new Date(item.startDate).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}
                  {" — "}
                  {new Date(item.endDate).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}
                </td>
                {/* Client */}
                <td className="px-4 py-3 text-ink font-medium max-w-[160px] truncate">
                  {item.client.name}
                </td>
                {/* Project */}
                <td className="px-4 py-3 text-ink-2 text-xs max-w-[140px] truncate">
                  {item.projectName}
                </td>
                {/* Amount */}
                <td className="px-4 py-3 text-right mono-num font-medium text-ink whitespace-nowrap">
                  {formatRub(item.finalAmount)}
                </td>
                {/* Payment progress */}
                <td className="px-4 py-3">
                  <div className="flex flex-col gap-1">
                    <ProgressBar amountPaid={item.amountPaid} finalAmount={item.finalAmount} />
                    <span className="text-[10px] text-ink-2 mono-num whitespace-nowrap">
                      {formatRub(item.amountPaid)}
                      {Number(item.amountOutstanding) > 0 && (
                        <span className="text-rose"> / ост. {formatRub(item.amountOutstanding)}</span>
                      )}
                    </span>
                  </div>
                </td>
                {/* Payment status */}
                <td className="px-4 py-3">
                  <div className="flex flex-col gap-1">
                    <button
                      onClick={() => setPayingBooking(item)}
                      title="Зафиксировать платёж"
                    >
                      <StatusPill
                        variant={PAYMENT_STATUS_VARIANT[item.paymentStatus] ?? "none"}
                        label={PAYMENT_STATUS_LABELS[item.paymentStatus] ?? item.paymentStatus}
                        className="cursor-pointer hover:opacity-80"
                      />
                    </button>
                    {item.overdueDays > 0 && (
                      <span className="text-[10px] text-rose">
                        просрочено {item.overdueDays} {item.overdueDays === 1 ? "день" : item.overdueDays <= 4 ? "дня" : "дней"}
                      </span>
                    )}
                    <span className="text-[10px] text-ink-3">
                      {BOOKING_STATUS_LABELS[item.status] ?? item.status}
                    </span>
                  </div>
                </td>
                {/* Quick action */}
                <td className="px-3 py-3">
                  {item.paymentStatus !== "PAID" && (
                    <button
                      onClick={() => setPayingBooking(item)}
                      aria-label="Добавить платёж"
                      className="text-xs text-accent hover:text-accent-bright font-medium"
                    >
                      +₽
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {onLoadMore && (
        <div className="mt-4 text-center">
          <button
            onClick={onLoadMore}
            disabled={loading}
            className="px-4 py-2 text-sm border border-border rounded text-ink-2 hover:bg-surface-subtle disabled:opacity-50"
          >
            {loading ? "Загрузка…" : "Загрузить ещё"}
          </button>
        </div>
      )}

      {payingBooking && (
        <QuickPaymentModal
          booking={payingBooking}
          onClose={() => setPayingBooking(null)}
          onSaved={() => {
            setPayingBooking(null);
            onRefresh();
          }}
        />
      )}
    </>
  );
}
