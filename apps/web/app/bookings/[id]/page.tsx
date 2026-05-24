"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

import { apiFetch, apiFetchRaw } from "../../../src/lib/api";
import { getFileNameFromContentDisposition } from "../../../src/lib/download";
import { StatusPill } from "../../../src/components/StatusPill";
import { SectionHeader } from "../../../src/components/SectionHeader";
import { formatMoneyRub, formatRub } from "../../../src/lib/format";
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
import { ClientPortalAccessCard } from "../../../src/components/admin/ClientPortalAccessCard";
import { AddonEstimateSection } from "../../../src/components/bookings/AddonEstimateSection";
import { VehicleDriverRow } from "../../../src/components/bookings/VehicleDriverRow";

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
  // Transport snapshot — flat add-on, не участвует в скидке оборудования.
  // Multi-vehicle: vehicles[]. Legacy single columns kept for old bookings.
  vehicles?: Array<{
    id: string;
    vehicleId: string;
    vehicle?: { id: string; name: string; slug: string } | null;
    withGenerator: boolean;
    shiftHours: string | null;
    skipOvertime: boolean;
    kmOutsideMkad: number | null;
    ttkEntry: boolean;
    subtotalRub: string | null;
    driverName?: string | null;
    driverPhone?: string | null;
  }>;
  vehicleId?: string | null;
  transportSubtotalRub?: string | null;
  vehicle?: { id: string; name: string; slug: string } | null;
};

/**
 * Чистый заголовок брони: дата · клиент · проект.
 * Сознательно БЕЗ суммы — серверный displayName конкатенирует сумму
 * («17.05.2026 Захар Родомский 74623»), что путало оператора, потому
 * что эта цифра — equipment-after-discount без транспорта, а не итог.
 */
function bookingTitle(b: BookingDetail): string {
  const date = new Date(b.startDate).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Moscow",
  });
  const project = b.projectName?.trim() && b.projectName.trim() !== "Проект" ? b.projectName.trim() : null;
  return [date, b.client.name, project].filter(Boolean).join(" · ");
}

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
    <div className="p-4 pb-24 md:pb-4">
      {/* Parent top-bar — hidden when ApprovalReviewView is rendered; that view brings its own header */}
      {!showApprovalView && (
        <div className="flex items-center justify-between flex-wrap gap-3 no-print">
          <SectionHeader
            eyebrow="Бронирование"
            title={booking ? bookingTitle(booking) : `Бронь: ${id}`}
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
          {(() => {
            // Единый список позиций. Когда есть снапшот сметы — показываем
            // цены/суммы прямо здесь (раньше дублировалось отдельным списком
            // «Смета → Позиции»). Сопоставление по equipmentId, затем по имени.
            const estLines = booking.estimate?.lines ?? [];
            const priceByEquipmentId = new Map<string, { unitPrice: string; lineSum: string }>();
            const priceByName = new Map<string, { unitPrice: string; lineSum: string }>();
            for (const l of estLines) {
              if (l.equipmentId) priceByEquipmentId.set(l.equipmentId, { unitPrice: l.unitPrice, lineSum: l.lineSum });
              priceByName.set(l.nameSnapshot, { unitPrice: l.unitPrice, lineSum: l.lineSum });
            }
            const showPrices = estLines.length > 0;
            const colCount = showPrices ? 5 : 3;
            return (
              <div className="lg:col-span-8 rounded-lg border border-border bg-surface shadow-xs overflow-hidden">
                <div className="p-3 border-b border-border bg-surface-subtle">
                  <p className="eyebrow">Позиции брони ({booking.items.length})</p>
                </div>
                <div className="overflow-auto max-h-[560px]">
                  <table className="min-w-[860px] w-full text-sm">
                    <thead className="bg-surface-subtle text-ink-2 border-b border-border sticky top-0">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium">Категория</th>
                        <th className="text-left px-3 py-2 font-medium">Наименование</th>
                        <th className="px-3 py-2 w-[100px] font-medium text-right">Кол-во</th>
                        {showPrices && <th className="px-3 py-2 w-[120px] font-medium text-right">Цена</th>}
                        {showPrices && <th className="px-3 py-2 w-[130px] font-medium text-right">Сумма</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {booking.items.map((it) => {
                        const price =
                          (it.equipmentId ? priceByEquipmentId.get(it.equipmentId) : undefined) ??
                          priceByName.get(it.equipment?.name ?? it.customName ?? "");
                        return (
                          <tr key={it.id} className="border-t border-border">
                            <td className="px-3 py-2 text-ink-2">{it.equipment?.category ?? it.customCategory ?? "—"}</td>
                            <td className="px-3 py-2">
                              <div className="font-medium text-ink">{it.equipment?.name ?? it.customName ?? "—"}</div>
                              <div className="text-xs text-ink-3">
                                {it.equipment?.brand ? it.equipment.brand : ""} {it.equipment?.model ? `· ${it.equipment.model}` : ""}
                              </div>
                            </td>
                            <td className="px-3 py-2 font-medium text-right mono-num">{it.quantity}</td>
                            {showPrices && (
                              <td className="px-3 py-2 text-right mono-num text-ink-2">
                                {price ? formatMoneyRub(price.unitPrice) : "—"}
                              </td>
                            )}
                            {showPrices && (
                              <td className="px-3 py-2 text-right mono-num font-medium text-ink">
                                {price ? formatMoneyRub(price.lineSum) : "—"}
                              </td>
                            )}
                          </tr>
                        );
                      })}
                      {booking.items.length === 0 ? (
                        <tr>
                          <td className="px-3 py-6 text-center text-ink-3" colSpan={colCount}>
                            Нет позиций
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}

          <div className="lg:col-span-4 space-y-4">
            {/* Транспорт и водители — заполняется на погрузке.
                Поставлен в самый верх правой колонки, чтобы был первым после оборудования. */}
            {((booking.vehicles?.length ?? 0) > 0) && (
              <div className="rounded-lg border border-accent-border bg-surface shadow-xs overflow-hidden">
                <div className="p-3 border-b border-accent-border bg-accent-soft flex items-center justify-between">
                  <p className="eyebrow text-accent-bright">🚐 Транспорт и водители</p>
                  <span className="text-xs text-ink-3">
                    {booking.vehicles!.length} {booking.vehicles!.length === 1 ? "машина" : booking.vehicles!.length < 5 ? "машины" : "машин"}
                  </span>
                </div>
                <div className="p-3 space-y-2">
                  {booking.vehicles!.map((v) => (
                    <VehicleDriverRow
                      key={v.id}
                      bookingId={booking.id}
                      vehicle={v}
                      canEdit={user?.role === "SUPER_ADMIN" || user?.role === "WAREHOUSE"}
                      onUpdated={(next) => {
                        setBooking((prev) =>
                          prev
                            ? {
                                ...prev,
                                vehicles: prev.vehicles?.map((veh) =>
                                  veh.id === v.id
                                    ? { ...veh, driverName: next.driverName, driverPhone: next.driverPhone }
                                    : veh,
                                ),
                              }
                            : prev,
                        );
                      }}
                    />
                  ))}
                  {(user?.role === "SUPER_ADMIN" || user?.role === "WAREHOUSE") && (
                    <p className="text-xs text-ink-3 px-1 pt-1">
                      Заполняется при погрузке — ведём учёт, кто ездил за рулём.
                    </p>
                  )}
                </div>
              </div>
            )}
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
            {/* ── ФИНАНСЫ ── Mockup-faithful finance block ── */}
            {(user?.role === "SUPER_ADMIN" || user?.role === "WAREHOUSE") && (
              <div className="rounded-lg border border-border bg-surface shadow-xs overflow-hidden">
                {/* Header */}
                <div className="px-4 pt-4 pb-3 border-b border-border bg-surface-subtle">
                  <p className="eyebrow text-accent-bright mb-1">Финансы</p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <StatusPill
                      variant={
                        booking.paymentStatus === "PAID" ? "ok"
                        : booking.paymentStatus === "PARTIALLY_PAID" ? "limited"
                        : booking.paymentStatus === "OVERDUE" ? "alert"
                        : "none"
                      }
                      label={
                        booking.paymentStatus === "PAID" ? "Оплачен"
                        : booking.paymentStatus === "PARTIALLY_PAID" ? "Частично оплачен"
                        : booking.paymentStatus === "OVERDUE" ? "Просрочен"
                        : "Не оплачен"
                      }
                    />
                    {booking.expectedPaymentDate && (
                      <span className="text-xs text-ink-3">
                        срок {new Date(booking.expectedPaymentDate).toLocaleDateString("ru-RU")}
                      </span>
                    )}
                  </div>
                </div>

                <div className="p-4 space-y-4">
                  {/* KPI mini-strip */}
                  <div className="grid grid-cols-3 gap-2 p-3 bg-surface-2 rounded-lg">
                    <div>
                      <div className="eyebrow text-ink-3 mb-1">Сумма брони</div>
                      <div className="text-lg font-semibold mono-num text-ink">{formatMoneyRub(booking.finalAmount ?? "0")}</div>
                    </div>
                    <div>
                      <div className="eyebrow text-ink-3 mb-1">Получено</div>
                      <div className="text-lg font-semibold mono-num text-emerald">{formatMoneyRub(booking.amountPaid ?? "0")}</div>
                    </div>
                    <div>
                      <div className="eyebrow text-ink-3 mb-1">К получению</div>
                      <div className={`text-lg font-semibold mono-num ${Number(booking.amountOutstanding ?? "0") > 0 ? "text-rose" : "text-ink"}`}>
                        {formatMoneyRub(booking.amountOutstanding ?? "0")}
                      </div>
                    </div>
                  </div>

                  {/* Разбивка «Сумма брони» — единственный источник истины для оператора.
                      finalAmount = аренда-после-скидки (снапшот сметы) + транспорт.
                      Показываем явно, чтобы расхождение с блоком «Смета» (там только
                      оборудование, без транспорта) не сбивало с толку. */}
                  {(() => {
                    const equipAfterDiscount = booking.estimate
                      ? Number(booking.estimate.totalAfterDiscount)
                      : Number(booking.finalAmount ?? "0") - Number(booking.transportSubtotalRub ?? "0");
                    const transport = Number(booking.transportSubtotalRub ?? "0");
                    const transportVehicles = booking.vehicles ?? [];
                    const hasMultiVehicles = transportVehicles.length > 0;
                    const hasTransport =
                      (hasMultiVehicles || Boolean(booking.vehicleId)) && transport > 0;
                    const finalNum = Number(booking.finalAmount ?? "0");
                    const discount = booking.estimate ? Number(booking.estimate.discountAmount) : Number(booking.discountAmount ?? "0");
                    const rentBeforeDiscount = booking.estimate ? Number(booking.estimate.subtotal) : Number(booking.totalEstimateAmount ?? "0");
                    // Сигнал рассинхрона: снапшот сметы + транспорт ≠ сохранённый finalAmount.
                    const recomposed = equipAfterDiscount + transport;
                    const drifted = booking.estimate != null && Math.abs(recomposed - finalNum) > 0.01;
                    return (
                      <div className="rounded-lg border border-border bg-surface px-3 py-2.5 text-sm space-y-1.5">
                        <div className="eyebrow text-ink-3 mb-1">Из чего складывается сумма</div>
                        <div className="flex justify-between">
                          <span className="text-ink-2">Аренда оборудования</span>
                          <span className="mono-num text-ink-2">{formatMoneyRub(rentBeforeDiscount)}</span>
                        </div>
                        {discount > 0 && (
                          <div className="flex justify-between">
                            <span className="text-ink-2">
                              Скидка{booking.estimate?.discountPercent ? ` ${booking.estimate.discountPercent}%` : ""}
                            </span>
                            <span className="mono-num text-rose">−{formatMoneyRub(discount)}</span>
                          </div>
                        )}
                        <div className="flex justify-between">
                          <span className="text-ink-2">Аренда после скидки</span>
                          <span className="mono-num text-ink-2">{formatMoneyRub(equipAfterDiscount)}</span>
                        </div>
                        {hasTransport && hasMultiVehicles && (
                          <>
                            {transportVehicles.map((v) => (
                              <div key={v.id} className="flex justify-between">
                                <span className="text-ink-2">
                                  Транспорт{v.vehicle?.name ? ` (${v.vehicle.name})` : ""}
                                </span>
                                <span className="mono-num text-ink-2">
                                  +{formatMoneyRub(v.subtotalRub ?? "0")}
                                </span>
                              </div>
                            ))}
                          </>
                        )}
                        {hasTransport && !hasMultiVehicles && (
                          <div className="flex justify-between">
                            <span className="text-ink-2">
                              Доставка / транспорт{booking.vehicle?.name ? ` (${booking.vehicle.name})` : ""}
                            </span>
                            <span className="mono-num text-ink-2">+{formatMoneyRub(transport)}</span>
                          </div>
                        )}
                        <div className="flex justify-between border-t border-border pt-1.5 font-semibold">
                          <span className="text-ink">Сумма брони</span>
                          <span className="mono-num text-ink">{formatMoneyRub(booking.finalAmount ?? "0")}</span>
                        </div>
                        {drifted && (
                          <div className="mt-1 rounded bg-amber-soft border border-amber-border px-2 py-1 text-xs text-amber">
                            Смета пересчитана после изменений — итог брони ({formatMoneyRub(finalNum)}) актуальнее
                            суммы в снапшоте сметы ниже ({formatMoneyRub(recomposed)}).
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* CTA row (desktop) */}
                  <div className="hidden md:flex flex-wrap gap-2">
                    {/* Записать платёж: SA всегда; WH при ISSUED|RETURNED */}
                    {(user?.role === "SUPER_ADMIN" ||
                      (user?.role === "WAREHOUSE" &&
                        (booking.status === "ISSUED" || booking.status === "RETURNED") &&
                        (booking.amountOutstanding == null || Number(booking.amountOutstanding) > 0))
                    ) && (
                      <button
                        className="rounded bg-accent-bright text-white px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity"
                        onClick={() => setPaymentModalOpen(true)}
                      >
                        + Записать платёж
                      </button>
                    )}

                    {/* Отменить с депозитом (SA only) */}
                    {user?.role === "SUPER_ADMIN" &&
                      ["DRAFT", "PENDING_APPROVAL", "CONFIRMED"].includes(booking.status) &&
                      Number(booking.amountPaid ?? "0") > 0 && (
                        <button
                          className="rounded border border-rose px-3 py-2 text-sm text-rose hover:bg-rose-soft transition-colors"
                          onClick={() => setCancelDepositOpen(true)}
                        >
                          Отменить бронь
                        </button>
                    )}

                    {/* Счёт PDF — legacy */}
                    {booking.legacyFinance !== false && (
                      <button
                        className="rounded border border-border px-3 py-2 text-sm hover:bg-surface-subtle transition-colors"
                        onClick={() => download(`/api/bookings/${booking.id}/invoice.pdf`, `Счёт_${booking.id}.pdf`)}
                      >
                        📄 Скачать счёт PDF
                      </button>
                    )}

                    {/* Акт PDF */}
                    {(() => {
                      const canAct = booking.status === "RETURNED" && Number(booking.amountOutstanding ?? "0") === 0;
                      const actHint = "Акт доступен после возврата оборудования и закрытия долга";
                      return (
                        <button
                          className={`rounded border px-3 py-2 text-sm transition-colors ${
                            canAct
                              ? "border-border hover:bg-surface-subtle"
                              : "border-border text-ink-3 cursor-not-allowed opacity-50"
                          }`}
                          title={canAct ? "Скачать акт PDF" : actHint}
                          aria-label={canAct ? "Скачать акт PDF" : actHint}
                          disabled={!canAct}
                          onClick={canAct ? () => download(`/api/bookings/${booking.id}/act.pdf`, `Акт_${booking.id}.pdf`) : undefined}
                        >
                          📄 Скачать акт PDF
                        </button>
                      );
                    })()}
                  </div>

                  {/* Счета (Phase 2, post-cutoff) */}
                  {booking.legacyFinance === false && user?.role === "SUPER_ADMIN" && (
                    <div>
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
                        <div className="text-xs text-ink-3 py-2">Счетов пока нет</div>
                      ) : (
                        <div className="border border-border rounded-lg overflow-hidden">
                          <table className="w-full text-xs">
                            <thead className="bg-surface-subtle border-b border-border text-ink-2">
                              <tr>
                                <th className="text-left px-3 py-2 font-medium">№</th>
                                <th className="text-left px-3 py-2 font-medium">Тип</th>
                                <th className="text-right px-3 py-2 font-medium">Сумма</th>
                                <th className="text-right px-3 py-2 font-medium">Срок</th>
                                <th className="px-3 py-2"></th>
                              </tr>
                            </thead>
                            <tbody>
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
                                }[inv.status] ?? inv.status;
                                const kindLabel = { FULL: "Полный", DEPOSIT: "Предоплата", BALANCE: "Остаток", CORRECTION: "Корректировка" }[inv.kind] ?? inv.kind;
                                return (
                                  <tr key={inv.id} className="border-t border-border">
                                    <td className="px-3 py-2 font-mono text-ink-2">{inv.number ?? "—"}</td>
                                    <td className="px-3 py-2 text-ink-2">{kindLabel}</td>
                                    <td className="px-3 py-2 text-right mono-num">{formatMoneyRub(inv.total)}</td>
                                    <td className="px-3 py-2 text-right text-ink-3">
                                      {inv.dueDate ? new Date(inv.dueDate).toLocaleDateString("ru-RU") : "—"}
                                    </td>
                                    <td className="px-3 py-2">
                                      <div className="flex items-center gap-1.5 justify-end">
                                        <StatusPill variant={invStatusVariant} label={invStatusLabel} />
                                        {inv.number && (
                                          <button
                                            onClick={() => downloadInvoicePdf(inv)}
                                            className="text-ink-3 hover:text-accent px-1"
                                            title="PDF"
                                            aria-label="Скачать PDF счёта"
                                          >
                                            📄
                                          </button>
                                        )}
                                        {["ISSUED", "PARTIAL_PAID", "PAID"].includes(inv.status) && (
                                          <button
                                            onClick={() => setRefundInvoiceId(inv.id)}
                                            className="text-amber hover:underline"
                                          >
                                            ↩ Возврат
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
                      )}
                      <button
                        onClick={() => setCreditNoteOpen(true)}
                        className="mt-2 text-[11px] text-accent hover:underline"
                      >
                        Кредит-ноты клиента →
                      </button>
                    </div>
                  )}

                  {/* Платежи */}
                  {(booking.payments ?? []).length > 0 && (
                    <div>
                      <p className="eyebrow mb-2">Платежи</p>
                      <div className="divide-y divide-border">
                        {(booking.payments ?? []).map((p) => {
                          const isVoided = p.direction === "VOID";
                          return (
                            <div
                              key={p.id}
                              className={`flex items-center justify-between gap-2 py-2.5 text-sm ${isVoided ? "opacity-40 line-through" : ""}`}
                            >
                              <div className="min-w-0">
                                <span className={`font-semibold mono-num ${isVoided ? "" : "text-emerald"}`}>
                                  +{formatMoneyRub(p.amount)}
                                </span>
                                <span className="text-ink-3 mx-1.5">·</span>
                                <span className="text-ink-2">{paymentMethodLabel(p.method)}</span>
                                {p.note && <span className="text-xs text-ink-3 ml-1.5 truncate">{p.note}</span>}
                                <div className="text-xs text-ink-3 mt-0.5">
                                  {p.receivedAt ? new Date(p.receivedAt).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" }) : "—"}
                                </div>
                              </div>
                              {!isVoided && user?.role === "SUPER_ADMIN" && (
                                <div className="flex gap-1.5 shrink-0">
                                  <button
                                    className="text-xs text-rose border border-rose-border rounded px-2 py-0.5 hover:bg-rose-soft transition-colors"
                                    onClick={() => setVoidPaymentId(p.id)}
                                  >
                                    ⊘ Аннулировать
                                  </button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Хронология денег (SA only, collapsible) */}
                  {user?.role === "SUPER_ADMIN" && (
                    <details className="group">
                      <summary className="cursor-pointer flex items-center justify-between px-3 py-2.5 bg-surface-2 rounded-lg text-sm font-medium text-ink list-none hover:bg-surface-subtle transition-colors">
                        <span>📊 Хронология денег</span>
                        <span className="text-ink-3 group-open:rotate-180 transition-transform text-xs">▾</span>
                      </summary>
                      <div className="pt-3 px-1">
                        <FinanceTimeline bookingId={booking.id} />
                      </div>
                    </details>
                  )}

                  {/* Связанные расходы (SA only, collapsible) */}
                  {user?.role === "SUPER_ADMIN" && (
                    <details className="group">
                      <summary className="cursor-pointer flex items-center justify-between px-3 py-2.5 bg-surface-2 rounded-lg text-sm font-medium text-ink list-none hover:bg-surface-subtle transition-colors">
                        <span>🛒 Связанные расходы</span>
                        <span className="text-ink-3 group-open:rotate-180 transition-transform text-xs">▾</span>
                      </summary>
                      <div className="pt-3 px-1">
                        <RelatedExpenses bookingId={booking.id} />
                      </div>
                    </details>
                  )}

                  {/* WAREHOUSE finance note */}
                  {user?.role === "WAREHOUSE" && (
                    <div className="text-xs text-ink-3 bg-accent-soft border border-accent-border rounded-lg px-3 py-2">
                      <strong className="text-accent-bright">Доступ склада:</strong> только наличные/карта · до 100 000 ₽ за операцию
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Данные заказа */}
            <div className="rounded-lg border border-border bg-surface shadow-xs overflow-hidden">
              <div className="p-3 border-b border-border bg-surface-subtle">
                <p className="eyebrow">Данные заказа</p>
              </div>
              <div className="p-3 text-sm text-ink space-y-2">
                <div>
                  <span className="text-ink-3">Клиент:</span> <span className="font-medium">{booking.client.name}</span>
                </div>
                <div>
                  <span className="text-ink-3">Проект:</span>{" "}
                  {booking.projectName?.trim() === "Проект" ? (
                    <span className="font-medium text-ink-3">Без названия</span>
                  ) : (
                    <span className="font-medium">{booking.projectName}</span>
                  )}
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
              </div>
            </div>

            {/* Доступ в клиентский кабинет — только для SUPER_ADMIN */}
            {user?.role === "SUPER_ADMIN" && booking.client?.id && (
              <ClientPortalAccessCard
                clientId={booking.client.id}
                defaultEmail={booking.client.email ?? null}
              />
            )}

            {booking.estimate ? (
              <div className="rounded-lg border border-border bg-surface shadow-xs overflow-hidden">
                <div className="p-3 border-b border-border bg-surface-subtle flex items-center justify-between">
                  <p className="eyebrow">Смета (только оборудование)</p>
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
                  {((booking.vehicles?.length ?? 0) > 0 || Boolean(booking.vehicleId)) &&
                    Number(booking.transportSubtotalRub ?? "0") > 0 && (
                      <div className="text-xs text-ink-3 rounded bg-surface-subtle px-2 py-1.5">
                        Без транспорта. Полная сумма к оплате — в блоке «Финансы» выше
                        ({formatMoneyRub(booking.finalAmount ?? "0")}).
                      </div>
                    )}

                  <div className="space-y-2 no-print">
                    {/* Equipment-only smeta */}
                    <div>
                      <p className="text-xs text-ink-3 mb-1.5">Только оборудование:</p>
                      <div className="flex gap-2">
                        <button
                          className="flex-1 rounded border border-border px-3 py-2 text-sm hover:bg-surface-muted transition-colors"
                          onClick={() =>
                            download(
                              `/api/estimates/${booking.estimate!.id}/export/xlsx`,
                              `estimate-${booking.estimate!.id}.xlsx`,
                            )
                          }
                        >
                          📊 Excel
                        </button>
                        <button
                          className="flex-1 rounded border border-border px-3 py-2 text-sm hover:bg-surface-muted transition-colors"
                          onClick={() =>
                            download(
                              `/api/estimates/${booking.estimate!.id}/export/pdf`,
                              `estimate-${booking.estimate!.id}.pdf`,
                            )
                          }
                        >
                          📄 PDF
                        </button>
                      </div>
                    </div>
                    {/* Full smeta — includes transport. Highlighted as primary action. */}
                    <div>
                      <p className="text-xs text-ink-3 mb-1.5">Полная смета (с транспортом):</p>
                      <div className="flex gap-2 flex-wrap">
                        <button
                          className="flex-1 min-w-[80px] rounded border border-border px-3 py-2 text-sm hover:bg-surface-muted transition-colors"
                          onClick={() =>
                            download(
                              `/api/bookings/${booking.id}/full-estimate/export/xlsx`,
                              `booking-${booking.id}-full.xlsx`,
                            )
                          }
                        >
                          📊 Excel
                        </button>
                        <button
                          className="flex-1 min-w-[80px] rounded bg-accent-bright text-white px-3 py-2 text-sm hover:bg-accent transition-colors"
                          onClick={() =>
                            download(
                              `/api/bookings/${booking.id}/full-estimate/export/pdf`,
                              `booking-${booking.id}-full.pdf`,
                            )
                          }
                        >
                          📄 PDF
                        </button>
                        <button
                          className="flex-1 min-w-[80px] rounded border border-border px-3 py-2 text-sm hover:bg-surface-muted transition-colors"
                          onClick={() =>
                            download(
                              `/api/bookings/${booking.id}/full-estimate.xml`,
                              `booking-${booking.id}.xml`,
                            )
                          }
                          title="Выгрузка для 1С и учётных систем"
                        >
                          ⟨/⟩ XML
                        </button>
                        <button
                          className="flex-1 min-w-[80px] rounded border border-border px-3 py-2 text-sm hover:bg-surface-muted transition-colors"
                          onClick={() => window.print()}
                        >
                          🖨 Печать
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Позиции сметы показаны выше в таблице «Позиции брони»
                      (с ценами/суммами) — здесь не дублируем. */}
                  <div className="text-xs text-ink-3 border-t border-border pt-2">
                    Состав позиций — в таблице «Позиции брони» (с ценами).
                  </div>

                  {booking.estimate.commentSnapshot ? <div className="text-xs text-ink-3">{booking.estimate.commentSnapshot}</div> : null}
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-surface-subtle p-3 text-sm text-ink-2">
                Смета пока не сформирована (возможно, это черновик).
              </div>
            )}
            <AddonEstimateSection bookingId={booking.id} />
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
          {/* ₽ Платёж — primary */}
          {(user?.role === "SUPER_ADMIN" ||
            ((booking.status === "ISSUED" || booking.status === "RETURNED") &&
              (booking.amountOutstanding == null || Number(booking.amountOutstanding) > 0))
          ) && (
            <button
              className="flex-1 rounded bg-accent-bright text-white px-2 py-2.5 text-sm font-medium hover:opacity-90 transition-opacity"
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
            📄 Счёт
          </button>
          {/* PDF Акт */}
          {(() => {
            const canAct = booking.status === "RETURNED" && Number(booking.amountOutstanding ?? "0") === 0;
            const actHint = "Акт доступен после возврата оборудования и закрытия долга";
            return (
              <button
                className={`flex-1 rounded border px-2 py-2.5 text-sm font-medium transition-colors ${
                  canAct ? "border-border hover:bg-surface-subtle" : "border-border text-ink-3 opacity-50 cursor-not-allowed"
                }`}
                title={canAct ? "Скачать акт PDF" : actHint}
                aria-label={canAct ? "Скачать акт PDF" : actHint}
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

