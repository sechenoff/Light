"use client";

import { formatMoneyRub } from "../../../lib/format";

type CatalogItemCardProps = {
  name: string;
  rentalRatePerShift: string;
  availableQuantity: number;
  currentQty: number;
  onAdd: () => void;
  onQuantityChange: (qty: number) => void;
};

export function CatalogItemCard({
  name,
  rentalRatePerShift,
  availableQuantity,
  currentQty,
  onAdd,
  onQuantityChange,
}: CatalogItemCardProps) {
  const unitPrice = Number(rentalRatePerShift);
  const isAdded = currentQty > 0;
  const isUnavailable = availableQuantity === 0 && currentQty === 0;
  const atMax = currentQty >= availableQuantity;

  if (isUnavailable) {
    return (
      <div className="flex items-center rounded-lg border border-border bg-surface-muted px-3 py-2 opacity-45">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-ink">{name}</div>
          <div className="mt-0.5 text-[11px] text-ink-3">
            {formatMoneyRub(unitPrice)} ₽/день{" "}
            <span className="opacity-40">· 0 шт.</span>
          </div>
        </div>
        <span className="shrink-0 text-[11px] text-ink-3">Нет в наличии</span>
      </div>
    );
  }

  if (!isAdded) {
    return (
      <div className="flex items-center rounded-lg border border-border bg-surface px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-ink">{name}</div>
          <div className="mt-0.5 text-[11px] text-ink-3">
            {formatMoneyRub(unitPrice)} ₽/день{" "}
            <span className="opacity-40">· {availableQuantity} шт.</span>
          </div>
        </div>
        <button
          type="button"
          onClick={onAdd}
          className="shrink-0 flex items-center gap-1 rounded-[5px] border border-accent-bright bg-surface px-2.5 py-1 text-[11px] font-medium text-accent-bright hover:bg-accent-soft"
        >
          <span className="text-sm">+</span> Добавить
        </button>
      </div>
    );
  }

  // Added state — green card with −/qty/+
  return (
    <div className="flex items-center rounded-lg border border-emerald bg-emerald-soft px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-ink">{name}</div>
        <div className="mt-0.5 text-[11px] text-ink-3">
          {formatMoneyRub(unitPrice)} ₽/день{" "}
          <span className="opacity-40">· {availableQuantity} шт.</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center">
        <button
          type="button"
          aria-label="Уменьшить количество"
          onClick={() => onQuantityChange(currentQty - 1)}
          className="flex h-[30px] w-[30px] items-center justify-center rounded-l-[5px] border border-border bg-surface text-[16px] text-ink-2 hover:bg-surface-muted"
        >
          −
        </button>
        <div className="flex h-[30px] w-[34px] items-center justify-center border-y border-border bg-surface font-mono text-[13px] font-semibold text-ink">
          {currentQty}
        </div>
        <button
          type="button"
          aria-label="Увеличить количество"
          onClick={() => onQuantityChange(currentQty + 1)}
          disabled={atMax}
          className={
            atMax
              ? "flex h-[30px] w-[30px] items-center justify-center rounded-r-[5px] border border-border bg-surface-muted text-[16px] text-border-strong"
              : "flex h-[30px] w-[30px] items-center justify-center rounded-r-[5px] border border-border bg-surface text-[16px] text-accent-bright hover:bg-surface-muted"
          }
        >
          +
        </button>
      </div>
    </div>
  );
}
