"use client";

import { useState } from "react";
import { formatRub } from "../../lib/format";
import { RecordPaymentModal } from "./RecordPaymentModal";
import { BookingQuickEditModal } from "./BookingQuickEditModal";
import { StatusCell } from "./StatusCell";

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
  isLegacyImport: boolean;
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
  /** T7: callback to open RecordPaymentModal when list is empty */
  onRecordPayment?: () => void;
}

/**
 * Нормализует projectName для компактного отображения в объединённой графе «Клиент / проект».
 * Для legacy-импортов срезает префикс «Импорт: » и расширение файла (.xlsx/.xls/.csv).
 */
function displayProjectName(projectName: string): string {
  let name = projectName.replace(/^Импорт:\s*/i, "").trim();
  name = name.replace(/\.(xlsx|xls|csv)$/i, "");
  return name || projectName;
}

export function PaymentsTable({ items, loading, onLoadMore, onRefresh, onRecordPayment }: Props) {
  const [payingBooking, setPayingBooking] = useState<OverviewItem | null>(null);
  const [editingBooking, setEditingBooking] = useState<OverviewItem | null>(null);

  if (loading && items.length === 0) {
    return (
      <div className="py-12 text-center text-ink-3 text-sm">Загрузка…</div>
    );
  }

  if (!loading && items.length === 0) {
    return (
      <div className="py-14 text-center bg-accent-soft border border-accent-border rounded-lg">
        <p className="eyebrow mb-2">Платежи</p>
        <p className="text-[15px] font-medium text-ink mb-1">Платежей пока нет</p>
        <p className="text-sm text-ink-2 mb-4">Нет данных по выбранным фильтрам</p>
        {onRecordPayment && (
          <button
            onClick={onRecordPayment}
            className="px-4 py-2 text-sm bg-accent-bright text-white rounded hover:bg-accent transition-colors"
          >
            Записать первый платёж →
          </button>
        )}
      </div>
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
              <th className="text-left px-4 py-3 eyebrow">Клиент / проект</th>
              <th className="text-right pl-4 pr-8 py-3 eyebrow w-[140px]">Сумма</th>
              <th className="text-left px-4 py-3 eyebrow w-[440px] min-w-[440px]">Статус оплаты</th>
              <th className="px-2 py-3 w-[40px]"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-b border-border last:border-0 hover:bg-surface-subtle">
                {/* Start date */}
                <td className="px-4 py-3 text-ink font-semibold mono-num text-xs whitespace-nowrap">
                  {new Date(item.startDate).toLocaleDateString("ru-RU")}
                </td>
                {/* Period */}
                <td className="px-4 py-3 text-ink-2 text-xs whitespace-nowrap">
                  {new Date(item.startDate).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}
                  {" — "}
                  {new Date(item.endDate).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}
                </td>
                {/* Client / project — merged */}
                <td className="px-4 py-3 max-w-[280px] truncate" title={`${item.client.name} / ${item.projectName}`}>
                  <span className="text-ink font-medium">{item.client.name}</span>
                  <span className="text-ink-3 mx-1">/</span>
                  <span className="text-ink-2">{displayProjectName(item.projectName)}</span>
                </td>
                {/* Amount — сдвинуто левее через pr-8 */}
                <td className="pl-4 pr-8 py-3 text-right mono-num font-medium text-ink whitespace-nowrap">
                  {formatRub(item.finalAmount)}
                </td>
                {/* Status cell — variant C */}
                <td className="px-4 py-3">
                  <StatusCell item={item} onPay={() => setPayingBooking(item)} />
                </td>
                {/* Edit action */}
                <td className="px-2 py-3 text-center">
                  <button
                    onClick={() => setEditingBooking(item)}
                    aria-label="Редактировать бронь"
                    title="Редактировать клиента, проект, сумму"
                    className="p-1.5 rounded text-ink-3 hover:text-accent hover:bg-accent-soft transition-colors"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="w-4 h-4"
                    >
                      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                    </svg>
                  </button>
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

      {/* RecordPaymentModal — T2: replaces QuickPaymentModal */}
      <RecordPaymentModal
        open={payingBooking !== null}
        onClose={() => setPayingBooking(null)}
        defaultBookingId={payingBooking?.id}
        bookingContext={payingBooking ? {
          id: payingBooking.id,
          projectName: payingBooking.projectName,
          client: payingBooking.client,
          finalAmount: payingBooking.finalAmount,
          amountPaid: payingBooking.amountPaid,
          amountOutstanding: payingBooking.amountOutstanding,
        } : undefined}
        onCreated={() => {
          setPayingBooking(null);
          onRefresh();
        }}
      />

      {editingBooking && (
        <BookingQuickEditModal
          booking={editingBooking}
          onClose={() => setEditingBooking(null)}
          onSaved={() => {
            setEditingBooking(null);
            onRefresh();
          }}
        />
      )}
    </>
  );
}
