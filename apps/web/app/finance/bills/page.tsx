"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { useRequireRole } from "../../../src/hooks/useRequireRole";
import { apiFetch } from "../../../src/lib/api";
import { formatMoneyRub, pluralize } from "../../../src/lib/format";
import { printEstimate } from "../../../src/lib/estimateExport";
import { StatusPill } from "../../../src/components/StatusPill";
import { FinanceTabNav } from "../../../src/components/finance/FinanceTabNav";
import { toast } from "../../../src/components/ToastProvider";
import {
  BILL_STATUS_LABELS,
  billStatusVariant,
  type BillDto,
  type BillStatus,
} from "../../../src/components/finance/BillEditor";

type ListResponse = {
  items: BillDto[];
  counts: Partial<Record<BillStatus | "ALL", number>>;
  sums: Partial<Record<BillStatus, string>>;
  years: number[];
};

const STATUS_TABS: Array<{ key: BillStatus | "ALL"; label: string }> = [
  { key: "ALL", label: "Все" },
  { key: "ISSUED", label: BILL_STATUS_LABELS.ISSUED },
  { key: "PAID", label: BILL_STATUS_LABELS.PAID },
  { key: "CANCELLED", label: BILL_STATUS_LABELS.CANCELLED },
];

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/**
 * Реестр счетов на оплату контрагентам. Не путать со «Счетами по броням»
 * (финансовые обязательства с платежами и дебиторкой): здесь — печатные
 * документы, которые ИП выставляет заказчику для оплаты по реквизитам.
 */
function BillsPage() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [statusTab, setStatusTab] = useState<BillStatus | "ALL">(
    (searchParams.get("status") as BillStatus | null) ?? "ALL",
  );
  const [year, setYear] = useState<string>(searchParams.get("year") ?? "");
  const [search, setSearch] = useState(searchParams.get("q") ?? "");
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusTab !== "ALL") params.set("status", statusTab);
      if (year) params.set("year", year);
      if (search.trim()) params.set("q", search.trim());
      params.set("limit", "300");
      setData(await apiFetch<ListResponse>(`/api/bills?${params}`));
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Не удалось загрузить счета");
    } finally {
      setLoading(false);
    }
  }, [statusTab, year, search]);

  useEffect(() => {
    const t = setTimeout(() => void load(), search ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  function syncUrl(next: { status?: BillStatus | "ALL"; year?: string; q?: string }) {
    const params = new URLSearchParams(searchParams.toString());
    const status = next.status ?? statusTab;
    const y = next.year ?? year;
    const q = next.q ?? search;
    if (status === "ALL") params.delete("status");
    else params.set("status", status);
    if (y) params.set("year", y);
    else params.delete("year");
    if (q) params.set("q", q);
    else params.delete("q");
    router.replace(`/finance/bills?${params}`, { scroll: false });
  }

  const items = data?.items ?? [];
  const counts = data?.counts ?? {};
  const issuedSum = Number(data?.sums?.ISSUED ?? 0);
  const paidSum = Number(data?.sums?.PAID ?? 0);

  return (
    <div className="min-h-screen">
      <FinanceTabNav />

      <div className="p-4 lg:p-6">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="eyebrow text-ink-3">Финансы</p>
            <h1 className="mt-1 text-[22px] font-semibold text-ink">Счета на оплату</h1>
            <p className="mt-1 text-xs text-ink-3">
              Печатные счета контрагентам по реквизитам ИП. Ждут оплаты: {formatMoneyRub(issuedSum)} · оплачено: {formatMoneyRub(paidSum)}
            </p>
          </div>
          <Link
            href="/finance/bills/new"
            className="inline-flex h-10 items-center justify-center whitespace-nowrap rounded bg-accent-bright px-3.5 text-[12px] font-semibold text-surface hover:opacity-90 sm:h-9"
          >
            + Выставить счёт
          </Link>
        </div>

        {/* Статусы */}
        {/* На телефоне лента выходит к краю экрана — обрез читается как прокрутка */}
        <div className="-mx-4 mb-4 flex gap-0.5 overflow-x-auto border-b border-border px-4 sm:mx-0 sm:px-0">
          {STATUS_TABS.map((tab) => {
            const count = counts[tab.key] ?? 0;
            const active = statusTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => {
                  setStatusTab(tab.key);
                  syncUrl({ status: tab.key });
                }}
                className={`-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-3 text-[13px] transition-colors sm:px-3.5 ${
                  active ? "border-accent-bright font-semibold text-accent-bright" : "border-transparent text-ink-2 hover:text-ink"
                }`}
              >
                {tab.label}
                {count > 0 && (
                  <span
                    className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${
                      active
                        ? "border border-accent-border bg-accent-soft text-accent-bright"
                        : "border border-border bg-surface-subtle text-ink-3"
                    }`}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Фильтры */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            type="search"
            placeholder="🔍 контрагент, ИНН или № счёта"
            className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-[13px] text-ink sm:flex-none sm:min-w-[240px]"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              syncUrl({ q: e.target.value });
            }}
          />
          <select
            aria-label="Год"
            className="shrink-0 rounded-lg border border-border bg-surface px-3 py-2 text-[13px] text-ink"
            value={year}
            onChange={(e) => {
              setYear(e.target.value);
              syncUrl({ year: e.target.value });
            }}
          >
            <option value="">Все годы</option>
            {(data?.years ?? []).map((y) => (
              <option key={y} value={String(y)}>{y}</option>
            ))}
          </select>
        </div>

        {loading && !data ? (
          <div className="py-12 text-center text-sm text-ink-3">Загрузка…</div>
        ) : items.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface py-16 text-center text-ink-2">
            <p className="mb-2 text-[15px] font-medium">Счетов пока нет</p>
            <p className="text-sm text-ink-3">
              Нажмите «Выставить счёт» — контрагент, услуга, сумма — и сразу на печать.
            </p>
          </div>
        ) : (
          <>
            {/* Desktop */}
            {/* overflow-x-auto: таблица не обрезается, «Содержание» появляется с xl */}
            <div className="hidden overflow-x-auto rounded-lg border border-border bg-surface shadow-xs md:block">
              <table className="w-full text-[12.5px]">
                <thead className="border-b border-border bg-surface-subtle">
                  <tr>
                    <th className="eyebrow whitespace-nowrap px-3 py-3 text-left">№</th>
                    <th className="eyebrow whitespace-nowrap px-3 py-3 text-left">Дата</th>
                    <th className="eyebrow whitespace-nowrap px-3 py-3 text-left">Контрагент</th>
                    <th className="eyebrow hidden whitespace-nowrap px-3 py-3 text-left xl:table-cell">Содержание</th>
                    <th className="eyebrow whitespace-nowrap px-3 py-3 text-right">Сумма</th>
                    <th className="eyebrow whitespace-nowrap px-3 py-3 text-left">Оплатить до</th>
                    <th className="eyebrow whitespace-nowrap px-3 py-3 text-left">Статус</th>
                    <th className="w-28 px-3 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((b) => {
                    const first = b.lines[0]?.name ?? "";
                    const more = b.lines.length - 1;
                    const overdue = b.status === "ISSUED" && b.dueDate && new Date(b.dueDate).getTime() < Date.now();
                    return (
                      <tr key={b.id} className={`border-b border-border last:border-0 hover:bg-surface-subtle ${b.status === "CANCELLED" ? "opacity-60" : ""}`}>
                        <td className="px-3 py-2.5 font-mono text-ink">
                          <Link href={`/finance/bills/${b.id}`} className="hover:text-accent">
                            {b.number}
                            <span className="text-ink-3">/{b.year}</span>
                          </Link>
                        </td>
                        <td className="mono-num whitespace-nowrap px-3 py-2.5 text-ink-2">{fmtDate(b.date)}</td>
                        <td className="min-w-[160px] px-3 py-2.5">
                          <div className="line-clamp-2 font-medium text-ink" title={b.payer.legalName ?? b.clientName}>{b.payer.legalName ?? b.clientName}</div>
                          {b.payer.inn && <div className="font-mono text-[11px] text-ink-3">ИНН {b.payer.inn}</div>}
                        </td>
                        {/* truncate — на внутреннем div: на самой ячейке он не ограничивал ширину колонки */}
                        <td className="hidden px-3 py-2.5 text-ink-2 xl:table-cell" title={b.lines.map((l) => l.name).join("; ")}>
                          <div className="max-w-[320px] truncate">
                            {first}
                            {more > 0 && <span className="text-ink-3"> +{more}</span>}
                          </div>
                        </td>
                        <td className="mono-num whitespace-nowrap px-3 py-2.5 text-right font-medium text-ink">{formatMoneyRub(b.total)}</td>
                        <td className={`mono-num whitespace-nowrap px-3 py-2.5 ${overdue ? "text-rose" : "text-ink-2"}`}>{fmtDate(b.dueDate)}</td>
                        <td className="px-3 py-2.5">
                          <StatusPill variant={billStatusVariant(b.status)} label={BILL_STATUS_LABELS[b.status]} />
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <button
                            type="button"
                            onClick={() => void printEstimate(`/api/bills/${b.id}/pdf`, "Счёт не найден")}
                            className="rounded border border-border px-2.5 py-1 text-[12px] text-ink-2 hover:bg-surface-muted"
                          >
                            Печать
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile */}
            <div className="space-y-2 md:hidden">
              {items.map((b) => (
                <Link
                  key={b.id}
                  href={`/finance/bills/${b.id}`}
                  className="block rounded-lg border border-border bg-surface p-3 shadow-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-sm text-ink">№ {b.number}/{b.year}</span>
                    <StatusPill variant={billStatusVariant(b.status)} label={BILL_STATUS_LABELS[b.status]} />
                  </div>
                  <div className="mt-1 text-sm font-medium text-ink">{b.payer.legalName ?? b.clientName}</div>
                  <div className="mt-0.5 truncate text-xs text-ink-3">{b.lines[0]?.name}</div>
                  <div className="mt-2 flex items-baseline justify-between">
                    <span className="text-xs text-ink-3">{fmtDate(b.date)}</span>
                    <span className="mono-num font-semibold text-ink">{formatMoneyRub(b.total)}</span>
                  </div>
                </Link>
              ))}
            </div>

            <p className="mt-3 text-xs text-ink-3">
              {items.length} {pluralize(items.length, "счёт", "счёта", "счетов")}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function PageGuard() {
  const { authorized, loading } = useRequireRole(["SUPER_ADMIN"]);
  if (loading || !authorized) return null;
  return (
    <Suspense fallback={<div className="p-6 text-sm text-ink-3">Загрузка…</div>}>
      <BillsPage />
    </Suspense>
  );
}

export default function BillsRoute() {
  return <PageGuard />;
}
