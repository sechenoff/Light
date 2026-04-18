"use client";

import { useState } from "react";
import { formatRub } from "../../lib/format";
import { QuickPaymentModal } from "./QuickPaymentModal";
import { StatusCell, statusBgClass } from "./StatusCell";

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

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  PAID: "Оплачено",
  PARTIALLY_PAID: "Частично",
  NOT_PAID: "Не оплачено",
  OVERDUE: "Просрочено",
};

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
              <th className="text-left px-4 py-3 eyebrow w-[110px]">Проект</th>
              <th className="text-right px-4 py-3 eyebrow">Сумма</th>
              <th className="text-left px-4 py-3 eyebrow w-[320px] min-w-[320px]">Статус оплаты</th>
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
                <td className="px-4 py-3 text-ink-2 text-xs max-w-[110px] truncate">
                  {item.projectName}
                </td>
                {/* Amount */}
                <td className="px-4 py-3 text-right mono-num font-medium text-ink whitespace-nowrap">
                  {formatRub(item.finalAmount)}
                </td>
                {/* Status cell — variant C */}
                <td className={`px-4 py-3 ${statusBgClass(item.paymentStatus)}`}>
                  <StatusCell item={item} onPay={() => setPayingBooking(item)} />
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
