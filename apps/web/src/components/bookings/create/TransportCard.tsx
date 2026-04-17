"use client";

import { useState } from "react";
import { formatMoneyRub } from "../../../lib/format";
import type { VehicleRow, TransportBreakdown } from "./types";

type TransportCardProps = {
  vehicles: VehicleRow[];
  selectedVehicleId: string | null;
  onChangeVehicle: (id: string | null) => void;
  withGenerator: boolean;
  onChangeGenerator: (v: boolean) => void;
  shiftHours: number;
  onChangeShiftHours: (h: number) => void;
  skipOvertime: boolean;
  onChangeSkipOvertime: (v: boolean) => void;
  kmOutsideMkad: number;
  onChangeKm: (n: number) => void;
  ttkEntry: boolean;
  onChangeTtk: (v: boolean) => void;
  breakdown: TransportBreakdown | null;
};

export function TransportCard({
  vehicles,
  selectedVehicleId,
  onChangeVehicle,
  withGenerator,
  onChangeGenerator,
  shiftHours,
  onChangeShiftHours,
  skipOvertime,
  onChangeSkipOvertime,
  kmOutsideMkad,
  onChangeKm,
  ttkEntry,
  onChangeTtk,
  breakdown,
}: TransportCardProps) {
  const selectedVehicle = vehicles.find((v) => v.id === selectedVehicleId) ?? null;
  const [showKm, setShowKm] = useState(kmOutsideMkad > 0);

  function handleVehicleChange(id: string | null) {
    onChangeVehicle(id);
    // Reset generator if new vehicle doesn't support it
    if (id !== null) {
      const vehicle = vehicles.find((v) => v.id === id);
      if (!vehicle?.hasGeneratorOption) {
        onChangeGenerator(false);
      }
    }
  }

  function handleKmCheckbox(checked: boolean) {
    setShowKm(checked);
    if (!checked) onChangeKm(0);
  }

  return (
    <section className="rounded-lg border border-border bg-surface p-5 shadow-xs">
      <h2 className="mb-4 text-sm font-semibold text-ink">4. Транспорт</h2>

      {/* Vehicle radio list */}
      <div className="flex flex-col gap-2">
        {/* No transport option */}
        <label className="flex cursor-pointer items-center gap-3 rounded-md border border-border px-3 py-2.5 hover:bg-surface-muted">
          <input
            type="radio"
            name="transport-vehicle"
            checked={selectedVehicleId === null}
            onChange={() => handleVehicleChange(null)}
            className="h-4 w-4 accent-accent"
          />
          <span className="text-sm text-ink">Без транспорта</span>
        </label>

        {vehicles.map((vehicle) => (
          <label
            key={vehicle.id}
            className={[
              "flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2.5 hover:bg-surface-muted",
              selectedVehicleId === vehicle.id
                ? "border-accent bg-accent-soft"
                : "border-border",
            ].join(" ")}
          >
            <input
              type="radio"
              name="transport-vehicle"
              value={vehicle.id}
              checked={selectedVehicleId === vehicle.id}
              onChange={() => handleVehicleChange(vehicle.id)}
              className="h-4 w-4 accent-accent"
            />
            <span className="flex-1 text-sm text-ink">{vehicle.name}</span>
            <span className="mono-num text-sm text-ink-3">
              {formatMoneyRub(Number(vehicle.shiftPriceRub))} ₽/смена
            </span>
          </label>
        ))}
      </div>

      {/* Options — only when vehicle is selected */}
      {selectedVehicle && (
        <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4">
          {/* Generator option (Ивеко only) */}
          {selectedVehicle.hasGeneratorOption && (
            <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={withGenerator}
                onChange={(e) => onChangeGenerator(e.target.checked)}
                className="h-4 w-4 accent-accent"
              />
              <span>
                + Генератор{" "}
                {selectedVehicle.generatorPriceRub && (
                  <span className="text-ink-2">
                    (+{formatMoneyRub(Number(selectedVehicle.generatorPriceRub))} ₽)
                  </span>
                )}
              </span>
            </label>
          )}

          {/* Shift hours */}
          <div className="flex items-center gap-3">
            <label className="w-28 shrink-0 text-sm text-ink-2">Часы смены</label>
            <input
              type="number"
              min={1}
              max={24}
              value={shiftHours}
              onChange={(e) => onChangeShiftHours(Math.max(1, Number(e.target.value)))}
              className="w-20 rounded border border-border bg-surface px-2 py-1 text-sm text-ink focus:border-accent focus:outline-none"
            />
            <span className="text-xs text-ink-3">ч.</span>
          </div>

          {/* Skip overtime */}
          <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={skipOvertime}
              onChange={(e) => onChangeSkipOvertime(e.target.checked)}
              className="h-4 w-4 accent-accent"
            />
            <span>Без переработки</span>
          </label>

          {/* Outside MKAD */}
          <div className="flex flex-col gap-2">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={showKm}
                onChange={(e) => handleKmCheckbox(e.target.checked)}
                className="h-4 w-4 accent-accent"
              />
              <span>Выезд за МКАД (120 ₽/км × туда-обратно)</span>
            </label>
            {showKm && (
              <div className="ml-6 flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  value={kmOutsideMkad}
                  onChange={(e) => onChangeKm(Math.max(0, Number(e.target.value)))}
                  className="w-24 rounded border border-border bg-surface px-2 py-1 text-sm text-ink focus:border-accent focus:outline-none"
                  placeholder="0"
                />
                <span className="text-xs text-ink-3">км до площадки</span>
              </div>
            )}
          </div>

          {/* TTK entry */}
          <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={ttkEntry}
              onChange={(e) => onChangeTtk(e.target.checked)}
              className="h-4 w-4 accent-accent"
            />
            <span>Заезд в ТТК (+500 ₽)</span>
          </label>

          {/* Live breakdown */}
          {breakdown && (
            <div className="mt-1 rounded-md border border-border bg-surface-muted p-3 text-xs">
              <p className="mb-1 font-semibold text-ink">Расчёт транспорта:</p>
              <div className="flex flex-col gap-0.5 text-ink-2">
                <div className="flex justify-between">
                  <span>Смена ({selectedVehicle.name})</span>
                  <span className="mono-num">{formatMoneyRub(Number(breakdown.shiftRate))} ₽</span>
                </div>
                {Number(breakdown.overtime) > 0 && (
                  <div className="flex justify-between">
                    <span>Переработка ({breakdown.overtimeHours} ч.)</span>
                    <span className="mono-num">{formatMoneyRub(Number(breakdown.overtime))} ₽</span>
                  </div>
                )}
                {Number(breakdown.km) > 0 && (
                  <div className="flex justify-between">
                    <span>За МКАД ({kmOutsideMkad} км)</span>
                    <span className="mono-num">{formatMoneyRub(Number(breakdown.km))} ₽</span>
                  </div>
                )}
                {Number(breakdown.ttk) > 0 && (
                  <div className="flex justify-between">
                    <span>ТТК</span>
                    <span className="mono-num">{formatMoneyRub(Number(breakdown.ttk))} ₽</span>
                  </div>
                )}
                <div className="mt-1 flex justify-between border-t border-border pt-1 font-semibold text-ink">
                  <span>Итого транспорт</span>
                  <span className="mono-num">{formatMoneyRub(Number(breakdown.total))} ₽</span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

