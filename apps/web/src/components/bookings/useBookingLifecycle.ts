"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { toast } from "../ToastProvider";

export type LifecycleAction = "issue" | "return" | "cancel";

/**
 * Переходы жизненного цикла брони со страницы карточки (фаза 4.3, вынос из
 * bookings/[id]/page.tsx — поведение 1:1). BD-1 / BD-4: issue/return —
 * POST /:id/status. Отмена: при наличии оплаты родитель открывает модалку
 * распоряжения депозитом (onCancelWithDeposit), иначе — обычная отмена
 * статусом. Мягкий гард ранней выдачи: 409 ISSUE_TOO_EARLY → confirm →
 * повтор с force: true (сервер пишет forcedEarlyIssue в аудит).
 */
export function useBookingLifecycle(args: {
  bookingId: string;
  booking: { amountPaid?: string | null } | null;
  reloadBooking: () => Promise<void>;
  onCancelWithDeposit: () => void;
}) {
  const { bookingId, booking, reloadBooking, onCancelWithDeposit } = args;
  const [lifecycleBusy, setLifecycleBusy] = useState(false);

  async function runLifecycleAction(action: LifecycleAction, opts?: { force?: boolean }) {
    if (!bookingId || !booking) return;
    const isForcedRetry = opts?.force === true;
    if (!isForcedRetry) {
      if (action === "cancel") {
        if (Number(booking.amountPaid ?? "0") > 0) {
          onCancelWithDeposit();
          return;
        }
        if (!confirm("Отменить бронь?\n\nРезервы оборудования будут сняты.")) return;
      }
      if (action === "issue" && !confirm("Перевести бронь в статус «Выдано»?")) return;
      if (action === "return" && !confirm("Перевести бронь в статус «Возвращено»?")) return;
    }
    setLifecycleBusy(true);
    try {
      await apiFetch(`/api/bookings/${bookingId}/status`, {
        method: "POST",
        body: JSON.stringify({ action, ...(isForcedRetry ? { force: true } : {}) }),
      });
      toast.success(
        action === "issue" ? "Бронь выдана" : action === "return" ? "Бронь возвращена" : "Бронь отменена",
      );
      await reloadBooking();
    } catch (e: any) {
      if (action === "issue" && !isForcedRetry && e?.code === "ISSUE_TOO_EARLY") {
        const serverMsg = typeof e?.message === "string" ? e.message : "До начала аренды больше суток.";
        if (confirm(`${serverMsg}\n\nВыдать оборудование заранее?`)) {
          await runLifecycleAction("issue", { force: true });
        }
        return;
      }
      toast.error(e?.message ?? "Не удалось изменить статус");
    } finally {
      setLifecycleBusy(false);
    }
  }

  return { lifecycleBusy, runLifecycleAction };
}
