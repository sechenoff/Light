"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../src/lib/api";
import { SectionHeader } from "../../src/components/SectionHeader";
import { StatusPill } from "../../src/components/StatusPill";
import { useRequireRole } from "../../src/hooks/useRequireRole";
import { BOOKING_STATUS_LABELS } from "../../src/components/finance/StatusCell";

interface ActiveBookingRef {
  bookingId: string;
  projectName: string;
  clientName: string | null;
  startDate: string;
  endDate: string;
  status: "CONFIRMED" | "ISSUED";
  isCurrent: boolean;
}

interface VehicleSummary {
  id: string;
  name: string;
  slug: string;
  licensePlate: string | null;
  currentMileage: number;
  lastServiceAt: string | null;
  lastServiceMileage: number | null;
  lastServiceKind: string | null;
  notes: string | null;
  active: boolean;
  activeBooking: ActiveBookingRef | null;
}

const SERVICE_KIND_LABEL: Record<string, string> = {
  SCHEDULED_TO: "Плановое ТО",
  OIL_CHANGE: "Замена масла",
  TIRE_CHANGE: "Шиномонтаж",
  REPAIR: "Ремонт",
  INSPECTION: "Диагностика",
  OTHER: "Прочее",
};

function formatKm(n: number): string {
  return n.toLocaleString("ru-RU") + " км";
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Moscow",
  });
}

/** Короткая дата «дд.мм» — для компактного диапазона брони в списке. */
function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Europe/Moscow",
  });
}

/** Дней с последнего ТО. Возвращает null если даты нет. */
function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return 0;
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

export default function VehiclesPage() {
  const { user, loading: roleLoading } = useRequireRole([
    "SUPER_ADMIN",
    "WAREHOUSE",
    "TECHNICIAN",
  ]);
  const [vehicles, setVehicles] = useState<VehicleSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (roleLoading || !user) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await apiFetch<{ vehicles: VehicleSummary[] }>(
          "/api/vehicles/fleet?includeInactive=1",
        );
        if (cancelled) return;
        setVehicles(data.vehicles);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Не удалось загрузить автопарк");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [roleLoading, user]);

  if (roleLoading || !user) {
    return <div className="p-8 text-ink-3">Загрузка...</div>;
  }

  return (
    <div className="p-4">
      <SectionHeader
        eyebrow="Автопарк"
        title="Машины"
        actions={
          user.role === "SUPER_ADMIN" ? (
            <Link
              href="/admin/vehicles"
              className="text-xs text-accent-bright hover:text-accent font-medium"
            >
              Управление тарифами →
            </Link>
          ) : undefined
        }
      />

      <div className="mt-4 rounded-lg border border-border bg-surface shadow-xs overflow-hidden">
        <div className="overflow-auto">
          <table className="min-w-[860px] w-full text-sm">
            <thead className="bg-slate--soft text-ink-2 border-b border-border">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Машина</th>
                <th className="text-left px-3 py-2 font-medium">Гос. номер</th>
                <th className="text-right px-3 py-2 font-medium">Пробег</th>
                <th className="text-left px-3 py-2 font-medium">Занятость</th>
                <th className="text-left px-3 py-2 font-medium">Последнее ТО / ремонт</th>
                <th className="text-left px-3 py-2 font-medium">Статус</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {vehicles === null && !error && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-ink-3">
                    Загрузка...
                  </td>
                </tr>
              )}
              {error && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-rose">
                    {error}
                  </td>
                </tr>
              )}
              {vehicles && vehicles.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-ink-3">
                    В парке пока нет машин
                  </td>
                </tr>
              )}
              {vehicles?.map((v) => {
                const days = daysSince(v.lastServiceAt);
                return (
                  <tr
                    key={v.id}
                    className="border-t border-border hover:bg-surface-muted transition-colors"
                  >
                    <td className="px-3 py-2">
                      <span className="text-ink font-medium">{v.name}</span>
                    </td>
                    <td className="px-3 py-2 text-ink-2 mono-num">
                      {v.licensePlate?.trim() || <span className="text-ink-3">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right mono-num text-ink">
                      {formatKm(v.currentMileage)}
                    </td>
                    <td className="px-3 py-2">
                      {v.activeBooking ? (
                        <Link
                          href={`/bookings/${v.activeBooking.bookingId}`}
                          className="group inline-flex flex-col gap-0.5"
                        >
                          <span className="inline-flex items-center gap-1.5">
                            <StatusPill
                              variant={v.activeBooking.isCurrent ? "warn" : "info"}
                              label={
                                v.activeBooking.isCurrent
                                  ? "На брони"
                                  : BOOKING_STATUS_LABELS[v.activeBooking.status] ??
                                    v.activeBooking.status
                              }
                            />
                            <span className="text-xs text-ink-3 mono-num">
                              {formatShortDate(v.activeBooking.startDate)}–
                              {formatShortDate(v.activeBooking.endDate)}
                            </span>
                          </span>
                          <span className="text-xs text-accent-bright group-hover:text-accent truncate max-w-[220px]">
                            {v.activeBooking.clientName ?? v.activeBooking.projectName}
                          </span>
                        </Link>
                      ) : (
                        <span className="text-xs text-ink-3">Свободна</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-ink-2">
                      {v.lastServiceAt ? (
                        <span>
                          {formatDate(v.lastServiceAt)}
                          {v.lastServiceKind && (
                            <span className="text-ink-3"> · {SERVICE_KIND_LABEL[v.lastServiceKind] ?? v.lastServiceKind}</span>
                          )}
                          {days !== null && days > 0 && (
                            <span className="text-ink-3"> · {days} дн. назад</span>
                          )}
                        </span>
                      ) : (
                        <span className="text-ink-3">Записей нет</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {v.active ? (
                        <StatusPill variant="ok" label="Активна" />
                      ) : (
                        <StatusPill variant="none" label="Не активна" />
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Link
                        className="text-xs text-accent-bright hover:text-accent font-medium"
                        href={`/vehicles/${v.id}`}
                      >
                        Открыть
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
