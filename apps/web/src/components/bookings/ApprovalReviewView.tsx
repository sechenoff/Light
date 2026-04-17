"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

import { apiFetch } from "../../lib/api";
import { formatMoneyRub } from "../../lib/format";
import { StatusPill } from "../StatusPill";
import { RoleBadge } from "../RoleBadge";
import { RejectBookingModal } from "./RejectBookingModal";
import { EquipmentEditTable, type EditableItem } from "./review/EquipmentEditTable";
import { toast } from "../ToastProvider";
import type { CurrentUser } from "../../lib/auth";

// ------------------------------------------------------------------ types ---

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
    equipmentId: string;
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
    };
  }>;
};

type AuditItem = {
  id: string;
  userId: string;
  action: string;
  createdAt: string;
  after: Record<string, unknown> | null;
  user?: { username: string } | null;
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

// --------------------------------------------------------- debounce hook ---

function useDebouncedCallback<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  const timer = useRef<NodeJS.Timeout | null>(null);
  return useCallback(
    (...args: A) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => fn(...args), ms);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fn, ms],
  );
}

// ---------------------------------------------------------- main component ---

type Totals = {
  totalEstimateAmount: string | null | undefined;
  discountAmount: string | null | undefined;
  finalAmount: string | null | undefined;
  discountPercent: string | null | undefined;
};

type Props = {
  booking: BookingForReview;
  onReload: () => void;
  currentUser: CurrentUser;
};

export function ApprovalReviewView({ booking, onReload, currentUser }: Props) {
  const router = useRouter();

  // Local state for editable fields
  const [items, setItems] = useState<EditableItem[]>(
    booking.items.map((it) => ({ ...it }))
  );
  const [discountPercent, setDiscountPercent] = useState<number>(
    Number(booking.discountPercent ?? "0") || 0
  );
  const [totals, setTotals] = useState<Totals>({
    totalEstimateAmount: booking.totalEstimateAmount,
    discountAmount: booking.discountAmount,
    finalAmount: booking.finalAmount,
    discountPercent: booking.discountPercent,
  });
  const [saving, setSaving] = useState(false);

  // Approval actions state
  const [approving, setApproving] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectBusy, setRejectBusy] = useState(false);

  // Audit timeline
  const [auditItems, setAuditItems] = useState<AuditItem[] | null>(null);

  // Estimate shift count from date range (coarse: ceil hours/8)
  const shifts = Math.max(
    1,
    Math.ceil(
      (new Date(booking.endDate).getTime() - new Date(booking.startDate).getTime()) /
        (1000 * 60 * 60 * 8),
    ),
  );

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

  // ---- debounced PATCH ----
  const doPatch = useCallback(
    async (payload: { items?: Array<{ equipmentId: string; quantity: number }>; discountPercent?: number }) => {
      setSaving(true);
      try {
        const res = await apiFetch<{ booking: BookingForReview & Totals }>(
          `/api/bookings/${booking.id}`,
          { method: "PATCH", body: JSON.stringify(payload) },
        );
        setTotals({
          totalEstimateAmount: res.booking.totalEstimateAmount,
          discountAmount: res.booking.discountAmount,
          finalAmount: res.booking.finalAmount,
          discountPercent: res.booking.discountPercent,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Не удалось сохранить изменения";
        toast.error(msg);
      } finally {
        setSaving(false);
      }
    },
    [booking.id],
  );

  const patchDebounced = useDebouncedCallback(doPatch, 500);

  // ---- equipment edit handlers ----
  function handleChangeQty(equipmentId: string, newQty: number) {
    const updated = items.map((it) =>
      it.equipmentId === equipmentId ? { ...it, quantity: Math.max(1, newQty) } : it,
    );
    setItems(updated);
    patchDebounced({ items: updated.map((i) => ({ equipmentId: i.equipmentId, quantity: i.quantity })) });
  }

  function handleRemove(equipmentId: string) {
    const updated = items.filter((it) => it.equipmentId !== equipmentId);
    setItems(updated);
    patchDebounced({ items: updated.map((i) => ({ equipmentId: i.equipmentId, quantity: i.quantity })) });
  }

  function handleAdd(row: {
    equipmentId: string;
    name: string;
    category: string;
    rentalRatePerShift: string;
    availableQuantity: number;
    totalQuantity: number;
  }) {
    const existing = items.find((it) => it.equipmentId === row.equipmentId);
    let updated: EditableItem[];
    if (existing) {
      updated = items.map((it) =>
        it.equipmentId === row.equipmentId ? { ...it, quantity: it.quantity + 1 } : it,
      );
    } else {
      const newItem: EditableItem = {
        id: `temp-${row.equipmentId}`,
        equipmentId: row.equipmentId,
        quantity: 1,
        equipment: {
          id: row.equipmentId,
          name: row.name,
          category: row.category,
          brand: null,
          model: null,
          rentalRatePerShift: row.rentalRatePerShift,
          totalQuantity: row.totalQuantity,
          availableQuantity: row.availableQuantity,
        },
      };
      updated = [...items, newItem];
    }
    setItems(updated);
    patchDebounced({ items: updated.map((i) => ({ equipmentId: i.equipmentId, quantity: i.quantity })) });
  }

  function handleDiscountChange(value: number) {
    const clamped = Math.max(0, Math.min(100, value));
    setDiscountPercent(clamped);
    patchDebounced({ discountPercent: clamped });
  }

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

  // ----------------------------------------------------------------------- render ---

  const title = booking.displayName
    ?? `${booking.client.name} · проект «${booking.projectName}»`;

  return (
    <div>
      {/* Breadcrumb + status + role pills (parent page hides its own top-bar in this mode) */}
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

      {/* Hero — amber highlight card with title + primary actions */}
      <div className="mb-5 rounded-lg border border-amber-border bg-amber-soft px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-ink truncate">{title}</h1>
            <p className="mt-1 text-sm text-ink-2">
              {formatDateRange(booking.startDate, booking.endDate)}
              {" · "}
              <span className="text-ink-3">отправлено кладовщиком</span>
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
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
                <div className="font-medium text-ink">{booking.projectName}</div>
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

          {/* Equipment card */}
          <div className="rounded-lg border border-border bg-surface shadow-xs overflow-hidden">
            <div className="border-b border-border bg-surface-subtle px-4 py-2.5">
              <p className="eyebrow">Оборудование</p>
            </div>
            <EquipmentEditTable
              items={items}
              shifts={shifts}
              startISO={booking.startDate}
              endISO={booking.endDate}
              onChangeQty={handleChangeQty}
              onRemove={handleRemove}
              onAdd={handleAdd}
            />
          </div>

          {/* Discount card */}
          <div className="rounded-lg border border-border bg-surface shadow-xs overflow-hidden">
            <div className="border-b border-border bg-surface-subtle px-4 py-2.5">
              <p className="eyebrow">Скидка</p>
            </div>
            <div className="flex items-center justify-between gap-4 p-4">
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={discountPercent}
                  onChange={(e) => handleDiscountChange(Number(e.target.value))}
                  className="w-20 rounded border border-border bg-surface px-2 py-1.5 text-sm text-ink focus:border-accent focus:outline-none"
                />
                <span className="text-sm text-ink-2">%</span>
              </div>
              <div className="text-right text-sm">
                <span className="text-ink-3">−</span>{" "}
                <span className="font-medium mono-num">
                  {formatMoneyRub(totals.discountAmount ?? "0")} ₽
                </span>
              </div>
            </div>
          </div>

          {/* Transport card */}
          <div className="rounded-lg border border-border bg-surface shadow-xs overflow-hidden">
            <div className="border-b border-border bg-surface-subtle px-4 py-2.5">
              <p className="eyebrow">Транспорт</p>
            </div>
            <div className="p-4 text-sm text-ink-3">—</div>
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

        {/* Right column — sticky total sidebar */}
        <div className="lg:sticky lg:top-20 h-fit">
          <div className="rounded-lg border border-border bg-surface shadow-xs overflow-hidden">
            <div className="border-b border-border bg-surface-subtle px-4 py-2.5">
              <p className="eyebrow">Итог</p>
            </div>
            <div className="p-4">
              {/* Big amount */}
              <div className="mb-4 text-center">
                <div className="text-3xl font-bold mono-num text-ink">
                  {formatMoneyRub(totals.finalAmount ?? "0")} ₽
                </div>
                {saving && (
                  <div className="mt-1 text-xs text-ink-3">сохраняю…</div>
                )}
              </div>

              {/* Breakdown */}
              <div className="space-y-1.5 text-sm border-t border-border pt-3">
                <div className="flex justify-between">
                  <span className="text-ink-2">Аренда</span>
                  <span className="mono-num">{formatMoneyRub(totals.totalEstimateAmount ?? "0")} ₽</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-2">Транспорт</span>
                  <span className="mono-num text-ink-3">—</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-2">
                    Скидка {totals.discountPercent ? `${totals.discountPercent}%` : ""}
                  </span>
                  <span className="mono-num text-rose">
                    −{formatMoneyRub(totals.discountAmount ?? "0")} ₽
                  </span>
                </div>
                <div className="flex justify-between border-t border-border pt-2 font-semibold">
                  <span>Итого</span>
                  <span className="mono-num">{formatMoneyRub(totals.finalAmount ?? "0")} ₽</span>
                </div>
              </div>

              {/* Duplicate action buttons */}
              <div className="mt-4 flex flex-col gap-2">
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
