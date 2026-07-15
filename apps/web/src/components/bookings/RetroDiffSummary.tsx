"use client";

import { RetroDiffPanel } from "./RetroDiffPanel";
import type { RetroEditsState } from "./useRetroEdit";

// Сводка правок retro-режима (фаза 4.10, вынос из bookings/[id]/page.tsx,
// поведение 1:1): считает агрегаты из retroEdits и рендерит RetroDiffPanel.
// Ставится в самом верху правой колонки, чтобы оператор всегда видел сводку
// своих правок без необходимости скроллить.

export type RetroDiffBooking = {
  projectName: string;
  comment?: string | null;
  discountPercent?: string | number | null;
  manualFinalAmount?: string | null;
  finalAmount?: string | null;
};

export function RetroDiffSummary({
  booking,
  retroEdits,
}: {
  booking: RetroDiffBooking;
  retroEdits: RetroEditsState;
}) {
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
}
