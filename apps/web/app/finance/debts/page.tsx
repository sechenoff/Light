"use client";

import { useEffect, useState } from "react";
import { useRequireRole } from "../../../src/hooks/useRequireRole";
import { apiFetch } from "../../../src/lib/api";
import { formatRub } from "../../../src/lib/format";
import type { UserRole } from "../../../src/lib/auth";

const ALLOWED: UserRole[] = ["SUPER_ADMIN"];

interface DebtProject {
  bookingId: string;
  projectName: string;
  amountOutstanding: string;
  expectedPaymentDate: string | null;
  daysOverdue: number | null;
  paymentStatus: string;
}

interface ClientDebt {
  clientId: string;
  clientName: string;
  totalOutstanding: string;
  overdueAmount: string;
  maxDaysOverdue: number;
  bookingsCount: number;
  projects: DebtProject[];
}

interface DebtsResponse {
  debts: ClientDebt[];
  summary: {
    totalClients: number;
    totalOutstanding: string;
    totalOverdue: string;
    asOf: string;
  };
}

function agingBucket(daysOverdue: number | null): "0-7" | "8-30" | "30+" {
  if (!daysOverdue || daysOverdue <= 0) return "0-7";
  if (daysOverdue <= 7) return "0-7";
  if (daysOverdue <= 30) return "8-30";
  return "30+";
}

function computeBuckets(debts: ClientDebt[]) {
  const buckets: Record<"0-7" | "8-30" | "30+", { count: number; total: number }> = {
    "0-7": { count: 0, total: 0 },
    "8-30": { count: 0, total: 0 },
    "30+": { count: 0, total: 0 },
  };
  for (const d of debts) {
    const bucket = agingBucket(d.maxDaysOverdue);
    buckets[bucket].count += d.bookingsCount;
    buckets[bucket].total += Number(d.totalOutstanding);
  }
  return buckets;
}

export default function DebtsPage() {
  const { authorized, loading } = useRequireRole(ALLOWED);
  const [data, setData] = useState<DebtsResponse | null>(null);
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [minAmount, setMinAmount] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [fetching, setFetching] = useState(false);

  const fetchDebts = () => {
    if (!authorized) return;
    setFetching(true);
    const params = new URLSearchParams();
    if (overdueOnly) params.set("overdueOnly", "true");
    if (minAmount && Number(minAmount) > 0) params.set("minAmount", minAmount);
    apiFetch<DebtsResponse>(`/api/finance/debts?${params}`)
      .then(setData)
      .finally(() => setFetching(false));
  };

  useEffect(() => { fetchDebts(); }, [authorized, overdueOnly, minAmount]);

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  if (loading || !authorized) return null;
  if (!data && fetching) return <div className="p-8 text-ink-3 text-sm">Загрузка…</div>;

  const buckets = data ? computeBuckets(data.debts) : null;

  return (
    <div className="space-y-6 pb-10">
      {/* Header */}
      <div>
        <p className="eyebrow">Финансы</p>
        <h1 className="text-2xl font-semibold text-ink mt-1">Дебиторская задолженность</h1>
      </div>

      {/* Aging buckets */}
      {buckets && (
        <div className="grid grid-cols-3 gap-3">
          {(["0-7", "8-30", "30+"] as const).map((key) => (
            <div key={key} className="bg-surface border border-border rounded-lg p-4 shadow-xs">
              <p className="eyebrow">{key} дней</p>
              <p className="mono-num text-xl mt-1 text-ink">{formatRub(buckets[key].total)}</p>
              <p className="text-xs text-ink-3 mt-0.5">{buckets[key].count} брон.</p>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-4 items-center">
        <label className="flex items-center gap-2 text-sm text-ink-2 cursor-pointer">
          <input
            type="checkbox"
            checked={overdueOnly}
            onChange={(e) => setOverdueOnly(e.target.checked)}
            className="rounded border-border"
          />
          Только просроченные
        </label>
        <div className="flex items-center gap-2">
          <span className="text-sm text-ink-2">Минимальная сумма:</span>
          <input
            type="number"
            value={minAmount}
            onChange={(e) => setMinAmount(e.target.value)}
            placeholder="0"
            className="border border-border rounded px-2 py-1 text-sm w-32 bg-surface text-ink"
          />
        </div>
      </div>

      {/* Table */}
      {data && (
        <div className="bg-surface border border-border rounded-lg shadow-xs overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-subtle">
                <th className="text-left px-4 py-3 text-ink-2 font-medium">Клиент</th>
                <th className="text-right px-4 py-3 text-ink-2 font-medium">Долг</th>
                <th className="text-right px-4 py-3 text-ink-2 font-medium">Макс. просрочка</th>
                <th className="text-right px-4 py-3 text-ink-2 font-medium">Брони</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {data.debts.map((d) => (
                <>
                  <tr
                    key={d.clientId}
                    className="border-b border-border hover:bg-surface-subtle cursor-pointer"
                    onClick={() => toggleExpanded(d.clientId)}
                  >
                    <td className="px-4 py-3 font-medium text-ink">{d.clientName}</td>
                    <td className="px-4 py-3 text-right mono-num text-ink font-medium">
                      {formatRub(d.totalOutstanding)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {d.maxDaysOverdue > 0 ? (
                        <span className="text-rose">{d.maxDaysOverdue} дн.</span>
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-ink-2">{d.bookingsCount}</td>
                    <td className="px-4 py-3 text-center text-ink-3">
                      {expanded.has(d.clientId) ? "▲" : "▼"}
                    </td>
                  </tr>
                  {expanded.has(d.clientId) && d.projects.map((p) => (
                    <tr key={p.bookingId} className="bg-surface-subtle border-b border-border">
                      <td className="px-8 py-2 text-ink-2 text-xs">{p.projectName}</td>
                      <td className="px-4 py-2 text-right mono-num text-xs text-ink-2">
                        {formatRub(p.amountOutstanding)}
                      </td>
                      <td className="px-4 py-2 text-right text-xs">
                        {p.daysOverdue !== null && p.daysOverdue > 0 ? (
                          <span className="text-rose">{p.daysOverdue} дн.</span>
                        ) : (
                          <span className="text-ink-3">—</span>
                        )}
                      </td>
                      <td colSpan={2} className="px-4 py-2 text-xs text-ink-3">
                        {p.paymentStatus}
                      </td>
                    </tr>
                  ))}
                </>
              ))}
              {data.debts.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-ink-3 text-sm">
                    Нет задолженностей
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {data.summary && (
            <div className="px-4 py-3 border-t border-border bg-surface-subtle flex justify-between text-sm">
              <span className="text-ink-2">{data.summary.totalClients} клиентов</span>
              <span className="mono-num font-medium text-ink">{formatRub(data.summary.totalOutstanding)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
