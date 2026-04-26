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
import { ApprovalContext } from "../../../src/components/bookings/ApprovalContext";
import { ApprovalReviewView } from "../../../src/components/bookings/ApprovalReviewView";
import { toast } from "../../../src/components/ToastProvider";
import { RecordPaymentModal } from "../../../src/components/finance/RecordPaymentModal";
import { VoidPaymentModal } from "../../../src/components/finance/VoidPaymentModal";
import { FinanceTimeline } from "../../../src/components/finance/FinanceTimeline";
import { RelatedExpenses } from "../../../src/components/finance/RelatedExpenses";
import { RefundModal } from "../../../src/components/finance/RefundModal";
import { CreateInvoiceModal } from "../../../src/components/finance/CreateInvoiceModal";
import { CancelWithDepositModal } from "../../../src/components/finance/CancelWithDepositModal";
import { CreditNoteApplyModal } from "../../../src/components/finance/CreditNoteApplyModal";

type ScanSession = {
  id: string;
  workerName: string;
  operation: "ISSUE" | "RETURN";
  status: "ACTIVE" | "COMPLETED" | "CANCELLED";
  createdAt: string;
  completedAt: string | null;
  _count: { scanRecords: number };
};

type InvoiceItem = {
  id: string;
  number: string | null;
  kind: "FULL" | "DEPOSIT" | "BALANCE" | "CORRECTION";
  status: "DRAFT" | "ISSUED" | "PARTIAL_PAID" | "PAID" | "OVERDUE" | "VOID";
  total: string;
  paidAmount: string;
  dueDate: string | null;
};

type BookingDetail = {
  id: string;
  displayName?: string;
  legacyFinance?: boolean;
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
  payments?: Array<{
    id: string;
    amount: string;
    method: string | null;
    receivedAt: string | null;
    direction: string;
    note: string | null;
  }>;
  financeEvents?: Array<{
    id: string;
    eventType: string;
    statusFrom: string | null;
    statusTo: string | null;
    amountDelta: string | null;
    createdAt: string;
  }>;
  client: { id: string; name: string; phone: string | null; email: string | null; comment: string | null };
  items: Array<{
    id: string;
    equipmentId: string | null;
    quantity: number;
    customName?: string | null;
    customCategory?: string | null;
    customUnitPrice?: string | null;
    equipment: any;
  }>;
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

function paymentMethodLabel(method: string | null): string {
  switch (method) {
    case "CASH": return "Наличные";
    case "CARD": return "Карта";
    case "BANK_TRANSFER": return "Перевод";
    case "OTHER": return "Другое";
    default: return method ?? "—";
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
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [voidPaymentId, setVoidPaymentId] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<InvoiceItem[]>([]);
  const [createInvoiceOpen, setCreateInvoiceOpen] = useState(false);
  const [refundInvoiceId, setRefundInvoiceId] = useState<string | null>(null);
  const [cancelDepositOpen, setCancelDepositOpen] = useState(false);
  const [creditNoteOpen, setCreditNoteOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let isActive = true;
    async function load() {
      setLoading(true);
      try {
        const data = await apiFetch<{ booking: BookingDetail }>(`/api/bookings/${id}`, {
          signal: controller.signal,
        });
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

  async function reloadBooking() {
    if (!id) return;
    const fresh = await apiFetch<{ booking: BookingDetail }>(`/api/bookings/${id}`);
    setBooking(fresh.booking);
  }

  async function loadInvoices() {
    if (!id) return;
    try {
      const data = await apiFetch<{ items: InvoiceItem[] }>(`/api/invoices?bookingId=${id}`);
      setInvoices(data.items);
    } catch {
      // Non-fatal; invoices section will just show empty
    }
  }

  async function downloadInvoicePdf(inv: InvoiceItem) {
    const res = await apiFetchRaw(`/api/invoices/${inv.id}/pdf`, { method: "GET", credentials: "include" });
    if (!res.ok) { toast.error("Не удалось скачать PDF счёта"); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `invoice-${inv.number ?? inv.id}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
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

  // Загружаем счета когда бронь загружена и не legacyFinance
  useEffect(() => {
    if (booking && !booking.legacyFinance) {
      loadInvoices();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booking?.id, booking?.legacyFinance]);

  const showApprovalView =
    booking?.status === "PENDING_APPROVAL" && user?.role === "SUPER_ADMIN";

  return (
    <div className="p-4">
      {/* Parent top-bar — hidden when ApprovalReviewView is rendered; that view brings its own header */}
      {!showApprovalView && (
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
      )}

      {loading ? (
        <div className="mt-4 text-ink-3">Загрузка...</div>
      ) : err ? (
        <div className="mt-4 text-rose">{err}</div>
      ) : booking ? (
        booking.status === "PENDING_APPROVAL" && user?.role === "SUPER_ADMIN" ? (
          <ApprovalReviewView
            booking={booking}
            onReload={() => {
              // Re-fetch booking by re-triggering the effect via a state change
              const controller = new AbortController();
              fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000"}/api/bookings/${id}`, {
                signal: controller.signal,
                credentials: "include",
              })
                .then((r) => r.json())
                .then((data) => setBooking(data.booking))
                .catch(() => {});
            }}
            currentUser={user!}
          />
        ) : (
        <div className="mt-4">
          {booking.status === "DRAFT" && booking.rejectionReason && (
            <div className="mb-4 rounded border-l-4 border-rose bg-rose-soft px-4 py-3 text-sm text-ink">
              <div className="eyebrow mb-1 text-rose">Отклонено руководителем</div>
              <div className="whitespace-pre-wrap">{booking.rejectionReason}</div>
              <div className="mt-2 text-xs text-ink-3">
                Внесите правки и отправьте снова кнопкой «Отправить на согласование».
              </div>
            </div>
          )}

          {booking.status === "PENDING_APPROVAL" && (
            <div className="mb-4 rounded border border-amber bg-amber-soft px-4 py-2 text-sm text-ink">
              Бронь на согласовании у руководителя — редактирование временно заблокировано.
            </div>
          )}

          {booking.status === "PENDING_APPROVAL" && user?.role === "SUPER_ADMIN" && (
            <div className="mb-4">
              <ApprovalContext
                bookingId={booking.id}
                clientId={booking.client.id}
                startDate={booking.startDate}
                endDate={booking.endDate}
                itemCount={booking.items.length}
                comment={booking.comment}
                items={booking.items}
              />
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

          {/* Finance Phase 2 modals */}
          <CreateInvoiceModal
            open={createInvoiceOpen}
            onClose={() => setCreateInvoiceOpen(false)}
            defaultBookingId={booking.id}
            defaultTotal={booking.finalAmount ?? undefined}
            onCreated={() => { setCreateInvoiceOpen(false); loadInvoices(); }}
          />
          <RefundModal
            open={!!refundInvoiceId}
            onClose={() => setRefundInvoiceId(null)}
            invoiceId={refundInvoiceId ?? undefined}
            bookingId={booking.id}
            onSuccess={() => { setRefundInvoiceId(null); reloadBooking(); }}
          />
          <CancelWithDepositModal
            open={cancelDepositOpen}
            onClose={() => setCancelDepositOpen(false)}
            bookingId={booking.id}
            bookingDisplayName={booking.displayName ?? booking.projectName}
            clientId={booking.client.id}
            clientName={booking.client.name}
            depositTotal={Number(booking.amountPaid ?? "0")}
            onCancelled={() => { setCancelDepositOpen(false); reloadBooking(); }}
          />
          <CreditNoteApplyModal
            open={creditNoteOpen}
            onClose={() => setCreditNoteOpen(false)}
            bookingId={booking.id}
            clientId={booking.client.id}
            onApplied={() => { setCreditNoteOpen(false); reloadBooking(); }}
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
                      <td className="px-3 py-2 text-ink-2">{it.equipment?.category ?? it.customCategory ?? "—"}</td>
                      <td className="px-3 py-2">
                        <div className="font-medium text-ink">{it.equipment?.name ?? it.customName ?? "—"}</div>
                        <div className="text-xs text-ink-3">
                          {it.equipment?.brand ? it.equipment.brand : ""} {it.equipment?.model ? `· ${it.equipment.model}` : ""}
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
                  <div><span className="text-ink-3">Остаток к оплате:</span> <span className="font-medium mono-num">{formatMoneyRub(booking.amountOutstanding ?? "0")}</span></div>
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
                        : booking.paymentStatus === "PARTIALLY_PAID" ? "Частично оплачен"
                        : booking.paymentStatus === "OVERDUE" ? "Просрочен"
                        : "Не оплачен"
                      }
                    />
                  </div>
                  <div><span className="text-ink-3">Плановая дата платежа:</span> <span className="font-medium">{booking.expectedPaymentDate ? new Date(booking.expectedPaymentDate).toLocaleDateString("ru-RU") : "—"}</span></div>

                  {/* F3: Хронология денег — SA only (D3: backend gated SA-only) */}
                  {user?.role === "SUPER_ADMIN" && (
                    <div className="pt-2 mt-2 border-t border-border">
                      <FinanceTimeline bookingId={booking.id} />
                    </div>
                  )}

                  {/* F4: Связанные расходы — SA only (D3: backend gated SA-only) */}
                  {user?.role === "SUPER_ADMIN" && (
                    <div>
                      <RelatedExpenses bookingId={booking.id} />
                    </div>
                  )}

                  {/* Список платежей — Платежи */}
                  {(booking.payments ?? []).length > 0 && (
                    <div className="pt-2 mt-2 border-t border-border">
                      <p className="eyebrow mb-2">Платежи</p>
                      <div className="space-y-1">
                        {(booking.payments ?? []).map((p) => (
                          <div key={p.id} className="flex items-center justify-between gap-2 text-sm py-1">
                            <div className="flex items-center gap-2 text-ink-2 min-w-0">
                              <span className="text-xs text-ink-3">
                                {p.receivedAt ? new Date(p.receivedAt).toLocaleDateString("ru-RU") : "—"}
                              </span>
                              <span>{paymentMethodLabel(p.method)}</span>
                              {p.note && <span className="text-xs text-ink-3 truncate">{p.note}</span>}
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <span className="font-medium mono-num">{formatMoneyRub(p.amount)}</span>
                              {user?.role === "SUPER_ADMIN" && (
                                <button
                                  className="text-xs text-rose hover:underline"
                                  onClick={() => setVoidPaymentId(p.id)}
                                >
                                  Аннулировать
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* CTA row — role-gated (T3) */}
                  <div className="pt-2 flex flex-wrap gap-2">
                    {/* Записать платёж: SA всегда; WH при ISSUED|RETURNED (остаток > 0 или не известен) */}
                    {/* C3: outstanding=null means finance not computed yet; show button so WH can record payment */}
                    {(user?.role === "SUPER_ADMIN" ||
                      (user?.role === "WAREHOUSE" &&
                        (booking.status === "ISSUED" || booking.status === "RETURNED") &&
                        (booking.amountOutstanding == null || Number(booking.amountOutstanding) > 0))
                    ) && (
                      <button
                        className="rounded border border-border px-3 py-1.5 text-sm hover:bg-surface-subtle transition-colors"
                        onClick={() => setPaymentModalOpen(true)}
                      >
                        Записать платёж
                      </button>
                    )}

                    {/* Скачать счёт PDF (Phase 1 legacy) — только для legacyFinance */}
                    {/* A1: use apiFetch-based download() to respect NEXT_PUBLIC_API_BASE_URL and auth cookies */}
                    {(user?.role === "SUPER_ADMIN" || user?.role === "WAREHOUSE") && booking.legacyFinance !== false && (
                      <button
                        className="rounded border border-border px-3 py-1.5 text-sm hover:bg-surface-subtle transition-colors"
                        onClick={() => download(`/api/bookings/${booking.id}/invoice.pdf`, `Счёт_${booking.id}.pdf`)}
                      >
                        Скачать счёт PDF
                      </button>
                    )}

                    {/* Отменить бронь с депозитом (SA only) */}
                    {user?.role === "SUPER_ADMIN" &&
                      ["DRAFT", "PENDING_APPROVAL", "CONFIRMED"].includes(booking.status) &&
                      Number(booking.amountPaid ?? "0") > 0 && (
                        <button
                          className="rounded border border-rose px-3 py-1.5 text-sm text-rose hover:bg-rose-soft transition-colors"
                          onClick={() => setCancelDepositOpen(true)}
                        >
                          Отменить бронь
                        </button>
                    )}

                    {/* Скачать акт PDF (T10) — только при RETURNED и нулевом остатке */}
                    {(user?.role === "SUPER_ADMIN" || user?.role === "WAREHOUSE") && (() => {
                      const canAct = booking.status === "RETURNED" && Number(booking.amountOutstanding ?? "0") === 0;
                      return (
                        <button
                          className={`rounded border px-3 py-1.5 text-sm transition-colors ${
                            canAct
                              ? "border-border hover:bg-surface-subtle"
                              : "border-border text-ink-3 cursor-not-allowed opacity-50"
                          }`}
                          title={canAct ? "" : "Доступно после возврата и закрытия долга"}
                          disabled={!canAct}
                          onClick={canAct ? () => download(`/api/bookings/${booking.id}/act.pdf`, `Акт_${booking.id}.pdf`) : undefined}
                        >
                          Скачать акт PDF
                        </button>
                      );
                    })()}
                  </div>

                  {/* Счета (Phase 2) — скрыто если legacyFinance */}
                  {booking.legacyFinance === false && user?.role === "SUPER_ADMIN" && (
                    <div className="pt-2 mt-2 border-t border-border">
                      <div className="flex items-center justify-between mb-2">
                        <p className="eyebrow">Счета</p>
                        <button
                          onClick={() => setCreateInvoiceOpen(true)}
                          className="text-[11px] px-2 py-1 bg-accent-bright text-white rounded hover:opacity-90"
                        >
                          + Создать счёт
                        </button>
                      </div>
                      {invoices.length === 0 ? (
                        <div className="text-xs text-ink-3">Счетов пока нет</div>
                      ) : (
                        <div className="space-y-1.5">
                          {invoices.map((inv) => {
                            const invStatusVariant = (
                              inv.status === "DRAFT" ? "view" :
                              inv.status === "ISSUED" ? "info" :
                              inv.status === "PARTIAL_PAID" ? "warn" :
                              inv.status === "PAID" ? "ok" :
                              inv.status === "OVERDUE" ? "alert" : "none"
                            ) as "view" | "info" | "warn" | "ok" | "alert" | "none";
                            const invStatusLabel = {
                              DRAFT: "Черновик", ISSUED: "Выставлен", PARTIAL_PAID: "Частично",
                              PAID: "Оплачен", OVERDUE: "Просрочен", VOID: "Аннулирован",
                            }[inv.status];
                            const kindLabel = { FULL: "Полный", DEPOSIT: "Предоплата", BALANCE: "Остаток", CORRECTION: "Корректировка" }[inv.kind];
                            return (
                              <div key={inv.id} className="flex items-center justify-between gap-2 text-xs py-1.5 border-b border-dashed border-border last:border-0">
                                <div className="min-w-0">
                                  <div className="font-mono">{inv.number ?? "Черновик"} · {kindLabel}</div>
                                  <div className="text-ink-3">
                                    {inv.dueDate ? new Date(inv.dueDate).toLocaleDateString("ru-RU") : "—"}
                                  </div>
                                </div>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  <StatusPill variant={invStatusVariant} label={invStatusLabel} />
                                  {inv.number && (
                                    <button
                                      onClick={() => downloadInvoicePdf(inv)}
                                      className="text-ink-3 hover:text-accent"
                                      title="PDF"
                                      aria-label="Скачать PDF счёта"
                                    >
                                      ↓
                                    </button>
                                  )}
                                  {["ISSUED", "PARTIAL_PAID", "PAID"].includes(inv.status) && (
                                    <button
                                      onClick={() => setRefundInvoiceId(inv.id)}
                                      className="text-amber hover:underline text-[10px]"
                                    >
                                      Возврат
                                    </button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {/* Кредит-ноты */}
                      <button
                        onClick={() => setCreditNoteOpen(true)}
                        className="mt-2 text-[11px] text-accent hover:underline"
                      >
                        Кредит-ноты клиента →
                      </button>
                    </div>
                  )}
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
        )
      ) : (
        <div className="mt-4 text-ink-3">Бронь не найдена.</div>
      )}
      {/* B2: Mobile-only sticky bottom CTA (390px). Mirrors the inline CTAs in the finance block. */}
      {booking && (user?.role === "SUPER_ADMIN" || user?.role === "WAREHOUSE") &&
        booking.status !== "CANCELLED" && booking.status !== "DRAFT" && booking.status !== "PENDING_APPROVAL" && (
        <div className="md:hidden fixed bottom-0 left-0 right-0 z-30 flex gap-2 px-3 py-3 bg-surface border-t border-border shadow-lg no-print">
          {/* ₽ Платёж */}
          {(user?.role === "SUPER_ADMIN" ||
            ((booking.status === "ISSUED" || booking.status === "RETURNED") &&
              (booking.amountOutstanding == null || Number(booking.amountOutstanding) > 0))
          ) && (
            <button
              className="flex-1 rounded border border-border px-2 py-2.5 text-sm font-medium hover:bg-surface-subtle transition-colors"
              onClick={() => setPaymentModalOpen(true)}
            >
              ₽ Платёж
            </button>
          )}
          {/* PDF Счёт */}
          <button
            className="flex-1 rounded border border-border px-2 py-2.5 text-sm font-medium hover:bg-surface-subtle transition-colors"
            onClick={() => download(`/api/bookings/${booking.id}/invoice.pdf`, `Счёт_${booking.id}.pdf`)}
          >
            PDF Счёт
          </button>
          {/* PDF Акт */}
          {(() => {
            const canAct = booking.status === "RETURNED" && Number(booking.amountOutstanding ?? "0") === 0;
            return (
              <button
                className={`flex-1 rounded border px-2 py-2.5 text-sm font-medium transition-colors ${
                  canAct ? "border-border hover:bg-surface-subtle" : "border-border text-ink-3 opacity-50 cursor-not-allowed"
                }`}
                disabled={!canAct}
                onClick={canAct ? () => download(`/api/bookings/${booking.id}/act.pdf`, `Акт_${booking.id}.pdf`) : undefined}
              >
                PDF Акт
              </button>
            );
          })()}
        </div>
      )}

      {/* RecordPaymentModal — T2 */}
      {booking && (
        <RecordPaymentModal
          open={paymentModalOpen}
          onClose={() => setPaymentModalOpen(false)}
          defaultBookingId={booking.id}
          legacyFinance={booking.legacyFinance !== false ? true : false}
          bookingContext={{
            id: booking.id,
            projectName: booking.projectName,
            client: booking.client,
            finalAmount: booking.finalAmount ?? undefined,
            amountPaid: booking.amountPaid ?? undefined,
            amountOutstanding: booking.amountOutstanding ?? undefined,
          }}
          onCreated={() => {
            setPaymentModalOpen(false);
            reloadBooking();
          }}
        />
      )}

      {/* VoidPaymentModal — T11 */}
      <VoidPaymentModal
        open={voidPaymentId !== null}
        paymentId={voidPaymentId}
        onClose={() => setVoidPaymentId(null)}
        onVoided={() => {
          setVoidPaymentId(null);
          reloadBooking();
        }}
      />

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

