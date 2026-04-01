"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

import { apiFetchRaw } from "../../../src/lib/api";
import { getFileNameFromContentDisposition } from "../../../src/lib/download";
import { StatusBadge } from "../../../src/components/StatusBadge";
import { formatMoneyRub } from "../../../src/lib/format";

type BookingDetail = {
  id: string;
  displayName?: string;
  status: "DRAFT" | "CONFIRMED" | "ISSUED" | "RETURNED" | "CANCELLED";
  projectName: string;
  startDate: string;
  endDate: string;
  comment: string | null;
  discountPercent: string | null;
  paymentStatus?: "NOT_PAID" | "PARTIALLY_PAID" | "PAID" | "OVERDUE";
  totalEstimateAmount?: string | null;
  discountAmount?: string | null;
  finalAmount?: string | null;
  amountPaid?: string | null;
  amountOutstanding?: string | null;
  expectedPaymentDate?: string | null;
  paymentComment?: string | null;
  financeEvents?: Array<{
    id: string;
    eventType: string;
    statusFrom: string | null;
    statusTo: string | null;
    amountDelta: string | null;
    createdAt: string;
  }>;
  client: { id: string; name: string; phone: string | null; email: string | null; comment: string | null };
  items: Array<{ id: string; equipmentId: string; quantity: number; equipment: any }>;
  estimate: null | {
    id: string;
    currency: string;
    shifts: number;
    subtotal: string;
    discountPercent: string | null;
    discountAmount: string;
    totalAfterDiscount: string;
    commentSnapshot: string | null;
    lines: Array<{
      id: string;
      equipmentId: string | null;
      categorySnapshot: string;
      nameSnapshot: string;
      brandSnapshot: string | null;
      modelSnapshot: string | null;
      quantity: number;
      unitPrice: string;
      lineSum: string;
    }>;
  };
};

function statusText(s: BookingDetail["status"]) {
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
}

export default function BookingDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [booking, setBooking] = useState<BookingDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let isActive = true;
    async function load() {
      setLoading(true);
      try {
        const res = await fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000"}/api/bookings/${id}`, {
          signal: controller.signal,
          credentials: "include",
        });
        if (!res.ok) throw new Error(`Не удалось открыть заказ (${res.status})`);
        const data = await res.json();
        if (!isActive) return;
        setBooking(data.booking);
      } catch (e: any) {
        const isAbort = e?.name === "AbortError" || e?.message === "signal is aborted without reason";
        if (!isAbort && isActive) setErr(e?.message ?? "Ошибка загрузки");
      } finally {
        if (isActive) setLoading(false);
      }
    }
    load();
    return () => {
      isActive = false;
      controller.abort();
    };
  }, [id]);

  async function download(path: string, filename: string) {
    const res = await apiFetchRaw(path, { method: "GET", credentials: "include" });
    if (!res.ok) {
      alert("Не удалось скачать файл");
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const disposition = res.headers.get("content-disposition") ?? "";
    a.download = getFileNameFromContentDisposition(disposition, filename);
    a.click();
    URL.revokeObjectURL(url);
  }

  async function quickAddPayment() {
    if (!booking) return;
    const raw = prompt("Сумма полученного платежа (RUB):");
    if (!raw) return;
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount <= 0) {
      alert("Некорректная сумма");
      return;
    }
    await fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000"}/api/payments`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bookingId: booking.id,
        amount,
        direction: "INCOME",
        status: "RECEIVED",
        paymentDate: new Date().toISOString(),
        paymentMethod: "BANK_TRANSFER",
      }),
    });
    const fresh = await fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000"}/api/bookings/${booking.id}`, {
      credentials: "include",
    }).then((r) => r.json());
    setBooking(fresh.booking);
  }

  return (
    <div className="p-4">
      <div className="flex items-center justify-between flex-wrap gap-3 no-print">
        <h1 className="text-xl font-semibold">{booking?.displayName || `Бронь: ${id}`}</h1>
        <div className="flex items-center gap-2 flex-wrap">
          <Link href="/bookings" className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">
            ← Брони
          </Link>
          <Link href="/bookings/new" className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">
            Новая бронь
          </Link>
          <div className="text-sm text-slate-600">{booking ? <StatusBadge status={statusText(booking.status)} /> : ""}</div>
        </div>
      </div>

      {loading ? (
        <div className="mt-4 text-slate-500">Загрузка...</div>
      ) : err ? (
        <div className="mt-4 text-rose-700">{err}</div>
      ) : booking ? (
        <div className="mt-4 grid grid-cols-1 lg:grid-cols-12 gap-4 print-booking">
          <div className="lg:col-span-8 rounded border border-slate-200 bg-white overflow-hidden">
            <div className="p-3 border-b border-slate-200 bg-slate-50 text-sm font-semibold text-slate-700">
              Позиции
            </div>
            <div className="overflow-auto">
              <table className="min-w-[860px] w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="text-left px-3 py-2">Категория</th>
                    <th className="text-left px-3 py-2">Наименование</th>
                    <th className="px-3 py-2 w-[120px]">Кол-во</th>
                  </tr>
                </thead>
                <tbody>
                  {booking.items.map((it) => (
                    <tr key={it.id} className="border-t border-slate-100">
                      <td className="px-3 py-2">{it.equipment.category}</td>
                      <td className="px-3 py-2">
                        <div className="font-medium">{it.equipment.name}</div>
                        <div className="text-xs text-slate-500">
                          {it.equipment.brand ? it.equipment.brand : ""} {it.equipment.model ? `· ${it.equipment.model}` : ""}
                        </div>
                      </td>
                      <td className="px-3 py-2 font-medium">{it.quantity}</td>
                    </tr>
                  ))}
                  {booking.items.length === 0 ? (
                    <tr>
                      <td className="px-3 py-6 text-center text-slate-500" colSpan={3}>
                        Нет позиций
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>

          <div className="lg:col-span-4 space-y-4">
            <div className="rounded border border-slate-200 bg-white overflow-hidden">
              <div className="p-3 border-b border-slate-200 bg-slate-50 text-sm font-semibold text-slate-700">
                Данные заказа и финансы
              </div>
              <div className="p-3 text-sm text-slate-700 space-y-2">
                <div>
                  <span className="text-slate-500">Клиент:</span> <span className="font-medium">{booking.client.name}</span>
                </div>
                <div>
                  <span className="text-slate-500">Проект:</span> <span className="font-medium">{booking.projectName}</span>
                </div>
                <div>
                  <span className="text-slate-500">Период:</span>{" "}
                  <span className="font-medium">
                    {new Date(booking.startDate).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })} —{" "}
                    {new Date(booking.endDate).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}
                  </span>
                </div>
                {booking.comment ? (
                  <div>
                    <span className="text-slate-500">Комментарий:</span> <span>{booking.comment}</span>
                  </div>
                ) : null}
                <div className="border-t border-slate-200 pt-2 mt-2 space-y-1">
                  <div><span className="text-slate-500">Сумма сметы:</span> <span className="font-medium">{formatMoneyRub(booking.totalEstimateAmount ?? "0")}</span></div>
                  <div><span className="text-slate-500">Скидка:</span> <span className="font-medium">{formatMoneyRub(booking.discountAmount ?? "0")}</span></div>
                  <div><span className="text-slate-500">Итог:</span> <span className="font-medium">{formatMoneyRub(booking.finalAmount ?? "0")}</span></div>
                  <div><span className="text-slate-500">Оплачено:</span> <span className="font-medium">{formatMoneyRub(booking.amountPaid ?? "0")}</span></div>
                  <div><span className="text-slate-500">Остаток:</span> <span className="font-medium">{formatMoneyRub(booking.amountOutstanding ?? "0")}</span></div>
                  <div><span className="text-slate-500">Статус оплаты:</span> <span className="font-medium"><StatusBadge status={booking.paymentStatus ?? "NOT_PAID"} /></span></div>
                  <div><span className="text-slate-500">Плановая дата платежа:</span> <span className="font-medium">{booking.expectedPaymentDate ? new Date(booking.expectedPaymentDate).toLocaleDateString("ru-RU") : "—"}</span></div>
                  <div className="pt-2">
                    <button className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50" onClick={quickAddPayment}>Добавить платеж</button>
                  </div>
                </div>
              </div>
            </div>

            {booking.estimate ? (
              <div className="rounded border border-slate-200 bg-white overflow-hidden">
                <div className="p-3 border-b border-slate-200 bg-slate-50 text-sm font-semibold text-slate-700 flex items-center justify-between">
                  <span>Смета</span>
                  <span className="text-xs text-slate-500">Шифты: {booking.estimate.shifts}</span>
                </div>
                <div className="p-3 space-y-3">
                  <div className="text-sm flex justify-between">
                    <span className="text-slate-600">Итого</span>
                    <span className="font-medium">{formatMoneyRub(booking.estimate.subtotal)}</span>
                  </div>
                  <div className="text-sm flex justify-between">
                    <span className="text-slate-600">Скидка</span>
                    <span className="font-medium">-{formatMoneyRub(booking.estimate.discountAmount)}</span>
                  </div>
                  <div className="text-base flex justify-between pt-1 border-t border-slate-200">
                    <span className="font-semibold text-slate-900">После скидки</span>
                    <span className="font-semibold text-slate-900">{formatMoneyRub(booking.estimate.totalAfterDiscount)}</span>
                  </div>

                  <div className="flex gap-2 no-print">
                    <button
                      className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50"
                      onClick={() =>
                        download(
                          `/api/estimates/${booking.estimate!.id}/export/xlsx`,
                          `estimate-${booking.estimate!.id}.xlsx`,
                        )
                      }
                    >
                      Excel
                    </button>
                    <button
                      className="flex-1 rounded bg-slate-900 text-white px-3 py-2 text-sm hover:bg-slate-800"
                      onClick={() =>
                        download(
                          `/api/estimates/${booking.estimate!.id}/export/pdf`,
                          `estimate-${booking.estimate!.id}.pdf`,
                        )
                      }
                    >
                      PDF
                    </button>
                    <button className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50" onClick={() => window.print()}>
                      Печать
                    </button>
                  </div>

                  <div className="max-h-[280px] overflow-auto border rounded border-slate-200">
                    <div className="text-xs bg-slate-50 p-2 font-semibold text-slate-700">Позиции</div>
                    {booking.estimate.lines.map((l) => (
                      <div key={l.id} className="px-2 py-2 border-t border-slate-100 flex justify-between gap-3 text-sm">
                        <div className="min-w-0">
                          <div className="font-medium truncate">{l.nameSnapshot}</div>
                          <div className="text-xs text-slate-500">
                            {l.quantity} × {formatMoneyRub(l.unitPrice)}
                          </div>
                        </div>
                        <div className="font-medium">{formatMoneyRub(l.lineSum)}</div>
                      </div>
                    ))}
                  </div>

                  {booking.estimate.commentSnapshot ? <div className="text-xs text-slate-500">{booking.estimate.commentSnapshot}</div> : null}
                </div>
              </div>
            ) : (
              <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                Смета пока не сформирована (возможно, это черновик).
              </div>
            )}
            <div className="rounded border border-slate-200 bg-white overflow-hidden">
              <div className="p-3 border-b border-slate-200 bg-slate-50 text-sm font-semibold text-slate-700">Журнал изменений</div>
              <div className="max-h-[280px] overflow-auto">
                {(booking.financeEvents ?? []).map((ev) => (
                  <div key={ev.id} className="px-3 py-2 border-b border-slate-100 text-sm flex items-center justify-between gap-2">
                    <div>
                      <div className="font-medium">{ev.eventType}</div>
                      <div className="text-xs text-slate-500">{new Date(ev.createdAt).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}</div>
                    </div>
                    <div className="text-right text-xs text-slate-600">
                      {ev.statusFrom || ev.statusTo ? `${ev.statusFrom ?? "—"} → ${ev.statusTo ?? "—"}` : ""}
                      {ev.amountDelta ? <div>{formatMoneyRub(ev.amountDelta)}</div> : null}
                    </div>
                  </div>
                ))}
                {(booking.financeEvents ?? []).length === 0 ? (
                  <div className="px-3 py-4 text-sm text-slate-500">Пока нет событий.</div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-4 text-slate-500">Бронь не найдена.</div>
      )}
      <style jsx global>{`
        @media print {
          body * {
            visibility: hidden;
          }
          .print-booking,
          .print-booking * {
            visibility: visible;
          }
          .print-booking {
            position: absolute;
            left: 0;
            top: 0;
            width: 100%;
            background: white;
          }
          .no-print {
            display: none !important;
          }
        }
      `}</style>
    </div>
  );
}

