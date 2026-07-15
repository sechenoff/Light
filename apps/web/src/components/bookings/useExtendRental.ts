"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { toast } from "../ToastProvider";

/**
 * F-EXTEND (1), вынос из bookings/[id]/page.tsx (фаза 4.4, поведение 1:1):
 * продление выданной брони. Оператор вводит новую дату возврата, шлём PATCH
 * с extendEndDate. Если сервер контракт ещё не принимает — 409
 * BOOKING_EDIT_FORBIDDEN показываем тостом, не роняя UI.
 */
export function useExtendRental(args: {
  booking: { id: string; endDate: string } | null;
  reloadBooking: () => Promise<void>;
}) {
  const { booking, reloadBooking } = args;
  const [extendOpen, setExtendOpen] = useState(false);
  const [extendEndDate, setExtendEndDate] = useState("");
  const [extendBusy, setExtendBusy] = useState(false);

  function openExtend() {
    if (!booking) return;
    // Префилл текущей датой возврата в формате datetime-local (Europe/Moscow).
    const d = new Date(booking.endDate);
    // Приводим к московскому времени и парсим компоненты в формат datetime-local.
    const parts = new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    setExtendEndDate(`${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`);
    setExtendOpen(true);
  }

  async function submitExtend() {
    if (!booking || extendBusy) return;
    if (!extendEndDate) {
      toast.error("Укажите новую дату возврата");
      return;
    }
    const nextEnd = new Date(extendEndDate);
    if (Number.isNaN(nextEnd.getTime())) {
      toast.error("Некорректная дата возврата");
      return;
    }
    if (nextEnd.getTime() <= new Date(booking.endDate).getTime()) {
      toast.error("Новая дата возврата должна быть позже текущей");
      return;
    }
    setExtendBusy(true);
    try {
      await apiFetch(`/api/bookings/${booking.id}`, {
        method: "PATCH",
        body: JSON.stringify({ extendEndDate: nextEnd.toISOString() }),
      });
      toast.success("Аренда продлена");
      setExtendOpen(false);
      setExtendEndDate("");
      await reloadBooking();
    } catch (e: any) {
      toast.error(e?.message ?? "Не удалось продлить аренду");
    } finally {
      setExtendBusy(false);
    }
  }

  function cancelExtend() {
    setExtendOpen(false);
    setExtendEndDate("");
  }

  return {
    extendOpen,
    extendEndDate,
    extendBusy,
    openExtend,
    submitExtend,
    cancelExtend,
    setExtendEndDate,
  };
}
