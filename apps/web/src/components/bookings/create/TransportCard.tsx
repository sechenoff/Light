"use client";

import { formatMoneyRub } from "../../../lib/format";
import type { VehicleRow, TransportBreakdown, SelectedVehicle } from "./types";

type TransportCardProps = {
  vehicles: VehicleRow[];
  selected: SelectedVehicle[];
  /** Toggle a vehicle on/off. When enabling, parent seeds default params. */
  onToggleVehicle: (vehicleId: string, checked: boolean) => void;
  /** Patch one field of one selected vehicle. */
  onPatchVehicle: (vehicleId: string, patch: Partial<SelectedVehicle>) => void;
  /** Per-vehicle breakdowns keyed by vehicleId (from quote or local calc). */
  breakdownByVehicleId: Record<string, TransportBreakdown>;
};

export function TransportCard({
  vehicles,
  selected,
  onToggleVehicle,
  onPatchVehicle,
  breakdownByVehicleId,
}: TransportCardProps) {
  const selectedById = new Map(selected.map((s) => [s.vehicleId, s]));
  const totalAll = selected.reduce(
    (acc, s) => acc + Number(breakdownByVehicleId[s.vehicleId]?.total ?? 0),
    0,
  );

  return (
    <section className="rounded-lg border border-border bg-surface p-5 shadow-xs">
      <h2 className="mb-1 text-sm font-semibold text-ink">4. Транспорт</h2>
      <p className="mb-4 text-xs text-ink-3">
        {selected.length === 0
          ? "Без транспорта — отметьте машины ниже"
          : `Выбрано машин: ${selected.length}`}
      </p>

      <div className="flex flex-col gap-3">
        {vehicles.map((vehicle) => {
          const sel = selectedById.get(vehicle.id) ?? null;
          const isSelected = sel !== null;
          const breakdown = breakdownByVehicleId[vehicle.id] ?? null;
          return (
            <div
              key={vehicle.id}
              className={[
                "rounded-md border",
                isSelected ? "border-accent bg-accent-soft" : "border-border",
              ].join(" ")}
            >
              <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-surface-muted">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={(e) => onToggleVehicle(vehicle.id, e.target.checked)}
                  className="h-4 w-4 accent-accent"
                  aria-label={`Выбрать машину ${vehicle.name}`}
                />
                <span className="flex-1 text-sm text-ink">{vehicle.name}</span>
                <span className="mono-num text-sm text-ink-3">
                  {formatMoneyRub(Number(vehicle.shiftPriceRub))} ₽/смена
                </span>
              </label>

              {isSelected && sel && (
                <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
                  {/* Generator option */}
                  {vehicle.hasGeneratorOption && (
                    <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
                      <input
                        type="checkbox"
                        checked={sel.withGenerator}
                        onChange={(e) =>
                          onPatchVehicle(vehicle.id, { withGenerator: e.target.checked })
                        }
                        className="h-4 w-4 accent-accent"
                        aria-label={`Генератор для ${vehicle.name}`}
                      />
                      <span>
                        + Генератор{" "}
                        {vehicle.generatorPriceRub && (
                          <span className="text-ink-2">
                            (+{formatMoneyRub(Number(vehicle.generatorPriceRub))} ₽)
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
                      value={sel.shiftHours}
                      onChange={(e) =>
                        onPatchVehicle(vehicle.id, {
                          shiftHours: Math.max(1, Number(e.target.value)),
                        })
                      }
                      className="w-20 rounded border border-border bg-surface px-2 py-1 text-sm text-ink focus:border-accent focus:outline-none"
                      aria-label={`Часы смены для ${vehicle.name}`}
                    />
                    <span className="text-xs text-ink-3">ч.</span>
                  </div>

                  {/* Skip overtime */}
                  <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      checked={sel.skipOvertime}
                      onChange={(e) =>
                        onPatchVehicle(vehicle.id, { skipOvertime: e.target.checked })
                      }
                      className="h-4 w-4 accent-accent"
                      aria-label={`Без переработки для ${vehicle.name}`}
                    />
                    <span>Без переработки</span>
                  </label>

                  {/* Outside MKAD */}
                  <div className="flex flex-col gap-2">
                    <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
                      <input
                        type="checkbox"
                        checked={sel.kmOutsideMkad > 0}
                        onChange={(e) =>
                          onPatchVehicle(vehicle.id, {
                            kmOutsideMkad: e.target.checked ? sel.kmOutsideMkad || 1 : 0,
                          })
                        }
                        className="h-4 w-4 accent-accent"
                        aria-label={`Выезд за МКАД для ${vehicle.name}`}
                      />
                      <span>Выезд за МКАД (120 ₽/км × туда-обратно)</span>
                    </label>
                    {sel.kmOutsideMkad > 0 && (
                      <div className="ml-6 flex items-center gap-2">
                        <input
                          type="number"
                          min={0}
                          value={sel.kmOutsideMkad}
                          onChange={(e) =>
                            onPatchVehicle(vehicle.id, {
                              kmOutsideMkad: Math.max(0, Number(e.target.value)),
                            })
                          }
                          className="w-24 rounded border border-border bg-surface px-2 py-1 text-sm text-ink focus:border-accent focus:outline-none"
                          placeholder="0"
                          aria-label={`Километры за МКАД для ${vehicle.name}`}
                        />
                        <span className="text-xs text-ink-3">км до площадки</span>
                      </div>
                    )}
                  </div>

                  {/* TTK entry */}
                  <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      checked={sel.ttkEntry}
                      onChange={(e) =>
                        onPatchVehicle(vehicle.id, { ttkEntry: e.target.checked })
                      }
                      className="h-4 w-4 accent-accent"
                      aria-label={`Заезд в ТТК для ${vehicle.name}`}
                    />
                    <span>Заезд в ТТК (+500 ₽)</span>
                  </label>

                  {/* Per-vehicle breakdown */}
                  {breakdown && (
                    <div className="mt-1 rounded-md border border-border bg-surface-muted p-3 text-xs">
                      <div className="flex flex-col gap-0.5 text-ink-2">
                        <div className="flex justify-between">
                          <span>Смена</span>
                          <span className="mono-num">
                            {formatMoneyRub(Number(breakdown.shiftRate))} ₽
                          </span>
                        </div>
                        {Number(breakdown.overtime) > 0 && (
                          <div className="flex justify-between">
                            <span>Переработка ({breakdown.overtimeHours} ч.)</span>
                            <span className="mono-num">
                              {formatMoneyRub(Number(breakdown.overtime))} ₽
                            </span>
                          </div>
                        )}
                        {Number(breakdown.km) > 0 && (
                          <div className="flex justify-between">
                            <span>За МКАД ({sel.kmOutsideMkad} км)</span>
                            <span className="mono-num">
                              {formatMoneyRub(Number(breakdown.km))} ₽
                            </span>
                          </div>
                        )}
                        {Number(breakdown.ttk) > 0 && (
                          <div className="flex justify-between">
                            <span>ТТК</span>
                            <span className="mono-num">
                              {formatMoneyRub(Number(breakdown.ttk))} ₽
                            </span>
                          </div>
                        )}
                        <div className="mt-1 flex justify-between border-t border-border pt-1 font-semibold text-ink">
                          <span>Итого {vehicle.name}</span>
                          <span className="mono-num">
                            {formatMoneyRub(Number(breakdown.total))} ₽
                          </span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Total across all selected vehicles */}
      {selected.length > 0 && (
        <div className="mt-4 flex justify-between border-t border-border pt-3 text-sm font-semibold text-ink">
          <span>Итого транспорт ({selected.length})</span>
          <span className="mono-num">{formatMoneyRub(totalAll)} ₽</span>
        </div>
      )}
    </section>
  );
}
