"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { useRequireRole } from "../../../src/hooks/useRequireRole";
import { useCurrentUser } from "../../../src/hooks/useCurrentUser";
import { apiFetch, apiFetchRaw } from "../../../src/lib/api";
import { formatRub } from "../../../src/lib/format";
import { StatusPill } from "../../../src/components/StatusPill";
import { FinanceTabNav } from "../../../src/components/finance/FinanceTabNav";
import { CreateInvoiceModal } from "../../../src/components/finance/CreateInvoiceModal";
import { VoidInvoiceModal } from "../../../src/components/finance/VoidInvoiceModal";
import { toast } from "../../../src/components/ToastProvider";
import { FINANCE_TERMS } from "../../../src/lib/financeTerms";

// ── Types ─────────────────────────────────────────────────────────────────────

type InvoiceStatus = "DRAFT" | "ISSUED" | "PARTIAL_PAID" | "PAID" | "OVERDUE" | "VOID";
type InvoiceKind = "FULL" | "DEPOSIT" | "BALANCE" | "CORRECTION";

interface Invoice {
  id: string;
  number: string | null;
  kind: InvoiceKind;
  status: InvoiceStatus;
  total: string;
  paidAmount: string;
  dueDate: string | null;
  createdAt: string;
  booking: {
    id: string;
    projectName: string;
    client: { id: string; name: string };
  };
}

interface InvoicesResponse {
  items: Invoice[];
  total: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type PeriodKey = "today" | "7d" | "30d" | "quarter" | "year" | "all";

const PERIOD_OPTIONS: Array<{ key: PeriodKey; label: string }> = [
  { key: "7d", label: "7 дней" },
  { key: "30d", label: "30 дней" },
  { key: "quarter", label: "Квартал" },
  { key: "year", label: "Год" },
  { key: "all", label: "За всё время" },
];

function periodToDates(period: PeriodKey): { createdAfter?: string; createdBefore?: string } {
  if (period === "all") return {};
  const now = new Date();
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  const start = new Date(now);
  if (period === "today") {
    start.setHours(0, 0, 0, 0);
  } else if (period === "7d") {
    start.setDate(start.getDate() - 6);
    start.setHours(0, 0, 0, 0);
  } else if (period === "30d") {
    start.setDate(start.getDate() - 29);
    start.setHours(0, 0, 0, 0);
  } else if (period === "quarter") {
    start.setDate(start.getDate() - 90);
    start.setHours(0, 0, 0, 0);
  } else if (period === "year") {
    start.setFullYear(start.getFullYear() - 1);
    start.setHours(0, 0, 0, 0);
  }
  return { createdAfter: start.toISOString(), createdBefore: end.toISOString() };
}

const STATUS_TABS: Array<{ key: InvoiceStatus | "ALL"; label: string }> = [
  { key: "ALL", label: "Все" },
  { key: "DRAFT", label: "К выставлению" },
  { key: "ISSUED", label: "Выставлено" },
  { key: "PARTIAL_PAID", label: "Частично" },
  { key: "PAID", label: "Оплачены" },
  { key: "OVERDUE", label: "Просрочены" },
  { key: "VOID", label: "Аннулированы" },
];

const KIND_LABELS: Record<InvoiceKind, string> = {
  FULL: "Полный",
  DEPOSIT: "Предоплата",
  BALANCE: "Остаток",
  CORRECTION: "Корректировка",
};

function statusVariant(s: InvoiceStatus): "view" | "info" | "warn" | "ok" | "alert" | "none" {
  switch (s) {
    case "DRAFT": return "view";
    case "ISSUED": return "info";
    case "PARTIAL_PAID": return "warn";
    case "PAID": return "ok";
    case "OVERDUE": return "alert";
    case "VOID": return "none";
  }
}

function statusLabel(s: InvoiceStatus): string {
  switch (s) {
    case "DRAFT": return FINANCE_TERMS.draft;
    case "ISSUED": return FINANCE_TERMS.billed;
    case "PARTIAL_PAID": return FINANCE_TERMS.partial;
    case "PAID": return FINANCE_TERMS.paid;
    case "OVERDUE": return FINANCE_TERMS.overdue;
    case "VOID": return FINANCE_TERMS.void;
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

function daysOverdue(dueDate: string | null): number | null {
  if (!dueDate) return null;
  const d = Math.floor((Date.now() - new Date(dueDate).getTime()) / 86400000);
  return d > 0 ? d : null;
}

// ── Main page component ───────────────────────────────────────────────────────

function InvoicesPage() {
  const { user } = useCurrentUser();
  const isSA = user?.role === "SUPER_ADMIN";

  const searchParams = useSearchParams();
  const router = useRouter();

  const [statusTab, setStatusTab] = useState<InvoiceStatus | "ALL">(
    (searchParams.get("status") as InvoiceStatus | "ALL") ?? "ALL"
  );
  const [search, setSearch] = useState(searchParams.get("search") ?? "");
  const [period, setPeriod] = useState<PeriodKey>(
    (searchParams.get("period") as PeriodKey) ?? "all"
  );
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkIssuing, setBulkIssuing] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [voidInvoiceId, setVoidInvoiceId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setSelected(new Set());
    try {
      const params = new URLSearchParams();
      if (statusTab !== "ALL") params.set("status", statusTab);
      if (search.trim()) params.set("search", search.trim());
      params.set("limit", "100");
      const { createdAfter, createdBefore } = periodToDates(period);
      if (createdAfter) params.set("createdAfter", createdAfter);
      if (createdBefore) params.set("createdBefore", createdBefore);
      const data = await apiFetch<InvoicesResponse>(`/api/invoices?${params}`);
      setInvoices(data.items);
      setTotal(data.total);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Ошибка загрузки счетов");
    } finally {
      setLoading(false);
    }
  }, [statusTab, search, period]);

  useEffect(() => {
    load();
  }, [load]);

  function changeTab(tab: InvoiceStatus | "ALL") {
    setStatusTab(tab);
    const params = new URLSearchParams(searchParams.toString());
    if (tab === "ALL") params.delete("status");
    else params.set("status", tab);
    router.replace(`/finance/invoices?${params}`);
  }

  async function issueInvoice(id: string) {
    try {
      await apiFetch(`/api/invoices/${id}/issue`, { method: "POST" });
      toast.success("Счёт выставлен");
      load();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Ошибка выставления");
    }
  }

  async function bulkIssue() {
    const draftIds = invoices
      .filter((inv) => selected.has(inv.id) && inv.status === "DRAFT")
      .map((inv) => inv.id);
    if (draftIds.length === 0) {
      toast.info("Нет черновиков для выставления");
      return;
    }
    setBulkIssuing(true);
    let ok = 0;
    let fail = 0;
    for (const id of draftIds) {
      try {
        await apiFetch(`/api/invoices/${id}/issue`, { method: "POST" });
        ok++;
      } catch {
        fail++;
      }
    }
    setBulkIssuing(false);
    if (ok > 0) toast.success(`Выставлено ${ok} счётов${fail > 0 ? `, ${fail} ошибок` : ""}`);
    else toast.error(`Ошибка выставления всех счетов`);
    load();
  }

  async function downloadPdf(inv: Invoice) {
    try {
      const res = await apiFetchRaw(`/api/invoices/${inv.id}/pdf`, { method: "GET", credentials: "include" });
      if (!res.ok) { toast.error("Не удалось скачать PDF"); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `invoice-${inv.number ?? inv.id}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error("Ошибка скачивания PDF");
    }
  }

  const allSelectableIds = invoices.filter((inv) => inv.status === "DRAFT").map((inv) => inv.id);
  const allSelected = allSelectableIds.length > 0 && allSelectableIds.every((id) => selected.has(id));

  function toggleSelectAll() {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(allSelectableIds));
  }

  function toggleSelect(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  const selectedCount = selected.size;
  const draftSelectedCount = invoices.filter((inv) => selected.has(inv.id) && inv.status === "DRAFT").length;

  // Counts per status (loaded from server totals or client side)
  const counts = STATUS_TABS.reduce((acc, tab) => {
    if (tab.key === "ALL") acc[tab.key] = invoices.length;
    else acc[tab.key] = invoices.filter((inv) => inv.status === tab.key).length;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div className="min-h-screen bg-surface-subtle">
      <FinanceTabNav />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-5">

        {/* Header */}
        <div className="mb-4">
          <p className="eyebrow text-ink-3">Финансы</p>
          <h1 className="text-[22px] font-semibold text-ink mt-1">Счета</h1>
        </div>

        {/* Tabs (underline style) */}
        <div className="flex border-b border-border mb-4 overflow-x-auto gap-0.5">
          {STATUS_TABS.map((tab) => {
            const count = counts[tab.key] ?? 0;
            const active = statusTab === tab.key;
            const isOverdue = tab.key === "OVERDUE";
            return (
              <button
                key={tab.key}
                onClick={() => changeTab(tab.key as InvoiceStatus | "ALL")}
                className={`flex items-center gap-1.5 px-3.5 py-3 text-[13px] border-b-2 -mb-px whitespace-nowrap transition-colors ${
                  active
                    ? "text-accent-bright border-accent-bright font-semibold"
                    : "text-ink-2 border-transparent hover:text-ink"
                }`}
              >
                {tab.label}
                {count > 0 && (
                  <span className={`text-[11px] px-1.5 py-0.5 rounded font-mono ${
                    active
                      ? "bg-accent-soft text-accent-bright border border-accent-border"
                      : isOverdue
                        ? "bg-rose-soft text-rose border border-rose-border"
                        : "bg-surface-subtle text-ink-3 border border-border"
                  }`}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Filter bar + CTA */}
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <div className="flex gap-2 flex-wrap">
            <input
              type="text"
              placeholder="🔍 № счёта, клиент, проект…"
              className="border border-border rounded-lg px-3 py-2 text-[13px] bg-surface text-ink min-w-[240px]"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {/* Period pills */}
            <div className="flex items-center gap-1 bg-surface border border-border rounded-lg p-1 overflow-x-auto flex-nowrap">
              {PERIOD_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => setPeriod(opt.key)}
                  className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors whitespace-nowrap ${
                    period === opt.key
                      ? "bg-accent-bright text-white shadow-xs"
                      : "text-ink-2 hover:text-ink"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <button className="px-3.5 py-2 text-[12px] font-medium border border-border bg-surface text-ink rounded-lg hover:bg-surface-subtle transition-colors">
              📊 Экспорт XLSX
            </button>
            {isSA && (
              <button
                onClick={() => setCreateOpen(true)}
                className="px-3.5 py-2 text-[12px] font-semibold bg-accent-bright text-white rounded-lg hover:opacity-90 transition-opacity"
              >
                + Создать счёт
              </button>
            )}
          </div>
        </div>

        {/* Bulk bar (visible when selected) */}
        {selectedCount > 0 && (
          <div className="flex items-center gap-3 mb-3 px-4 py-2.5 bg-accent-soft border border-accent-border rounded-lg text-[13px]">
            <input type="checkbox" className="rounded" checked={allSelected} onChange={toggleSelectAll} />
            <span><strong>{selectedCount} счёт{selectedCount > 1 ? "а" : ""}</strong> выбрано</span>
            {draftSelectedCount > 0 && isSA && (
              <button
                onClick={bulkIssue}
                disabled={bulkIssuing}
                className="px-3 py-1.5 bg-accent-bright text-white rounded text-[12px] hover:opacity-90 disabled:opacity-50"
              >
                {bulkIssuing ? "Выставляем…" : "Выставить выбранные"}
              </button>
            )}
            <button
              onClick={async () => {
                // Download PDFs for selected invoices that have a number
                for (const inv of invoices.filter((i) => selected.has(i.id) && i.number)) {
                  await downloadPdf(inv);
                }
              }}
              className="px-3 py-1.5 border border-border bg-surface rounded text-[12px] hover:bg-surface-subtle"
            >
              Скачать все PDF
            </button>
            <span className="ml-auto text-ink-3 text-[11.5px]">Действие применится только к черновикам</span>
          </div>
        )}

        {/* Table — desktop */}
        {loading ? (
          <div className="text-center py-12 text-ink-3 text-sm">Загрузка…</div>
        ) : invoices.length === 0 ? (
          <div className="text-center py-16 text-ink-2 bg-surface border border-border rounded-lg">
            <p className="text-[15px] font-medium mb-2">Счетов нет</p>
            <p className="text-sm text-ink-3">Создайте счёт на странице брони → «Создать счёт»</p>
          </div>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden md:block bg-surface border border-border rounded-lg overflow-hidden shadow-xs">
              <table className="w-full text-[12.5px]">
                <thead className="bg-surface-subtle border-b border-border">
                  <tr>
                    <th className="w-9 px-3 py-3 text-left">
                      <input
                        type="checkbox"
                        className="rounded"
                        checked={allSelected}
                        onChange={toggleSelectAll}
                        title="Выбрать все черновики"
                      />
                    </th>
                    <th className="px-3 py-3 text-left eyebrow">№ счёта</th>
                    <th className="px-3 py-3 text-left eyebrow">Клиент</th>
                    <th className="px-3 py-3 text-left eyebrow">Бронь</th>
                    <th className="px-3 py-3 text-left eyebrow">Тип</th>
                    <th className="px-3 py-3 text-right eyebrow">Сумма</th>
                    <th className="px-3 py-3 text-right eyebrow">Оплачено</th>
                    <th className="px-3 py-3 text-right eyebrow">Остаток</th>
                    <th className="px-3 py-3 text-left eyebrow">Срок</th>
                    <th className="px-3 py-3 text-left eyebrow">Статус</th>
                    <th className="px-3 py-3 w-24"></th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => {
                    const outstanding = Math.max(0, Number(inv.total) - Number(inv.paidAmount));
                    const overdueDays = daysOverdue(inv.dueDate);
                    const isVoid = inv.status === "VOID";
                    return (
                      <tr
                        key={inv.id}
                        className={`border-b border-slate-soft last:border-0 transition-colors ${
                          isVoid ? "bg-surface-subtle opacity-60" : "hover:bg-surface-subtle/50"
                        }`}
                      >
                        <td className="px-3 py-3">
                          {inv.status === "DRAFT" && (
                            <input
                              type="checkbox"
                              className="rounded"
                              checked={selected.has(inv.id)}
                              onChange={() => toggleSelect(inv.id)}
                            />
                          )}
                          {isVoid && <input type="checkbox" className="rounded" disabled />}
                        </td>
                        <td className="px-3 py-3">
                          <span className={`font-mono text-xs bg-surface-subtle border border-border rounded px-1.5 py-0.5 ${isVoid ? "line-through" : ""}`}>
                            {inv.number ?? "—"}
                          </span>
                        </td>
                        <td className="px-3 py-3">
                          <div className="font-medium text-ink">{inv.booking.client.name}</div>
                          <div className="text-[11px] text-ink-3 mt-0.5 truncate max-w-[180px]">{inv.booking.projectName}</div>
                        </td>
                        <td className="px-3 py-3">
                          <Link href={`/bookings/${inv.booking.id}`} className="text-[11px] text-accent hover:underline font-mono">
                            #{inv.booking.id.slice(-6)}
                          </Link>
                        </td>
                        <td className="px-3 py-3 text-ink-2">{KIND_LABELS[inv.kind]}</td>
                        <td className={`px-3 py-3 text-right mono-num ${isVoid ? "line-through text-ink-3" : ""}`}>{formatRub(Number(inv.total))}</td>
                        <td className="px-3 py-3 text-right mono-num text-ink-2">
                          {isVoid ? "—" : formatRub(Number(inv.paidAmount))}
                        </td>
                        <td className="px-3 py-3 text-right mono-num font-semibold">
                          {isVoid ? "—" : outstanding > 0 ? formatRub(outstanding) : "—"}
                        </td>
                        <td className="px-3 py-3 text-ink-2">
                          <div className="text-[12px]">{isVoid ? "—" : formatDate(inv.dueDate)}</div>
                          {!isVoid && overdueDays && (
                            <div className="text-rose text-[11px]">{overdueDays} дн. проср.</div>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <StatusPill variant={statusVariant(inv.status)} label={statusLabel(inv.status)} />
                        </td>
                        <td className="px-3 py-3">
                          {isVoid ? (
                            <span className="text-[11px] text-ink-3">аннулирован</span>
                          ) : (
                            <div className="flex gap-1 justify-end">
                              {inv.status === "DRAFT" && isSA && (
                                <button
                                  onClick={() => issueInvoice(inv.id)}
                                  className="w-7 h-7 flex items-center justify-center border border-border rounded hover:border-accent-bright hover:text-accent-bright text-[13px]"
                                  aria-label="Выставить счёт"
                                  title="Выставить"
                                >
                                  ✓
                                </button>
                              )}
                              {/* ₽ payment button for issued/overdue */}
                              {["ISSUED", "PARTIAL_PAID", "OVERDUE"].includes(inv.status) && (
                                <button
                                  className="w-7 h-7 flex items-center justify-center border border-border rounded hover:border-accent-bright hover:text-accent-bright text-[12px] font-mono"
                                  aria-label="Записать платёж"
                                  title="Записать платёж"
                                >
                                  ₽
                                </button>
                              )}
                              {inv.number && (
                                <button
                                  onClick={() => downloadPdf(inv)}
                                  className="w-7 h-7 flex items-center justify-center border border-border rounded hover:border-accent-bright hover:text-accent-bright text-[13px]"
                                  aria-label="Скачать PDF"
                                  title="Скачать PDF"
                                >
                                  📄
                                </button>
                              )}
                              {isSA && ["ISSUED", "PARTIAL_PAID", "OVERDUE"].includes(inv.status) && (
                                <button
                                  onClick={() => setVoidInvoiceId(inv.id)}
                                  className="w-7 h-7 flex items-center justify-center border border-border rounded hover:border-rose hover:text-rose text-[13px]"
                                  aria-label="Аннулировать"
                                  title="Аннулировать"
                                >
                                  ⋯
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile card list */}
            <div className="md:hidden">
              {/* Status pills summary on mobile */}
              <div className="flex gap-2 flex-wrap mb-3">
                {counts["OVERDUE"] > 0 && (
                  <span className="px-2.5 py-1 rounded-full text-[12px] font-medium bg-rose-soft text-rose border border-rose-border">
                    Просрочено · {counts["OVERDUE"]}
                  </span>
                )}
                {counts["ISSUED"] > 0 && (
                  <span className="px-2.5 py-1 rounded-full text-[12px] font-medium bg-accent-soft text-accent-bright border border-accent-border">
                    Выставлено · {counts["ISSUED"]}
                  </span>
                )}
                {counts["PAID"] > 0 && (
                  <span className="px-2.5 py-1 rounded-full text-[12px] font-medium bg-emerald-soft text-emerald border border-emerald-border">
                    Оплачено · {counts["PAID"]}
                  </span>
                )}
              </div>
              <div className="space-y-3">
                {invoices.map((inv) => {
                  const outstanding = Math.max(0, Number(inv.total) - Number(inv.paidAmount));
                  const overdueDays = daysOverdue(inv.dueDate);
                  const isOverdueSt = inv.status === "OVERDUE";
                  return (
                    <div
                      key={inv.id}
                      className={`border rounded-lg p-4 ${
                        isOverdueSt
                          ? "border-rose-border bg-rose-soft/20"
                          : "border-border bg-surface"
                      }`}
                    >
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <span className="font-mono text-xs bg-surface-subtle border border-border rounded px-1.5 py-0.5">
                            {inv.number ?? "Черновик"}
                          </span>
                          <div className="mt-1.5 font-semibold text-ink text-sm">{inv.booking.client.name}</div>
                          <div className="text-[11px] text-ink-3 mt-0.5">
                            {KIND_LABELS[inv.kind]}
                            {inv.dueDate && !isOverdueSt && ` · срок ${formatDate(inv.dueDate)}`}
                            {isOverdueSt && overdueDays && ` · срок ${formatDate(inv.dueDate)}`}
                          </div>
                        </div>
                        <StatusPill variant={statusVariant(inv.status)} label={statusLabel(inv.status)} />
                      </div>
                      <div className="mono-num text-[18px] font-semibold mb-3">
                        {formatRub(Number(inv.total))}
                      </div>
                      <div className="flex gap-2">
                        {["ISSUED", "PARTIAL_PAID", "OVERDUE"].includes(inv.status) && (
                          <button className="flex-1 py-2 text-[12px] bg-accent-bright text-white rounded-lg font-medium hover:opacity-90">
                            ₽ Платёж
                          </button>
                        )}
                        {inv.number && (
                          <button
                            onClick={() => downloadPdf(inv)}
                            className="py-2 px-3 text-[12px] border border-border rounded-lg hover:border-accent-bright hover:text-accent-bright"
                          >
                            📄 PDF
                          </button>
                        )}
                        {inv.status === "DRAFT" && isSA && (
                          <button
                            onClick={() => issueInvoice(inv.id)}
                            className="py-2 px-3 text-[12px] border border-border rounded-lg hover:border-accent-bright hover:text-accent-bright"
                          >
                            Выставить
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {/* Modals */}
        <CreateInvoiceModal
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreated={load}
        />
        <VoidInvoiceModal
          open={!!voidInvoiceId}
          invoiceId={voidInvoiceId}
          onClose={() => setVoidInvoiceId(null)}
          onVoided={() => { setVoidInvoiceId(null); load(); }}
        />
      </div>
    </div>
  );
}

// ── Page guards ───────────────────────────────────────────────────────────────

function PageGuard() {
  const { authorized, loading } = useRequireRole(["SUPER_ADMIN", "WAREHOUSE"]);
  if (loading || !authorized) return null;
  return (
    <Suspense fallback={<div className="p-6 text-sm text-ink-3">Загрузка…</div>}>
      <InvoicesPage />
    </Suspense>
  );
}

export default function InvoicesRoute() {
  return <PageGuard />;
}
