"use client";

import { ReviewItemCard } from "./ReviewItemCard";
import type { PendingReviewItem, AvailabilityRow } from "./types";
import { pluralize } from "../../../lib/format";

type EquipmentSelection = {
  equipmentId: string;
  name: string;
  category: string;
  rentalRatePerShift: string;
  availableQuantity: number;
};

type Props = {
  items: PendingReviewItem[];
  pickupISO: string;
  returnISO: string;
  onConfirm: (reviewId: string, equipment: EquipmentSelection, quantity: number) => void;
  onOffCatalog: (reviewId: string) => void;
  onSkip: (reviewId: string) => void;
  onSkipAll: () => void;
};

export function ReviewPanel({
  items,
  pickupISO,
  returnISO,
  onConfirm,
  onOffCatalog,
  onSkip,
  onSkipAll,
}: Props) {
  return (
    <div className="overflow-hidden rounded-lg border border-accent-border bg-accent-soft">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-accent-border bg-surface-muted">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold text-ink">🤖 Распознано — подтвердите позиции</span>
          <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] font-mono text-ink-2">
            {items.length} {pluralize(items.length, "позиция", "позиции", "позиций")} требует подтверждения
          </span>
        </div>
        <button
          type="button"
          onClick={onSkipAll}
          className="text-[12px] text-ink-3 hover:text-ink"
        >
          Пропустить все
        </button>
      </div>

      {/* Items */}
      <div className="divide-y divide-accent-border">
        {items.map((item) => (
          <ReviewItemCard
            key={item.reviewId}
            item={item}
            pickupISO={pickupISO}
            returnISO={returnISO}
            onConfirm={onConfirm}
            onOffCatalog={onOffCatalog}
            onSkip={onSkip}
          />
        ))}
      </div>
    </div>
  );
}
