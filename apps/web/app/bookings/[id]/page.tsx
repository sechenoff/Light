"use client";

import { useEffect, useReducer, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

import { apiFetch, apiFetchRaw } from "../../../src/lib/api";
import { getFileNameFromContentDisposition } from "../../../src/lib/download";
import { StatusPill } from "../../../src/components/StatusPill";
import { SectionHeader } from "../../../src/components/SectionHeader";
import { formatMoneyRub, formatRub } from "../../../src/lib/format";
import { useCurrentUser } from "../../../src/hooks/useCurrentUser";
import { EquipmentPickerModal } from "../../../src/components/bookings/EquipmentPickerModal";
import { RetroDiffPanel } from "../../../src/components/bookings/RetroDiffPanel";
import { ChangeClientModal } from "../../../src/components/bookings/ChangeClientModal";
import { ApprovalTimeline } from "../../../src/components/bookings/ApprovalTimeline";
import { ApprovalReviewView } from "../../../src/components/bookings/ApprovalReviewView";
import { BookingHeader } from "../../../src/components/bookings/BookingHeader";
import { useBookingLifecycle } from "../../../src/components/bookings/useBookingLifecycle";
import { useExtendRental } from "../../../src/components/bookings/useExtendRental";
import {
  financeModalInitialState,
  financeModalReducer,
} from "../../../src/components/bookings/financeModalReducer";
import {
  useRetroEdit,
  type RetroEditItem,
} from "../../../src/components/bookings/useRetroEdit";
import { toast } from "../../../src/components/ToastProvider";
import {
  bookingStatusLabel as statusText,
  bookingStatusVariant as statusVariant,
} from "../../../src/lib/bookingConstants";
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
  /** Soft-delete: бронь в архиве. Когда задано — все действия read-only. */
  deletedAt?: string | null;
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
  /** Ручной override итоговой суммы. `null` → автоматический расчёт. */
  manualFinalAmount?: string | null;
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
    /** Аннулирование: платёж помечен voidedAt (direction/status не меняются). */
    voidedAt?: string | null;
    voidReason?: string | null;
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
    vehicle?: {
      id: string;
      name: string;
      slug: string;
      /** Текущий пробег (актуальное значение для подсказки «было N км») */
      currentMileage?: number;
    } | null;
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

function paymentMethodLabel(method: string | null): string {
  switch (method) {
    case "CASH": return "Наличные";
    case "CARD": return "Карта";
    case "BANK_TRANSFER": return "Перевод";
    case "OTHER": return "Другое";
    default: return method ?? "—";
  }
}

export default function BookingDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [booking, setBooking] = useState<BookingDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { user } = useCurrentUser();
  const [changeClientOpen, setChangeClientOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState<null | "submit" | "instant">(null);
  // Фаза 4.5: шесть финансовых модалок — один reducer вместо шести useState.
  const [financeModals, dispatchFinanceModal] = useReducer(
    financeModalReducer,
    financeModalInitialState,
  );
  const [invoices, setInvoices] = useState<InvoiceItem[]>([]);
  const [invoicesError, setInvoicesError] = useState(false);
  // F-EXTEND: продление выданной (ISSUED) брони — инлайн-поле новой даты возврата.
  // F-EXTEND: повторная отправка на согласование правленной CONFIRMED-брони (WAREHOUSE).
  const [resubmitBusy, setResubmitBusy] = useState(false);

  // Ретро-редактирование закрытой брони (SUPER_ADMIN + RETURNED) вынесено в
  // useRetroEdit (фаза 4.6). JSX ретро-режима остаётся ниже (вплетён в
  // основную таблицу позиций) и читает состояние/обработчики из хука.
  const {
    retroEditMode,
    retroEdits,
    setRetroEdits,
    retroBusy,
    retroPickerOpen,
    setRetroPickerOpen,
    enterRetroEdit,
    cancelRetroEdit,
    updateRetroVehicle,
    updateRetroItemQty,
    toggleRetroItemDeleted,
    addRetroItemFromEquipment,
    saveRetroEdit,
  } = useRetroEdit({ booking, reloadBooking });

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

  // BD-1 / BD-4: переходы жизненного цикла (issue/return/cancel) вынесены в
  // useBookingLifecycle (фаза 4.3). Отмена при наличии оплаты открывает модалку
  // распоряжения депозитом.
  const { lifecycleBusy, runLifecycleAction } = useBookingLifecycle({
    bookingId: id,
    booking,
    reloadBooking,
    onCancelWithDeposit: () => dispatchFinanceModal({ type: "openCancelDeposit" }),
  });

  async function archiveBooking() {
    if (!id) return;
    // BD-2: у не-терминальной брони (резерв/выдача) архивация снимет резервы и
    // вернёт оборудование в доступные — предупреждаем об этом явно.
    const st = booking?.status;
    const hasActiveEquipment = st === "CONFIRMED" || st === "ISSUED" || st === "PENDING_APPROVAL";
    const baseMsg = "Бронь пропадёт из списка, но останется в БД — её можно вернуть из /bookings/archive.";
    const equipMsg =
      st === "ISSUED"
        ? "\n\n⚠ Оборудование сейчас ВЫДАНО. При архивации резервы будут сняты, а единицы вернутся в «доступные», хотя физически они у клиента. Обычно сначала оформляют возврат. Точно в архив?"
        : "\n\n⚠ У брони есть зарезервированное оборудование. При архивации резервы будут сняты и единицы вернутся в «доступные».";
    if (!confirm(`Отправить бронь в архив?\n\n${baseMsg}${hasActiveEquipment ? equipMsg : ""}`)) return;
    try {
      const res = await apiFetch<{ freedUnits?: number }>(`/api/bookings/${id}`, { method: "DELETE" });
      const freed = res?.freedUnits ?? 0;
      toast.success(freed > 0 ? `Бронь в архиве · освобождено единиц: ${freed}` : "Бронь отправлена в архив");
      window.location.href = "/bookings";
    } catch (e: any) {
      toast.error(e?.message ?? "Не удалось архивировать бронь");
    }
  }

  // F-EXTEND (1): продление выданной брони вынесено в useExtendRental (фаза 4.4).
  const {
    extendOpen,
    extendEndDate,
    extendBusy,
    openExtend,
    submitExtend,
    cancelExtend,
    setExtendEndDate,
  } = useExtendRental({ booking, reloadBooking });

  /**
   * F-EXTEND (2): WAREHOUSE правил уже подтверждённую бронь и хочет отправить её
   * на повторное согласование. Бэкенд-переход CONFIRMED → PENDING_APPROVAL
   * реализует кластер C-BOOK-API. Пока submit-for-approval принимает только
   * DRAFT — сервер вернёт 409, показываем тостом. Если сервер вернёт бронь в
   * PENDING_APPROVAL — состояние обновится и страница переключится на экран
   * согласования (для SA) или покажет баннер «на согласовании».
   */
  async function resubmitForApproval() {
    if (!booking || resubmitBusy) return;
    if (!confirm("Отправить изменённую бронь на повторное согласование руководителю?")) return;
    setResubmitBusy(true);
    try {
      const data = await apiFetch<{ booking: BookingDetail }>(
        `/api/bookings/${booking.id}/submit-for-approval`,
        { method: "POST" },
      );
      setBooking(data.booking);
      toast.success("Бронь отправлена на повторное согласование");
    } catch (e: any) {
      toast.error(e?.message ?? "Не удалось отправить на согласование");
    } finally {
      setResubmitBusy(false);
    }
  }

  // Бронь в архиве — все мутации заблокированы на бэкенде (BOOKING_ARCHIVED),
  // на фронте показываем read-only баннер и прячем кнопки действий.
  const isArchived = Boolean(booking?.deletedAt);

  // Только SUPER_ADMIN видит retro-edit-кнопку на закрытой (и не архивной) броне.
  const canRetroEdit =
    user?.role === "SUPER_ADMIN" && booking?.status === "RETURNED" && !isArchived;

  async function loadInvoices() {
    if (!id) return;
    try {
      const data = await apiFetch<{ items: InvoiceItem[] }>(`/api/invoices?bookingId=${id}`);
      setInvoices(data.items);
      setInvoicesError(false);
    } catch {
      // Сбой загрузки счетов больше не выглядит как «счетов нет» — показываем
      // ошибку, чтобы оператор не создал дубликат счёта по ошибке.
      setInvoicesError(true);
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

  /**
   * Экспорт сметы, когда снапшота ещё нет (старый черновик). Новые черновики
   * создаются сразу с MAIN-сметой — для них рендерится полный блок экспорта.
   * У старых черновиков без сметы full-estimate отвечает 404
   * MAIN_ESTIMATE_NOT_FOUND — вместо alert показываем понятный тост.
   */
  async function downloadEstimatePdfWithFallback() {
    if (!booking) return;
    try {
      const res = await apiFetchRaw(`/api/bookings/${booking.id}/full-estimate/export/pdf`, {
        method: "GET",
        credentials: "include",
      });
      if (!res.ok) {
        toast.error("Смета ещё не сформирована — сохраните бронь");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const disposition = res.headers.get("content-disposition") ?? "";
      a.download = getFileNameFromContentDisposition(disposition, `booking-${booking.id}-full.pdf`);
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error("Смета ещё не сформирована — сохраните бронь");
    }
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

  /**
   * SA-шорткат «Согласовать сразу»: DRAFT → PENDING_APPROVAL → CONFIRMED двумя
   * последовательными вызовами (submit-for-approval, затем approve). Прямой
   * POST /:id/confirm для веба закрыт (409 USE_APPROVAL_FLOW), а цепочка
   * сохраняет обе аудит-записи (BOOKING_SUBMITTED + BOOKING_APPROVED).
   * Если approve падает (например, конфликт доступности) — бронь остаётся в
   * PENDING_APPROVAL, страница сама переключится на экран согласования, где
   * SA увидит конфликты и сможет отклонить или поправить.
   */
  async function handleApproveNow() {
    if (!booking) return;
    if (
      !confirm(
        "Согласовать бронь сразу?\n\nБронь будет отправлена на согласование и тут же одобрена: статус станет «Подтверждено», оборудование будет зарезервировано.",
      )
    )
      return;
    setActionBusy("instant");
    try {
      const submitted = await apiFetch<{ booking: BookingDetail }>(
        `/api/bookings/${booking.id}/submit-for-approval`,
        { method: "POST" },
      );
      setBooking(submitted.booking);
      try {
        const approved = await apiFetch<{ booking: BookingDetail }>(
          `/api/bookings/${booking.id}/approve`,
          { method: "POST" },
        );
        setBooking(approved.booking);
        toast.success("Бронь согласована и подтверждена, оборудование зарезервировано");
      } catch (e: any) {
        toast.error(
          `Бронь отправлена на согласование, но одобрить не удалось: ${e?.message ?? "ошибка"}`,
        );
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Не удалось отправить на согласование");
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
      {/* Parent top-bar — hidden when ApprovalReviewView is rendered; that view brings its own header.
          Сам заголовок брони отрисован ниже в Hero-секции (по мокапу v2) — здесь только
          breadcrumb-style ссылки и action-кнопки, чтобы не было дубля заголовка. */}
      {!showApprovalView && (
        <BookingHeader
          bookingId={id}
          booking={booking}
          userRole={user?.role}
          isArchived={isArchived}
          retroEditMode={retroEditMode}
          canRetroEdit={canRetroEdit}
          lifecycleBusy={lifecycleBusy}
          resubmitBusy={resubmitBusy}
          extendOpen={extendOpen}
          extendEndDate={extendEndDate}
          extendBusy={extendBusy}
          onLifecycleAction={runLifecycleAction}
          onArchive={archiveBooking}
          onResubmit={resubmitForApproval}
          onEnterRetroEdit={enterRetroEdit}
          onOpenExtend={openExtend}
          onChangeExtendDate={setExtendEndDate}
          onSubmitExtend={submitExtend}
          onCancelExtend={cancelExtend}
        />
      )}

      {loading ? (
        <div className="mt-4 text-ink-3">Загрузка...</div>
      ) : err ? (
        <div className="mt-4 text-rose">{err}</div>
      ) : booking ? (
        booking.status === "PENDING_APPROVAL" && user?.role === "SUPER_ADMIN" ? (
          <>
            {/* Экран согласования (ApprovalReviewView) даёт только «Одобрить»/
                «Отклонить»/«Редактировать». Но сервер разрешает cancel из
                PENDING_APPROVAL, а руководителю бывает нужно сразу отменить
                бронь (клиент отказался) или отправить в архив, не выдумывая
                причину отклонения. Плюс показываем уже полученную оплату —
                депозит мог быть записан ещё на DRAFT и на экране согласования
                финансы иначе не видны. */}
            {!isArchived && (
              <div className="mb-3 flex flex-wrap items-center justify-end gap-2 no-print">
                {Number(booking.amountPaid ?? "0") > 0 && (
                  <span className="mr-auto text-xs text-ink-3">
                    Уже оплачено:{" "}
                    <span className="mono-num text-ink-2">
                      {formatMoneyRub(booking.amountPaid ?? "0")}
                    </span>
                  </span>
                )}
                <button
                  type="button"
                  disabled={lifecycleBusy}
                  onClick={() => runLifecycleAction("cancel")}
                  className="rounded border border-rose-border text-rose px-3 py-1.5 text-sm hover:bg-rose-soft transition-colors disabled:opacity-40"
                >
                  Отменить бронь
                </button>
                <button
                  type="button"
                  onClick={archiveBooking}
                  className="rounded border border-rose-border text-rose px-3 py-1.5 text-sm hover:bg-rose-soft transition-colors"
                  title="Отправить в архив (можно восстановить из /bookings/archive)"
                >
                  В архив
                </button>
              </div>
            )}
            {/* Модалка распоряжения депозитом при отмене — runLifecycleAction
                открывает её, когда amountPaid > 0. Основной экземпляр живёт в
                ветке обычного вида ниже, но она там не смонтирована при
                showApprovalView, поэтому дублируем здесь. */}
            <CancelWithDepositModal
              open={financeModals.cancelDepositOpen}
              onClose={() => dispatchFinanceModal({ type: "closeCancelDeposit" })}
              bookingId={booking.id}
              bookingDisplayName={booking.displayName ?? booking.projectName}
              clientId={booking.client.id}
              clientName={booking.client.name}
              depositTotal={Number(booking.amountPaid ?? "0")}
              onCancelled={() => { dispatchFinanceModal({ type: "closeCancelDeposit" }); reloadBooking(); }}
            />
            <ApprovalReviewView
              booking={booking}
              onReload={() => {
                // Перезагрузка через общий apiFetch-хелпер (проверяет res.ok,
                // парсит ошибки, идёт через прокси с X-API-Key). Раньше был raw
                // fetch с пустым .catch — сбой оставлял устаревшее состояние молча.
                reloadBooking().catch((e) =>
                  toast.error(e instanceof Error ? e.message : "Не удалось обновить бронь"),
                );
              }}
              currentUser={user!}
            />
          </>
        ) : (
        <div className={`mt-4 ${retroEditMode ? "pb-24" : ""}`}>
          {retroEditMode && (
            <div className="mb-4 rounded-lg border border-amber-border bg-amber-soft px-4 py-3 flex items-start gap-3 no-print">
              <span className="text-lg" aria-hidden>⚠</span>
              <div className="flex-1">
                <p className="text-sm font-semibold text-amber">Режим редактирования закрытой брони</p>
                <p className="mt-1 text-xs text-ink-2">
                  Изменения попадут в аудит-лог как{" "}
                  <span className="font-mono">BOOKING_RETROACTIVE_EDIT</span>. Сметы и счёт-факты
                  не перевыпускаются автоматически — после сохранения проверьте финансы.
                </p>
                <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3 max-w-3xl">
                  <label className="block">
                    <span className="eyebrow block mb-1">Проект</span>
                    <input
                      type="text"
                      value={retroEdits.projectName ?? ""}
                      onChange={(e) => setRetroEdits((s) => ({ ...s, projectName: e.target.value }))}
                      className="w-full rounded border border-amber-border bg-white px-2 py-1 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-amber"
                    />
                  </label>
                  <label className="block md:col-span-2">
                    <span className="eyebrow block mb-1">Комментарий гафера</span>
                    <textarea
                      rows={2}
                      value={retroEdits.comment ?? ""}
                      onChange={(e) => setRetroEdits((s) => ({ ...s, comment: e.target.value }))}
                      className="w-full rounded border border-amber-border bg-white px-2 py-1 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-amber resize-y"
                    />
                  </label>
                  <label className="block">
                    <span className="eyebrow block mb-1">Скидка, %</span>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={0.5}
                      value={retroEdits.discountPercent ?? ""}
                      onChange={(e) =>
                        setRetroEdits((s) => ({
                          ...s,
                          discountPercent: e.target.value === "" ? null : Number(e.target.value),
                        }))
                      }
                      className="w-32 mono-num rounded border border-amber-border bg-white px-2 py-1 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-amber"
                    />
                    {booking.discountPercent != null && (
                      <span className="block mt-1 text-xs text-ink-3">
                        Было {Number(booking.discountPercent)}%
                      </span>
                    )}
                  </label>
                  {/*
                    Ручной override итоговой суммы. Используется когда фактическая
                    сумма по итогам переговоров отличается от автомата сметы.
                    Пустое поле → null → автопересчёт. Сохраняется в Booking.
                    manualFinalAmount. recomputeBookingFinance подставляет это
                    значение в finalAmount.
                  */}
                  <label className="block md:col-span-3 mt-2 pt-3 border-t border-amber-border/40">
                    <span className="eyebrow block mb-1">Итог брони, ₽ (ручной override)</span>
                    <div className="flex items-center gap-2 flex-wrap">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={retroEdits.manualFinalAmount ?? ""}
                        onChange={(e) =>
                          setRetroEdits((s) => ({ ...s, manualFinalAmount: e.target.value }))
                        }
                        placeholder={`автомат: ${formatMoneyRub(booking.finalAmount ?? "0")}`}
                        className="w-56 mono-num rounded border border-amber-border bg-white px-2 py-1 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-amber"
                      />
                      {(retroEdits.manualFinalAmount ?? "").trim() !== "" && (
                        <button
                          type="button"
                          onClick={() => setRetroEdits((s) => ({ ...s, manualFinalAmount: "" }))}
                          className="text-xs text-accent-bright hover:text-accent"
                          title="Очистить override — итог вернётся к автоматическому расчёту"
                        >
                          ↺ Сбросить (вернуть автомат)
                        </button>
                      )}
                    </div>
                    <span className="block mt-1 text-xs text-ink-3">
                      Пустое поле — итог считается автоматически (
                      <span className="mono-num">{formatMoneyRub(booking.finalAmount ?? "0")}</span>
                      ). Заполните, если фактическая сумма по итогам переговоров отличается от сметы.
                      {booking.manualFinalAmount != null && (
                        <span className="text-amber">
                          {" "}Сейчас override активен:{" "}
                          <span className="mono-num">{formatMoneyRub(booking.manualFinalAmount)}</span>.
                        </span>
                      )}
                    </span>
                  </label>
                </div>
                <p className="mt-3 text-xs text-ink-3">
                  Прямо на этой странице правятся: проект, комментарий, скидка, итог (override),
                  состав и количество позиций — в таблице «Позиции брони» ниже (кнопка
                  «+ Добавить позицию», ✕ для удаления), а также водители и пробег транспорта.
                  Даты брони и расчётные параметры транспорта (часы, км) задним числом не меняются.
                </p>
              </div>
            </div>
          )}

          {isArchived && (
            <div className="mb-4 rounded border-l-4 border-amber bg-amber-soft px-4 py-3 text-sm text-ink no-print">
              <div className="eyebrow mb-1 text-amber">Бронь в архиве</div>
              <div>
                Эта бронь удалена из основного списка и доступна только для чтения.
                Действия (редактирование, платежи, смена статуса) заблокированы.
              </div>
              <Link
                href="/bookings/archive"
                className="mt-2 inline-block text-xs text-accent-bright hover:text-accent font-medium"
              >
                Восстановить из архива →
              </Link>
            </div>
          )}

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

          {/* NB: для SA + PENDING_APPROVAL страница целиком заменяется на
              ApprovalReviewView (ветка выше) — контекст согласования
              (конфликты доступности, долг клиента) и кнопки «Одобрить»/
              «Отклонить» живут там, здесь их дублей нет. */}

          {user?.role === "SUPER_ADMIN" && (
            <ApprovalTimeline bookingId={booking.id} />
          )}

          <div className="mb-4 flex flex-wrap gap-2">
            {!isArchived && booking.status === "DRAFT" && (user?.role === "WAREHOUSE" || user?.role === "SUPER_ADMIN") && (
              <button
                type="button"
                onClick={handleSubmitForApproval}
                disabled={actionBusy !== null}
                className="rounded bg-accent-bright px-4 py-2 text-sm text-white hover:bg-accent-bright/90 disabled:opacity-50"
              >
                {actionBusy === "submit" ? "Отправляю…" : "Отправить на согласование"}
              </button>
            )}
            {/* SA согласует сам с собой: один клик вместо двух экранов.
                Для WAREHOUSE кнопки нет — его брони одобряет руководитель. */}
            {!isArchived && booking.status === "DRAFT" && user?.role === "SUPER_ADMIN" && (
              <button
                type="button"
                onClick={handleApproveNow}
                disabled={actionBusy !== null}
                className="rounded bg-emerald px-4 py-2 text-sm text-white hover:bg-emerald/90 disabled:opacity-50"
              >
                {actionBusy === "instant" ? "Согласовываю…" : "✓ Согласовать сразу"}
              </button>
            )}
          </div>

          <ChangeClientModal
            open={changeClientOpen}
            bookingId={booking.id}
            currentClientId={booking.client.id}
            currentClientName={booking.client.name}
            onClose={() => setChangeClientOpen(false)}
            onSuccess={() => { setChangeClientOpen(false); reloadBooking(); }}
          />

          {/* Finance Phase 2 modals */}
          <CreateInvoiceModal
            open={financeModals.createInvoiceOpen}
            onClose={() => dispatchFinanceModal({ type: "closeCreateInvoice" })}
            defaultBookingId={booking.id}
            defaultTotal={booking.finalAmount ?? undefined}
            onCreated={() => { dispatchFinanceModal({ type: "closeCreateInvoice" }); loadInvoices(); }}
          />
          <RefundModal
            open={!!financeModals.refundInvoiceId}
            onClose={() => dispatchFinanceModal({ type: "closeRefund" })}
            invoiceId={financeModals.refundInvoiceId ?? undefined}
            bookingId={booking.id}
            onSuccess={() => { dispatchFinanceModal({ type: "closeRefund" }); reloadBooking(); }}
          />
          <CancelWithDepositModal
            open={financeModals.cancelDepositOpen}
            onClose={() => dispatchFinanceModal({ type: "closeCancelDeposit" })}
            bookingId={booking.id}
            bookingDisplayName={booking.displayName ?? booking.projectName}
            clientId={booking.client.id}
            clientName={booking.client.name}
            depositTotal={Number(booking.amountPaid ?? "0")}
            onCancelled={() => { dispatchFinanceModal({ type: "closeCancelDeposit" }); reloadBooking(); }}
          />
          <CreditNoteApplyModal
            open={financeModals.creditNoteOpen}
            onClose={() => dispatchFinanceModal({ type: "closeCreditNote" })}
            bookingId={booking.id}
            clientId={booking.client.id}
            onApplied={() => { dispatchFinanceModal({ type: "closeCreditNote" }); reloadBooking(); }}
          />

          {/* ───────── Hero + Finance strip ────────────────────────────────────
              По мокапу docs/mockups/booking-detail-v2.html: первый блок
              страницы — крупный заголовок брони (eyebrow + проект + пилы +
              мета), под ним полоса из 4 финансовых карточек. Это «лицо»
              страницы.

              В retro-edit режиме скрываем (пользователь работает с формами).
          */}
          {!retroEditMode && (() => {
            const startD = new Date(booking.startDate);
            const endD = new Date(booking.endDate);
            const tz = { timeZone: "Europe/Moscow" } as const;
            const heroDate = startD.toLocaleDateString("ru-RU", {
              day: "2-digit", month: "long", year: "numeric", ...tz,
            });
            const project =
              booking.projectName?.trim() && booking.projectName.trim() !== "Проект"
                ? booking.projectName.trim()
                : "Без названия";
            // Кол-во смен (приблизительно: целые сутки между startDate и endDate)
            const msPerDay = 24 * 60 * 60 * 1000;
            const shifts = Math.max(1, Math.ceil((endD.getTime() - startD.getTime()) / msPerDay));
            const periodStr =
              startD.toLocaleDateString("ru-RU", { day: "2-digit", month: "short", ...tz }) +
              " – " +
              endD.toLocaleDateString("ru-RU", { day: "2-digit", month: "short", ...tz });

            // Платёжный статус → пилка (отдельная функция)
            const payStatus = booking.paymentStatus ?? "NOT_PAID";
            const payLabel =
              payStatus === "PAID" ? "Оплачено"
              : payStatus === "PARTIALLY_PAID" ? "Частично"
              : payStatus === "OVERDUE" ? "Просрочено"
              : "Не оплачено";
            const payVariant: "ok" | "warn" | "alert" | "none" =
              payStatus === "PAID" ? "ok"
              : payStatus === "OVERDUE" ? "alert"
              : payStatus === "PARTIALLY_PAID" ? "warn"
              : "none";

            const total = booking.finalAmount ?? "0";
            const paid = booking.amountPaid ?? "0";
            const outstanding = booking.amountOutstanding ?? "0";
            const discountPct = booking.discountPercent ? Number(booking.discountPercent) : 0;
            const discountAmount = booking.discountAmount ?? "0";

            // Финансовые карточки — стили под мокап. Цветовая семантика:
            //  • Оплачено → emerald, если PAID; иначе нейтральный
            //  • Остаток → rose, если OVERDUE; иначе нейтральный
            //  • Итого / Скидка — нейтральные.
            const paidCardTone = payStatus === "PAID" ? "fin--ok" : "";
            const outstandingTone =
              payStatus === "OVERDUE" ? "fin--alert" : "";

            return (
              <>
                <section className="mb-5 no-print">
                  <p className="eyebrow text-ink-3">Бронь · {heroDate}</p>
                  <h1 className="mt-1 font-cond text-3xl md:text-4xl leading-tight tracking-tight text-ink">
                    {project}
                  </h1>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-ink-3">
                    <StatusPill variant={statusVariant(booking.status)} label={statusText(booking.status)} />
                    <StatusPill variant={payVariant} label={payLabel} />
                    <span className="text-border-strong">·</span>
                    <span>{booking.client.name}</span>
                    <span className="text-border-strong">·</span>
                    <span className="mono-num">
                      {periodStr} · {shifts} {shifts === 1 ? "смена" : shifts < 5 ? "смены" : "смен"}
                    </span>
                  </div>
                </section>

                <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5 no-print">
                  <div className="rounded-lg border border-border bg-surface shadow-xs p-3">
                    <p className="eyebrow">
                      Итого
                      {booking.manualFinalAmount != null && (
                        <span className="ml-1.5 align-middle inline-block bg-amber text-white text-[9px] px-1 py-0.5 rounded font-semibold tracking-wide">
                          РУЧНОЙ
                        </span>
                      )}
                    </p>
                    <p className="mt-1.5 font-cond text-2xl font-semibold mono-num text-ink">
                      {formatMoneyRub(total)}
                    </p>
                    <p className="mt-0.5 text-[11px] text-ink-3">
                      {booking.manualFinalAmount != null
                        ? "override SUPER_ADMIN'а — автомат не применяется"
                        : "оборудование + транспорт − скидка"}
                    </p>
                  </div>
                  <div className={`rounded-lg border shadow-xs p-3 ${paidCardTone ? "border-emerald-border bg-gradient-to-b from-emerald-soft to-surface" : "border-border bg-surface"}`}>
                    <p className="eyebrow">Оплачено</p>
                    <p className={`mt-1.5 font-cond text-2xl font-semibold mono-num ${paidCardTone ? "text-emerald" : "text-ink"}`}>
                      {formatMoneyRub(paid)}
                    </p>
                    <p className="mt-0.5 text-[11px] text-ink-3">
                      {payStatus === "PAID" ? "100% оплачено" : "по платежам"}
                    </p>
                  </div>
                  <div className={`rounded-lg border shadow-xs p-3 ${outstandingTone ? "border-rose-border bg-gradient-to-b from-rose-soft to-surface" : "border-border bg-surface"}`}>
                    <p className="eyebrow">Остаток</p>
                    <p className={`mt-1.5 font-cond text-2xl font-semibold mono-num ${outstandingTone ? "text-rose" : Number(outstanding) === 0 ? "text-ink-3" : "text-ink"}`}>
                      {formatMoneyRub(outstanding)}
                    </p>
                    <p className="mt-0.5 text-[11px] text-ink-3">
                      {payStatus === "OVERDUE" ? "просрочен" : Number(outstanding) === 0 ? "ничего не должны" : "к оплате"}
                    </p>
                  </div>
                  <div className="rounded-lg border border-border bg-surface shadow-xs p-3">
                    <p className="eyebrow">Скидка</p>
                    <p className="mt-1.5 font-cond text-2xl font-semibold mono-num text-rose">
                      {discountPct > 0 ? `−${discountPct}%` : "—"}
                    </p>
                    <p className="mt-0.5 text-[11px] text-ink-3">
                      {discountPct > 0 ? `−${formatMoneyRub(discountAmount)}` : "не применялась"}
                    </p>
                  </div>
                </section>
              </>
            );
          })()}

          {/*
            Печатная шапка-реквизиты. Видна ТОЛЬКО при печати через @media print
            (`.print-only-block { display:none }` по умолчанию → `display:block`
            в print-блоке ниже). На экране не должна занимать пиксели.
          */}
          <div className="print-only-block">
            <div className="print-header">
              <div className="print-header-inner">
                <div>
                  <div className="print-org">Светобаза · аренда осветительного оборудования</div>
                  <div className="print-org-sub">
                    ИП Сеченов В.А. · ИНН 7700000000 · +7 (495) 123-45-67 · svetobazarent.ru
                  </div>
                </div>
                <div className="print-doc">
                  <div>Смета к броне</div>
                  <div className="print-doc-num">
                    № {booking.id.slice(0, 8)}… от {new Date().toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" })}
                  </div>
                </div>
              </div>
              <div className="print-hero">
                <div className="print-eyebrow">
                  Бронь · {new Date(booking.startDate).toLocaleDateString("ru-RU", { day: "2-digit", month: "long", year: "numeric", timeZone: "Europe/Moscow" })}
                </div>
                <h1 className="print-title">{booking.projectName}</h1>
                <div className="print-meta">
                  <span>{statusText(booking.status)}</span>
                  {booking.paymentStatus && <span> · {(() => {
                    switch (booking.paymentStatus) {
                      case "PAID": return "Оплачено";
                      case "PARTIALLY_PAID": return "Частично оплачено";
                      case "OVERDUE": return "Просрочено";
                      default: return "Не оплачено";
                    }
                  })()}</span>}
                  <span> · {booking.client.name}</span>
                </div>
              </div>
            </div>
          </div>

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
            // В retro-edit добавляется столбец «✕» (delete) + цены в таблице отображаются read-only.
            const colCount = (showPrices ? 5 : 3) + (retroEditMode ? 1 : 0);
            // Источник правды для рендера: либо живые items, либо retro-edits.
            // В retro-edits сохранены original quantities — нужно для подсветки изменений.
            const displayItems = retroEditMode && retroEdits.items
              ? retroEdits.items
              : booking.items.map((it) => ({
                  id: it.id,
                  equipmentId: it.equipmentId,
                  equipment: it.equipment,
                  customName: it.customName ?? null,
                  customCategory: it.customCategory ?? null,
                  quantity: it.quantity,
                  originalQuantity: it.quantity,
                  _deleted: false,
                  _added: false,
                }));
            return (
              <div className="lg:col-span-8 rounded-lg border border-border bg-surface shadow-xs overflow-hidden">
                <div className="p-3 border-b border-border bg-surface-subtle flex items-center justify-between">
                  <p className="eyebrow">Позиции брони ({displayItems.filter((i) => !(i as any)._deleted).length})</p>
                  {retroEditMode && (
                    <button
                      type="button"
                      onClick={() => setRetroPickerOpen(true)}
                      className="rounded border border-amber-border bg-amber-soft text-amber px-2.5 py-1 text-xs font-medium hover:bg-amber hover:text-white transition-colors no-print"
                    >
                      + Добавить позицию
                    </button>
                  )}
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
                        {retroEditMode && <th className="px-3 py-2 w-[40px] no-print"></th>}
                      </tr>
                    </thead>
                    <tbody>
                      {displayItems.map((it) => {
                        const price =
                          (it.equipmentId ? priceByEquipmentId.get(it.equipmentId) : undefined) ??
                          priceByName.get(it.equipment?.name ?? it.customName ?? "");
                        const anyIt = it as RetroEditItem;
                        const qtyChanged =
                          retroEditMode &&
                          anyIt.originalQuantity !== undefined &&
                          anyIt.quantity !== anyIt.originalQuantity &&
                          !anyIt._added;
                        const rowClass = anyIt._deleted
                          ? "border-t border-border bg-rose-soft"
                          : anyIt._added
                            ? "border-t border-border bg-emerald-soft"
                            : qtyChanged
                              ? "border-t border-border bg-amber-soft"
                              : "border-t border-border";
                        return (
                          <tr key={it.id} className={rowClass}>
                            <td className="px-3 py-2 text-ink-2">{it.equipment?.category ?? it.customCategory ?? "—"}</td>
                            <td className="px-3 py-2">
                              <div className={`font-medium text-ink ${anyIt._deleted ? "line-through text-ink-3" : ""}`}>
                                {it.equipment?.name ?? it.customName ?? "—"}
                              </div>
                              <div className="text-xs text-ink-3">
                                {it.equipment?.brand ? it.equipment.brand : ""} {it.equipment?.model ? `· ${it.equipment.model}` : ""}
                                {qtyChanged && (
                                  <span className="text-amber ml-1">
                                    · было {anyIt.originalQuantity} → стало {anyIt.quantity}
                                  </span>
                                )}
                                {anyIt._added && <span className="text-emerald ml-1">· новая позиция</span>}
                                {anyIt._deleted && <span className="text-rose ml-1">· к удалению</span>}
                              </div>
                            </td>
                            <td className="px-3 py-2 text-right mono-num">
                              {retroEditMode ? (
                                <input
                                  type="number"
                                  min={0}
                                  step={1}
                                  value={anyIt.quantity}
                                  disabled={anyIt._deleted}
                                  onChange={(e) =>
                                    updateRetroItemQty(it.id, Number(e.target.value) || 0)
                                  }
                                  className="w-16 text-right rounded border border-amber-border bg-white px-1 py-0.5 mono-num text-sm focus:outline-none focus:ring-1 focus:ring-amber disabled:bg-rose-soft disabled:text-ink-3"
                                />
                              ) : (
                                <span className="font-medium">{it.quantity}</span>
                              )}
                            </td>
                            {showPrices && (
                              <td className="px-3 py-2 text-right mono-num text-ink-2">
                                {price ? formatMoneyRub(price.unitPrice) : "—"}
                              </td>
                            )}
                            {showPrices && (
                              <td className={`px-3 py-2 text-right mono-num font-medium ${qtyChanged ? "text-amber" : "text-ink"}`}>
                                {price
                                  ? retroEditMode && !anyIt._deleted
                                    // Live-пересчёт суммы строки при правке кол-ва:
                                    // цена за смену × текущее кол-во (бэкенд пересчитает
                                    // окончательно на сохранении, но оператор видит эффект сразу).
                                    ? formatMoneyRub(String(Number(price.unitPrice) * anyIt.quantity))
                                    : formatMoneyRub(price.lineSum)
                                  : "—"}
                              </td>
                            )}
                            {retroEditMode && (
                              <td className="px-3 py-2 text-center no-print">
                                <button
                                  type="button"
                                  onClick={() => toggleRetroItemDeleted(it.id)}
                                  aria-label={anyIt._deleted ? "Вернуть строку" : "Удалить строку"}
                                  title={anyIt._deleted ? "Вернуть строку" : "Удалить строку"}
                                  className={`text-base ${anyIt._deleted ? "text-accent-bright hover:text-accent" : "text-rose hover:text-rose/80"}`}
                                >
                                  {anyIt._deleted ? "↩" : "✕"}
                                </button>
                              </td>
                            )}
                          </tr>
                        );
                      })}
                      {displayItems.length === 0 ? (
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
            {/* RetroDiffPanel — видна только в retro-режиме. В САМОМ верху
                правой колонки, чтобы оператор всегда видел сводку своих
                правок без необходимости скроллить.
            */}
            {retroEditMode && (() => {
              // Подсчитываем agg'и из текущего retroEdits state.
              const items = retroEdits.items ?? [];
              const vehicles = retroEdits.vehicles ?? [];
              const itemsAdded = items.filter((i) => i._added && !i._deleted).length;
              const itemsRemoved = items.filter((i) => i._deleted && !i._added).length;
              const itemsQtyChanged = items.filter(
                (i) =>
                  !i._added &&
                  !i._deleted &&
                  i.originalQuantity !== undefined &&
                  i.quantity !== i.originalQuantity,
              ).length;
              const vehiclesDriverChanged = vehicles.filter(
                (v) =>
                  v.driverName !== v.originalDriverName ||
                  v.driverPhone !== v.originalDriverPhone,
              ).length;
              const vehiclesMileageChanged = vehicles.filter((v) => {
                const t = v.endMileage.trim();
                if (t === "") return false;
                const n = Number.parseInt(t, 10);
                return Number.isFinite(n) && n !== v.originalCurrentMileage;
              }).length;
              return (
                <RetroDiffPanel
                  originalProjectName={booking.projectName}
                  editedProjectName={retroEdits.projectName}
                  originalComment={booking.comment ?? ""}
                  editedComment={retroEdits.comment ?? ""}
                  originalDiscountPercent={booking.discountPercent ? Number(booking.discountPercent) : null}
                  editedDiscountPercent={retroEdits.discountPercent ?? null}
                  originalManualFinalAmount={booking.manualFinalAmount ?? null}
                  editedManualFinalAmount={retroEdits.manualFinalAmount ?? ""}
                  autoFinalAmount={booking.finalAmount ?? "0"}
                  itemsAdded={itemsAdded}
                  itemsRemoved={itemsRemoved}
                  itemsQtyChanged={itemsQtyChanged}
                  vehiclesDriverChanged={vehiclesDriverChanged}
                  vehiclesMileageChanged={vehiclesMileageChanged}
                />
              );
            })()}
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
                  {retroEditMode ? (
                    /*
                      В retro-режиме показываем кастомную inline-форму:
                      driverName / driverPhone / endMileage. Сохраняется
                      централизованно через PATCH /api/bookings/:id с
                      retroactive:true. VehicleDriverRow в retro-mode не
                      используется — у него отдельный endpoint для warehouse
                      kiosk и он не вписывается в общий save flow.
                    */
                    (retroEdits.vehicles ?? []).map((rv) => {
                      const original = booking.vehicles!.find((v) => v.id === rv.bookingVehicleId);
                      return (
                        <div
                          key={rv.bookingVehicleId}
                          className="rounded-lg border border-amber-border bg-amber-soft/40 p-3 space-y-2"
                        >
                          <div className="flex items-baseline justify-between">
                            <p className="text-sm font-medium text-ink">{rv.vehicleName}</p>
                            <span className="text-xs text-ink-3 mono-num">
                              {original?.shiftHours ? `${original.shiftHours} ч` : ""}
                              {original?.kmOutsideMkad ? ` · ${original.kmOutsideMkad} км вне МКАД` : ""}
                            </span>
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                            <label className="block">
                              <span className="eyebrow block mb-1">Водитель</span>
                              <input
                                type="text"
                                value={rv.driverName}
                                onChange={(e) =>
                                  updateRetroVehicle(rv.bookingVehicleId, { driverName: e.target.value })
                                }
                                className="w-full rounded border border-amber-border bg-white px-2 py-1 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-amber"
                                placeholder="ФИО"
                              />
                            </label>
                            <label className="block">
                              <span className="eyebrow block mb-1">Телефон</span>
                              <input
                                type="text"
                                value={rv.driverPhone}
                                onChange={(e) =>
                                  updateRetroVehicle(rv.bookingVehicleId, { driverPhone: e.target.value })
                                }
                                className="w-full rounded border border-amber-border bg-white px-2 py-1 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-amber mono-num"
                                placeholder="+7 (XXX) XXX-XX-XX"
                              />
                            </label>
                            <label className="block">
                              <span className="eyebrow block mb-1">Пробег после смены, км</span>
                              <input
                                type="number"
                                min={rv.originalCurrentMileage}
                                step={1}
                                value={rv.endMileage}
                                onChange={(e) =>
                                  updateRetroVehicle(rv.bookingVehicleId, { endMileage: e.target.value })
                                }
                                placeholder={`≥ ${rv.originalCurrentMileage}`}
                                className="w-full rounded border border-amber-border bg-white px-2 py-1 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-amber mono-num"
                              />
                              <span className="block mt-1 text-xs text-ink-3">
                                было {rv.originalCurrentMileage.toLocaleString("ru-RU")} км
                              </span>
                            </label>
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    booking.vehicles!.map((v) => (
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
                    ))
                  )}
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
                    {/* Записать платёж: SA всегда; WH при ISSUED|RETURNED. Не для архивных. */}
                    {!isArchived && (user?.role === "SUPER_ADMIN" ||
                      (user?.role === "WAREHOUSE" &&
                        (booking.status === "ISSUED" || booking.status === "RETURNED") &&
                        (booking.amountOutstanding == null || Number(booking.amountOutstanding) > 0))
                    ) && (
                      <button
                        className="rounded bg-accent-bright text-white px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity"
                        onClick={() => dispatchFinanceModal({ type: "openPayment" })}
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
                          onClick={() => dispatchFinanceModal({ type: "openCancelDeposit" })}
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
                          onClick={() => dispatchFinanceModal({ type: "openCreateInvoice" })}
                          className="text-[11px] px-2 py-1 bg-accent-bright text-white rounded hover:opacity-90"
                        >
                          + Создать счёт
                        </button>
                      </div>
                      {invoicesError ? (
                        <div className="text-xs text-rose py-2">
                          Не удалось загрузить счета.{" "}
                          <button type="button" onClick={() => loadInvoices()} className="underline hover:text-rose/80">
                            Повторить
                          </button>
                        </div>
                      ) : invoices.length === 0 ? (
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
                                            onClick={() => dispatchFinanceModal({ type: "openRefund", invoiceId: inv.id })}
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
                        onClick={() => dispatchFinanceModal({ type: "openCreditNote" })}
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
                          // Аннулирование пишет voidedAt (paymentService.voidPayment);
                          // direction остаётся INCOME — никакого значения "VOID" в
                          // enum PaymentDirection нет. Сервер исключает voided из
                          // сумм (recomputeBookingFinance), здесь — только отображение.
                          const isVoided = Boolean(p.voidedAt);
                          return (
                            <div
                              key={p.id}
                              className={`flex items-center justify-between gap-2 py-2.5 text-sm ${isVoided ? "opacity-60" : ""}`}
                            >
                              <div className="min-w-0">
                                <span className={isVoided ? "line-through" : ""}>
                                  <span className={`font-semibold mono-num ${isVoided ? "text-ink-3" : "text-emerald"}`}>
                                    +{formatMoneyRub(p.amount)}
                                  </span>
                                  <span className="text-ink-3 mx-1.5">·</span>
                                  <span className={isVoided ? "text-ink-3" : "text-ink-2"}>{paymentMethodLabel(p.method)}</span>
                                  {p.note && <span className="text-xs text-ink-3 ml-1.5 truncate">{p.note}</span>}
                                </span>
                                <div className="text-xs text-ink-3 mt-0.5">
                                  {p.receivedAt ? new Date(p.receivedAt).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" }) : "—"}
                                </div>
                                {isVoided && (
                                  <div className="text-xs text-rose mt-0.5">
                                    Аннулирован{p.voidReason ? `: ${p.voidReason}` : ""}
                                  </div>
                                )}
                              </div>
                              {!isVoided && user?.role === "SUPER_ADMIN" && (
                                <div className="flex gap-1.5 shrink-0">
                                  <button
                                    className="text-xs text-rose border border-rose-border rounded px-2 py-0.5 hover:bg-rose-soft transition-colors"
                                    onClick={() => dispatchFinanceModal({ type: "openVoidPayment", paymentId: p.id })}
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
                <div className="flex items-center gap-2">
                  <span className="text-ink-3">Клиент:</span>{" "}
                  <span className="font-medium">{booking.client.name}</span>
                  {user?.role === "SUPER_ADMIN" && booking.status !== "PENDING_APPROVAL" && !isArchived && (
                    <button
                      type="button"
                      aria-label="Сменить клиента"
                      onClick={() => setChangeClientOpen(true)}
                      className="ml-1 rounded border border-border px-2 py-0.5 text-xs text-ink-3 hover:bg-surface-soft hover:text-ink transition-colors"
                    >
                      Сменить
                    </button>
                  )}
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
              <div className="rounded-lg border border-border bg-surface-subtle p-3 text-sm text-ink-2 space-y-2">
                <div>Смета пока не сформирована (возможно, это черновик).</div>
                {/* CTA вместо тупика: у новых черновиков MAIN-смета создаётся
                    сразу (тогда выше рендерится полный блок экспорта); у старых
                    без сметы сервер ответит 404 MAIN_ESTIMATE_NOT_FOUND — покажем
                    понятный тост вместо молчаливой заглушки. */}
                <button
                  type="button"
                  className="rounded border border-border bg-surface px-3 py-2 text-sm hover:bg-surface-muted transition-colors no-print"
                  onClick={downloadEstimatePdfWithFallback}
                >
                  📄 Скачать смету (PDF)
                </button>
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

          {/* Подписи — только в печати, А4-friendly */}
          <div className="print-only-block">
            <div className="print-signatures">
              <div className="sig-block">
                <strong>Исполнитель</strong>
                <div>ИП Сеченов В.А.</div>
                <div className="sig-line">подпись · дата</div>
              </div>
              <div className="sig-block">
                <strong>Заказчик</strong>
                <div>{booking.client.name}</div>
                <div className="sig-line">подпись · дата</div>
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
          {/* ₽ Платёж — primary. Не для архивных. */}
          {!isArchived && (user?.role === "SUPER_ADMIN" ||
            ((booking.status === "ISSUED" || booking.status === "RETURNED") &&
              (booking.amountOutstanding == null || Number(booking.amountOutstanding) > 0))
          ) && (
            <button
              className="flex-1 rounded bg-accent-bright text-white px-2 py-2.5 text-sm font-medium hover:opacity-90 transition-opacity"
              onClick={() => dispatchFinanceModal({ type: "openPayment" })}
            >
              ₽ Платёж
            </button>
          )}
          {/* PDF Счёт — только legacy-финансы (как на десктопе). У Phase-2
              броней легаси-invoice.pdf отдаёт 409/неверный PDF. */}
          {booking.legacyFinance !== false && (
            <button
              className="flex-1 rounded border border-border px-2 py-2.5 text-sm font-medium hover:bg-surface-subtle transition-colors"
              onClick={() => download(`/api/bookings/${booking.id}/invoice.pdf`, `Счёт_${booking.id}.pdf`)}
            >
              📄 Счёт
            </button>
          )}
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
          open={financeModals.paymentOpen}
          onClose={() => dispatchFinanceModal({ type: "closePayment" })}
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
            dispatchFinanceModal({ type: "closePayment" });
            reloadBooking();
          }}
        />
      )}

      {/*
        Sticky save-bar — виден только в retro-edit режиме. Показывает короткое
        summary («что изменится») и две кнопки. Высота резервируется в
        контейнере выше через pb-24 чтобы не перекрывать контент.
      */}
      {/* z-50 (выше плавающей кнопки фидбэка z-40), чтобы FAB не перехватывал
          клик по «Сохранить»; pr на actions-группе уводит кнопки левее FAB. */}
      {retroEditMode && (
        <div className="fixed bottom-0 left-0 right-0 z-50 bg-surface border-t-2 border-amber shadow-lg no-print">
          <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3 text-sm">
              <span className="text-amber" aria-hidden>⚠</span>
              <div>
                <p className="font-semibold text-amber">Ретро-редактирование</p>
                <p className="text-xs text-ink-3">
                  Запись будет помечена как <span className="font-mono">BOOKING_RETROACTIVE_EDIT</span> в аудит-логе.
                </p>
              </div>
            </div>
            <div className="flex gap-2 pr-16 sm:pr-0">
              <button
                type="button"
                onClick={cancelRetroEdit}
                disabled={retroBusy}
                className="rounded border border-border bg-surface px-4 py-2 text-sm text-ink-2 hover:bg-surface-muted disabled:opacity-50"
              >
                Отменить
              </button>
              <button
                type="button"
                onClick={saveRetroEdit}
                disabled={retroBusy}
                className="rounded bg-amber text-white px-4 py-2 text-sm font-semibold hover:bg-amber/90 disabled:opacity-50"
              >
                {retroBusy ? "Сохраняем..." : "Сохранить изменения"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Equipment picker для retro-edit: добавление новой позиции в RETURNED-бронь */}
      <EquipmentPickerModal
        open={retroPickerOpen}
        onPick={addRetroItemFromEquipment}
        onClose={() => setRetroPickerOpen(false)}
      />

      {/* VoidPaymentModal — T11 */}
      <VoidPaymentModal
        open={financeModals.voidPaymentId !== null}
        paymentId={financeModals.voidPaymentId}
        onClose={() => dispatchFinanceModal({ type: "closeVoidPayment" })}
        onVoided={() => {
          dispatchFinanceModal({ type: "closeVoidPayment" });
          reloadBooking();
        }}
      />

      <style jsx global>{`
        /* По умолчанию печатные элементы скрыты на экране */
        .print-only-block { display: none; }

        @media print {
          @page { size: A4; margin: 14mm; }
          html, body { background: #fff !important; color: #000 !important; font-size: 11pt; }

          /* Скрываем всё */
          body * { visibility: hidden; }

          /* Печатаем только print-booking + print-only-block */
          .print-booking, .print-booking *,
          .print-only-block, .print-only-block * {
            visibility: visible;
          }

          .print-only-block { display: block; }
          .print-booking,
          .print-only-block.print-signatures-wrapper {
            position: static;
          }

          /* Хорошая полиграфия для шапки */
          .print-header {
            border-bottom: 2px solid #000;
            padding-bottom: 4mm;
            margin-bottom: 6mm;
          }
          .print-header-inner {
            display: flex;
            justify-content: space-between;
            align-items: flex-end;
          }
          .print-org {
            font-family: "IBM Plex Sans Condensed", "Helvetica Neue", sans-serif;
            font-weight: 700;
            font-size: 14pt;
          }
          .print-org-sub {
            font-size: 9pt;
            color: #444;
            margin-top: 2pt;
          }
          .print-doc {
            text-align: right;
            font-size: 10pt;
          }
          .print-doc-num {
            font-family: "IBM Plex Mono", ui-monospace, monospace;
            font-weight: 600;
          }
          .print-hero { margin-top: 4mm; }
          .print-eyebrow {
            font-family: "IBM Plex Sans Condensed", sans-serif;
            font-weight: 600;
            font-size: 9pt;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            color: #444;
          }
          .print-title {
            font-family: "IBM Plex Sans Condensed", sans-serif;
            font-weight: 600;
            font-size: 18pt;
            margin-top: 1mm;
          }
          .print-meta {
            font-size: 10pt;
            color: #222;
            margin-top: 2mm;
          }

          /* Подписи в конце */
          .print-signatures {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 24mm;
            margin-top: 14mm;
            break-inside: avoid;
            page-break-inside: avoid;
          }
          .sig-block { font-size: 10pt; }
          .sig-block > strong { display: block; }
          .sig-line {
            border-top: 1px solid #000;
            margin-top: 18mm;
            padding-top: 2pt;
            font-size: 9pt;
            color: #444;
          }

          /* Снижаем декоративные эффекты, чтобы экономить тонер */
          .shadow-xs, .shadow-sm, .shadow-md { box-shadow: none !important; }
          .bg-amber-soft, .bg-rose-soft, .bg-emerald-soft, .bg-accent-soft {
            background: #fff !important;
          }
          /* Карточкам — простая чёрная рамка */
          .print-booking .border, .print-booking [class*="border-"] {
            border-color: #999 !important;
          }
          /* Цветные пилы → чёрно-белые контуры */
          .print-booking .pill, .print-booking [class*="pill--"] {
            background: #fff !important;
            color: #000 !important;
            border: 1px solid #999 !important;
          }

          .no-print { display: none !important; }
        }
      `}</style>
    </div>
  );
}

