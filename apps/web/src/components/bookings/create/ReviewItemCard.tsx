"use client";

import { useState } from "react";
import { CatalogSearchPopover } from "./CatalogSearchPopover";
import type { PendingReviewItem, AvailabilityRow } from "./types";

type EquipmentSelection = {
  equipmentId: string;
  name: string;
  category: string;
  rentalRatePerShift: string;
  availableQuantity: number;
};

type Props = {
  item: PendingReviewItem;
  pickupISO: string;
  returnISO: string;
  onConfirm: (reviewId: string, equipment: EquipmentSelection, quantity: number) => void;
  onOffCatalog: (reviewId: string) => void;
  onSkip: (reviewId: string) => void;
};

export function ReviewItemCard({ item, pickupISO, returnISO, onConfirm, onOffCatalog, onSkip }: Props) {
  const [showSearch, setShowSearch] = useState(false);
  const { match } = item;

  function handleSelectFromCatalog(row: AvailabilityRow) {
    setShowSearch(false);
    onConfirm(
      item.reviewId,
      {
        equipmentId: row.equipmentId,
        name: row.name,
        category: row.category,
        rentalRatePerShift: row.rentalRatePerShift,
        availableQuantity: row.availableQuantity,
      },
      item.quantity,
    );
  }

  const quantityBadge = (
    <span className="ml-1.5 rounded bg-surface-muted px-1.5 py-0.5 text-[11px] font-mono text-ink-2">
      ×{item.quantity} шт.
    </span>
  );

  if (match.kind === "resolved") {
    const pct = Math.round(match.confidence * 100);
    return (
      <div className="border-l-4 border-emerald bg-emerald-soft px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-ink">
              {item.gafferPhrase || item.interpretedName}
              {quantityBadge}
            </p>
            <p className="mt-0.5 text-[12px] text-ink-2">
              Найдено: <span className="font-medium text-ink">{match.catalogName}</span>
              <span className="ml-1 text-ink-3">{pct}% уверенности</span>
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() =>
                onConfirm(
                  item.reviewId,
                  {
                    equipmentId: match.equipmentId,
                    name: match.catalogName,
                    category: match.category,
                    rentalRatePerShift: match.rentalRatePerShift,
                    availableQuantity: match.availableQuantity,
                  },
                  item.quantity,
                )
              }
              className="rounded border border-emerald-border bg-surface px-2.5 py-1 text-[12px] font-medium text-emerald hover:bg-emerald-soft"
            >
              ✓ Подтвердить
            </button>
            <button
              type="button"
              onClick={() => setShowSearch((s) => !s)}
              className="rounded border border-border px-2.5 py-1 text-[12px] text-ink-2 hover:text-ink"
            >
              Найти другое
            </button>
          </div>
        </div>
        {showSearch && (
          <div className="mt-2">
            <CatalogSearchPopover
              pickupISO={pickupISO}
              returnISO={returnISO}
              onSelect={handleSelectFromCatalog}
              onClose={() => setShowSearch(false)}
            />
          </div>
        )}
      </div>
    );
  }

  if (match.kind === "needsReview") {
    const top3 = match.candidates.slice(0, 3);
    return (
      <div className="border-l-4 border-amber bg-amber-soft px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <p className="min-w-0 text-[13px] font-medium text-ink">
            {item.gafferPhrase || item.interpretedName}
            {quantityBadge}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => setShowSearch((s) => !s)}
              className="rounded border border-border bg-surface px-2.5 py-1 text-[12px] font-medium text-ink-2 hover:text-ink"
            >
              Найти другое
            </button>
            <button
              type="button"
              onClick={() => onSkip(item.reviewId)}
              className="rounded border border-border bg-surface px-2.5 py-1 text-[12px] text-ink-3 hover:text-ink"
            >
              Пропустить
            </button>
          </div>
        </div>
        <ul className="mt-1.5 space-y-1">
          {top3.map((c) => {
            const pct = Math.round(c.confidence * 100);
            return (
              <li key={c.equipmentId} className="flex items-center justify-between gap-2 rounded border border-border bg-surface px-2.5 py-1.5">
                <span className="text-[12px] text-ink">
                  <span className="font-medium">{c.catalogName}</span>
                  <span className="ml-1.5 text-ink-3">
                    — {pct}% · {c.rentalRatePerShift} ₽/день · {c.availableQuantity} доступно
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() =>
                    onConfirm(
                      item.reviewId,
                      {
                        equipmentId: c.equipmentId,
                        name: c.catalogName,
                        category: c.category,
                        rentalRatePerShift: c.rentalRatePerShift,
                        availableQuantity: c.availableQuantity,
                      },
                      item.quantity,
                    )
                  }
                  className="shrink-0 rounded border border-border px-2 py-0.5 text-[11px] font-medium text-ink-2 hover:text-ink"
                >
                  Выбрать
                </button>
              </li>
            );
          })}
        </ul>
        {showSearch && (
          <div className="mt-2">
            <CatalogSearchPopover
              pickupISO={pickupISO}
              returnISO={returnISO}
              onSelect={handleSelectFromCatalog}
              onClose={() => setShowSearch(false)}
            />
          </div>
        )}
      </div>
    );
  }

  // unmatched
  return (
    <div className="border-l-4 border-rose bg-rose-soft px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-ink">
            {item.gafferPhrase || item.interpretedName}
            {quantityBadge}
          </p>
          <p className="mt-0.5 text-[12px] text-ink-3">Не найдено в каталоге</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => setShowSearch((s) => !s)}
            className="rounded border border-accent-border bg-surface px-2.5 py-1 text-[12px] font-medium text-accent-bright hover:bg-accent-soft"
          >
            🔍 Найти в каталоге
          </button>
          <button
            type="button"
            onClick={() => onOffCatalog(item.reviewId)}
            className="rounded border border-border bg-surface px-2.5 py-1 text-[12px] text-ink-2 hover:text-ink"
          >
            Добавить вне каталога
          </button>
          <button
            type="button"
            onClick={() => onSkip(item.reviewId)}
            className="rounded border border-border bg-surface px-2.5 py-1 text-[12px] text-ink-3 hover:text-ink"
          >
            Пропустить
          </button>
        </div>
      </div>
      {showSearch && (
        <div className="mt-2">
          <CatalogSearchPopover
            pickupISO={pickupISO}
            returnISO={returnISO}
            onSelect={handleSelectFromCatalog}
            onClose={() => setShowSearch(false)}
          />
        </div>
      )}
    </div>
  );
}
