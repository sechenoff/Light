"use client";

import type { AvailabilityRow, CatalogRowAdjustment } from "./types";
import { formatMoneyRub } from "../../../lib/format";

type Props = {
  row: AvailabilityRow;
  selectedQty: number;
  adjustment?: CatalogRowAdjustment;
  onAdd: (row: AvailabilityRow) => void;
  onChangeQty: (equipmentId: string, newQty: number) => void;
  onRemove: (equipmentId: string) => void;
};

export function CatalogRow({ row, selectedQty, adjustment, onAdd, onChangeQty, onRemove }: Props) {
  const isSelected = selectedQty > 0;
  const isUnavailable = row.availableQuantity === 0;
  const isAtMax = selectedQty >= row.availableQuantity;
  const isClampedDown = adjustment?.kind === "clampedDown";
  const isHardUnavail = adjustment?.kind === "unavailable";

  const containerCls = isHardUnavail
    ? "border-l-[3px] border-l-rose bg-rose-soft"
    : isSelected
      ? "border-l-[3px] border-l-emerald bg-emerald-soft/40"
      : isUnavailable
        ? "opacity-40"
        : "bg-surface";

  return (
    <div
      className={`flex items-center gap-3 px-5 py-2.5 transition-colors ${containerCls} hover:bg-surface-muted`}
      data-testid={`catalog-row-${row.equipmentId}`}
    >
      <div className="min-w-0 flex-1">
        <div className={`text-[13px] font-medium ${isSelected ? "text-emerald" : "text-ink"}`}>
          {row.name}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-ink-3">
          <span className="font-mono">{formatMoneyRub(Number(row.rentalRatePerShift))} ₽/день</span>
          {isUnavailable ? (
            <span className="text-rose">нет в наличии</span>
          ) : (
            <span className={row.availableQuantity <= 1 ? "text-amber" : "text-emerald"}>
              {row.availableQuantity} доступно
            </span>
          )}
          {isClampedDown && (
            <span className="text-amber">
              скорректировано до {(adjustment as { kind: "clampedDown"; previousQty: number; newQty: number }).newQty} из {(adjustment as { kind: "clampedDown"; previousQty: number; newQty: number }).previousQty}
            </span>
          )}
          {isHardUnavail && <span className="text-rose">недоступно на новые даты</span>}
        </div>
      </div>

      <div className="flex-shrink-0">
        {isSelected ? (
          isHardUnavail ? (
            <button
              type="button"
              aria-label="Удалить позицию"
              onClick={() => onRemove(row.equipmentId)}
              className="rounded border border-rose-border bg-surface px-3 py-1 text-[12px] text-rose hover:bg-rose-soft"
            >
              Убрать
            </button>
          ) : (
            <div className="inline-flex items-center overflow-hidden rounded border border-emerald-border bg-surface">
              <button
                type="button"
                aria-label="Уменьшить количество"
                onClick={() =>
                  selectedQty - 1 <= 0 ? onRemove(row.equipmentId) : onChangeQty(row.equipmentId, selectedQty - 1)
                }
                className="flex h-7 w-7 items-center justify-center text-ink-2 hover:bg-emerald-soft"
              >
                −
              </button>
              <div className="flex h-7 w-8 items-center justify-center border-x border-emerald-border bg-emerald-soft/30 font-mono text-[12px] font-semibold text-emerald">
                {selectedQty}
              </div>
              <button
                type="button"
                aria-label="Увеличить количество"
                disabled={isAtMax}
                onClick={() => onChangeQty(row.equipmentId, selectedQty + 1)}
                className="flex h-7 w-7 items-center justify-center text-ink-2 hover:bg-emerald-soft disabled:cursor-not-allowed disabled:opacity-40"
              >
                +
              </button>
            </div>
          )
        ) : !isUnavailable ? (
          <button
            type="button"
            onClick={() => onAdd(row)}
            className="rounded border border-accent-border bg-surface px-3 py-1 text-[12px] font-medium text-accent-bright hover:bg-accent-soft"
          >
            + Добавить
          </button>
        ) : null}
      </div>
    </div>
  );
}
