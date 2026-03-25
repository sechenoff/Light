"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../src/lib/api";
import { StatusBadge } from "../../src/components/StatusBadge";
import { formatMoneyRub } from "../../src/lib/format";

type BookingItemMini = {
  id: string;
  equipmentId: string;
  quantity: number;
  equipment: { id: string; name: string; category: string };
};

type BookingRow = {
  id: string;
  status: "DRAFT" | "CONFIRMED" | "ISSUED" | "RETURNED" | "CANCELLED";
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
};


export default function BookingHistoryPage() {
  const [rows, setRows] = useState<BookingRow[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [paymentFilter, setPaymentFilter] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let isActive = true;
    async function load() {
      setLoading(true);
      try {
        const data = await apiFetch<{ bookings: BookingRow[] }>("/api/bookings?limit=100", {
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
  }, []);

  const statusText = (s: BookingRow["status"]) => {
    switch (s) {
      case "DRAFT":
        return "Черновик";
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

  const filteredRows = rows.filter((r) => {
    if (statusFilter && r.status !== statusFilter) return false;
    if (paymentFilter && r.paymentStatus !== paymentFilter) return false;
    return true;
  });


  return (
    <div className="p-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">История броней</h1>
        <div className="flex items-center gap-2">
          <Link href="/equipment/manage" className="rounded border border-slate-300 bg-white px-4 py-2 hover:bg-slate-50">
            Оборудование
          </Link>
          <Link href="/finance" className="rounded border border-slate-300 bg-white px-4 py-2 hover:bg-slate-50">
            Финансы
          </Link>
          <Link href="/crew-calculator" className="rounded border border-slate-300 bg-white px-4 py-2 hover:bg-slate-50">
            Калькулятор осветителей
          </Link>
          <Link href="/bookings/new" className="rounded bg-slate-900 text-white px-4 py-2 hover:bg-slate-800">
            Новая бронь
          </Link>
        </div>
      </div>

      <div className="mt-4 rounded border border-slate-200 bg-white overflow-hidden">
        <div className="p-3 border-b border-slate-200 flex items-center justify-between">
          <div className="text-sm text-slate-700">Последние брони</div>
          <div className="flex items-center gap-2">
            <select className="rounded border border-slate-300 px-2 py-1 text-xs bg-white" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">Все статусы брони</option>
              <option value="DRAFT">DRAFT</option>
              <option value="CONFIRMED">CONFIRMED</option>
              <option value="ISSUED">ISSUED</option>
              <option value="RETURNED">RETURNED</option>
              <option value="CANCELLED">CANCELLED</option>
            </select>
            <select className="rounded border border-slate-300 px-2 py-1 text-xs bg-white" value={paymentFilter} onChange={(e) => setPaymentFilter(e.target.value)}>
              <option value="">Все статусы оплаты</option>
              <option value="NOT_PAID">NOT_PAID</option>
              <option value="PARTIALLY_PAID">PARTIALLY_PAID</option>
              <option value="PAID">PAID</option>
              <option value="OVERDUE">OVERDUE</option>
            </select>
            <div className="text-xs text-slate-500">{loading ? "Загрузка..." : `Всего: ${filteredRows.length}`}</div>
          </div>
        </div>
        <div className="overflow-auto">
          <table className="min-w-[1300px] w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="text-center px-3 py-2">Название</th>
                <th className="text-center px-3 py-2">Клиент</th>
                <th className="text-center px-3 py-2">Проект</th>
                <th className="text-center px-3 py-2">Период</th>
                <th className="text-center px-3 py-2">Статус</th>
                <th className="text-center px-3 py-2">Оплата</th>
                <th className="text-center px-3 py-2">Остаток</th>
                <th className="text-center px-3 py-2">Действия</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r) => (
                <tr key={r.id} className="border-t border-slate-100">
                  <td className="px-3 py-2 text-center">{r.displayName}</td>
                  <td className="px-3 py-2 text-center">{r.client.name}</td>
                  <td className="px-3 py-2 text-center">{r.projectName}</td>
                  <td className="px-3 py-2 text-center">
                    {new Date(r.startDate).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })} —{" "}
                    {new Date(r.endDate).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}
                  </td>
                  <td className="px-3 py-2 text-center"><StatusBadge status={statusText(r.status)} /></td>
                  <td className="px-3 py-2 text-center"><StatusBadge status={paymentStatusText(r.paymentStatus)} /></td>
                  <td className="px-3 py-2 text-center">{formatMoneyRub(r.amountOutstanding)}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-center gap-3">
                      <Link className="text-slate-700 hover:text-slate-900" href={`/bookings/${r.id}`}>
                        Открыть
                      </Link>
                      {["DRAFT", "CONFIRMED"].includes(r.status) ? (
                        <Link
                          href={`/bookings/${r.id}/edit`}
                          title="Редактировать"
                          className="text-slate-500 hover:text-slate-900"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 20h9" />
                            <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z" />
                          </svg>
                        </Link>
                      ) : (
                        <span className="text-slate-300 cursor-not-allowed">
                          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 20h9" />
                            <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z" />
                          </svg>
                        </span>
                      )}
                      <button
                        type="button"
                        title="Удалить"
                        className="text-rose-500 hover:text-rose-700 disabled:opacity-40"
                        disabled={busyId === r.id}
                        onClick={() => removeBooking(r.id)}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 6h18" />
                          <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                          <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                        </svg>
                      </button>
                      {r.status === "DRAFT" ? (
                        <button
                          type="button"
                          className="text-xs rounded border border-slate-300 px-2 py-1"
                          disabled={busyId === r.id}
                          onClick={() => runStatusAction(r.id, "confirm")}
                        >
                          Подтвердить
                        </button>
                      ) : null}
                      {r.status === "CONFIRMED" ? (
                        <button
                          type="button"
                          className="text-xs rounded border border-slate-300 px-2 py-1"
                          disabled={busyId === r.id}
                          onClick={() => runStatusAction(r.id, "issue")}
                        >
                          Выдать
                        </button>
                      ) : null}
                      {r.status === "ISSUED" ? (
                        <button
                          type="button"
                          className="text-xs rounded border border-slate-300 px-2 py-1"
                          disabled={busyId === r.id}
                          onClick={() => runStatusAction(r.id, "return")}
                        >
                          Вернуть
                        </button>
                      ) : null}
                      {!["CANCELLED", "RETURNED"].includes(r.status) ? (
                        <button
                          type="button"
                          className="text-xs rounded border border-rose-300 text-rose-700 px-2 py-1"
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
                  <td className="px-3 py-6 text-center text-slate-500" colSpan={8}>
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

