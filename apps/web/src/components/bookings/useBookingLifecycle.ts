"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { toast } from "../ToastProvider";

export type LifecycleAction = "issue" | "return" | "cancel";

/** Код 409: бронь уже в другом статусе (коллега успел раньше, страница устарела). */
export const INVALID_BOOKING_STATE = "INVALID_BOOKING_STATE";

/** Ответ POST /api/bookings/:id/status — только то, что нужно для подсказок. */
export type StatusChangeResponse = {
  /** Предупреждение сервера: не записан пробег машин, сбой пересчёта финансов… */
  warning?: string | null;
  /** Сколько незавершённых сессий киоска закрыла ручная смена статуса. */
  closedScanSessions?: number;
};

/** Предупреждение сервера держим дольше обычного тоста: его надо успеть прочитать. */
const WARNING_TOAST_MS = 10_000;

/**
 * Побочные итоги ручной смены статуса. Общие для карточки брони и реестра:
 * «Выдать» / «Вернуть» кнопкой закрывают брошенную в киоске сессию, а сервер
 * может предупредить о незаписанном пробеге — молчать об этом нельзя.
 */
export function announceStatusChangeNotes(res: StatusChangeResponse | null | undefined): void {
  const closed = typeof res?.closedScanSessions === "number" ? res.closedScanSessions : 0;
  if (closed === 1) toast.info("Незавершённая сессия киоска по этой брони закрыта");
  else if (closed > 1) toast.info(`Закрыты незавершённые сессии киоска по этой брони: ${closed}`);
  const warning = typeof res?.warning === "string" ? res.warning.trim() : "";
  if (warning) toast.info(warning, { durationMs: WARNING_TOAST_MS });
}

/**
 * Текст INVALID_BOOKING_STATE после того, как данные уже перечитаны:
 * «Бронь уже выдана — обновите страницу» → «Бронь уже выдана. Карточка обновлена».
 */
export function staleStateMessage(message: string | undefined, suffix: string): string {
  const base = (message?.trim() || "Бронь уже изменили")
    .replace(/\s*—\s*обновите страницу\.?$/u, "")
    .replace(/\.$/u, "");
  return `${base}. ${suffix}`;
}

/**
 * Переходы жизненного цикла брони со страницы карточки (фаза 4.3, вынос из
 * bookings/[id]/page.tsx — поведение 1:1). BD-1 / BD-4: issue/return —
 * POST /:id/status. Отмена: при наличии оплаты родитель открывает модалку
 * распоряжения депозитом (onCancelWithDeposit), иначе — обычная отмена
 * статусом. Мягкий гард ранней выдачи: 409 ISSUE_TOO_EARLY → confirm →
 * повтор с force: true (сервер пишет forcedEarlyIssue в аудит).
 *
 * Устаревшая страница (бронь уже выдал / принял / отменил коллега) → 409
 * INVALID_BOOKING_STATE: показываем текст сервера и перечитываем карточку,
 * чтобы кнопки соответствовали настоящему статусу.
 */
export function useBookingLifecycle(args: {
  bookingId: string;
  booking: { amountPaid?: string | null } | null;
  reloadBooking: () => Promise<void>;
  onCancelWithDeposit: () => void;
  /**
   * «Вернуть» открывает окно «Принять возврат» (позиции «по плану», «Вернули
   * не всё»). Без него — прежнее подтверждение и POST /status.
   */
  onReturn?: () => void;
}) {
  const { bookingId, booking, reloadBooking, onCancelWithDeposit, onReturn } = args;
  const [lifecycleBusy, setLifecycleBusy] = useState(false);

  async function runLifecycleAction(action: LifecycleAction, opts?: { force?: boolean }) {
    if (!bookingId || !booking) return;
    if (action === "return" && onReturn) {
      onReturn();
      return;
    }
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
      const res = await apiFetch<StatusChangeResponse>(`/api/bookings/${bookingId}/status`, {
        method: "POST",
        body: JSON.stringify({ action, ...(isForcedRetry ? { force: true } : {}) }),
      });
      toast.success(
        action === "issue" ? "Бронь выдана" : action === "return" ? "Бронь возвращена" : "Бронь отменена",
      );
      announceStatusChangeNotes(res);
      await reloadBooking();
    } catch (e: any) {
      if (action === "issue" && !isForcedRetry && e?.code === "ISSUE_TOO_EARLY") {
        const serverMsg = typeof e?.message === "string" ? e.message : "До начала аренды больше суток.";
        if (confirm(`${serverMsg}\n\nВыдать оборудование заранее?`)) {
          await runLifecycleAction("issue", { force: true });
        }
        return;
      }
      if (e?.code === INVALID_BOOKING_STATE) {
        const reloaded = await reloadBooking().then(
          () => true,
          () => false,
        );
        toast.error(staleStateMessage(e?.message, reloaded ? "Карточка обновлена" : "Обновите страницу"));
        return;
      }
      toast.error(e?.message ?? "Не удалось изменить статус");
    } finally {
      setLifecycleBusy(false);
    }
  }

  return { lifecycleBusy, runLifecycleAction };
}
