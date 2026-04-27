"use client";

import { useEffect, useState, Suspense, useMemo } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { apiFetch } from "../../src/lib/api";
import { StatusPill } from "../../src/components/StatusPill";
import { SectionHeader } from "../../src/components/SectionHeader";
import { formatRub, formatWaitingTime } from "../../src/lib/format";
import { useCurrentUser } from "../../src/hooks/useCurrentUser";

type BookingItemMini = {
  id: string;
  equipmentId: string;
  quantity: number;
  equipment: { id: string; name: string; category: string };
};

type BookingRow = {
  id: string;
  status: "DRAFT" | "PENDING_APPROVAL" | "CONFIRMED" | "ISSUED" | "RETURNED" | "CANCELLED";
  paymentStatus: "NOT_PAID" | "PARTIALLY_PAID" | "PAID" | "OVERDUE";
  projectName: string;
  startDate: string;
  endDate: string;
  displayName: string;
  client: { id: string; name: string };
  items: BookingItemMini[];
  amountPaid: string;
  amountOutstanding: string;
  finalAmount: string;
  expectedPaymentDate: string | null;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
  hasScanSessions?: boolean;
  lastScanOperation?: "ISSUE" | "RETURN" | null;
  lastScanStatus?: string | null;
};


function formatBookingPeriod(startDate: string, endDate: string): string {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const sameDay =
    start.toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" }) ===
    end.toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" });
  if (sameDay) {
    return (
      start.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" }) +
      " — " +
      end.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" })
    );
  }
  return (
    start.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", timeZone: "Europe/Moscow" }) +
    " — " +
    end.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", timeZone: "Europe/Moscow" })
  );
}

function BookingHistoryPageInner() {
  const { user } = useCurrentUser();
  const isSuperAdmin = user?.role === "SUPER_ADMIN";
  const searchParams = useSearchParams();
  const [rows, setRows] = useState<BookingRow[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>(() => searchParams?.get("status") ?? "");
  const [paymentFilter, setPaymentFilter] = useState<string>("");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let isActive = true;
    async function load() {
      setLoading(true);
      try {
        const url = statusFilter
          ? `/api/bookings?limit=100&status=${encodeURIComponent(statusFilter)}`
          : `/api/bookings?limit=100`;
        const data = await apiFetch<{ bookings: BookingRow[] }>(url, {
          signal: controller.signal,
        });
        if (!isActive) return;
        setRows(data.bookings);
      } catch (e: any) {
        const isAbort = e?.name === "AbortError" || e?.message === "signal is aborted without reason";
        if (!isAbort) {
          // eslint-disable-next-line no-console
          console.error("Failed to load bookings", e);
        }
      } finally {
        if (isActive) setLoading(false);
      }
    }
    load();
    return () => {
      isActive = false;
      controller.abort();
    };
  }, [statusFilter]);

  const statusText = (s: BookingRow["status"]) => {
    switch (s) {
      case "DRAFT":
        return "Черновик";
      case "PENDING_APPROVAL":
        return "На согласовании";
      case "CONFIRMED":
        return "Подтверждено";
      case "ISSUED":
        return "Выдано";
      case "RETURNED":
        return "Возвращено";
      case "CANCELLED":
        return "Отменено";
    }
  };

  const statusVariant = (s: BookingRow["status"]): "view" | "warn" | "ok" | "limited" | "none" | "full" | "edit" => {
    switch (s) {
      case "DRAFT": return "view";
      case "PENDING_APPROVAL": return "warn";
      case "CONFIRMED": return "full";
      case "ISSUED": return "edit";
      case "RETURNED": return "ok";
      case "CANCELLED": return "none";
    }
  };

  const paymentStatusText = (s: BookingRow["paymentStatus"]) => {
    switch (s) {
      case "NOT_PAID":
        return "Не оплачен";
      case "PARTIALLY_PAID":
        return "Частично";
      case "PAID":
        return "Оплачен";
      case "OVERDUE":
        return "Просрочен";
    }
  };

  async function removeBooking(id: string) {
    if (!confirm("Удалить бронь? Действие нельзя отменить.")) return;
    setBusyId(id);
    try {
      await apiFetch<{ ok: boolean }>(`/api/bookings/${id}`, { method: "DELETE" });
      setRows((prev) => prev.filter((r) => r.id !== id));
    } catch (e: any) {
      alert(e?.message ?? "Не удалось удалить бронь");
    } finally {
      setBusyId(null);
    }
  }

  async function runStatusAction(id: string, action: "confirm" | "issue" | "return" | "cancel") {
    setBusyId(id);
    try {
      await apiFetch(`/api/bookings/${id}/status`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      const data = await apiFetch<{ bookings: BookingRow[] }>("/api/bookings?limit=100");
      setRows(data.bookings);
    } catch (e: any) {
      alert(e?.message ?? "Не удалось обновить статус");
    } finally {
      setBusyId(null);
    }
  }

  const filteredRows = useMemo(() => rows.filter((r) => {
    if (paymentFilter && r.paymentStatus !== paymentFilter) return false;
    if (dateFrom || dateTo) {
      const startStr = new Date(r.startDate).toLocaleDateString("en-CA", { timeZone: "Europe/Moscow" }); // YYYY-MM-DD
      if (dateFrom && startStr < dateFrom) return false;
      if (dateTo && startStr > dateTo) return false;
    }
    return true;
  }), [rows, paymentFilter, dateFrom, dateTo]);


  return (
    <div className="p-4">
      <SectionHeader
        eyebrow="Аренда"
        title="История броней"
        actions={
          <Link href="/bookings/new" className="rounded bg-accent-bright text-white px-4 py-2 text-sm hover:bg-accent transition-colors">
            Создать бронь
          </Link>
        }
      />

      <div className="mt-4 rounded-lg border border-border bg-surface shadow-xs overflow-hidden">
        <div className="p-3 border-b border-border flex items-center justify-between">
          <p className="eyebrow">Список броней</p>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2">
              <label className="text-xs text-ink-3">С</label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="text-sm border border-border rounded px-2 py-1 bg-surface text-ink focus:outline-none focus:ring-1 focus:ring-accent"
              />
              <label className="text-xs text-ink-3">По</label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="text-sm border border-border rounded px-2 py-1 bg-surface text-ink focus:outline-none focus:ring-1 focus:ring-accent"
              />
              {(dateFrom || dateTo) && (
                <button
                  onClick={() => { setDateFrom(""); setDateTo(""); }}
                  className="text-xs text-accent hover:underline"
                >
                  Сбросить
                </button>
              )}
            </div>
            <select className="rounded border border-border px-2 py-1 text-xs bg-surface" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">Все статусы брони</option>
              <option value="DRAFT">Черновик</option>
              <option value="PENDING_APPROVAL">На согласовании</option>
              <option value="CONFIRMED">Подтверждено</option>
              <option value="ISSUED">Выдано</option>
              <option value="RETURNED">Возвращено</option>
              <option value="CANCELLED">Отменено</option>
            </select>
            <select className="rounded border border-border px-2 py-1 text-xs bg-surface" value={paymentFilter} onChange={(e) => setPaymentFilter(e.target.value)}>
              <option value="">Все статусы оплаты</option>
              <option value="NOT_PAID">Не оплачен</option>
              <option value="PARTIALLY_PAID">Частично</option>
              <option value="PAID">Оплачен</option>
              <option value="OVERDUE">Просрочен</option>
            </select>
            <div className="text-xs text-ink-3">{loading ? "Загрузка..." : `Всего: ${filteredRows.length}`}</div>
          </div>
        </div>
        <div className="overflow-auto">
          <table className="min-w-[1400px] w-full text-sm">
            <thead className="bg-slate--soft text-ink-2 border-b border-border">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Дата</th>
                <th className="text-left px-3 py-2 font-medium">Период</th>
                <th className="text-left px-3 py-2 font-medium">Клиент</th>
                <th className="text-left px-3 py-2 font-medium">Проект</th>
                <th className="text-left px-3 py-2 font-medium">Название</th>
                <th className="text-left px-3 py-2 font-medium">Статус</th>
                <th className="text-left px-3 py-2 font-medium">Ждёт</th>
                <th className="text-left px-3 py-2 font-medium">Оплата</th>
                <th className="text-right px-3 py-2 font-medium">Остаток</th>
                <th className="px-3 py-2 font-medium">Действия</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r) => (
                <tr key={r.id} className="border-t border-border hover:bg-surface-muted transition-colors">
                  <td className="px-3 py-2 text-ink mono-num whitespace-nowrap">
                    {new Date(r.startDate).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Moscow" })}
                  </td>
                  <td className="px-3 py-2 text-ink-2 whitespace-nowrap mono-num">
                    {formatBookingPeriod(r.startDate, r.endDate)}
                  </td>
                  <td className="px-3 py-2 text-ink-2">{r.client.name}</td>
                  <td className="px-3 py-2">
                    {r.projectName === "Проект" ? (
                      <span className="text-ink-3">Без названия</span>
                    ) : (
                      <span className="text-ink-2">{r.projectName}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-ink">{r.displayName}</td>
                  <td className="px-3 py-2">
                    <StatusPill
                      variant={statusVariant(r.status)}
                      label={statusText(r.status)}
                    />
                    {r.hasScanSessions && (
                      <span className="ml-1 inline-block" title={
                        r.lastScanOperation === "ISSUE" && r.lastScanStatus === "COMPLETED" ? "Выдача отсканирована" :
                        r.lastScanOperation === "RETURN" && r.lastScanStatus === "COMPLETED" ? "Возврат завершён" :
                        "Есть сканирования"
                      }>
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="inline text-accent-bright">
                          <path d="M3 7V5a2 2 0 0 1 2-2h2" /><path d="M17 3h2a2 2 0 0 1 2 2v2" /><path d="M21 17v2a2 2 0 0 1-2 2h-2" /><path d="M7 21H5a2 2 0 0 1-2-2v-2" /><line x1="7" y1="12" x2="17" y2="12" />
                        </svg>
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {r.status === "PENDING_APPROVAL" ? (() => {
                      const aging = formatWaitingTime(r.updatedAt, r.createdAt);
                      return aging ? <span className={aging.className}>{aging.text}</span> : "—";
                    })() : ""}
                  </td>
                  <td className="px-3 py-2">
                    <StatusPill
                      variant={
                        r.paymentStatus === "PAID" ? "ok"
                        : r.paymentStatus === "PARTIALLY_PAID" ? "limited"
                        : r.paymentStatus === "OVERDUE" ? "warn"
                        : "none"
                      }
                      label={paymentStatusText(r.paymentStatus)}
                    />
                  </td>
                  <td className="px-3 py-2 text-right mono-num text-ink">{formatRub(r.amountOutstanding)}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Link className="text-xs text-accent-bright hover:text-accent font-medium" href={`/bookings/${r.id}`}>
                        Открыть
                      </Link>
                      {(["DRAFT", "CONFIRMED"].includes(r.status) || (r.status === "PENDING_APPROVAL" && isSuperAdmin)) ? (
                        <Link
                          href={`/bookings/${r.id}/edit`}
                          title="Редактировать"
                          className="text-ink-3 hover:text-ink"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 20h9" />
                            <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z" />
                          </svg>
                        </Link>
                      ) : (
                        <span className="text-border cursor-not-allowed">
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 20h9" />
                            <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z" />
                          </svg>
                        </span>
                      )}
                      {isSuperAdmin && (
                        <button
                          type="button"
                          title="Удалить"
                          className="text-rose hover:text-rose/80 disabled:opacity-40"
                          disabled={busyId === r.id}
                          onClick={() => removeBooking(r.id)}
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3 6h18" />
                            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                          </svg>
                        </button>
                      )}
                      {r.status === "CONFIRMED" ? (
                        <button
                          type="button"
                          className="text-xs rounded border border-border px-2 py-1 text-ink-2 hover:bg-surface-muted disabled:opacity-40"
                          disabled={busyId === r.id}
                          onClick={() => runStatusAction(r.id, "issue")}
                        >
                          Выдать
                        </button>
                      ) : null}
                      {r.status === "ISSUED" ? (
                        <button
                          type="button"
                          className="text-xs rounded border border-border px-2 py-1 text-ink-2 hover:bg-surface-muted disabled:opacity-40"
                          disabled={busyId === r.id}
                          onClick={() => runStatusAction(r.id, "return")}
                        >
                          Вернуть
                        </button>
                      ) : null}
                      {!["CANCELLED", "RETURNED"].includes(r.status) ? (
                        <button
                          type="button"
                          className="text-xs rounded border border-rose-border text-rose px-2 py-1 hover:bg-rose-soft disabled:opacity-40"
                          disabled={busyId === r.id}
                          onClick={() => runStatusAction(r.id, "cancel")}
                        >
                          Отменить
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
              {filteredRows.length === 0 ? (
                <tr>
                  <td className="px-3 py-6 text-center text-ink-3" colSpan={10}>
                    Нет данных
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}

export default function BookingHistoryPage() {
  return (
    <Suspense fallback={<div className="p-8 text-ink-3">Загрузка...</div>}>
      <BookingHistoryPageInner />
    </Suspense>
  );
}

