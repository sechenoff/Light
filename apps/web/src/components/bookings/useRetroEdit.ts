"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { toast } from "../ToastProvider";

// ── Ретро-редактирование закрытой брони (SUPER_ADMIN + RETURNED) ──────────
// Вынос из bookings/[id]/page.tsx (фаза 4.6, поведение 1:1). Меняется:
// название проекта, комментарий, % скидки, ручной итог, состав позиций
// (qty, удалить, добавить), водители/пробег машин. Backend сохраняет в той же
// транзакции и пишет audit BOOKING_RETROACTIVE_EDIT. JSX ретро-режима остаётся
// в странице (он вплетён в основную таблицу позиций) и читает всё из хука.

export type RetroEditItem = {
  /** id существующего BookingItem ИЛИ "__new-N" для добавленного inline */
  id: string;
  equipmentId: string | null;
  customName?: string | null;
  customUnitPrice?: number | null;
  quantity: number;
  /** Снапшот для display + подсветка изменений */
  equipment?: {
    id: string;
    name: string;
    category: string;
    brand?: string | null;
    model?: string | null;
  } | null;
  customCategory?: string | null;
  /** UI-only: оригинальное qty для подсветки «было N → стало M» */
  originalQuantity?: number;
  /** UI-only: помечен на удаление (но строка остаётся видимой как strikethrough) */
  _deleted?: boolean;
  /** UI-only: добавлено в этом сеансе (подсветка emerald-soft) */
  _added?: boolean;
};

export type RetroEditVehicle = {
  /** id BookingVehicle (его передаём в PATCH vehicleEdits) */
  bookingVehicleId: string;
  /** Имя машины для отображения («Газель», «Ивеко») */
  vehicleName: string;
  /** Текущее значение пробега машины — для подсказки «было N км» */
  originalCurrentMileage: number;
  driverName: string;
  driverPhone: string;
  /** Пользователь вводит итоговый одометр после смены; пустая строка = не трогать */
  endMileage: string;
  /** Снимок исходных значений для diff-панели */
  originalDriverName: string;
  originalDriverPhone: string;
};

export type RetroEditsState = {
  projectName?: string;
  comment?: string | null;
  discountPercent?: number | null;
  /**
   * Ручной override итоговой суммы брони.
   *  - undefined → не трогаем поле (по умолчанию при entering edit-mode)
   *  - "" пустая строка → null (очистить override на бэке, вернуть auto)
   *  - строка-число → новый override
   * Хранится как string для контролируемого input'а; парсится при submit.
   */
  manualFinalAmount?: string;
  items?: RetroEditItem[];
  vehicles?: RetroEditVehicle[];
};

/** Минимальная форма брони, нужная ретро-редактированию (структурно совместима с BookingDetail). */
export type RetroBooking = {
  id: string;
  projectName: string;
  comment?: string | null;
  discountPercent?: string | number | null;
  manualFinalAmount?: string | null;
  items: Array<{
    id: string;
    equipmentId: string | null;
    customName?: string | null;
    customUnitPrice?: string | number | null;
    quantity: number;
    customCategory?: string | null;
    equipment?: {
      id: string;
      name: string;
      category: string;
      brand?: string | null;
      model?: string | null;
    } | null;
  }>;
  vehicles?: Array<{
    id: string;
    driverName?: string | null;
    driverPhone?: string | null;
    vehicle?: { name?: string | null; currentMileage?: number | null } | null;
  }> | null;
};

export function useRetroEdit(args: {
  booking: RetroBooking | null;
  reloadBooking: () => Promise<void>;
}) {
  const { booking, reloadBooking } = args;
  const [retroEditMode, setRetroEditMode] = useState(false);
  const [retroEdits, setRetroEdits] = useState<RetroEditsState>({});
  const [retroBusy, setRetroBusy] = useState(false);
  /** Модалка для добавления новой позиции (equipment picker) */
  const [retroPickerOpen, setRetroPickerOpen] = useState(false);

  function enterRetroEdit() {
    if (!booking) return;
    setRetroEdits({
      projectName: booking.projectName,
      comment: booking.comment ?? "",
      discountPercent: booking.discountPercent ? Number(booking.discountPercent) : null,
      manualFinalAmount: booking.manualFinalAmount ?? "",
      vehicles: (booking.vehicles ?? []).map((v) => ({
        bookingVehicleId: v.id,
        vehicleName: v.vehicle?.name ?? "Машина",
        originalCurrentMileage: v.vehicle?.currentMileage ?? 0,
        driverName: v.driverName ?? "",
        driverPhone: v.driverPhone ?? "",
        endMileage: "",
        originalDriverName: v.driverName ?? "",
        originalDriverPhone: v.driverPhone ?? "",
      })),
      items: booking.items.map((it) => ({
        id: it.id,
        equipmentId: it.equipmentId,
        customName: it.customName ?? null,
        customUnitPrice: it.customUnitPrice ? Number(it.customUnitPrice) : null,
        quantity: it.quantity,
        equipment: it.equipment
          ? {
              id: it.equipment.id,
              name: it.equipment.name,
              category: it.equipment.category,
              brand: it.equipment.brand ?? null,
              model: it.equipment.model ?? null,
            }
          : null,
        customCategory: it.customCategory ?? null,
        originalQuantity: it.quantity,
      })),
    });
    setRetroEditMode(true);
  }

  function cancelRetroEdit() {
    setRetroEditMode(false);
    setRetroEdits({});
    setRetroPickerOpen(false);
  }

  /** Обновляет одно поле машины в retro-edit. */
  function updateRetroVehicle(
    bookingVehicleId: string,
    patch: Partial<Pick<RetroEditVehicle, "driverName" | "driverPhone" | "endMileage">>,
  ) {
    setRetroEdits((s) => ({
      ...s,
      vehicles: s.vehicles?.map((v) =>
        v.bookingVehicleId === bookingVehicleId ? { ...v, ...patch } : v,
      ),
    }));
  }

  /** Меняет qty конкретной позиции в retro-edit. */
  function updateRetroItemQty(itemId: string, qty: number) {
    setRetroEdits((s) => ({
      ...s,
      items: s.items?.map((i) => (i.id === itemId ? { ...i, quantity: Math.max(0, qty) } : i)),
    }));
  }

  /** Помечает на удаление / возвращает обратно. */
  function toggleRetroItemDeleted(itemId: string) {
    setRetroEdits((s) => ({
      ...s,
      items: s.items
        ?.map((i) => (i.id === itemId ? { ...i, _deleted: !i._deleted } : i))
        // Если строка _added и _deleted одновременно — просто убираем из массива
        // (она ещё не сохранена в БД, нет смысла держать как strikethrough).
        .filter((i) => !(i._added && i._deleted)),
    }));
  }

  /** Добавляет новую позицию из equipment-picker'а. */
  function addRetroItemFromEquipment(eq: {
    id: string;
    name: string;
    category: string;
    brand?: string | null;
    model?: string | null;
  }) {
    setRetroEdits((s) => {
      const items = s.items ?? [];
      // Если такое equipment уже есть — не дублируем, увеличиваем qty.
      const existing = items.find(
        (i) => i.equipmentId === eq.id && !i._deleted,
      );
      if (existing) {
        return {
          ...s,
          items: items.map((i) =>
            i.id === existing.id ? { ...i, quantity: i.quantity + 1 } : i,
          ),
        };
      }
      const newId = `__new-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      return {
        ...s,
        items: [
          ...items,
          {
            id: newId,
            equipmentId: eq.id,
            customName: null,
            customUnitPrice: null,
            quantity: 1,
            equipment: {
              id: eq.id,
              name: eq.name,
              category: eq.category,
              brand: eq.brand ?? null,
              model: eq.model ?? null,
            },
            customCategory: null,
            originalQuantity: 0,
            _added: true,
          },
        ],
      };
    });
    setRetroPickerOpen(false);
  }

  async function saveRetroEdit() {
    if (!booking || retroBusy) return;
    setRetroBusy(true);
    try {
      const body: Record<string, unknown> = { retroactive: true };
      if (retroEdits.projectName !== undefined && retroEdits.projectName !== booking.projectName) {
        body.projectName = retroEdits.projectName;
      }
      const currentComment = booking.comment ?? "";
      const nextComment = retroEdits.comment ?? "";
      if (nextComment !== currentComment) {
        body.comment = nextComment === "" ? null : nextComment;
      }
      const currentDiscount = booking.discountPercent ? Number(booking.discountPercent) : null;
      const nextDiscount = retroEdits.discountPercent ?? null;
      if (nextDiscount !== currentDiscount) {
        body.discountPercent = nextDiscount;
      }

      // manualFinalAmount: пустая строка → null (очистить override),
      // непустая → парсим число. Сравниваем с текущим (string).
      const currentOverride = booking.manualFinalAmount ?? "";
      const nextOverrideRaw = (retroEdits.manualFinalAmount ?? "").trim();
      if (nextOverrideRaw !== currentOverride) {
        if (nextOverrideRaw === "") {
          body.manualFinalAmount = null;
        } else {
          // WEB-1: parseFloat("12 000") === 12 — молча резал суммы с пробелами
          // (включая NBSP из ru-RU форматирования). Убираем разделители и парсим
          // строго через Number: мусор даёт NaN и отсекается проверкой ниже.
          const n = Number(nextOverrideRaw.replace(/[\s  ]/g, "").replace(",", "."));
          if (!Number.isFinite(n) || n < 0) {
            toast.error("Итог брони должен быть неотрицательным числом");
            return;
          }
          body.manualFinalAmount = n;
        }
      }

      // Items — отправляем если что-то поменялось (qty, состав).
      // Backend (PATCH с items) делает полную замену: deleteMany + createMany.
      // Фильтруем _deleted и строки с qty=0; backend требует minLength=1.
      const editedItems = retroEdits.items ?? [];
      const itemsChanged =
        editedItems.length !== booking.items.length ||
        editedItems.some(
          (i) =>
            i._added ||
            i._deleted ||
            i.quantity !== (i.originalQuantity ?? i.quantity),
        );
      if (itemsChanged) {
        const filtered = editedItems.filter((i) => !i._deleted && i.quantity > 0);
        if (filtered.length === 0) {
          toast.error("Нельзя оставить бронь без позиций — отмените удаление хотя бы одной.");
          return;
        }
        body.items = filtered.map((i) => ({
          equipmentId: i.equipmentId,
          quantity: i.quantity,
          customName: i.customName ?? undefined,
          customUnitPrice: i.customUnitPrice ?? undefined,
        }));
      }

      // Транспорт: формируем vehicleEdits — только реально изменившиеся поля
      // по каждой машине, чтобы не дёргать BookingVehicle.update без нужды.
      const editedVehicles = retroEdits.vehicles ?? [];
      const vehicleEdits: Array<{
        bookingVehicleId: string;
        driverName?: string | null;
        driverPhone?: string | null;
        endMileage?: number;
      }> = [];
      for (const v of editedVehicles) {
        const patch: {
          bookingVehicleId: string;
          driverName?: string | null;
          driverPhone?: string | null;
          endMileage?: number;
        } = { bookingVehicleId: v.bookingVehicleId };
        if (v.driverName !== v.originalDriverName) {
          patch.driverName = v.driverName.trim() === "" ? null : v.driverName.trim();
        }
        if (v.driverPhone !== v.originalDriverPhone) {
          patch.driverPhone = v.driverPhone.trim() === "" ? null : v.driverPhone.trim();
        }
        const trimmed = v.endMileage.trim();
        if (trimmed !== "") {
          const n = Number.parseInt(trimmed, 10);
          if (!Number.isFinite(n) || n < 0) {
            toast.error(`Пробег "${v.vehicleName}" должен быть целым числом ≥ 0`);
            return;
          }
          if (n < v.originalCurrentMileage) {
            toast.error(
              `Пробег "${v.vehicleName}" не может уменьшаться (было ${v.originalCurrentMileage} км)`,
            );
            return;
          }
          if (n !== v.originalCurrentMileage) {
            patch.endMileage = n;
          }
        }
        // Если в патче только bookingVehicleId — изменений нет, пропускаем
        if (Object.keys(patch).length > 1) vehicleEdits.push(patch);
      }
      if (vehicleEdits.length > 0) {
        body.vehicleEdits = vehicleEdits;
      }

      if (Object.keys(body).length === 1) {
        // Только retroactive: true — нет реальных изменений.
        toast.info("Нет изменений для сохранения");
        setRetroEditMode(false);
        return;
      }
      await apiFetch(`/api/bookings/${booking.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      toast.success("Изменения сохранены. Запись в аудит-логе.");
      setRetroEditMode(false);
      setRetroEdits({});
      await reloadBooking();
    } catch (e: any) {
      toast.error(e?.message ?? "Не удалось сохранить изменения");
    } finally {
      setRetroBusy(false);
    }
  }

  return {
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
  };
}
