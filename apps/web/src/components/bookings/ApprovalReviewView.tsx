"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

import { apiFetch } from "../../lib/api";
import { formatMoneyRub } from "../../lib/format";
import { StatusPill } from "../StatusPill";
import { RoleBadge } from "../RoleBadge";
import { RejectBookingModal } from "./RejectBookingModal";
import { toast } from "../ToastProvider";
import type { CurrentUser } from "../../lib/auth";

// ------------------------------------------------------------------ types ---

type EstimateLine = {
  id: string;
  equipmentId: string | null;
  categorySnapshot: string;
  nameSnapshot: string;
  brandSnapshot: string | null;
  modelSnapshot: string | null;
  quantity: number;
  unitPrice: string;
  lineSum: string;
};

type BookingForReview = {
  id: string;
  status: string;
  projectName: string;
  displayName?: string;
  startDate: string;
  endDate: string;
  comment: string | null;
  discountPercent: string | null;
  totalEstimateAmount?: string | null;
  discountAmount?: string | null;
  finalAmount?: string | null;
  client: { id: string; name: string; phone: string | null; email: string | null; comment: string | null };
  items: Array<{
    id: string;
    equipmentId: string | null;
    quantity: number;
    equipment: {
      id: string;
      name: string;
      category: string;
      brand: string | null;
      model: string | null;
      rentalRatePerShift: string;
      totalQuantity: number;
      availableQuantity: number;
    } | null;
  }>;
  estimate?: null | {
    id: string;
    shifts: number;
    subtotal: string;
    discountPercent: string | null;
    discountAmount: string;
    totalAfterDiscount: string;
    lines: EstimateLine[];
  };
  // Transport snapshot
  vehicleId?: string | null;
  vehicleWithGenerator?: boolean;
  vehicleShiftHours?: string | null;
  vehicleSkipOvertime?: boolean;
  vehicleKmOutsideMkad?: number | null;
  vehicleTtkEntry?: boolean;
  transportSubtotalRub?: string | null;
  vehicle?: { id: string; name: string; slug: string } | null;
};

type AuditItem = {
  id: string;
  userId: string;
  action: string;
  createdAt: string;
  after: Record<string, unknown> | null;
  user?: { username: string; role?: string | null } | null;
};

// --------------------------------------------------------------- helpers ---

const REVIEW_ACTIONS = new Set([
  "BOOKING_SUBMITTED",
  "BOOKING_APPROVED",
  "BOOKING_REJECTED",
  "BOOKING_EDITED_IN_REVIEW",
]);

function actionLabel(action: string): string {
  switch (action) {
    case "BOOKING_SUBMITTED": return "Отправлено на согласование";
    case "BOOKING_APPROVED": return "Одобрено";
    case "BOOKING_REJECTED": return "Отклонено";
    case "BOOKING_EDITED_IN_REVIEW": return "Изменено руководителем";
    default: return action;
  }
}

function actionDotClass(action: string): string {
  switch (action) {
    case "BOOKING_APPROVED": return "bg-emerald";
    case "BOOKING_REJECTED": return "bg-rose";
    case "BOOKING_EDITED_IN_REVIEW": return "bg-accent";
    default: return "bg-amber";
  }
}

function formatDateRange(start: string, end: string): string {
  const fmt = (s: string) =>
    new Date(s).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  return `${fmt(start)} — ${fmt(end)}`;
}

function submitterLabel(role: string | null | undefined): string {
  switch (role) {
    case "SUPER_ADMIN": return "отправлено руководителем";
    case "WAREHOUSE": return "отправлено кладовщиком";
    case "TECHNICIAN": return "отправлено техником";
    default: return "отправлено";
  }
}

function formatTs(iso: string): string {
  try {
    return new Date(iso).toLocaleString("ru-RU", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------- main component ---

type Props = {
  booking: BookingForReview;
  onReload: () => void;
  currentUser: CurrentUser;
};

/**
 * Read-only summary of a PENDING_APPROVAL booking for the SUPER_ADMIN to
 * approve or reject. For edits, a "Редактировать" button navigates to the
 * full /bookings/:id/edit page (same UI as /bookings/new).
 *
 * No inline editing here — this is purely a confirmation screen.
 */
export function ApprovalReviewView({ booking, onReload: _onReload, currentUser: _currentUser }: Props) {
  const router = useRouter();

  // Approval actions state
  const [approving, setApproving] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectBusy, setRejectBusy] = useState(false);

  // Audit timeline
  const [auditItems, setAuditItems] = useState<AuditItem[] | null>(null);

  // ---- fetch audit timeline ----
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/audit?entityType=Booking&entityId=${encodeURIComponent(booking.id)}&limit=100`, {
      credentials: "include",
    })
      .then(async (res) => {
        if (cancelled || !res.ok) return;
        const data = (await res.json()) as { items: AuditItem[] };
        const filtered = (data.items ?? [])
          .filter((it) => REVIEW_ACTIONS.has(it.action))
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        if (!cancelled) setAuditItems(filtered);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [booking.id]);

  // ---- approve / reject ----
  async function handleApprove() {
    setApproving(true);
    try {
      await apiFetch(`/api/bookings/${booking.id}/approve`, { method: "POST" });
      toast.success("Заявка подтверждена, оборудование зарезервировано");
      router.push(`/bookings/${booking.id}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Не удалось одобрить бронь";
      toast.error(msg);
      setApproving(false);
    }
  }

  async function handleReject(reason: string) {
    setRejectBusy(true);
    try {
      await apiFetch(`/api/bookings/${booking.id}/reject`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
      toast.success("Заявка отклонена, возвращена кладовщику");
      router.push("/bookings");
    } catch (e: unknown) {
      setRejectBusy(false);
      throw e; // let modal show inline error
    }
  }

  const actionsBusy = approving || rejectBusy;

  // Group estimate lines by category for display
  const lines: EstimateLine[] = booking.estimate?.lines ?? [];
  const hasEstimate = lines.length > 0;
  const linesByCategory = new Map<string, EstimateLine[]>();
  for (const ln of lines) {
    const list = linesByCategory.get(ln.categorySnapshot) ?? [];
    list.push(ln);
    linesByCategory.set(ln.categorySnapshot, list);
  }

  // Derive submitter role from first BOOKING_SUBMITTED audit event
  const submitterRole = auditItems
    ? (auditItems.find((it) => it.action === "BOOKING_SUBMITTED")?.user?.role ?? null)
    : null;

  // Transport display
  const hasTransport = Boolean(booking.vehicleId && booking.transportSubtotalRub);
  const transportName = booking.vehicle?.name ?? null;

  // ----------------------------------------------------------------------- render ---

  const title = booking.displayName
    ?? `${booking.client.name} · проект «${booking.projectName}»`;

  return (
    <div>
      {/* Breadcrumb + status + role pills */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm">
          <Link href="/bookings" className="text-ink-3 hover:text-ink">
            ← Брони
          </Link>
          <span className="text-ink-3">/</span>
          <span className="text-ink-2 truncate max-w-[280px]">{title}</span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <StatusPill variant="warn" label="На согласовании" />
          <RoleBadge role="SUPER_ADMIN" />
        </div>
      </div>

      {/* Hero — title, dates, + Edit + Reject + Approve buttons */}
      <div className="mb-5 rounded-lg border border-amber-border bg-amber-soft px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-ink truncate">{title}</h1>
            <p className="mt-1 text-sm text-ink-2">
              {formatDateRange(booking.startDate, booking.endDate)}
              {" · "}
              <span className="text-ink-3">{submitterLabel(submitterRole)}</span>
            </p>
          </div>
          <div className="flex gap-2 shrink-0 flex-wrap">
            <Link
              href={`/bookings/${booking.id}/edit`}
              className="rounded border border-border bg-surface px-4 py-2 text-sm text-ink-2 hover:bg-surface-muted"
            >
              ✎ Редактировать
            </Link>
            <button
              type="button"
              disabled={actionsBusy}
              onClick={() => setRejectOpen(true)}
              className="rounded border border-rose px-4 py-2 text-sm text-rose hover:bg-rose-soft disabled:opacity-50"
            >
              ✕ Отклонить
            </button>
            <button
              type="button"
              disabled={actionsBusy}
              onClick={handleApprove}
              className="rounded bg-emerald px-4 py-2 text-sm text-white hover:bg-emerald/90 disabled:opacity-50"
            >
              {approving ? "Подтверждаю…" : "✓ Подтвердить и зарезервировать"}
            </button>
          </div>
        </div>
      </div>

      {/* Two-column grid */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_320px]">
        {/* Left column */}
        <div className="flex flex-col gap-3.5">
          {/* Meta card */}
          <div className="rounded-lg border border-border bg-surface shadow-xs overflow-hidden">
            <div className="border-b border-border bg-surface-subtle px-4 py-2.5">
              <p className="eyebrow">Данные заказа</p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 p-4 text-sm">
              <div>
                <div className="eyebrow mb-1">Клиент</div>
                <div className="font-medium text-ink">{booking.client.name}</div>
                {booking.client.phone && (
                  <div className="text-xs text-ink-3">{booking.client.phone}</div>
                )}
              </div>
              <div>
                <div className="eyebrow mb-1">Проект</div>
                {booking.projectName === "Проект" ? (
                  <div className="font-medium text-ink-3">Без названия</div>
                ) : (
                  <div className="font-medium text-ink">{booking.projectName}</div>
                )}
              </div>
              <div>
                <div className="eyebrow mb-1">Период</div>
                <div className="font-medium text-ink">
                  {new Date(booking.startDate).toLocaleDateString("ru-RU")} —{" "}
                  {new Date(booking.endDate).toLocaleDateString("ru-RU")}
                </div>
              </div>
            </div>
          </div>

          {/* Equipment card — read-only table */}
          <div className="rounded-lg border border-border bg-surface shadow-xs overflow-hidden">
            <div className="border-b border-border bg-surface-subtle px-4 py-2.5">
              <p className="eyebrow">
                Оборудование
                {hasEstimate && booking.estimate && booking.estimate.shifts > 1 && (
                  <span className="ml-2 font-normal text-ink-3">· {booking.estimate.shifts} смен</span>
                )}
              </p>
            </div>
            {!hasEstimate ? (
              <div className="px-4 py-6 text-center text-sm text-ink-3">Нет позиций</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-sm">
                  <thead>
                    <tr className="border-b border-border bg-surface-subtle/50 text-xs text-ink-2">
                      <th className="px-4 py-2 text-left font-medium">Наименование</th>
                      <th className="px-4 py-2 text-right font-medium w-28">Цена/день</th>
                      <th className="px-4 py-2 text-center font-medium w-20">Кол-во</th>
                      <th className="px-4 py-2 text-right font-medium w-28">Сумма</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from(linesByCategory.entries()).map(([cat, catLines]) => (
                      <>
                        <tr key={`cat-${cat}`} className="border-t border-border bg-surface-subtle">
                          <td colSpan={4} className="px-4 py-1 text-[11px] font-semibold uppercase tracking-wider text-ink-3">
                            {cat}
                          </td>
                        </tr>
                        {catLines.map((ln) => (
                          <tr key={ln.id} className="border-t border-border">
                            <td className="px-4 py-2 text-ink font-medium">{ln.nameSnapshot}</td>
                            <td className="px-4 py-2 text-right mono-num text-ink-2">{formatMoneyRub(ln.unitPrice)} ₽</td>
                            <td className="px-4 py-2 text-center mono-num text-ink">{ln.quantity}</td>
                            <td className="px-4 py-2 text-right mono-num font-medium text-ink">{formatMoneyRub(ln.lineSum)} ₽</td>
                          </tr>
                        ))}
                      </>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Transport card */}
          <div className="rounded-lg border border-border bg-surface shadow-xs overflow-hidden">
            <div className="border-b border-border bg-surface-subtle px-4 py-2.5">
              <p className="eyebrow">Транспорт</p>
            </div>
            {!hasTransport ? (
              <div className="p-4 text-sm text-ink-3">Не выбран</div>
            ) : (
              <div className="p-4 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-medium text-ink">
                      {transportName ?? "Транспорт"}
                      {booking.vehicleWithGenerator && (
                        <span className="ml-2 rounded bg-amber-soft px-1.5 py-0.5 text-[11px] text-amber">+ генератор</span>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-ink-3 space-x-2">
                      {booking.vehicleShiftHours && <span>{Number(booking.vehicleShiftHours)} ч.</span>}
                      {booking.vehicleSkipOvertime && <span>· без переработки</span>}
                      {booking.vehicleKmOutsideMkad && Number(booking.vehicleKmOutsideMkad) > 0 && (
                        <span>· {booking.vehicleKmOutsideMkad} км за МКАД</span>
                      )}
                      {booking.vehicleTtkEntry && <span>· ТТК</span>}
                    </div>
                  </div>
                  <div className="mono-num text-ink font-medium whitespace-nowrap">
                    {formatMoneyRub(booking.transportSubtotalRub ?? "0")} ₽
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Comment card */}
          {booking.comment && (
            <div className="rounded-lg border border-border bg-surface shadow-xs overflow-hidden">
              <div className="border-b border-border bg-surface-subtle px-4 py-2.5">
                <p className="eyebrow">Комментарий кладовщика</p>
              </div>
              <div className="p-4 text-sm text-ink whitespace-pre-wrap">{booking.comment}</div>
            </div>
          )}

          {/* History / Timeline card */}
          <div className="rounded-lg border border-border bg-surface shadow-xs overflow-hidden">
            <div className="border-b border-border bg-surface-subtle px-4 py-2.5">
              <p className="eyebrow">История согласования</p>
            </div>
            {!auditItems || auditItems.length === 0 ? (
              <div className="p-4 text-sm text-ink-3">Нет событий</div>
            ) : (
              <ol className="divide-y divide-border px-4 py-1">
                {auditItems.map((it) => {
                  const reason =
                    it.action === "BOOKING_REJECTED" && it.after && typeof (it.after as { rejectionReason?: unknown }).rejectionReason === "string"
                      ? (it.after as { rejectionReason: string }).rejectionReason
                      : null;
                  const username = it.user?.username ?? it.userId;
                  return (
                    <li key={it.id} className="flex items-start gap-3 py-2">
                      <span
                        aria-hidden="true"
                        className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${actionDotClass(it.action)}`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="text-sm font-semibold text-ink">{actionLabel(it.action)}</span>
                          <span className="text-xs text-ink-3">{formatTs(it.createdAt)}</span>
                        </div>
                        <div className="text-xs text-ink-2">{username}</div>
                        {reason && (
                          <div className="mt-1 whitespace-pre-wrap rounded bg-rose-soft px-2 py-1 text-xs text-rose">
                            {reason}
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </div>

        {/* Right column — sticky totals + actions */}
        <div className="lg:sticky lg:top-20 h-fit">
          <div className="rounded-lg border border-border bg-surface shadow-xs overflow-hidden">
            <div className="border-b border-border bg-surface-subtle px-4 py-2.5">
              <p className="eyebrow">Итог</p>
            </div>
            <div className="p-4">
              {/* Big final amount — single line, auto-fit if long */}
              <div className="mb-4 text-center">
                <div className="mono-num font-bold text-ink whitespace-nowrap leading-tight text-[clamp(20px,4.2vw,32px)]">
                  {formatMoneyRub(booking.finalAmount ?? "0")}&nbsp;₽
                </div>
              </div>

              {/* Breakdown */}
              <div className="space-y-1.5 text-sm border-t border-border pt-3">
                <div className="flex justify-between">
                  <span className="text-ink-2">Аренда</span>
                  <span className="mono-num">{formatMoneyRub(booking.totalEstimateAmount ?? "0")} ₽</span>
                </div>
                {booking.discountPercent && Number(booking.discountPercent) > 0 && (
                  <div className="flex justify-between">
                    <span className="text-ink-2">Скидка {booking.discountPercent}%</span>
                    <span className="mono-num text-rose">
                      −{formatMoneyRub(booking.discountAmount ?? "0")} ₽
                    </span>
                  </div>
                )}
                {hasTransport && (
                  <div className="flex justify-between">
                    <span className="text-ink-2">
                      Транспорт{transportName ? ` (${transportName})` : ""}
                    </span>
                    <span className="mono-num">{formatMoneyRub(booking.transportSubtotalRub ?? "0")} ₽</span>
                  </div>
                )}
                <div className="flex justify-between border-t border-border pt-2 font-semibold">
                  <span>Итого</span>
                  <span className="mono-num">{formatMoneyRub(booking.finalAmount ?? "0")} ₽</span>
                </div>
              </div>

              {/* Duplicate action buttons */}
              <div className="mt-4 flex flex-col gap-2">
                <Link
                  href={`/bookings/${booking.id}/edit`}
                  className="w-full rounded border border-border bg-surface py-2 text-center text-sm text-ink-2 hover:bg-surface-muted"
                >
                  ✎ Редактировать
                </Link>
                <button
                  type="button"
                  disabled={actionsBusy}
                  onClick={handleApprove}
                  className="w-full rounded bg-emerald py-2 text-sm text-white hover:bg-emerald/90 disabled:opacity-50"
                >
                  {approving ? "Подтверждаю…" : "✓ Подтвердить"}
                </button>
                <button
                  type="button"
                  disabled={actionsBusy}
                  onClick={() => setRejectOpen(true)}
                  className="w-full rounded border border-rose py-2 text-sm text-rose hover:bg-rose-soft disabled:opacity-50"
                >
                  ✕ Отклонить
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Reject modal */}
      <RejectBookingModal
        open={rejectOpen}
        bookingDisplayName={booking.displayName ?? booking.projectName}
        loading={rejectBusy}
        onClose={() => setRejectOpen(false)}
        onSubmit={handleReject}
      />
    </div>
  );
}
