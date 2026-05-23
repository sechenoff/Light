"use client";

/**
 * DriverPanel — карточка «Водители» на экране чек-листа.
 *
 * Где появляется: вверху IssueChecklist и ReturnChecklist (то есть прямо во
 * время погрузки/разгрузки). Цель — кузовщик спрашивает у того, кто грузится,
 * кто за рулём, вбивает ФИО + телефон → данные сохраняются на BookingVehicle
 * и подгружаются в карточку брони руководителя.
 *
 * Дизайн: kiosk-friendly. Крупные input'ы (touch-targets), яркие подписи,
 * accent-обводка чтобы блок не пропускали. Inline-сохранение по `blur` +
 * Enter; при ошибке — пилюля сверху, при успехе — галочка возле имени машины.
 */

import { useEffect, useRef, useState } from "react";
import { scanApi, type SessionVehicle } from "./api";
import { isScanApiError } from "./types";

interface Props {
  sessionId: string;
  /** "ISSUE" или "RETURN" — влияет только на копирайт подсказки. */
  operation: "ISSUE" | "RETURN";
}

export function DriverPanel({ sessionId, operation }: Props) {
  const [vehicles, setVehicles] = useState<SessionVehicle[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    void (async () => {
      try {
        const v = await scanApi.listSessionVehicles(sessionId);
        if (!cancelled) setVehicles(v);
      } catch (e) {
        if (!cancelled)
          setErr(isScanApiError(e) ? e.message : "Не удалось загрузить машины");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (loading) {
    return (
      <div className="mb-3 rounded-lg border border-accent-border bg-accent-soft p-3 text-sm text-ink-2">
        Загружаю машины…
      </div>
    );
  }

  if (err) {
    return (
      <div className="mb-3 rounded-lg border border-rose-border bg-rose-soft p-3 text-sm text-rose">
        {err}
      </div>
    );
  }

  if (!vehicles || vehicles.length === 0) {
    // На брони нет машин — блок не показываем (на проде такие тоже бывают).
    return null;
  }

  const hint =
    operation === "ISSUE"
      ? "Кто грузится за рулём? Вписать перед выдачей."
      : "Кто привёз машину? Вписать на приёмке.";

  return (
    <div className="mb-3 overflow-hidden rounded-lg border border-accent-border bg-surface shadow-xs">
      <div className="flex items-center justify-between gap-2 border-b border-accent-border bg-accent-soft px-3 py-2">
        <p className="eyebrow text-accent-bright">🚐 Водители</p>
        <span className="text-[11px] text-ink-3">
          {vehicles.length} {vehicles.length === 1 ? "машина" : vehicles.length < 5 ? "машины" : "машин"}
        </span>
      </div>
      <div className="p-3 space-y-2">
        {vehicles.map((v) => (
          <DriverRow
            key={v.id}
            sessionId={sessionId}
            vehicle={v}
            onUpdated={(next) => {
              setVehicles((prev) =>
                prev
                  ? prev.map((veh) =>
                      veh.id === v.id
                        ? { ...veh, driverName: next.driverName, driverPhone: next.driverPhone }
                        : veh,
                    )
                  : prev,
              );
            }}
          />
        ))}
        <p className="px-1 pt-1 text-[11px] text-ink-3">{hint}</p>
      </div>
    </div>
  );
}

function DriverRow({
  sessionId,
  vehicle,
  onUpdated,
}: {
  sessionId: string;
  vehicle: SessionVehicle;
  onUpdated: (next: { driverName: string | null; driverPhone: string | null }) => void;
}) {
  // Локальные input-значения. Сохраняем на blur + Enter.
  const [name, setName] = useState<string>(vehicle.driverName ?? "");
  const [phone, setPhone] = useState<string>(vehicle.driverPhone ?? "");
  const [saving, setSaving] = useState<null | "name" | "phone">(null);
  const [justSaved, setJustSaved] = useState(false);
  const [rowErr, setRowErr] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setName(vehicle.driverName ?? "");
    setPhone(vehicle.driverPhone ?? "");
  }, [vehicle.driverName, vehicle.driverPhone]);

  useEffect(() => {
    return () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, []);

  async function saveField(which: "name" | "phone", raw: string) {
    const trimmed = raw.trim();
    const current = which === "name" ? vehicle.driverName ?? "" : vehicle.driverPhone ?? "";
    if (trimmed === current) return; // ничего не менялось
    setSaving(which);
    setRowErr(null);
    try {
      const res = await scanApi.setSessionDriver(sessionId, vehicle.id, {
        [which === "name" ? "driverName" : "driverPhone"]: trimmed || null,
      });
      onUpdated({
        driverName: res.vehicle.driverName,
        driverPhone: res.vehicle.driverPhone,
      });
      setJustSaved(true);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setJustSaved(false), 1500);
    } catch (e) {
      setRowErr(isScanApiError(e) ? e.message : "Не сохранилось");
    } finally {
      setSaving(null);
    }
  }

  const vehicleName = vehicle.vehicle?.name ?? "Машина";

  return (
    <div className="rounded border border-border bg-surface p-3">
      <div className="mb-2 flex items-center gap-2 text-sm">
        <span aria-hidden>🚐</span>
        <span className="font-semibold text-ink">{vehicleName}</span>
        {justSaved && (
          <span className="text-[11px] text-emerald" aria-live="polite">✓ сохранено</span>
        )}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_180px]">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-ink-3">ФИО водителя</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={(e) => void saveField("name", e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            placeholder="Например, Лёша"
            maxLength={120}
            disabled={saving === "name"}
            className="rounded border border-border bg-surface px-2 py-2 text-sm focus:border-accent-bright focus:outline-none disabled:opacity-50"
            aria-label={`ФИО водителя для ${vehicleName}`}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-ink-3">Телефон</span>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            onBlur={(e) => void saveField("phone", e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            placeholder="+7 (___) ___-__-__"
            maxLength={40}
            disabled={saving === "phone"}
            className="rounded border border-border bg-surface px-2 py-2 text-sm focus:border-accent-bright focus:outline-none disabled:opacity-50"
            aria-label={`Телефон водителя для ${vehicleName}`}
          />
        </label>
      </div>
      {rowErr && (
        <p className="mt-2 text-[11px] text-rose">{rowErr}</p>
      )}
    </div>
  );
}
