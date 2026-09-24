"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";
import { formatRub } from "../../lib/format";
import { toMoscowDateString } from "../../lib/moscowDate";
import { StatusPill } from "../StatusPill";
import { RecordPaymentModal } from "./RecordPaymentModal";
import { StatusCell } from "./StatusCell";
import type { OverviewItem } from "./PaymentsTable";
import type { PaymentsFilter } from "./PaymentsFilterBar";

/** Converts ISO datetime to YYYY-MM-DD for /api/finance/payments-by-client (Zod regex). */
function toDateParam(iso: string): string {
  try {
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
    return toMoscowDateString(new Date(iso));
  } catch {
    return iso;
  }
}

interface ClientRow {
  id: string;
  name: string;
  bookingCount: number;
  lastBookingDate: string | null;
  totalBilled: string;
  totalPaid: string;
  totalOutstanding: string;
}

interface ClientsResponse {
  clients: ClientRow[];
  totals: {
    clientCount: number;
    billed: string;
    paid: string;
    outstanding: string;
    averageDebt: string;
  };
}

function buildClientQuery(filter: PaymentsFilter): string {
  const params = new URLSearchParams();
  if (filter.from) params.set("from", toDateParam(filter.from));
  if (filter.to) params.set("to", toDateParam(filter.to));
  if (filter.amountMin) params.set("amountMin", filter.amountMin);
  if (filter.amountMax) params.set("amountMax", filter.amountMax);
  if (filter.paymentStatuses.length > 0 && filter.paymentStatuses.length < 4) {
    params.set("paymentStatus", filter.paymentStatuses.join(","));
  }
  return params.toString() ? `?${params.toString()}` : "";
}

function buildOverviewQuery(clientId: string, filter: PaymentsFilter): string {
  const params = new URLSearchParams();
  params.set("clientId", clientId);
  params.set("limit", "50");
  if (filter.from) params.set("from", toDateParam(filter.from));
  if (filter.to) params.set("to", toDateParam(filter.to));
  return `?${params.toString()}`;
}

interface Props {
  filter: PaymentsFilter;
}

export function PaymentsByClient({ filter }: Props) {
  const [data, setData] = useState<ClientsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [clientBookings, setClientBookings] = useState<Record<string, OverviewItem[]>>({});
  const [clientBookingsLoading, setClientBookingsLoading] = useState<Set<string>>(new Set());
  const [payingBooking, setPayingBooking] = useState<OverviewItem | null>(null);

  const fetchData = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch<ClientsResponse>(`/api/finance/payments-by-client${buildClientQuery(filter)}`)
      .then((r) => { if (!cancelled) { setData(r); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Ошибка"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filter.from,
    filter.to,
    filter.amountMin,
    filter.amountMax,
    filter.paymentStatuses.join(","),
  ]);

  useEffect(() => {
    const cancel = fetchData();
    return cancel;
  }, [fetchData]);

  function toggleExpand(clientId: string) {
    const next = new Set(expanded);
    if (next.has(clientId)) {
      next.delete(clientId);
      setExpanded(next);
    } else {
      next.add(clientId);
      setExpanded(next);
      // Load bookings for this client if not already loaded
      if (!clientBookings[clientId]) {
        const loading = new Set(clientBookingsLoading);
        loading.add(clientId);
        setClientBookingsLoading(loading);
        apiFetch<{ items: OverviewItem[] }>(
          `/api/finance/payments-overview${buildOverviewQuery(clientId, filter)}`
        )
          .then((r) => {
            setClientBookings((prev) => ({ ...prev, [clientId]: r.items ?? [] }));
          })
          .catch(() => {
            setClientBookings((prev) => ({ ...prev, [clientId]: [] }));
          })
          .finally(() => {
            setClientBookingsLoading((prev) => {
              const s = new Set(prev);
              s.delete(clientId);
              return s;
            });
          });
      }
    }
  }

  if (loading) {
    return <div className="py-12 text-center text-ink-3 text-sm">Загрузка…</div>;
  }

  if (error) {
    return <div className="py-6 text-rose text-sm">Ошибка: {error}</div>;
  }

  if (!data || data.clients.length === 0) {
    return <div className="py-12 text-center text-ink-3 text-sm">Нет клиентов по выбранным фильтрам</div>;
  }

  return (
    <>
      <div className="space-y-2">
        {data.clients.map((client) => {
          const isOpen = expanded.has(client.id);
          const bookingsForClient = clientBookings[client.id] ?? [];
          const isLoadingBookings = clientBookingsLoading.has(client.id);
          const outstanding = Number(client.totalOutstanding);
          const billed = Number(client.totalBilled);
          const paidPct = billed > 0 ? (Number(client.totalPaid) / billed) * 100 : 0;

          return (
            <div key={client.id} className="border border-border rounded-lg overflow-hidden shadow-xs">
              {/* Client header */}
              <button
                className="w-full flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-4 py-3 bg-surface hover:bg-surface-subtle text-left transition-colors sm:flex-nowrap sm:px-5 sm:py-3.5"
                onClick={() => toggleExpand(client.id)}
                aria-expanded={isOpen}
              >
                <div className="flex min-w-0 flex-1 items-center gap-3 sm:gap-4">
                  <span
                    className={`text-ink-3 text-xs transition-transform ${isOpen ? "rotate-90" : ""}`}
                  >
                    ▶
                  </span>
                  <div>
                    <span className="text-sm font-semibold text-ink">{client.name}</span>
                    <span className="ml-2 text-xs text-ink-3 whitespace-nowrap">
                      {client.bookingCount} {client.bookingCount === 1 ? "бронь" : client.bookingCount <= 4 ? "брони" : "броней"}
                    </span>
                  </div>
                </div>
                {/* На телефоне — второй строкой под именем: «оплачено / начислено» слева,
                    долг справа; на sm+ колонки фиксированной минимальной ширины, чтобы
                    полосы и суммы у всех клиентов стояли на одной вертикали. */}
                <div className="flex w-full items-baseline justify-between gap-3 pl-6 sm:w-auto sm:items-center sm:justify-end sm:gap-6 sm:pl-0">
                  {/* Mini progress — 5-bucket approximation to avoid inline style */}
                  <div className="flex min-w-0 items-center gap-2 text-xs text-ink-2">
                    <div className="hidden h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-surface-subtle sm:block">
                      <div
                        className={`h-full rounded-full ${
                          paidPct >= 100 ? "w-full bg-emerald" :
                          paidPct >= 75  ? "w-3/4 bg-amber" :
                          paidPct >= 50  ? "w-1/2 bg-amber" :
                          paidPct >= 25  ? "w-1/4 bg-amber" :
                          paidPct > 0    ? "w-1/4 bg-amber" :
                          "w-0 bg-rose-soft"
                        }`}
                      />
                    </div>
                    <span className="mono-num sm:min-w-[210px] sm:whitespace-nowrap sm:text-right">{formatRub(client.totalPaid)} / {formatRub(client.totalBilled)}</span>
                  </div>
                  {/* Outstanding */}
                  <div className="flex shrink-0 justify-end whitespace-nowrap sm:min-w-[170px]">
                    {outstanding > 0 ? (
                      <span className="text-sm mono-num font-semibold text-rose">{formatRub(client.totalOutstanding)} долг</span>
                    ) : (
                      <StatusPill variant="ok" label="Оплачено" />
                    )}
                  </div>
                </div>
              </button>

              {/* Expanded bookings */}
              {isOpen && (
                // overflow-x-auto: на 375px вложенная таблица шире вьюпорта — без скролла
                // колонка «Статус оплаты» с CTA «Оплатить» была недостижима
                <div className="border-t border-border bg-surface-subtle overflow-x-auto">
                  {isLoadingBookings ? (
                    <p className="px-5 py-4 text-xs text-ink-3">Загрузка броней…</p>
                  ) : bookingsForClient.length === 0 ? (
                    <p className="px-5 py-4 text-xs text-ink-3">Нет броней</p>
                  ) : (
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border">
                          <th className="text-left px-5 py-2 eyebrow">Дата</th>
                          <th className="text-left px-4 py-2 eyebrow w-[110px]">Проект</th>
                          <th className="text-right px-4 py-2 eyebrow">Сумма</th>
                          <th className="text-left px-4 py-2 eyebrow w-[440px] min-w-[320px]">Статус оплаты</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bookingsForClient.map((b) => (
                          <tr key={b.id} className="border-b border-border last:border-0 hover:bg-surface">
                            <td className="px-5 py-2.5 text-ink-2 mono-num whitespace-nowrap">
                              {new Date(b.startDate).toLocaleDateString("ru-RU")}
                            </td>
                            <td className="px-4 py-2.5 text-ink max-w-[110px] truncate">{b.projectName}</td>
                            <td className="px-4 py-2.5 text-right mono-num font-medium text-ink whitespace-nowrap">
                              {formatRub(b.finalAmount)}
                            </td>
                            <td className="px-4 py-2.5">
                              <StatusCell item={b} onPay={() => setPayingBooking(b)} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Totals footer */}
      <div className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border shadow-xs xl:grid-cols-4">
        <div className="min-w-0 bg-surface px-3 py-3 sm:px-4">
          <p className="eyebrow mb-0.5">Клиентов</p>
          <p className="text-base sm:text-lg whitespace-nowrap font-semibold text-ink mono-num">{data.totals.clientCount}</p>
        </div>
        <div className="min-w-0 bg-surface px-3 py-3 sm:px-4">
          <p className="eyebrow mb-0.5">Начислено</p>
          <p className="text-base sm:text-lg whitespace-nowrap font-semibold text-ink mono-num">{formatRub(data.totals.billed)}</p>
        </div>
        <div className="min-w-0 bg-surface px-3 py-3 sm:px-4">
          <p className="eyebrow mb-0.5">К получению</p>
          <p className={`text-base sm:text-lg whitespace-nowrap font-semibold mono-num ${Number(data.totals.outstanding) > 0 ? "text-rose" : "text-ink"}`}>
            {formatRub(data.totals.outstanding)}
          </p>
        </div>
        <div className="min-w-0 bg-surface px-3 py-3 sm:px-4">
          <p className="eyebrow mb-0.5">Средний долг</p>
          <p className="text-base sm:text-lg whitespace-nowrap font-semibold text-ink mono-num">{formatRub(data.totals.averageDebt)}</p>
        </div>
      </div>

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
          // Refetch client data and clear cached booking lists
          setClientBookings({});
          fetchData();
        }}
      />
    </>
  );
}
