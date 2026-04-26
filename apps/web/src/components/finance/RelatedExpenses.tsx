"use client";

import { useState } from "react";
import Link from "next/link";
import { apiFetch } from "../../lib/api";
import { formatRub } from "../../lib/format";
import { StatusPill } from "../StatusPill";

// ── Types ─────────────────────────────────────────────────────────────────────

interface RelatedExpenseItem {
  id: string;
  category: string;
  amount: string;
  description: string | null;
  source: "DIRECT" | "REPAIR_LINKED";
  createdAt: string;
  documentUrl: string | null;
  approved: boolean;
  linkedRepairId?: string | null;
}

interface RelatedExpensesResult {
  items: RelatedExpenseItem[];
  total: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const EXPENSE_CATEGORY_LABEL: Record<string, string> = {
  TRANSPORT: "Транспорт",
  EQUIPMENT: "Оборудование",
  CONTRACTORS: "Подрядчики",
  STAFF: "Персонал",
  RENT: "Аренда",
  REPAIR: "Ремонт",
  PAYROLL: "Зарплата",
  PURCHASE: "Закупки",
  OTHER: "Прочее",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" });
}

// ── Row component ─────────────────────────────────────────────────────────────

interface ExpenseRowProps {
  item: RelatedExpenseItem;
}

function ExpenseRow({ item }: ExpenseRowProps) {
  const categoryLabel = EXPENSE_CATEGORY_LABEL[item.category] ?? item.category;

  return (
    <tr className="border-t border-border hover:bg-surface-subtle">
      <td className="px-3 py-2.5 text-[12px] text-ink-3">{formatDate(item.createdAt)}</td>
      <td className="px-3 py-2.5">
        <span className="text-[13px] font-medium text-ink">{categoryLabel}</span>
      </td>
      <td className="px-3 py-2.5 text-right mono-num text-[13px] font-semibold text-ink">
        {formatRub(item.amount)}
      </td>
      <td className="px-3 py-2.5 text-[12px] text-ink-2">
        {item.description ?? <span className="text-ink-3">—</span>}
      </td>
      <td className="px-3 py-2.5">
        {item.source === "DIRECT" ? (
          <StatusPill variant="info" label="Прямой" />
        ) : item.linkedRepairId ? (
          <Link
            href={`/repair/${item.linkedRepairId}`}
            className="hover:underline"
          >
            <StatusPill variant="warn" label="Через ремонт" />
          </Link>
        ) : (
          <StatusPill variant="warn" label="Через ремонт" />
        )}
      </td>
    </tr>
  );
}

// ── Mobile card list variant ──────────────────────────────────────────────────

function ExpenseCard({ item }: ExpenseRowProps) {
  const categoryLabel = EXPENSE_CATEGORY_LABEL[item.category] ?? item.category;

  return (
    <div className="py-2.5 border-b border-border last:border-0">
      <div className="flex justify-between items-start gap-2">
        <div className="min-w-0">
          <span className="text-[13px] font-medium text-ink">{categoryLabel}</span>
          {item.description && (
            <p className="text-[11.5px] text-ink-2 mt-0.5">{item.description}</p>
          )}
          <p className="text-[11px] text-ink-3 mt-0.5">{formatDate(item.createdAt)}</p>
        </div>
        <div className="text-right shrink-0">
          <p className="mono-num text-[13px] font-semibold text-ink">{formatRub(item.amount)}</p>
          <div className="mt-1">
            {item.source === "DIRECT" ? (
              <StatusPill variant="info" label="Прямой" />
            ) : item.linkedRepairId ? (
              <Link href={`/repair/${item.linkedRepairId}`}>
                <StatusPill variant="warn" label="Через ремонт" />
              </Link>
            ) : (
              <StatusPill variant="warn" label="Через ремонт" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface RelatedExpensesProps {
  bookingId: string;
}

export function RelatedExpenses({ bookingId }: RelatedExpensesProps) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<RelatedExpensesResult | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleToggle() {
    const next = !open;
    setOpen(next);
    // Lazy-load on first expansion
    if (next && data === null) {
      setLoading(true);
      try {
        const result = await apiFetch<RelatedExpensesResult>(`/api/bookings/${bookingId}/related-expenses`);
        setData(result);
      } catch {
        setData({ items: [], total: "0" });
      } finally {
        setLoading(false);
      }
    }
  }

  return (
    <div className="rounded-lg border border-border bg-surface shadow-xs overflow-hidden mb-4">
      {/* Header toggle */}
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={open}
        className="w-full flex items-center justify-between p-3 border-b border-border bg-surface-subtle text-left hover:bg-surface-subtle/80 transition-colors"
      >
        <p className="eyebrow">Связанные расходы</p>
        <span className={`text-ink-3 text-[12px] transition-transform ${open ? "rotate-90" : ""}`}>▸</span>
      </button>

      {open && (
        <div className="p-3">
          {loading ? (
            <div className="animate-pulse space-y-2">
              {[...Array(2)].map((_, i) => (
                <div key={i} className="h-8 bg-surface-subtle rounded" />
              ))}
            </div>
          ) : !data || data.items.length === 0 ? (
            <p className="text-sm text-ink-3 py-2">Связанных расходов нет.</p>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden sm:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left">
                      <th className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Дата</th>
                      <th className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Категория</th>
                      <th className="px-3 pb-2 text-right text-[11px] font-semibold uppercase tracking-wide text-ink-3">Сумма</th>
                      <th className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Описание</th>
                      <th className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Источник</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((item) => (
                      <ExpenseRow key={item.id} item={item} />
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile card list */}
              <div className="sm:hidden">
                {data.items.map((item) => (
                  <ExpenseCard key={item.id} item={item} />
                ))}
              </div>

              {/* Total row */}
              <div className="mt-3 pt-2.5 border-t border-border flex justify-between items-center">
                <span className="text-[12px] text-ink-3 uppercase tracking-wide font-semibold">Итого</span>
                <span className="mono-num text-[14px] font-semibold text-ink">{formatRub(data.total)}</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
