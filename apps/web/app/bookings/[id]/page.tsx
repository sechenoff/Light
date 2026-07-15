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
import { useRetroEdit } from "../../../src/components/bookings/useRetroEdit";
import {
  BookingFinancePanel,
  type InvoiceItem,
} from "../../../src/components/bookings/BookingFinancePanel";
import { BookingHero } from "../../../src/components/bookings/BookingHero";
import { BookingTransportSection } from "../../../src/components/bookings/BookingTransportSection";
import { BookingScanSection } from "../../../src/components/bookings/BookingScanSection";
import { BookingEstimateSection } from "../../../src/components/bookings/BookingEstimateSection";
import { BookingJournalSection } from "../../../src/components/bookings/BookingJournalSection";
import { BookingItemsTable } from "../../../src/components/bookings/BookingItemsTable";
import { RetroDiffSummary } from "../../../src/components/bookings/RetroDiffSummary";
import { BookingOrderInfoSection } from "../../../src/components/bookings/BookingOrderInfoSection";
import { BookingMobileCta } from "../../../src/components/bookings/BookingMobileCta";
import { readBookingsListHref } from "../../../src/components/bookings/bookingsListNav";
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
      window.location.href = readBookingsListHref();
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

          {/* Hero + финансовые карточки + печатная шапка — вынесено в BookingHero (фаза 4.10).
              Экранная часть скрыта в retro-режиме, печатная — рендерится всегда. */}
          <BookingHero booking={booking} showHero={!retroEditMode} />

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 print-booking">
          {/* Таблица позиций — вынесена в BookingItemsTable (фаза 4.10). */}
          <BookingItemsTable
            booking={booking}
            retroEditMode={retroEditMode}
            retroItems={retroEdits.items}
            onOpenPicker={() => setRetroPickerOpen(true)}
            onUpdateQty={updateRetroItemQty}
            onToggleDeleted={toggleRetroItemDeleted}
          />

          <div className="lg:col-span-4 space-y-4">
            {/* Сводка правок retro-режима — вынесена в RetroDiffSummary (фаза 4.10). */}
            {retroEditMode && <RetroDiffSummary booking={booking} retroEdits={retroEdits} />}

            {/* Транспорт и сканирование — вынесены в компоненты (фаза 4.10). */}
            <BookingTransportSection
              bookingId={booking.id}
              vehicles={booking.vehicles}
              userRole={user?.role}
              retroEditMode={retroEditMode}
              retroVehicles={retroEdits.vehicles}
              onUpdateRetroVehicle={updateRetroVehicle}
              onDriverUpdated={(vehicleRowId, next) => {
                setBooking((prev) =>
                  prev
                    ? {
                        ...prev,
                        vehicles: prev.vehicles?.map((veh) =>
                          veh.id === vehicleRowId
                            ? { ...veh, driverName: next.driverName, driverPhone: next.driverPhone }
                            : veh,
                        ),
                      }
                    : prev,
                );
              }}
            />
            <BookingScanSection
              bookingId={booking.id}
              bookingStatus={booking.status}
              scanSessions={booking.scanSessions}
            />

            {/* ── ФИНАНСЫ ── вынесено в BookingFinancePanel (фаза 4.7);
                модалки остаются на этой странице и открываются через dispatch. */}
            <BookingFinancePanel
              booking={booking}
              userRole={user?.role}
              isArchived={isArchived}
              invoices={invoices}
              invoicesError={invoicesError}
              dispatch={dispatchFinanceModal}
              onDownload={download}
              onReloadInvoices={loadInvoices}
              onDownloadInvoicePdf={downloadInvoicePdf}
            />

            {/* Данные заказа — вынесено в BookingOrderInfoSection (фаза 4.10). */}
            <BookingOrderInfoSection
              booking={booking}
              canChangeClient={
                user?.role === "SUPER_ADMIN" && booking.status !== "PENDING_APPROVAL" && !isArchived
              }
              onChangeClient={() => setChangeClientOpen(true)}
            />

            {/* Доступ в клиентский кабинет — только для SUPER_ADMIN */}
            {user?.role === "SUPER_ADMIN" && booking.client?.id && (
              <ClientPortalAccessCard
                clientId={booking.client.id}
                defaultEmail={booking.client.email ?? null}
              />
            )}

            {/* Смета и журнал изменений — вынесены в компоненты (фаза 4.10). */}
            <BookingEstimateSection
              booking={booking}
              onDownload={download}
              onDownloadEstimateFallback={downloadEstimatePdfWithFallback}
            />
            <AddonEstimateSection bookingId={booking.id} />
            <BookingJournalSection financeEvents={booking.financeEvents} />
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
      {/* Mobile sticky CTA — вынесено в BookingMobileCta (фаза 4.10). */}
      <BookingMobileCta
        booking={booking}
        userRole={user?.role}
        isArchived={isArchived}
        dispatch={dispatchFinanceModal}
        onDownload={download}
      />

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

