"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Decimal from "decimal.js";

import { apiFetch } from "../../lib/api";
import { formatMoneyRub, pluralize } from "../../lib/format";
import { StatusPill } from "../StatusPill";
import { RoleBadge } from "../RoleBadge";
import { RejectBookingModal } from "./RejectBookingModal";
import { toast } from "../ToastProvider";
import { EquipmentEditTable, type EditableItem } from "./review/EquipmentEditTable";
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

type BookingItem = {
  id: string;
  equipmentId: string | null;
  quantity: number;
  customName?: string | null;
  customCategory?: string | null;
  customUnitPrice?: string | null;
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
  items: BookingItem[];
  estimate?: null | {
    id: string;
    shifts: number;
    subtotal: string;
    discountPercent: string | null;
    discountAmount: string;
    totalAfterDiscount: string;
    lines: EstimateLine[];
  };
  // Transport snapshot — multi-vehicle (vehicles[]) + legacy single-vehicle fields
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
  }>;
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

/**
 * H4: количество полных циклов согласования (submit → approve/reject).
 * `items` отсортированы ascending.
 */
function countCycles(items: AuditItem[]): number {
  let cycles = 0;
  let awaiting = false;
  for (const it of items) {
    if (it.action === "BOOKING_SUBMITTED") {
      awaiting = true;
    } else if (awaiting && (it.action === "BOOKING_APPROVED" || it.action === "BOOKING_REJECTED")) {
      cycles++;
      awaiting = false;
    }
  }
  return cycles;
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
    default: return "отправлено кладовщиком";
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

/**
 * Преобразует BookingItem[] (от сервера) в EditableItem[] для inline-редактирования.
 * Кастомные позиции (без equipmentId) скрываются — их нельзя править через стандартный
 * EquipmentEditTable; они остаются в items при PATCH (re-send без изменений).
 */
function toEditableItems(items: BookingItem[]): EditableItem[] {
  const out: EditableItem[] = [];
  for (const it of items) {
    if (!it.equipmentId || !it.equipment) continue;
    out.push({
      id: it.id,
      equipmentId: it.equipmentId,
      quantity: it.quantity,
      equipment: {
        id: it.equipment.id,
        name: it.equipment.name,
        category: it.equipment.category,
        brand: it.equipment.brand ?? null,
        model: it.equipment.model ?? null,
        rentalRatePerShift: it.equipment.rentalRatePerShift,
        totalQuantity: it.equipment.totalQuantity,
        availableQuantity: it.equipment.availableQuantity,
      },
    });
  }
  return out;
}

/** PATCH payload для items: equipment + custom (custom не правится, но re-send без изменений). */
type PatchItem =
  | { equipmentId: string; quantity: number }
  | { customName: string; customUnitPrice: number; quantity: number };

function buildPatchItems(
  editable: EditableItem[],
  originalItems: BookingItem[],
): PatchItem[] {
  const out: PatchItem[] = [];
  for (const e of editable) {
    out.push({ equipmentId: e.equipmentId, quantity: e.quantity });
  }
  // Custom items — re-send как есть. customUnitPrice null/undefined трактуем как 0,
  // чтобы не «откусить» серверную позицию молча. См. MED #8.
  for (const it of originalItems) {
    if (it.equipmentId) continue;
    if (!it.customName) continue;
    out.push({
      customName: it.customName,
      customUnitPrice: Number(it.customUnitPrice ?? 0),
      quantity: it.quantity,
    });
  }
  return out;
}

// ---------------------------------------------------------- main component ---

type Props = {
  booking: BookingForReview;
  onReload: () => void;
  currentUser: CurrentUser;
};

/**
 * Inline-страница согласования для SUPER_ADMIN.
 * - Редактируется список оборудования (qty/удалить/добавить) + скидка %.
 * - Каждое изменение → debounce 500 ms → PATCH /api/bookings/:id → onReload().
 * - Транспорт показывается read-only (множественный список машин); inline-правка
 *   транспорта вне scope этой страницы — есть отдельная страница /edit.
 *
 * Контракт PATCH (SUPER_ADMIN на PENDING_APPROVAL): см. bookings.ts —
 * BOOKING_EDIT_FORBIDDEN на этот статус снят для SA, WH/TECH по-прежнему 409.
 */
export function ApprovalReviewView({ booking, onReload, currentUser: _currentUser }: Props) {
  const router = useRouter();

  // ──────── approve / reject state ────────
  const [approving, setApproving] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectBusy, setRejectBusy] = useState(false);

  // ──────── audit timeline ────────
  const [auditItems, setAuditItems] = useState<AuditItem[] | null>(null);

  // ──────── editable state ────────
  // Локальный snapshot equipment items + discount для оптимистичных обновлений.
  // Реконсилируется с booking prop'ом после каждого onReload.
  const [editable, setEditable] = useState<EditableItem[]>(() => toEditableItems(booking.items));
  const [discountPercent, setDiscountPercent] = useState<string>(
    booking.discountPercent != null ? String(Number(booking.discountPercent)) : "0",
  );
  const [saving, setSaving] = useState(false);

  // ──────── refs для debounce/in-flight guard ────────
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const pendingSave = useRef(false);
  // MED #7 — пока PATCH летит, не реконсилируем локальный state со stale prop'ом.
  // Аналогично `pollBlocked` в useTasksQuery.ts.
  const saveInFlightRef = useRef(false);
  // HIGH #1 — bookingRef хранит свежий booking для performSave; убирает
  // stale-closure (когда обработчик «pendingSave» вызывал себя со старым
  // booking.items / booking.id из закрытия useCallback).
  const bookingRef = useRef(booking);
  bookingRef.current = booking;

  // Реконсиляция при изменении booking prop'а (после parent re-fetch).
  // ВАЖНО: ключ — booking.id + сериализованный snapshot, чтобы не сбрасывать
  // локальный state на каждом re-render. Используем строки от сервера как
  // источник истины после успешного PATCH.
  const bookingFingerprint = useMemo(
    () =>
      JSON.stringify({
        id: booking.id,
        discount: booking.discountPercent,
        items: booking.items.map((i) => ({ id: i.id, q: i.quantity, eq: i.equipmentId })),
      }),
    [booking.id, booking.discountPercent, booking.items],
  );

  useEffect(() => {
    // MED #7 — если в этот момент летит PATCH (мы оптимистично уже применили
    // изменение, но сервер ещё не вернул), не затираем editable свежим prop'ом —
    // дождёмся завершения in-flight save, после чего onReload пересинхронизирует
    // нас через новый bookingFingerprint.
    if (saveInFlightRef.current) return;
    setEditable(toEditableItems(bookingRef.current.items));
    setDiscountPercent(
      bookingRef.current.discountPercent != null
        ? String(Number(bookingRef.current.discountPercent))
        : "0",
    );
    // HIGH #3 — bookingFingerprint уже сериализует id/items/discount, поэтому
    // booking.items и booking.discountPercent в depArray избыточны и приводили
    // к лишним пересборкам (object identity items[] меняется на каждом re-render
    // родителя). Достаточно одного ключа.
  }, [bookingFingerprint]);

  // ──────── fetch audit timeline ────────
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

  // ──────── save (debounced) ────────
  // HIGH #1 — performSave не закрывается над booking-prop'ом; всё, что
  // зависит от свежей версии (id / items для buildPatchItems / fallback при
  // ошибке), читается из bookingRef.current. Поэтому stale-closure исчезает
  // и useCallback может смело пропускать booking-зависимости.
  const performSave = useCallback(
    async (nextEditable: EditableItem[], nextDiscount: string) => {
      if (inFlight.current) {
        // Запрос уже летит — пометим, что нужен повторный после завершения.
        pendingSave.current = true;
        return;
      }
      inFlight.current = true;
      saveInFlightRef.current = true;
      setSaving(true);

      const currentBooking = bookingRef.current;
      const items = buildPatchItems(nextEditable, currentBooking.items);
      const discountNum = Number(nextDiscount);
      const body: { items: PatchItem[]; discountPercent: number | null } = {
        items,
        discountPercent: Number.isFinite(discountNum) ? discountNum : 0,
      };

      try {
        await apiFetch(`/api/bookings/${currentBooking.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        // После успешного PATCH — попросим родителя перечитать бронь;
        // useEffect выше реконсилирует editable state с серверным snapshot'ом.
        onReload?.();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Не удалось сохранить изменения";
        toast.error(msg);
        // Откатываем локальный state к серверному значению (свежему, не stale).
        const fallback = bookingRef.current;
        setEditable(toEditableItems(fallback.items));
        setDiscountPercent(
          fallback.discountPercent != null ? String(Number(fallback.discountPercent)) : "0",
        );
      } finally {
        inFlight.current = false;
        saveInFlightRef.current = false;
        setSaving(false);
        // Если за время запроса успели набрать новые изменения — повторим.
        if (pendingSave.current) {
          pendingSave.current = false;
          // Используем актуальное (state-after-update) значение через setState callback:
          setEditable((curEditable) => {
            setDiscountPercent((curDisc) => {
              // Запускаем повторный save с актуальными значениями.
              // performSave сам прочитает свежий booking из bookingRef.current.
              void performSave(curEditable, curDisc);
              return curDisc;
            });
            return curEditable;
          });
        }
      }
    },
    [onReload],
  );

  const scheduleSave = useCallback(
    (nextEditable: EditableItem[], nextDiscount: string) => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        void performSave(nextEditable, nextDiscount);
      }, 500);
    },
    [performSave],
  );

  // Cleanup на размонтирование — отменяем pending-debounce.
  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  // ──────── handlers редактирования ────────
  function handleChangeQty(equipmentId: string, newQty: number) {
    if (newQty < 1) return;
    setEditable((prev) => {
      const next = prev.map((it) =>
        it.equipmentId === equipmentId ? { ...it, quantity: newQty } : it,
      );
      scheduleSave(next, discountPercent);
      return next;
    });
  }

  function handleRemove(equipmentId: string) {
    setEditable((prev) => {
      const next = prev.filter((it) => it.equipmentId !== equipmentId);
      if (next.length === 0) {
        // Нельзя оставить бронь без оборудования — Zod min(1) на сервере.
        toast.error("Нельзя удалить последнюю позицию. Используйте отклонение.");
        return prev;
      }
      scheduleSave(next, discountPercent);
      return next;
    });
  }

  function handleAdd(row: {
    equipmentId: string;
    name: string;
    category: string;
    rentalRatePerShift: string;
    availableQuantity: number;
    totalQuantity: number;
  }) {
    setEditable((prev) => {
      // Если уже есть в списке — увеличим qty на 1.
      const idx = prev.findIndex((it) => it.equipmentId === row.equipmentId);
      let next: EditableItem[];
      if (idx >= 0) {
        next = prev.map((it, i) => (i === idx ? { ...it, quantity: it.quantity + 1 } : it));
      } else {
        next = [
          ...prev,
          {
            id: `new-${row.equipmentId}-${Date.now()}`,
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
          },
        ];
      }
      scheduleSave(next, discountPercent);
      return next;
    });
  }

  function handleDiscountChange(raw: string) {
    // Разрешаем пустую строку (пользователь стирает) — трактуем как 0.
    let clean = raw.replace(/[^\d]/g, "");
    if (clean === "") clean = "0";
    let n = Number(clean);
    if (!Number.isFinite(n)) n = 0;
    if (n < 0) n = 0;
    if (n > 100) n = 100;
    const next = String(n);
    setDiscountPercent(next);
    scheduleSave(editable, next);
  }

  // ──────── approve / reject ────────
  async function handleApprove() {
    // MED #6 — блокируем ОБЕ Approve-кнопки (hero + sidebar) ещё до flush
    // pending-debounce. Иначе пользователь может успеть кликнуть вторую кнопку,
    // пока PATCH ещё не завершился, и спровоцировать гонку approve↔patch.
    setApproving(true);
    // Если есть pending debounce — дождёмся его, чтобы approve видел свежие данные.
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
      await performSave(editable, discountPercent);
    }
    try {
      await apiFetch(`/api/bookings/${booking.id}/approve`, { method: "POST" });
      toast.success("Заявка подтверждена, оборудование зарезервировано");
      // См. комментарий в предыдущей реализации: URL не меняется, поэтому
      // явно сбрасываем флаг + просим parent перечитать бронь (статус сменится
      // на CONFIRMED → ApprovalReviewView размонтируется, появится обычный
      // booking-detail).
      setApproving(false);
      onReload?.();
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

  // ──────── derived ────────
  // Derive submitter role from first BOOKING_SUBMITTED audit event
  const submitterRole = auditItems
    ? (auditItems.find((it) => it.action === "BOOKING_SUBMITTED")?.user?.role ?? null)
    : null;

  // Transport display — multi-vehicle preferred, fallback to legacy single
  const vehiclesList = booking.vehicles ?? [];
  const hasMultiVehicles = vehiclesList.length > 0;
  const hasLegacyVehicle = Boolean(booking.vehicleId && booking.transportSubtotalRub);
  const hasTransport = hasMultiVehicles || hasLegacyVehicle;

  const shifts = booking.estimate?.shifts ?? 1;

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

      {/* Hero — title, dates, + Reject + Approve buttons */}
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
          <div className="flex gap-2 shrink-0 flex-wrap items-center">
            {saving && (
              <span className="text-xs text-ink-3" aria-live="polite">
                Сохраняем…
              </span>
            )}
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
                {booking.projectName?.trim() === "Проект" ? (
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
                {shifts > 1 && (
                  <div className="mt-1 text-xs text-ink-3">
                    {shifts} {pluralize(shifts, "смена", "смены", "смен")}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Equipment card — editable table */}
          <div className="rounded-lg border border-border bg-surface shadow-xs overflow-hidden">
            <div className="border-b border-border bg-surface-subtle px-4 py-2.5 flex items-center justify-between">
              <p className="eyebrow">
                Оборудование
                {editable.length > 0 && (
                  <span className="ml-2 font-normal normal-case text-ink-3 tracking-normal">
                    · {editable.length} {pluralize(editable.length, "позиция", "позиции", "позиций")}
                    {shifts > 1 && ` · ${shifts} ${pluralize(shifts, "смена", "смены", "смен")}`}
                  </span>
                )}
              </p>
            </div>
            <EquipmentEditTable
              items={editable}
              shifts={shifts}
              startISO={booking.startDate}
              endISO={booking.endDate}
              onChangeQty={handleChangeQty}
              onRemove={handleRemove}
              onAdd={handleAdd}
            />
          </div>

          {/* Discount card — editable */}
          <div className="rounded-lg border border-border bg-surface shadow-xs overflow-hidden">
            <div className="border-b border-border bg-surface-subtle px-4 py-2.5">
              <p className="eyebrow">Скидка</p>
            </div>
            <div className="flex items-center gap-3 p-4">
              <input
                type="number"
                min={0}
                max={100}
                value={discountPercent}
                onChange={(e) => handleDiscountChange(e.target.value)}
                aria-label="Процент скидки"
                className="w-24 rounded border border-border bg-surface px-3 py-1.5 text-right mono-num text-sm text-ink focus:border-accent focus:outline-none"
              />
              <span className="text-sm text-ink-2">%</span>
              {booking.discountAmount && Number(booking.discountAmount) > 0 && (
                <span className="ml-auto mono-num text-sm text-rose">
                  −{formatMoneyRub(booking.discountAmount)} ₽
                </span>
              )}
            </div>
          </div>

          {/* Transport card — read-only display (multi-vehicle aware) */}
          <div className="rounded-lg border border-border bg-surface shadow-xs overflow-hidden">
            <div className="border-b border-border bg-surface-subtle px-4 py-2.5">
              <p className="eyebrow">Транспорт</p>
            </div>
            {!hasTransport ? (
              <div className="p-4 text-sm text-ink-3">Не выбран</div>
            ) : hasMultiVehicles ? (
              <ul className="divide-y divide-border">
                {vehiclesList.map((v) => (
                  <li key={v.id} className="flex items-start justify-between gap-3 p-4 text-sm">
                    <div>
                      <div className="font-medium text-ink">
                        {v.vehicle?.name ?? "Транспорт"}
                        {v.withGenerator && (
                          <span className="ml-2 rounded bg-amber-soft px-1.5 py-0.5 text-[11px] text-amber">
                            + генератор
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-xs text-ink-3 space-x-2">
                        {v.shiftHours && <span>{Number(v.shiftHours)} ч.</span>}
                        {v.skipOvertime && <span>· без переработки</span>}
                        {v.kmOutsideMkad != null && Number(v.kmOutsideMkad) > 0 && (
                          <span>· {v.kmOutsideMkad} км за МКАД</span>
                        )}
                        {v.ttkEntry && <span>· ТТК</span>}
                      </div>
                    </div>
                    <div className="mono-num text-ink font-medium whitespace-nowrap">
                      {formatMoneyRub(v.subtotalRub ?? "0")} ₽
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="p-4 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-medium text-ink">
                      {booking.vehicle?.name ?? "Транспорт"}
                      {booking.vehicleWithGenerator && (
                        <span className="ml-2 rounded bg-amber-soft px-1.5 py-0.5 text-[11px] text-amber">
                          + генератор
                        </span>
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

          {/* История согласования — H4: свёрнуто по умолчанию + счётчик циклов. */}
          <details className="rounded-lg border border-border bg-surface shadow-xs overflow-hidden group">
            <summary className="cursor-pointer select-none border-b border-border bg-surface-subtle px-4 py-2.5 flex items-center justify-between">
              <span className="flex items-baseline gap-2">
                <span className="eyebrow">История согласования</span>
                {auditItems && auditItems.length > 0 && (() => {
                  const cycles = countCycles(auditItems);
                  return cycles > 1 ? (
                    <span className="text-xs font-medium text-amber">
                      {cycles} {pluralize(cycles, "цикл", "цикла", "циклов")}
                    </span>
                  ) : (
                    <span className="text-xs text-ink-3">({auditItems.length})</span>
                  );
                })()}
              </span>
              <span className="text-ink-3 group-open:rotate-180 transition-transform text-xs">▾</span>
            </summary>
            {!auditItems || auditItems.length === 0 ? (
              <div className="p-4 text-sm text-ink-3">Нет событий</div>
            ) : (
              <ol className="divide-y divide-border px-4 py-1">
                {[...auditItems].reverse().map((it) => {
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
          </details>
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
                {saving && (
                  <div className="mt-1 text-xs text-ink-3" aria-live="polite">
                    Пересчитываем…
                  </div>
                )}
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
                      Транспорт{hasMultiVehicles && vehiclesList.length > 1 ? ` (${vehiclesList.length})` : ""}
                    </span>
                    <span className="mono-num">
                      {formatMoneyRub(
                        hasMultiVehicles
                          ? // MED #9 — суммируем Decimal'ом, чтобы не терять копейки
                            // на множественном транспорте (Decimal — стандарт денег в проекте).
                            vehiclesList
                              .reduce(
                                (sum, v) => sum.plus(new Decimal(v.subtotalRub ?? "0")),
                                new Decimal(0),
                              )
                              .toString()
                          : booking.transportSubtotalRub ?? "0",
                      )} ₽
                    </span>
                  </div>
                )}
                <div className="flex justify-between border-t border-border pt-2 font-semibold">
                  <span>Итого</span>
                  <span className="mono-num">{formatMoneyRub(booking.finalAmount ?? "0")} ₽</span>
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
                <p className="text-center text-[11px] text-ink-3 mt-1">
                  При подтверждении оборудование резервируется до возврата
                </p>
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
