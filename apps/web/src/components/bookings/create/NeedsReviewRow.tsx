"use client";

import { formatMoneyRub } from "../../../lib/format";
import type { GafferCandidate } from "./types";

type Props = {
  itemId: string;
  gafferPhrase: string;
  interpretedName: string;
  quantity: number;
  candidates: GafferCandidate[];
  selectedEquipmentId: string | null;
  onSelectCandidate: (itemId: string, candidate: GafferCandidate) => void;
  onSkip: (itemId: string) => void;
  onQuantityChange: (itemId: string, qty: number) => void;
  onDelete: (itemId: string) => void;
  shifts: number;
};

export function NeedsReviewRow({
  itemId,
  gafferPhrase,
  interpretedName,
  quantity,
  candidates,
  selectedEquipmentId,
  onSelectCandidate,
  onSkip,
  onQuantityChange,
  onDelete,
  shifts,
}: Props) {
  const selected = candidates.find((c) => c.equipmentId === selectedEquipmentId) ?? null;

  const unitPrice = selected ? Number(selected.rentalRatePerShift) : null;
  const lineTotal = unitPrice !== null ? unitPrice * quantity * shifts : null;

  return (
    <div className="border-b border-border last:border-b-0">
      {/* Main row */}
      <div className="grid grid-cols-[6px_1fr_72px_90px_104px_24px] items-center gap-x-2 py-2 pr-2">
        {/* Amber left stripe */}
        <div className="h-full w-[6px] self-stretch rounded-sm bg-amber" aria-hidden="true" />

        {/* Name + alias */}
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-ink-1">{interpretedName}</div>
          <div className="truncate text-xs text-ink-3">{gafferPhrase}</div>
        </div>

        {/* Quantity input */}
        <input
          type="number"
          min={1}
          value={quantity}
          onChange={(e) => onQuantityChange(itemId, Number(e.target.value))}
          className="w-full rounded border border-border bg-surface px-2 py-1 text-sm text-ink-1 focus:border-accent focus:outline-none"
        />

        {/* Unit price */}
        <div className="text-right text-sm">
          {unitPrice !== null ? (
            <span className="mono-num text-ink-1">{formatMoneyRub(unitPrice)} ₽</span>
          ) : (
            <span className="text-amber text-xs">— уточнить →</span>
          )}
        </div>

        {/* Line total */}
        <div className="text-right text-sm">
          {lineTotal !== null ? (
            <span className="mono-num text-ink-1">{formatMoneyRub(lineTotal)} ₽</span>
          ) : (
            <span className="text-ink-3">—</span>
          )}
        </div>

        {/* Delete */}
        <button
          type="button"
          aria-label="Удалить позицию"
          onClick={() => onDelete(itemId)}
          className="flex items-center justify-center rounded p-0.5 text-ink-3 hover:bg-rose-soft hover:text-rose"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Expansion row — candidate picker */}
      <div className="grid grid-cols-[6px_1fr] pb-3">
        {/* Amber stripe continuation */}
        <div className="h-full w-[6px] rounded-sm bg-amber" aria-hidden="true" />

        <div className="pl-2 pr-2">
          <div className="mb-2 text-xs font-semibold text-amber">Какой именно?</div>
          <div className="flex flex-wrap gap-2">
            {candidates.map((c) => {
              const isSelected = c.equipmentId === selectedEquipmentId;
              return (
                <button
                  key={c.equipmentId}
                  type="button"
                  onClick={() => onSelectCandidate(itemId, c)}
                  className={
                    isSelected
                      ? "flex flex-col items-start rounded border px-2 py-1.5 text-left text-sm border-ink bg-ink text-white"
                      : "flex flex-col items-start rounded border px-2 py-1.5 text-left text-sm border-border-strong bg-surface text-ink hover:border-ink"
                  }
                >
                  <span className="font-medium leading-tight">{c.catalogName}</span>
                  <span
                    className={
                      isSelected
                        ? "font-mono text-[11px] text-white/60"
                        : "font-mono text-[11px] text-ink-3"
                    }
                  >
                    {formatMoneyRub(c.rentalRatePerShift)} ₽/день
                  </span>
                </button>
              );
            })}

            {/* Skip option */}
            <button
              type="button"
              onClick={() => onSkip(itemId)}
              className="flex flex-col items-start rounded border border-dashed border-border-strong bg-transparent px-2 py-1.5 text-left text-sm text-ink-3"
            >
              Пропустить позицию
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
