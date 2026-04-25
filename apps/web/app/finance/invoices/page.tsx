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

const STATUS_TABS: Array<{ key: InvoiceStatus | "ALL"; label: string }> = [
  { key: "ALL", label: "Все" },
  { key: "DRAFT", label: "Черновики" },
  { key: "ISSUED", label: "Выставлены" },
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
    case "DRAFT": return "Черновик";
    case "ISSUED": return "Выставлен";
    case "PARTIAL_PAID": return "Частично";
    case "PAID": return "Оплачен";
    case "OVERDUE": return "Просрочен";
    case "VOID": return "Аннулирован";
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
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkIssuing, setBulkIssuing] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [voidInvoiceId, setVoidInvoiceId] = useState<string | null>(null);

  // Fetch invoices
  const load = useCallback(async () => {
    setLoading(true);
    setSelected(new Set());
    try {
      const params = new URLSearchParams();
      if (statusTab !== "ALL") params.set("status", statusTab);
      if (search.trim()) params.set("search", search.trim());
      params.set("limit", "100");
      const data = await apiFetch<InvoicesResponse>(`/api/invoices?${params}`);
      setInvoices(data.items);
      setTotal(data.total);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Ошибка загрузки счетов");
    } finally {
      setLoading(false);
    }
  }, [statusTab, search]);

  useEffect(() => {
    load();
  }, [load]);

  // Update URL when tab changes
  function changeTab(tab: InvoiceStatus | "ALL") {
    setStatusTab(tab);
    const params = new URLSearchParams(searchParams.toString());
    if (tab === "ALL") params.delete("status");
    else params.set("status", tab);
    router.replace(`/finance/invoices?${params}`);
  }

  // Issue single invoice
  async function issueInvoice(id: string) {
    try {
      await apiFetch(`/api/invoices/${id}/issue`, { method: "POST" });
      toast.success("Счёт выставлен");
      load();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Ошибка выставления");
    }
  }

  // Bulk-issue selected DRAFT invoices
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

  // Download PDF
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

  // Select all
  const allSelectableIds = invoices.filter((inv) => inv.status === "DRAFT").map((inv) => inv.id);
  const allSelected = allSelectableIds.length > 0 && allSelectableIds.every((id) => selected.has(id));

  function toggleSelectAll() {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(allSelectableIds));
    }
  }

  function toggleSelect(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  const selectedCount = selected.size;
  const draftSelectedCount = invoices.filter((inv) => selected.has(inv.id) && inv.status === "DRAFT").length;

  // Counts per tab
  const counts = STATUS_TABS.reduce((acc, tab) => {
    if (tab.key === "ALL") acc[tab.key] = invoices.length;
    else acc[tab.key] = invoices.filter((inv) => inv.status === tab.key).length;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div className="min-h-screen bg-surface-2">
      <FinanceTabNav />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
        {/* Header */}
        <div className="flex items-start justify-between mb-5 gap-4 flex-wrap">
          <div>
            <p className="eyebrow text-ink-3">Финансы</p>
            <h1 className="text-xl font-semibold text-ink mt-1">Счета</h1>
          </div>
          {isSA && (
            <button
              onClick={() => setCreateOpen(true)}
              className="px-4 py-2 text-sm bg-accent-bright text-white rounded hover:opacity-90 font-medium"
            >
              + Создать счёт
            </button>
          )}
        </div>

        {/* Status tabs */}
        <div className="flex gap-1 border-b border-border mb-4 overflow-x-auto">
          {STATUS_TABS.map((tab) => {
            const count = counts[tab.key] ?? 0;
            const active = statusTab === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => changeTab(tab.key as InvoiceStatus | "ALL")}
                className={`flex items-center gap-1.5 px-3 py-2.5 text-[13px] border-b-2 -mb-px whitespace-nowrap transition-colors ${
                  active ? "text-accent border-accent font-semibold" : "text-ink-2 border-transparent hover:text-ink"
                }`}
              >
                {tab.label}
                {count > 0 && (
                  <span className={`text-[11px] px-1.5 py-0.5 rounded font-mono ${
                    active ? "bg-accent-soft text-accent" :
                    tab.key === "OVERDUE" ? "bg-rose-soft text-rose" :
                    "bg-surface-2 text-ink-3 border border-border"
                  }`}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Filter bar */}
        <div className="flex flex-wrap gap-2 mb-4">
          <input
            type="text"
            placeholder="Поиск по клиенту, проекту, № счёта…"
            className="border border-border rounded px-3 py-2 text-sm bg-surface text-ink min-w-[220px]"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* Bulk bar */}
        {selectedCount > 0 && (
          <div className="flex items-center gap-3 mb-4 px-4 py-2.5 bg-accent-soft border border-[#bfdbfe] rounded-lg text-sm">
            <span className="font-medium">{selectedCount} выбрано</span>
            {draftSelectedCount > 0 && isSA && (
              <button
                onClick={bulkIssue}
                disabled={bulkIssuing}
                className="px-3 py-1.5 bg-accent-bright text-white rounded text-[12px] hover:opacity-90 disabled:opacity-50"
              >
                {bulkIssuing ? "Выставляем…" : `Выставить черновики (${draftSelectedCount})`}
              </button>
            )}
            <button
              onClick={() => setSelected(new Set())}
              className="ml-auto text-ink-3 hover:text-ink text-[12px]"
            >
              Сбросить
            </button>
          </div>
        )}

        {/* Table — desktop */}
        {loading ? (
          <div className="text-center py-12 text-ink-3 text-sm">Загрузка…</div>
        ) : invoices.length === 0 ? (
          <div className="text-center py-16 text-ink-2">
            <p className="text-[15px] font-medium mb-2">Счетов нет</p>
            <p className="text-sm text-ink-3">Создайте счёт на странице брони → «Создать счёт»</p>
          </div>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden md:block bg-surface border border-border rounded-lg overflow-hidden shadow-xs">
              <table className="w-full text-sm">
                <thead className="bg-surface-2 border-b border-border">
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
                    <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-3">№ счёта</th>
                    <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-3">Клиент / Бронь</th>
                    <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-3">Тип</th>
                    <th className="px-3 py-3 text-right text-[11px] font-semibold uppercase tracking-wide text-ink-3">Сумма</th>
                    <th className="px-3 py-3 text-right text-[11px] font-semibold uppercase tracking-wide text-ink-3">Оплачено</th>
                    <th className="px-3 py-3 text-right text-[11px] font-semibold uppercase tracking-wide text-ink-3">Остаток</th>
                    <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-3">Срок</th>
                    <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-3">Статус</th>
                    <th className="px-3 py-3 w-24"></th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => {
                    const outstanding = Math.max(0, Number(inv.total) - Number(inv.paidAmount));
                    const overdueDays = daysOverdue(inv.dueDate);
                    return (
                      <tr key={inv.id} className="border-b border-slate-soft hover:bg-surface-2/50 transition-colors">
                        <td className="px-3 py-3">
                          {inv.status === "DRAFT" && (
                            <input
                              type="checkbox"
                              className="rounded"
                              checked={selected.has(inv.id)}
                              onChange={() => toggleSelect(inv.id)}
                            />
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <span className="font-mono text-xs bg-surface-2 border border-border rounded px-1.5 py-0.5">
                            {inv.number ?? "—"}
                          </span>
                        </td>
                        <td className="px-3 py-3">
                          <div className="font-medium text-ink">{inv.booking.client.name}</div>
                          <div className="text-xs text-ink-3">{inv.booking.projectName}</div>
                          <Link href={`/bookings/${inv.booking.id}`} className="text-xs text-accent hover:underline">
                            #{inv.booking.id.slice(-6)}
                          </Link>
                        </td>
                        <td className="px-3 py-3 text-ink-2">{KIND_LABELS[inv.kind]}</td>
                        <td className="px-3 py-3 text-right mono-num">{formatRub(Number(inv.total))}</td>
                        <td className="px-3 py-3 text-right mono-num text-emerald">{formatRub(Number(inv.paidAmount))}</td>
                        <td className="px-3 py-3 text-right mono-num font-medium">{outstanding > 0 ? formatRub(outstanding) : "—"}</td>
                        <td className="px-3 py-3 text-ink-2 text-xs">
                          <div>{formatDate(inv.dueDate)}</div>
                          {overdueDays && (
                            <div className="text-rose">{overdueDays} дн. просрочки</div>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <StatusPill variant={statusVariant(inv.status)} label={statusLabel(inv.status)} />
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex gap-1 justify-end">
                            {/* Issue */}
                            {inv.status === "DRAFT" && isSA && (
                              <button
                                onClick={() => issueInvoice(inv.id)}
                                className="text-[11px] px-2 py-1 border border-border rounded hover:border-accent-bright hover:text-accent-bright"
                                title="Выставить"
                              >
                                Выставить
                              </button>
                            )}
                            {/* PDF */}
                            {inv.number && (
                              <button
                                onClick={() => downloadPdf(inv)}
                                className="w-7 h-7 flex items-center justify-center border border-border rounded hover:border-accent-bright hover:text-accent-bright text-[13px]"
                                aria-label="Скачать PDF"
                                title="Скачать PDF"
                              >
                                ↓
                              </button>
                            )}
                            {/* Void */}
                            {isSA && ["ISSUED", "PARTIAL_PAID", "OVERDUE"].includes(inv.status) && (
                              <button
                                onClick={() => setVoidInvoiceId(inv.id)}
                                className="w-7 h-7 flex items-center justify-center border border-border rounded hover:border-rose hover:text-rose text-[13px]"
                                aria-label="Аннулировать"
                                title="Аннулировать"
                              >
                                ✕
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile card list */}
            <div className="md:hidden space-y-3">
              {invoices.map((inv) => {
                const outstanding = Math.max(0, Number(inv.total) - Number(inv.paidAmount));
                return (
                  <div key={inv.id} className="bg-surface border border-border rounded-lg p-4">
                    <div className="flex items-start justify-between mb-2">
                      <div>
                        <span className="font-mono text-xs bg-surface-2 border border-border rounded px-1.5 py-0.5">
                          {inv.number ?? "Черновик"}
                        </span>
                        <div className="mt-1 font-medium text-ink text-sm">{inv.booking.client.name}</div>
                        <div className="text-xs text-ink-3">{inv.booking.projectName}</div>
                      </div>
                      <StatusPill variant={statusVariant(inv.status)} label={statusLabel(inv.status)} />
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-xs mb-3">
                      <div>
                        <div className="text-ink-3 mb-0.5">Сумма</div>
                        <div className="mono-num font-medium">{formatRub(Number(inv.total))}</div>
                      </div>
                      <div>
                        <div className="text-ink-3 mb-0.5">Оплачено</div>
                        <div className="mono-num text-emerald">{formatRub(Number(inv.paidAmount))}</div>
                      </div>
                      <div>
                        <div className="text-ink-3 mb-0.5">Остаток</div>
                        <div className="mono-num font-medium">{outstanding > 0 ? formatRub(outstanding) : "—"}</div>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      {inv.status === "DRAFT" && isSA && (
                        <button
                          onClick={() => issueInvoice(inv.id)}
                          className="text-[12px] px-3 py-1.5 border border-border rounded hover:border-accent-bright hover:text-accent-bright"
                        >
                          Выставить
                        </button>
                      )}
                      {inv.number && (
                        <button
                          onClick={() => downloadPdf(inv)}
                          className="text-[12px] px-3 py-1.5 border border-border rounded hover:border-accent-bright hover:text-accent-bright"
                        >
                          PDF
                        </button>
                      )}
                      {isSA && ["ISSUED", "PARTIAL_PAID", "OVERDUE"].includes(inv.status) && (
                        <button
                          onClick={() => setVoidInvoiceId(inv.id)}
                          className="text-[12px] px-3 py-1.5 border border-border rounded hover:border-rose hover:text-rose text-rose"
                        >
                          Аннулировать
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
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
