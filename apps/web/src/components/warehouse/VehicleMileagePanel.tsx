"use client";

/**
 * Блок «Пробег машин» на возврате.
 *
 * Логика:
 * - Загружает список машин брони (`/api/warehouse/sessions/:id/vehicles`),
 *   включая `currentMileage` для отображения «было / стало».
 * - Если в брони нет машин — рендерит ничего (и репортит valid=true).
 * - По каждой машине обязательно введённое целое число ≥ currentMileage.
 * - При attemptedSubmit=true показывает per-row ошибки.
 *
 * Контракт наружу:
 * - `onChange(entries)` — массив `{ vehicleId, mileage }` готовый под backend.
 *   До прохождения валидации возвращается частично заполненный массив (пустые
 *   поля исключаются) — родитель использует только valid=true для разрешения
 *   submit.
 * - `onValidityChange(valid)` — все ли строки заполнены и проходят
 *   constraint mileage ≥ currentMileage.
 */

import { useEffect, useMemo, useState } from "react";

import { scanApi } from "./api";
import type { SessionVehicle } from "./api";
import type { VehicleMileageEntry } from "./types";

interface VehicleMileagePanelProps {
  sessionId: string;
  attemptedSubmit: boolean;
  onChange: (entries: VehicleMileageEntry[]) => void;
  onValidityChange: (valid: boolean) => void;
}

interface VehicleRowState {
  /** «сырой» ввод из <input> — пустая строка пока не заполнено. */
  raw: string;
}

function formatMileage(km: number): string {
  return km.toLocaleString("ru-RU");
}

export function VehicleMileagePanel({
  sessionId,
  attemptedSubmit,
  onChange,
  onValidityChange,
}: VehicleMileagePanelProps) {
  const [vehicles, setVehicles] = useState<SessionVehicle[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [inputs, setInputs] = useState<Record<string, VehicleRowState>>({});

  // Подтягиваем список машин брони. Cancelled-flag паттерн для guard'a
  // от set-state после unmount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await scanApi.listSessionVehicles(sessionId);
        if (cancelled) return;
        setVehicles(list);
      } catch (err) {
        if (cancelled) return;
        setLoadError(
          err instanceof Error
            ? err.message
            : "Не удалось загрузить машины брони",
        );
        setVehicles([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Считаем текущую валидность + entries при любом изменении ввода / списка.
  const { entries, allValid, perRowErrors } = useMemo(() => {
    if (!vehicles || vehicles.length === 0) {
      return {
        entries: [] as VehicleMileageEntry[],
        allValid: true,
        perRowErrors: {} as Record<string, string>,
      };
    }
    const computed: VehicleMileageEntry[] = [];
    const errs: Record<string, string> = {};
    let valid = true;
    for (const v of vehicles) {
      const state = inputs[v.vehicleId];
      const raw = (state?.raw ?? "").trim();
      if (raw === "") {
        valid = false;
        errs[v.vehicleId] = "Введите пробег";
        continue;
      }
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== raw) {
        valid = false;
        errs[v.vehicleId] = "Только целое число ≥ 0";
        continue;
      }
      const min = v.vehicle?.currentMileage ?? 0;
      if (parsed < min) {
        valid = false;
        errs[v.vehicleId] = `Меньше текущего (${formatMileage(min)} км). Одометр не уменьшается.`;
        continue;
      }
      computed.push({ vehicleId: v.vehicleId, mileage: parsed });
    }
    return { entries: computed, allValid: valid, perRowErrors: errs };
  }, [vehicles, inputs]);

  // Сообщаем родителю текущее состояние.
  useEffect(() => {
    onChange(entries);
  }, [entries, onChange]);

  useEffect(() => {
    onValidityChange(allValid);
  }, [allValid, onValidityChange]);

  if (vehicles === null) {
    return (
      <section className="mt-4 rounded-lg border border-border bg-surface p-3">
        <p className="eyebrow text-ink-3">Пробег машин</p>
        <p className="mt-2 text-sm text-ink-3">Загрузка...</p>
      </section>
    );
  }

  if (vehicles.length === 0) {
    if (loadError) {
      return (
        <section className="mt-4 rounded-lg border border-rose-border bg-rose-soft p-3 text-sm text-rose">
          {loadError}
        </section>
      );
    }
    return null;
  }

  return (
    <section
      className="mt-4 rounded-lg border border-border bg-surface shadow-xs"
      aria-labelledby="mileage-panel-title"
    >
      <header className="border-b border-border px-3 py-2">
        <p id="mileage-panel-title" className="eyebrow">
          Пробег машин
        </p>
        <p className="mt-1 text-xs text-ink-3">
          Введите итоговый одометр для каждой машины перед завершением возврата.
        </p>
      </header>
      <ul className="divide-y divide-border">
        {vehicles.map((v) => {
          const name = v.vehicle?.name ?? "Машина";
          const current = v.vehicle?.currentMileage ?? 0;
          const raw = inputs[v.vehicleId]?.raw ?? "";
          const rowErr = attemptedSubmit ? perRowErrors[v.vehicleId] : undefined;
          const inputId = `vehicle-mileage-${v.vehicleId}`;
          const errId = `${inputId}-err`;
          return (
            <li key={v.id} className="px-3 py-3">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-ink font-medium">{name}</p>
                  <p className="text-xs text-ink-3 mono-num">
                    было {formatMileage(current)} км
                  </p>
                </div>
                <div className="flex items-center gap-2 mt-1 sm:mt-0">
                  <label htmlFor={inputId} className="sr-only">
                    Пробег для {name}
                  </label>
                  <input
                    id={inputId}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    step={1}
                    placeholder="итоговый, км"
                    value={raw}
                    aria-invalid={Boolean(rowErr) || undefined}
                    aria-describedby={rowErr ? errId : undefined}
                    onChange={(e) =>
                      setInputs((prev) => ({
                        ...prev,
                        [v.vehicleId]: { raw: e.target.value },
                      }))
                    }
                    className={`mono-num w-32 rounded border px-2 py-1 text-sm bg-surface text-ink focus:outline-none focus:ring-1 focus:ring-accent ${
                      rowErr ? "border-rose-border" : "border-border"
                    }`}
                  />
                  <span className="text-xs text-ink-3">км</span>
                </div>
              </div>
              {rowErr ? (
                <p id={errId} className="mt-1 text-xs text-rose">
                  {rowErr}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
