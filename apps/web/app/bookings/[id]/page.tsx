"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

import { apiFetch, apiFetchRaw } from "../../../src/lib/api";
import { getFileNameFromContentDisposition } from "../../../src/lib/download";
import { StatusPill } from "../../../src/components/StatusPill";
import { SectionHeader } from "../../../src/components/SectionHeader";
import { formatMoneyRub } from "../../../src/lib/format";
import { useCurrentUser } from "../../../src/hooks/useCurrentUser";
import { RejectBookingModal } from "../../../src/components/bookings/RejectBookingModal";
import { ApprovalTimeline } from "../../../src/components/bookings/ApprovalTimeline";
import { toast } from "../../../src/components/ToastProvider";

type ScanSession = {
  id: string;
  workerName: string;
  operation: "ISSUE" | "RETURN";
  status: "ACTIVE" | "COMPLETED" | "CANCELLED";
  createdAt: string;
  completedAt: string | null;
  _count: { scanRecords: number };
};

type BookingDetail = {
  id: string;
  displayName?: string;
  status: "DRAFT" | "PENDING_APPROVAL" | "CONFIRMED" | "ISSUED" | "RETURNED" | "CANCELLED";
  rejectionReason?: string | null;
  scanSessions?: ScanSession[];
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
}

function statusVariant(s: BookingDetail["status"]): "info" | "warn" | "full" | "edit" | "ok" | "none" | "view" {
  switch (s) {
    case "DRAFT": return "view";
    case "PENDING_APPROVAL": return "warn";
    case "CONFIRMED": return "full";
    case "ISSUED": return "edit";
    case "RETURNED": return "ok";
    case "CANCELLED": return "none";
  }
}

export default function BookingDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [booking, setBooking] = useState<BookingDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { user } = useCurrentUser();
  const [rejectOpen, setRejectOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState<null | "submit" | "approve" | "reject">(null);

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
        method: "BANK_TRANSFER",
        receivedAt: new Date().toISOString(),
      }),
    });
    const fresh = await fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000"}/api/bookings/${booking.id}`, {
      credentials: "include",
    }).then((r) => r.json());
    setBooking(fresh.booking);
  }

  async function handleSubmitForApproval() {
    if (!booking) return;
    setActionBusy("submit");
    try {
      const data = await apiFetch<{ booking: BookingDetail }>(`/api/bookings/${booking.id}/submit-for-approval`, {
        method: "POST",
      });
      setBooking(data.booking);
      toast.success("Бронь отправлена на согласование");
    } catch (e: any) {
      toast.error(e?.message ?? "Не удалось отправить на согласование");
    } finally {
      setActionBusy(null);
    }
  }

  async function handleApprove() {
    if (!booking) return;
    if (!confirm("Одобрить бронь и перевести её в «Подтверждено»?")) return;
    setActionBusy("approve");
    try {
      const data = await apiFetch<{ booking: BookingDetail }>(`/api/bookings/${booking.id}/approve`, {
        method: "POST",
      });
      setBooking(data.booking);
      toast.success("Бронь одобрена");
    } catch (e: any) {
      toast.error(e?.message ?? "Не удалось одобрить бронь");
    } finally {
      setActionBusy(null);
    }
  }

  async function handleReject(reason: string) {
    if (!booking) return;
    setActionBusy("reject");
    try {
      const data = await apiFetch<{ booking: BookingDetail }>(`/api/bookings/${booking.id}/reject`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
      setBooking(data.booking);
      setRejectOpen(false);
      toast.success("Бронь отклонена и возвращена в черновик");
    } catch (e: any) {
      // Don't toast — let modal show inline via thrown error
      throw e;
    } finally {
      setActionBusy(null);
    }
  }

  return (
    <div className="p-4">
      <div className="flex items-center justify-between flex-wrap gap-3 no-print">
        <SectionHeader
          eyebrow="Бронирование"
          title={booking?.displayName || `Бронь: ${id}`}
        />
        <div className="flex items-center gap-2 flex-wrap">
          <Link href="/bookings" className="rounded border border-border px-3 py-1.5 text-sm hover:bg-surface-muted transition-colors">
            ← Брони
          </Link>
          <Link href="/bookings/new" className="rounded bg-accent-bright text-white px-3 py-1.5 text-sm hover:bg-accent transition-colors">
            Новая бронь
          </Link>
          {booking && (
            <StatusPill
              variant={statusVariant(booking.status)}
              label={statusText(booking.status)}
            />
          )}
        </div>
      </div>

      {loading ? (
        <div className="mt-4 text-slate-500">Загрузка...</div>
      ) : err ? (
        <div className="mt-4 text-rose-700">{err}</div>
      ) : booking ? (
        <div className="mt-4">
          {booking.status === "DRAFT" && booking.rejectionReason && (
            <div className="mb-4 rounded border-l-4 border-rose bg-rose-soft px-4 py-3 text-sm text-ink-1">
              <div className="eyebrow mb-1 text-rose">Отклонено руководителем</div>
              <div className="whitespace-pre-wrap">{booking.rejectionReason}</div>
              <div className="mt-2 text-xs text-ink-3">
                Внесите правки и отправьте снова кнопкой «Отправить на согласование».
              </div>
            </div>
          )}

          {booking.status === "PENDING_APPROVAL" && (
            <div className="mb-4 rounded border border-amber bg-amber-soft px-4 py-2 text-sm text-ink-1">
              Бронь на согласовании у руководителя — редактирование временно заблокировано.
            </div>
          )}

          {user?.role === "SUPER_ADMIN" && (
            <ApprovalTimeline bookingId={booking.id} />
          )}

          <div className="mb-4 flex flex-wrap gap-2">
            {booking.status === "DRAFT" && (user?.role === "WAREHOUSE" || user?.role === "SUPER_ADMIN") && (
              <button
                type="button"
                onClick={handleSubmitForApproval}
                disabled={actionBusy !== null}
                className="rounded bg-accent-bright px-4 py-2 text-sm text-white hover:bg-accent-bright/90 disabled:opacity-50"
              >
                {actionBusy === "submit" ? "Отправляю…" : "Отправить на согласование"}
              </button>
            )}
            {booking.status === "PENDING_APPROVAL" && user?.role === "SUPER_ADMIN" && (
              <>
                <button
                  type="button"
                  onClick={handleApprove}
                  disabled={actionBusy !== null}
                  className="rounded bg-emerald px-4 py-2 text-sm text-white hover:bg-emerald/90 disabled:opacity-50"
                >
                  {actionBusy === "approve" ? "Одобряю…" : "Одобрить"}
                </button>
                <button
                  type="button"
                  onClick={() => setRejectOpen(true)}
                  disabled={actionBusy !== null}
                  className="rounded border border-rose px-4 py-2 text-sm text-rose hover:bg-rose-soft disabled:opacity-50"
                >
                  Отклонить
                </button>
              </>
            )}
          </div>

          <RejectBookingModal
            open={rejectOpen}
            bookingDisplayName={booking.displayName ?? booking.projectName}
            loading={actionBusy === "reject"}
            onClose={() => setRejectOpen(false)}
            onSubmit={handleReject}
          />

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 print-booking">
          <div className="lg:col-span-8 rounded-lg border border-border bg-surface shadow-xs overflow-hidden">
            <div className="p-3 border-b border-border bg-surface-subtle">
              <p className="eyebrow">Позиции брони</p>
            </div>
            <div className="overflow-auto">
              <table className="min-w-[860px] w-full text-sm">
                <thead className="bg-surface-subtle text-ink-2 border-b border-border">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">Категория</th>
                    <th className="text-left px-3 py-2 font-medium">Наименование</th>
                    <th className="px-3 py-2 w-[120px] font-medium text-right">Кол-во</th>
                  </tr>
                </thead>
                <tbody>
                  {booking.items.map((it) => (
                    <tr key={it.id} className="border-t border-border">
                      <td className="px-3 py-2 text-ink-2">{it.equipment.category}</td>
                      <td className="px-3 py-2">
                        <div className="font-medium text-ink">{it.equipment.name}</div>
                        <div className="text-xs text-ink-3">
                          {it.equipment.brand ? it.equipment.brand : ""} {it.equipment.model ? `· ${it.equipment.model}` : ""}
                        </div>
                      </td>
                      <td className="px-3 py-2 font-medium text-right mono-num">{it.quantity}</td>
                    </tr>
                  ))}
                  {booking.items.length === 0 ? (
                    <tr>
                      <td className="px-3 py-6 text-center text-ink-3" colSpan={3}>
                        Нет позиций
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>

          <div className="lg:col-span-4 space-y-4">
            {(booking.status === "CONFIRMED" || booking.status === "ISSUED" || booking.status === "RETURNED") && (
              <div className="rounded-lg border border-border bg-surface shadow-xs overflow-hidden no-print">
                <div className="p-3 border-b border-border bg-surface-subtle">
                  <p className="eyebrow">Сканирование</p>
                </div>
                <div className="p-3 text-sm text-ink space-y-3">
                  {(booking.scanSessions ?? []).length > 0 ? (
                    <div className="space-y-2">
                      {(booking.scanSessions ?? []).map((ss) => (
                        <div key={ss.id} className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-border bg-surface-subtle">
                          <div className="flex items-center gap-2">
                            <StatusPill
                              variant={ss.operation === "ISSUE" ? "info" : "ok"}
                              label={ss.operation === "ISSUE" ? "Выдача" : "Возврат"}
                            />
                            <span className="text-ink-2">{ss.workerName}</span>
                          </div>
                          <div className="text-right text-xs text-ink-3">
                            <div>{new Date(ss.createdAt).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}</div>
                            <div className="flex items-center gap-1 justify-end">
                              <span>{ss._count.scanRecords} скан. ·</span>
                              <StatusPill
                                variant={ss.status === "COMPLETED" ? "ok" : ss.status === "ACTIVE" ? "edit" : "none"}
                                label={ss.status === "COMPLETED" ? "Завершена" : ss.status === "ACTIVE" ? "Активна" : "Отменена"}
                              />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-ink-3 text-sm">Нет сессий сканирования</div>
                  )}
                  {booking.status === "CONFIRMED" && (booking.scanSessions ?? []).some(s => s.operation === "ISSUE" && s.status === "COMPLETED") && (
                    <div className="text-xs text-accent bg-accent-soft border border-accent-border rounded-lg px-3 py-2">
                      Выдача отсканирована — переведите заказ в статус «Выдан»
                    </div>
                  )}
                  {(booking.status === "CONFIRMED" || booking.status === "ISSUED") && (
                    <Link
                      href={`/warehouse/scan?booking=${booking.id}`}
                      className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-sm hover:bg-surface-muted transition-colors"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 7V5a2 2 0 0 1 2-2h2" />
                        <path d="M17 3h2a2 2 0 0 1 2 2v2" />
                        <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
                        <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
                        <line x1="7" y1="12" x2="17" y2="12" />
                      </svg>
                      Начать сканирование
                    </Link>
                  )}
                </div>
              </div>
            )}
            <div className="rounded-lg border border-border bg-surface shadow-xs overflow-hidden">
              <div className="p-3 border-b border-border bg-surface-subtle">
                <p className="eyebrow">Данные заказа и финансы</p>
              </div>
              <div className="p-3 text-sm text-ink space-y-2">
                <div>
                  <span className="text-ink-3">Клиент:</span> <span className="font-medium">{booking.client.name}</span>
                </div>
                <div>
                  <span className="text-ink-3">Проект:</span> <span className="font-medium">{booking.projectName}</span>
                </div>
                <div>
                  <span className="text-ink-3">Период:</span>{" "}
                  <span className="font-medium">
                    {new Date(booking.startDate).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })} —{" "}
                    {new Date(booking.endDate).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}
                  </span>
                </div>
                {booking.comment ? (
                  <div>
                    <span className="text-ink-3">Комментарий:</span> <span>{booking.comment}</span>
                  </div>
                ) : null}
                <div className="border-t border-border pt-2 mt-2 space-y-1">
                  <div><span className="text-ink-3">Сумма сметы:</span> <span className="font-medium mono-num">{formatMoneyRub(booking.totalEstimateAmount ?? "0")}</span></div>
                  <div><span className="text-ink-3">Скидка:</span> <span className="font-medium mono-num">{formatMoneyRub(booking.discountAmount ?? "0")}</span></div>
                  <div><span className="text-ink-3">Итог:</span> <span className="font-semibold mono-num">{formatMoneyRub(booking.finalAmount ?? "0")}</span></div>
                  <div><span className="text-ink-3">Оплачено:</span> <span className="font-medium mono-num">{formatMoneyRub(booking.amountPaid ?? "0")}</span></div>
                  <div><span className="text-ink-3">Остаток:</span> <span className="font-medium mono-num">{formatMoneyRub(booking.amountOutstanding ?? "0")}</span></div>
                  <div className="flex items-center gap-2">
                    <span className="text-ink-3">Статус оплаты:</span>
                    <StatusPill
                      variant={
                        booking.paymentStatus === "PAID" ? "ok"
                        : booking.paymentStatus === "PARTIALLY_PAID" ? "limited"
                        : booking.paymentStatus === "OVERDUE" ? "warn"
                        : "none"
                      }
                      label={
                        booking.paymentStatus === "PAID" ? "Оплачен"
                        : booking.paymentStatus === "PARTIALLY_PAID" ? "Частично"
                        : booking.paymentStatus === "OVERDUE" ? "Просрочен"
                        : "Не оплачен"
                      }
                    />
                  </div>
                  <div><span className="text-ink-3">Плановая дата платежа:</span> <span className="font-medium">{booking.expectedPaymentDate ? new Date(booking.expectedPaymentDate).toLocaleDateString("ru-RU") : "—"}</span></div>
                  <div className="pt-2">
                    <button className="rounded border border-border px-3 py-1.5 text-sm hover:bg-surface-muted transition-colors" onClick={quickAddPayment}>Добавить платёж</button>
                  </div>
                </div>
              </div>
            </div>

            {booking.estimate ? (
              <div className="rounded-lg border border-border bg-surface shadow-xs overflow-hidden">
                <div className="p-3 border-b border-border bg-surface-subtle flex items-center justify-between">
                  <p className="eyebrow">Смета</p>
                  <span className="text-xs text-ink-3">Шифты: {booking.estimate.shifts}</span>
                </div>
                <div className="p-3 space-y-3">
                  <div className="text-sm flex justify-between">
                    <span className="text-ink-2">Итого</span>
                    <span className="font-medium mono-num">{formatMoneyRub(booking.estimate.subtotal)}</span>
                  </div>
                  <div className="text-sm flex justify-between">
                    <span className="text-ink-2">Скидка</span>
                    <span className="font-medium mono-num">-{formatMoneyRub(booking.estimate.discountAmount)}</span>
                  </div>
                  <div className="text-sm flex justify-between pt-1 border-t border-border">
                    <span className="font-semibold text-ink">После скидки</span>
                    <span className="font-semibold text-ink mono-num">{formatMoneyRub(booking.estimate.totalAfterDiscount)}</span>
                  </div>

                  <div className="flex gap-2 no-print">
                    <button
                      className="flex-1 rounded border border-border px-3 py-2 text-sm hover:bg-surface-muted transition-colors"
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
                      className="flex-1 rounded bg-accent-bright text-white px-3 py-2 text-sm hover:bg-accent transition-colors"
                      onClick={() =>
                        download(
                          `/api/estimates/${booking.estimate!.id}/export/pdf`,
                          `estimate-${booking.estimate!.id}.pdf`,
                        )
                      }
                    >
                      PDF
                    </button>
                    <button className="flex-1 rounded border border-border px-3 py-2 text-sm hover:bg-surface-muted transition-colors" onClick={() => window.print()}>
                      Печать
                    </button>
                  </div>

                  <div className="max-h-[280px] overflow-auto border rounded-lg border-border">
                    <div className="eyebrow p-2 border-b border-border">Позиции</div>
                    {booking.estimate.lines.map((l) => (
                      <div key={l.id} className="px-2 py-2 border-t border-border flex justify-between gap-3 text-sm">
                        <div className="min-w-0">
                          <div className="font-medium truncate">{l.nameSnapshot}</div>
                          <div className="text-xs text-ink-3 mono-num">
                            {l.quantity} × {formatMoneyRub(l.unitPrice)}
                          </div>
                        </div>
                        <div className="font-medium mono-num">{formatMoneyRub(l.lineSum)}</div>
                      </div>
                    ))}
                  </div>

                  {booking.estimate.commentSnapshot ? <div className="text-xs text-ink-3">{booking.estimate.commentSnapshot}</div> : null}
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-surface-subtle p-3 text-sm text-ink-2">
                Смета пока не сформирована (возможно, это черновик).
              </div>
            )}
            <div className="rounded-lg border border-border bg-surface shadow-xs overflow-hidden">
              <div className="p-3 border-b border-border bg-surface-subtle">
                <p className="eyebrow">Журнал изменений</p>
              </div>
              <div className="max-h-[280px] overflow-auto">
                {(booking.financeEvents ?? []).map((ev) => (
                  <div key={ev.id} className="px-3 py-2 border-b border-border text-sm flex items-center justify-between gap-2">
                    <div>
                      <div className="font-medium text-ink">{ev.eventType}</div>
                      <div className="text-xs text-ink-3">{new Date(ev.createdAt).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}</div>
                    </div>
                    <div className="text-right text-xs text-ink-2">
                      {ev.statusFrom || ev.statusTo ? `${ev.statusFrom ?? "—"} → ${ev.statusTo ?? "—"}` : ""}
                      {ev.amountDelta ? <div className="mono-num">{formatMoneyRub(ev.amountDelta)}</div> : null}
                    </div>
                  </div>
                ))}
                {(booking.financeEvents ?? []).length === 0 ? (
                  <div className="px-3 py-4 text-sm text-ink-3">Пока нет событий.</div>
                ) : null}
              </div>
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

