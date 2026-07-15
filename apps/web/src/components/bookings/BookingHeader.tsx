"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { UserRole } from "@/lib/auth";
import type { BookingStatus } from "@/lib/bookingConstants";
import { readBookingsListHref } from "./bookingsListNav";

/**
 * Шапка карточки брони (фаза 4.2): breadcrumb + action-кнопки жизненного цикла
 * + inline-панель продления. Чистый вынос из bookings/[id]/page.tsx —
 * состояние и обработчики остаются в странице, компонент только рендерит.
 * Рендерится родителем только когда НЕ показан ApprovalReviewView.
 */
export interface BookingHeaderProps {
  bookingId: string;
  booking: { status: BookingStatus; endDate: string } | null;
  userRole: UserRole | undefined;
  isArchived: boolean;
  retroEditMode: boolean;
  canRetroEdit: boolean;
  lifecycleBusy: boolean;
  resubmitBusy: boolean;
  extendOpen: boolean;
  extendEndDate: string;
  extendBusy: boolean;
  onLifecycleAction: (action: "issue" | "return" | "cancel") => void;
  onArchive: () => void;
  onResubmit: () => void;
  onEnterRetroEdit: () => void;
  onOpenExtend: () => void;
  onChangeExtendDate: (value: string) => void;
  onSubmitExtend: () => void;
  onCancelExtend: () => void;
}

export function BookingHeader({
  bookingId,
  booking,
  userRole,
  isArchived,
  retroEditMode,
  canRetroEdit,
  lifecycleBusy,
  resubmitBusy,
  extendOpen,
  extendEndDate,
  extendBusy,
  onLifecycleAction,
  onArchive,
  onResubmit,
  onEnterRetroEdit,
  onOpenExtend,
  onChangeExtendDate,
  onSubmitExtend,
  onCancelExtend,
}: BookingHeaderProps) {
  // «← К списку» возвращает на список с теми же фильтрами, что были активны
  // (sessionStorage). Читаем после маунта — на SSR sessionStorage нет, поэтому
  // useState-инициализатор дал бы «/bookings» и рассинхрон гидратации.
  const [backHref, setBackHref] = useState("/bookings");
  useEffect(() => {
    setBackHref(readBookingsListHref());
  }, []);

  return (
    <div className="flex items-center justify-between flex-wrap gap-3 no-print">
      <Link
        href={backHref}
        className="text-xs text-ink-3 hover:text-ink transition-colors"
      >
        ← К списку броней
      </Link>
      <div className="flex items-center gap-2 flex-wrap">
        <Link href="/bookings/new" className="rounded bg-accent-bright text-white px-3 py-1.5 text-sm hover:bg-accent transition-colors">
          + Новая бронь
        </Link>
        {/* BD-1: основные действия жизненного цикла — раньше были только в
            списке /bookings, на самой странице брони их не было. */}
        {booking && !isArchived && !retroEditMode && (
          <>
            {(["DRAFT", "CONFIRMED"].includes(booking.status) ||
              (booking.status === "PENDING_APPROVAL" && userRole === "SUPER_ADMIN")) && (
              <Link
                href={`/bookings/${bookingId}/edit`}
                className="rounded border border-border px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-muted transition-colors"
              >
                ✎ Изменить
              </Link>
            )}
            {booking.status === "CONFIRMED" && (userRole === "SUPER_ADMIN" || userRole === "WAREHOUSE") && (
              <button
                type="button"
                disabled={lifecycleBusy}
                onClick={() => onLifecycleAction("issue")}
                className="rounded border border-border px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-muted transition-colors disabled:opacity-40"
              >
                Выдать
              </button>
            )}
            {booking.status === "ISSUED" && (userRole === "SUPER_ADMIN" || userRole === "WAREHOUSE") && (
              <button
                type="button"
                disabled={lifecycleBusy}
                onClick={() => onLifecycleAction("return")}
                className="rounded border border-border px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-muted transition-colors disabled:opacity-40"
              >
                Вернуть
              </button>
            )}
            {/* F-EXTEND (1): продление выданной брони — только SUPER_ADMIN.
                Клиент оставил оборудование ещё на день — сдвигаем дату
                возврата, не дожидаясь физического возврата. */}
            {booking.status === "ISSUED" && userRole === "SUPER_ADMIN" && !extendOpen && (
              <button
                type="button"
                disabled={lifecycleBusy}
                onClick={onOpenExtend}
                className="rounded border border-border px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-muted transition-colors disabled:opacity-40"
              >
                Продлить аренду
              </button>
            )}
            {/* F-EXTEND (2): бронь правили после одобрения — WAREHOUSE может
                отправить её на повторное согласование руководителю. */}
            {booking.status === "CONFIRMED" && userRole === "WAREHOUSE" && (
              <button
                type="button"
                disabled={resubmitBusy}
                onClick={onResubmit}
                className="rounded border border-amber-border bg-amber-soft text-amber px-3 py-1.5 text-sm hover:bg-amber hover:text-white transition-colors disabled:opacity-40"
                title="Отправить изменённую бронь на повторное согласование"
              >
                {resubmitBusy ? "Отправляю…" : "На согласование"}
              </button>
            )}
            {/* «Отменить» только там, где сервер разрешает cancel:
                из ISSUED допустим лишь return (allowedActionsByStatus),
                и cancel-with-deposit тоже ограничен этими тремя статусами —
                иначе кнопка гарантированно заканчивалась 409. */}
            {["DRAFT", "PENDING_APPROVAL", "CONFIRMED"].includes(booking.status) && userRole === "SUPER_ADMIN" && (
              <button
                type="button"
                disabled={lifecycleBusy}
                onClick={() => onLifecycleAction("cancel")}
                className="rounded border border-rose-border text-rose px-3 py-1.5 text-sm hover:bg-rose-soft transition-colors disabled:opacity-40"
              >
                Отменить
              </button>
            )}
          </>
        )}
        {/*
          Ретро-редактирование: только SUPER_ADMIN на закрытой (RETURNED)
          брони. Кнопка прячется когда уже в режиме редактирования (там
          работает sticky-bar внизу). См. saveRetroEdit().
        */}
        {canRetroEdit && !retroEditMode && (
          <button
            type="button"
            onClick={onEnterRetroEdit}
            className="rounded border border-amber-border bg-amber-soft text-amber px-3 py-1.5 text-sm hover:bg-amber hover:text-white transition-colors"
            title="Изменить уже закрытую бронь — попадёт в аудит-лог"
          >
            ✎ Редактировать задним числом
          </button>
        )}
        {/* В архив — только SUPER_ADMIN, на не-архивной броне, не в retro-edit.
            Раньше архивировать можно было лишь из списка. */}
        {userRole === "SUPER_ADMIN" && !isArchived && !retroEditMode && (
          <button
            type="button"
            onClick={onArchive}
            className="rounded border border-rose-border text-rose px-3 py-1.5 text-sm hover:bg-rose-soft transition-colors"
            title="Отправить в архив (можно восстановить из /bookings/archive)"
          >
            В архив
          </button>
        )}
      </div>
      {/* F-EXTEND (1): инлайн-поле продления выданной брони. */}
      {extendOpen && booking && booking.status === "ISSUED" && (
        <div className="w-full mt-3 rounded-lg border border-border bg-surface-subtle p-3 no-print">
          <p className="eyebrow mb-2">Продлить аренду</p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="block">
              <span className="block mb-1 text-xs text-ink-3">Новая дата возврата</span>
              <input
                type="datetime-local"
                value={extendEndDate}
                onChange={(e) => onChangeExtendDate(e.target.value)}
                className="rounded border border-border bg-white px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-accent"
              />
            </label>
            <button
              type="button"
              disabled={extendBusy}
              onClick={onSubmitExtend}
              className="rounded bg-accent-bright text-white px-3 py-1.5 text-sm hover:bg-accent transition-colors disabled:opacity-40"
            >
              {extendBusy ? "Сохраняю…" : "Продлить"}
            </button>
            <button
              type="button"
              disabled={extendBusy}
              onClick={onCancelExtend}
              className="rounded border border-border px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-muted transition-colors disabled:opacity-40"
            >
              Отмена
            </button>
          </div>
          <p className="mt-2 text-xs text-ink-3">
            Текущая дата возврата:{" "}
            {new Date(booking.endDate).toLocaleString("ru-RU", {
              dateStyle: "short",
              timeStyle: "short",
              timeZone: "Europe/Moscow",
            })}
          </p>
        </div>
      )}
    </div>
  );
}
