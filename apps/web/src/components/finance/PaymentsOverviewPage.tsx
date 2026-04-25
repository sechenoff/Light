"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch } from "../../lib/api";
import { useCurrentUser } from "../../hooks/useCurrentUser";
import { PaymentsFilterBar, type PaymentsFilter } from "./PaymentsFilterBar";
import { PaymentsTotalsStrip } from "./PaymentsTotalsStrip";
import { PaymentsTable, type OverviewItem } from "./PaymentsTable";
import { PaymentsByClient } from "./PaymentsByClient";
import { FinanceTabNav } from "./FinanceTabNav";
import { PeriodSelector } from "./PeriodSelector";
import { RecordPaymentModal } from "./RecordPaymentModal";
import { derivePeriodRange, type PeriodKey } from "../../lib/periodUtils";

type ViewTab = "table" | "clients";

interface OverviewResponse {
  items: OverviewItem[];
  totals: {
    count: number;
    billed: string;
    paid: string;
    outstanding: string;
    averageAmount: string;
  };
  nextCursor: string | null;
}

function buildOverviewQuery(filter: PaymentsFilter, cursor?: string): string {
  const params = new URLSearchParams();
  params.set("limit", "50");
  if (filter.from) params.set("from", filter.from);
  if (filter.to) params.set("to", filter.to);
  if (filter.clientId) params.set("clientId", filter.clientId);
  if (filter.amountMin) params.set("amountMin", filter.amountMin);
  if (filter.amountMax) params.set("amountMax", filter.amountMax);
  if (filter.paymentStatuses.length > 0 && filter.paymentStatuses.length < 4) {
    params.set("paymentStatus", filter.paymentStatuses.join(","));
  }
  if (cursor) params.set("cursor", cursor);
  return `?${params.toString()}`;
}

export function PaymentsOverviewPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useCurrentUser();
  const [recordPaymentOpen, setRecordPaymentOpen] = useState(false);

  // Tab from URL
  const tabParam = searchParams.get("view") === "clients" ? "clients" : "table";
  const [view, setViewState] = useState<ViewTab>(tabParam);

  // Period selector
  const initialPeriod = (searchParams.get("period") as PeriodKey | null) ?? "month";
  const [period, setPeriod] = useState<PeriodKey>(initialPeriod);

  function setView(v: ViewTab) {
    setViewState(v);
    const params = new URLSearchParams(searchParams.toString());
    params.set("view", v);
    router.replace(`?${params.toString()}`);
  }

  function handlePeriodChange(p: PeriodKey) {
    setPeriod(p);
    const range = derivePeriodRange(p);
    setFilter((prev) => ({ ...prev, from: range.from, to: range.to }));
    setItems([]);
    setNextCursor(null);
    const params = new URLSearchParams(searchParams.toString());
    params.set("period", p);
    router.replace(`?${params.toString()}`);
  }

  const initialRange = derivePeriodRange(initialPeriod);
  const [filter, setFilter] = useState<PaymentsFilter>({
    from: initialRange.from,
    to: initialRange.to,
    clientId: "",
    amountMin: "",
    amountMax: "",
    paymentStatuses: ["NOT_PAID", "PARTIALLY_PAID", "PAID", "OVERDUE"],
  });

  // Table tab state
  const [items, setItems] = useState<OverviewItem[]>([]);
  const [totals, setTotals] = useState<OverviewResponse["totals"] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchOverview = useCallback(
    (append: boolean, cursor?: string) => {
      let cancelled = false;
      setLoading(true);
      apiFetch<OverviewResponse>(
        `/api/finance/payments-overview${buildOverviewQuery(filter, cursor)}`
      )
        .then((r) => {
          if (cancelled) return;
          setItems((prev) => (append ? [...prev, ...r.items] : r.items));
          setTotals(r.totals);
          setNextCursor(r.nextCursor);
          setError(null);
        })
        .catch((e) => {
          if (!cancelled) setError(e instanceof Error ? e.message : "Ошибка загрузки");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      return () => { cancelled = true; };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      filter.from,
      filter.to,
      filter.clientId,
      filter.amountMin,
      filter.amountMax,
      filter.paymentStatuses.join(","),
    ]
  );

  // Reload when filter changes (only for table tab; clients tab is self-contained)
  useEffect(() => {
    if (view !== "table") return;
    const cancel = fetchOverview(false);
    return cancel;
  }, [fetchOverview, view]);

  function handleFilterChange(f: PaymentsFilter) {
    setFilter(f);
    // reset pagination
    setItems([]);
    setNextCursor(null);
  }

  return (
    <div className="pb-10">
      <FinanceTabNav />

      <div className="px-7 py-5">
        {/* Page header */}
        <div className="flex items-end justify-between mb-5 pb-4 border-b border-border">
          <div>
            <p className="eyebrow mb-1">Финансы</p>
            <h1 className="text-[22px] font-semibold text-ink tracking-tight">Платежи</h1>
            {totals && view === "table" && (
              <p className="text-xs text-ink-2 mt-1">
                {totals.count} {totals.count === 1 ? "бронь" : totals.count <= 4 ? "брони" : "броней"}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* Записать платёж — T3: SA всегда, WH тоже (сервер валидирует по брони) */}
            {(user?.role === "SUPER_ADMIN" || user?.role === "WAREHOUSE") && (
              <button
                onClick={() => setRecordPaymentOpen(true)}
                className="px-3.5 py-1.5 text-xs font-medium bg-accent text-white rounded border border-accent hover:bg-accent-bright"
              >
                + Записать платёж
              </button>
            )}
            <PeriodSelector value={period} onChange={handlePeriodChange} />
            {/* Tab switcher */}
            <div className="flex border border-border rounded-lg overflow-hidden bg-surface-subtle">
              <button
                onClick={() => setView("table")}
                className={`px-4 py-2 text-sm font-medium transition-colors ${
                  view === "table"
                    ? "bg-accent-soft text-accent border-r border-accent-border"
                    : "text-ink-2 hover:text-ink border-r border-border"
                }`}
              >
                Таблица броней
              </button>
              <button
                onClick={() => setView("clients")}
                className={`px-4 py-2 text-sm font-medium transition-colors ${
                  view === "clients"
                    ? "bg-accent-soft text-accent"
                    : "text-ink-2 hover:text-ink"
                }`}
              >
                По клиентам
              </button>
            </div>
          </div>
        </div>

        {/* Filter bar */}
        <PaymentsFilterBar filter={filter} onChange={handleFilterChange} />

        {/* Totals strip — only for table tab */}
        {view === "table" && totals && (
          <PaymentsTotalsStrip
            billed={totals.billed}
            paid={totals.paid}
            outstanding={totals.outstanding}
            averageAmount={totals.averageAmount}
            count={totals.count}
          />
        )}

        {/* Error */}
        {error && view === "table" && (
          <div className="mb-4 p-3 rounded bg-rose-soft border border-rose-border text-rose text-sm">
            {error}
          </div>
        )}

        {/* Tab content */}
        {view === "table" ? (
          <PaymentsTable
            items={items}
            loading={loading}
            onLoadMore={nextCursor ? () => fetchOverview(true, nextCursor) : null}
            onRefresh={() => fetchOverview(false)}
            onRecordPayment={() => setRecordPaymentOpen(true)}
          />
        ) : (
          <PaymentsByClient filter={filter} />
        )}
      </div>

      {/* RecordPaymentModal — T2 global button call site */}
      <RecordPaymentModal
        open={recordPaymentOpen}
        onClose={() => setRecordPaymentOpen(false)}
        onCreated={() => {
          setRecordPaymentOpen(false);
          fetchOverview(false);
        }}
      />
    </div>
  );
}
