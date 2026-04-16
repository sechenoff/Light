"use client";

import { formatMoneyRub, pluralize } from "../../../lib/format";
import { NeedsReviewRow } from "./NeedsReviewRow";
import { UnmatchedRow } from "./UnmatchedRow";
import type { EquipmentTableItem, GafferCandidate, AvailabilityRow } from "./types";

type EquipmentTableProps = {
  items: EquipmentTableItem[];
  shifts: number;
  onQuantityChange: (itemId: string, qty: number) => void;
  onDelete: (itemId: string) => void;
  onSelectCandidate: (itemId: string, candidate: GafferCandidate) => void;
  onSkipItem: (itemId: string) => void;
  onSelectFromCatalog: (itemId: string, equipment: AvailabilityRow, saveAlias: boolean) => void;
  searchCatalog: (query: string) => Promise<AvailabilityRow[]>;
};

export function EquipmentTable({
  items,
  shifts,
  onQuantityChange,
  onDelete,
  onSelectCandidate,
  onSkipItem,
  onSelectFromCatalog,
  searchCatalog,
}: EquipmentTableProps) {
  if (items.length === 0) {
    return (
      <div className="rounded border border-dashed border-border py-8 text-center text-sm text-ink-3">
        Нет позиций. Вставьте текст от гаффера выше или добавьте вручную.
      </div>
    );
  }

  const dayLabel = `× ${shifts} ${pluralize(shifts, "день", "дня", "дней")}`;

  return (
    <div className="rounded border border-border bg-surface">
      {/* Header row */}
      <div className="grid grid-cols-[6px_1fr_72px_90px_104px_24px] items-center gap-x-2 border-b border-border bg-surface-muted px-0 py-2 pr-2">
        <div aria-hidden="true" />
        <div className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3" style={{ fontFamily: "var(--font-plex-condensed, sans-serif)" }}>
          Позиция
        </div>
        <div className="text-right text-[10.5px] font-semibold uppercase tracking-wide text-ink-3" style={{ fontFamily: "var(--font-plex-condensed, sans-serif)" }}>
          Кол-во
        </div>
        <div className="text-right text-[10.5px] font-semibold uppercase tracking-wide text-ink-3" style={{ fontFamily: "var(--font-plex-condensed, sans-serif)" }}>
          Цена/день
        </div>
        <div className="text-right text-[10.5px] font-semibold uppercase tracking-wide text-ink-3" style={{ fontFamily: "var(--font-plex-condensed, sans-serif)" }}>
          {dayLabel}
        </div>
        <div aria-hidden="true" />
      </div>

      {/* Item rows */}
      {items.map((item) => {
        if (item.match.kind === "resolved") {
          const match = item.match;
          const unitPrice = Number(match.rentalRatePerShift);
          const lineTotal = unitPrice * item.quantity * shifts;

          return (
            <div key={item.id} className="border-b border-border last:border-b-0">
              <div className="grid grid-cols-[6px_1fr_72px_90px_104px_24px] items-center gap-x-2 py-2 pr-2">
                {/* Green left stripe */}
                <div className="h-full w-[6px] self-stretch rounded-sm bg-emerald" aria-hidden="true" />

                {/* Name + alias */}
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-ink">{match.catalogName}</div>
                  <div className="truncate font-mono text-xs text-ink-3">
                    alias: «{item.gafferPhrase}»
                  </div>
                </div>

                {/* Quantity input */}
                <input
                  type="number"
                  min={1}
                  value={item.quantity}
                  onChange={(e) => onQuantityChange(item.id, Number(e.target.value))}
                  className="w-full rounded border border-border bg-surface px-2 py-1 text-sm text-ink focus:border-accent focus:outline-none font-mono"
                  style={{ width: "60px" }}
                />

                {/* Unit price */}
                <div className="text-right text-sm">
                  <span className="mono-num text-ink">{formatMoneyRub(unitPrice)} ₽</span>
                </div>

                {/* Line total */}
                <div className="text-right text-sm">
                  <span className="mono-num text-ink">{formatMoneyRub(lineTotal)} ₽</span>
                </div>

                {/* Delete */}
                <button
                  type="button"
                  aria-label="Удалить позицию"
                  onClick={() => onDelete(item.id)}
                  className="flex items-center justify-center rounded p-0.5 text-ink-3 hover:bg-rose-soft hover:text-rose"
                >
                  ×
                </button>
              </div>
            </div>
          );
        }

        if (item.match.kind === "needsReview") {
          const match = item.match;
          // Determine selected candidate: find by unitPrice match or default to first
          let selectedEquipmentId: string | null = null;
          if (item.unitPrice !== null) {
            const found = match.candidates.find(
              (c) => c.rentalRatePerShift === item.unitPrice,
            );
            selectedEquipmentId = found?.equipmentId ?? null;
          }
          if (selectedEquipmentId === null && match.candidates.length > 0) {
            // no pre-selection by default
            selectedEquipmentId = null;
          }

          return (
            <NeedsReviewRow
              key={item.id}
              itemId={item.id}
              gafferPhrase={item.gafferPhrase}
              interpretedName={item.interpretedName}
              quantity={item.quantity}
              candidates={match.candidates}
              selectedEquipmentId={selectedEquipmentId}
              onSelectCandidate={onSelectCandidate}
              onSkip={onSkipItem}
              onQuantityChange={onQuantityChange}
              onDelete={onDelete}
              shifts={shifts}
            />
          );
        }

        // unmatched
        return (
          <UnmatchedRow
            key={item.id}
            itemId={item.id}
            gafferPhrase={item.gafferPhrase}
            quantity={item.quantity}
            onSelectFromCatalog={onSelectFromCatalog}
            onQuantityChange={onQuantityChange}
            onDelete={onDelete}
            searchCatalog={searchCatalog}
          />
        );
      })}
    </div>
  );
}
