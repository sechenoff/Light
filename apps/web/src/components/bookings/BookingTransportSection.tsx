"use client";

import { VehicleDriverRow } from "./VehicleDriverRow";
import type { UserRole } from "@/lib/auth";
import type { RetroEditVehicle } from "./useRetroEdit";

// Транспорт и водители — заполняется на погрузке (фаза 4.10, вынос из
// bookings/[id]/page.tsx, поведение 1:1). В retro-режиме — кастомная inline-форма
// driverName / driverPhone / endMileage: сохраняется централизованно через
// PATCH /api/bookings/:id с retroactive:true. VehicleDriverRow в retro-mode не
// используется — у него отдельный endpoint для warehouse kiosk и он не
// вписывается в общий save flow.

export type TransportVehicle = {
  id: string;
  driverName?: string | null;
  driverPhone?: string | null;
  withGenerator?: boolean;
  shiftHours?: string | null;
  kmOutsideMkad?: number | null;
  ttkEntry?: boolean;
  subtotalRub?: string | null;
  vehicle?: { id: string; name: string; slug: string } | null;
};

export interface BookingTransportSectionProps {
  bookingId: string;
  vehicles: TransportVehicle[] | null | undefined;
  userRole: UserRole | undefined;
  retroEditMode: boolean;
  retroVehicles: RetroEditVehicle[] | undefined;
  onUpdateRetroVehicle: (
    bookingVehicleId: string,
    patch: Partial<Pick<RetroEditVehicle, "driverName" | "driverPhone" | "endMileage">>,
  ) => void;
  onDriverUpdated: (
    bookingVehicleId: string,
    next: { driverName: string | null; driverPhone: string | null },
  ) => void;
}

export function BookingTransportSection({
  bookingId,
  vehicles,
  userRole,
  retroEditMode,
  retroVehicles,
  onUpdateRetroVehicle,
  onDriverUpdated,
}: BookingTransportSectionProps) {
  if ((vehicles?.length ?? 0) === 0) return null;
  const list = vehicles!;

  return (
    <div className="rounded-lg border border-accent-border bg-surface shadow-xs overflow-hidden">
      <div className="p-3 border-b border-accent-border bg-accent-soft flex items-center justify-between">
        <p className="eyebrow text-accent-bright">🚐 Транспорт и водители</p>
        <span className="text-xs text-ink-3">
          {list.length} {list.length === 1 ? "машина" : list.length < 5 ? "машины" : "машин"}
        </span>
      </div>
      <div className="p-3 space-y-2">
        {retroEditMode ? (
          (retroVehicles ?? []).map((rv) => {
            const original = list.find((v) => v.id === rv.bookingVehicleId);
            return (
              <div
                key={rv.bookingVehicleId}
                className="rounded-lg border border-amber-border bg-amber-soft/40 p-3 space-y-2"
              >
                <div className="flex items-baseline justify-between">
                  <p className="text-sm font-medium text-ink">{rv.vehicleName}</p>
                  <span className="text-xs text-ink-3 mono-num">
                    {original?.shiftHours ? `${original.shiftHours} ч` : ""}
                    {original?.kmOutsideMkad ? ` · ${original.kmOutsideMkad} км вне МКАД` : ""}
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <label className="block">
                    <span className="eyebrow block mb-1">Водитель</span>
                    <input
                      type="text"
                      value={rv.driverName}
                      onChange={(e) =>
                        onUpdateRetroVehicle(rv.bookingVehicleId, { driverName: e.target.value })
                      }
                      className="w-full rounded border border-amber-border bg-white px-2 py-1 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-amber"
                      placeholder="ФИО"
                    />
                  </label>
                  <label className="block">
                    <span className="eyebrow block mb-1">Телефон</span>
                    <input
                      type="text"
                      value={rv.driverPhone}
                      onChange={(e) =>
                        onUpdateRetroVehicle(rv.bookingVehicleId, { driverPhone: e.target.value })
                      }
                      className="w-full rounded border border-amber-border bg-white px-2 py-1 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-amber mono-num"
                      placeholder="+7 (XXX) XXX-XX-XX"
                    />
                  </label>
                  <label className="block">
                    <span className="eyebrow block mb-1">Пробег после смены, км</span>
                    <input
                      type="number"
                      min={rv.originalCurrentMileage}
                      step={1}
                      value={rv.endMileage}
                      onChange={(e) =>
                        onUpdateRetroVehicle(rv.bookingVehicleId, { endMileage: e.target.value })
                      }
                      placeholder={`≥ ${rv.originalCurrentMileage}`}
                      className="w-full rounded border border-amber-border bg-white px-2 py-1 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-amber mono-num"
                    />
                    <span className="block mt-1 text-xs text-ink-3">
                      было {rv.originalCurrentMileage.toLocaleString("ru-RU")} км
                    </span>
                  </label>
                </div>
              </div>
            );
          })
        ) : (
          list.map((v) => (
            <VehicleDriverRow
              key={v.id}
              bookingId={bookingId}
              vehicle={v}
              canEdit={userRole === "SUPER_ADMIN" || userRole === "WAREHOUSE"}
              onUpdated={(next) => onDriverUpdated(v.id, next)}
            />
          ))
        )}
        {(userRole === "SUPER_ADMIN" || userRole === "WAREHOUSE") && (
          <p className="text-xs text-ink-3 px-1 pt-1">
            Заполняется при погрузке — ведём учёт, кто ездил за рулём.
          </p>
        )}
      </div>
    </div>
  );
}
