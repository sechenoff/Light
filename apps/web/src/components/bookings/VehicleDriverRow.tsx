"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api";
import { toast } from "../ToastProvider";

interface Vehicle {
  id: string;
  vehicle?: { id: string; name: string; slug: string } | null;
  driverName?: string | null;
  driverPhone?: string | null;
  withGenerator?: boolean;
  shiftHours?: string | null;
  kmOutsideMkad?: number | null;
  ttkEntry?: boolean;
}

interface Props {
  bookingId: string;
  vehicle: Vehicle;
  canEdit: boolean;
  onUpdated?: (next: { driverName: string | null; driverPhone: string | null }) => void;
}

/**
 * Строка с водителем для одной машины брони.
 * Read-only показ + inline-редактор (имя + телефон). Доступ к редактированию
 * у SUPER_ADMIN и WAREHOUSE — заполняется при погрузке.
 */
export function VehicleDriverRow({ bookingId, vehicle, canEdit, onUpdated }: Props) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(vehicle.driverName ?? "");
  const [phone, setPhone] = useState(vehicle.driverPhone ?? "");
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && nameRef.current) {
      nameRef.current.focus();
      nameRef.current.select();
    }
  }, [editing]);

  // Если родитель присылает свежие данные после ре-фетча — отражаем их в локальном состоянии.
  useEffect(() => {
    if (!editing) {
      setName(vehicle.driverName ?? "");
      setPhone(vehicle.driverPhone ?? "");
    }
  }, [vehicle.driverName, vehicle.driverPhone, editing]);

  const vehicleName = vehicle.vehicle?.name ?? "Машина";
  const specs: string[] = [];
  if (vehicle.shiftHours) specs.push(`${vehicle.shiftHours} ч`);
  if (vehicle.withGenerator) specs.push("+ генератор");
  if (vehicle.kmOutsideMkad != null && vehicle.kmOutsideMkad > 0) {
    specs.push(`+ ${vehicle.kmOutsideMkad} км за МКАД`);
  }
  if (vehicle.ttkEntry) specs.push("+ ТТК");

  async function save() {
    const trimmedName = name.trim();
    const trimmedPhone = phone.trim();
    setSaving(true);
    try {
      const res = await apiFetch<{
        vehicle: { id: string; driverName: string | null; driverPhone: string | null };
      }>(`/api/bookings/${bookingId}/vehicles/${vehicle.id}/driver`, {
        method: "PATCH",
        body: JSON.stringify({
          driverName: trimmedName || null,
          driverPhone: trimmedPhone || null,
        }),
      });
      onUpdated?.({
        driverName: res.vehicle.driverName,
        driverPhone: res.vehicle.driverPhone,
      });
      setEditing(false);
      toast.success("Водитель обновлён");
    } catch (e: any) {
      toast.error(e?.message ?? "Не удалось сохранить водителя");
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    setName(vehicle.driverName ?? "");
    setPhone(vehicle.driverPhone ?? "");
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="rounded border border-accent-border bg-accent-soft p-3 space-y-2">
        <div className="text-xs text-ink-3 flex items-center gap-2">
          <span aria-hidden>🚐</span>
          <span className="font-medium text-ink-2">{vehicleName}</span>
          {specs.length > 0 && <span>· {specs.join(" · ")}</span>}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_180px_auto] gap-2 items-start">
          <input
            ref={nameRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ФИО водителя"
            maxLength={120}
            disabled={saving}
            className="rounded border border-border bg-surface px-2 py-1.5 text-sm focus:outline-none focus:border-accent-bright"
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") cancel();
            }}
            aria-label="ФИО водителя"
          />
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+7 (___) ___-__-__"
            maxLength={40}
            disabled={saving}
            className="rounded border border-border bg-surface px-2 py-1.5 text-sm focus:outline-none focus:border-accent-bright"
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") cancel();
            }}
            aria-label="Телефон водителя"
          />
          <div className="flex gap-1 shrink-0">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="rounded bg-accent-bright text-white px-3 py-1.5 text-sm disabled:opacity-50 hover:bg-accent transition-colors"
            >
              {saving ? "Сохраняю…" : "Сохранить"}
            </button>
            <button
              type="button"
              onClick={cancel}
              disabled={saving}
              className="rounded border border-border bg-surface px-3 py-1.5 text-sm hover:bg-surface-muted transition-colors"
            >
              Отмена
            </button>
          </div>
        </div>
        <p className="text-xs text-ink-3">Enter — сохранить · Esc — отмена</p>
      </div>
    );
  }

  return (
    <div className="rounded border border-border bg-surface p-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-ink">
            <span aria-hidden>🚐</span>
            {vehicleName}
          </div>
          {specs.length > 0 && (
            <div className="text-xs text-ink-3 mt-1">{specs.join(" · ")}</div>
          )}
        </div>
        <div className="text-sm text-right">
          {vehicle.driverName ? (
            <>
              <div className="font-medium text-ink flex items-center gap-1.5 justify-end">
                <span aria-hidden>👤</span>
                <span>{vehicle.driverName}</span>
              </div>
              {vehicle.driverPhone && (
                <div className="text-xs text-ink-2 mt-1">
                  <a
                    href={`tel:${vehicle.driverPhone}`}
                    className="hover:text-accent-bright"
                  >
                    {vehicle.driverPhone}
                  </a>
                </div>
              )}
            </>
          ) : (
            <span className="text-xs text-ink-3 italic">Водитель не указан</span>
          )}
        </div>
      </div>
      {canEdit && (
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-xs text-accent-bright hover:underline"
          >
            {vehicle.driverName ? "Изменить водителя" : "+ Добавить водителя"}
          </button>
        </div>
      )}
    </div>
  );
}
