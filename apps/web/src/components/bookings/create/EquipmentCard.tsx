"use client";

import { formatMoneyRub, pluralize } from "../../../lib/format";
import { PasteZone } from "./PasteZone";
import { EquipmentTable } from "./EquipmentTable";
import type {
  EquipmentTableItem,
  GafferCandidate,
  AvailabilityRow,
  ParseResultCounts,
} from "./types";

type EquipmentCardProps = {
  // Data
  items: EquipmentTableItem[];
  shifts: number;
  totalAmount: number;

  // PasteZone props
  text: string;
  onTextChange: (v: string) => void;
  onParse: () => void;
  onClear: () => void;
  isParsing: boolean;
  error: string | null;
  resultCounts: ParseResultCounts | null;

  // EquipmentTable props
  onQuantityChange: (itemId: string, qty: number) => void;
  onDelete: (itemId: string) => void;
  onSelectCandidate: (itemId: string, candidate: GafferCandidate) => void;
  onSkipItem: (itemId: string) => void;
  onSelectFromCatalog: (itemId: string, equipment: AvailabilityRow, saveAlias: boolean) => void;
  searchCatalog: (query: string) => Promise<AvailabilityRow[]>;

  // Footer actions
  onAddManual: () => void;
};

export function EquipmentCard({
  items,
  shifts,
  totalAmount,
  text,
  onTextChange,
  onParse,
  onClear,
  isParsing,
  error,
  resultCounts,
  onQuantityChange,
  onDelete,
  onSelectCandidate,
  onSkipItem,
  onSelectFromCatalog,
  searchCatalog,
  onAddManual,
}: EquipmentCardProps) {
  const itemCount = items.length;
  const positionLabel = `${itemCount} ${pluralize(itemCount, "позиция", "позиции", "позиций")}`;
  const totalLabel = `${formatMoneyRub(totalAmount)} ₽ / период`;

  return (
    <div className="rounded-lg border border-border bg-surface shadow-xs">
      {/* Card header */}
      <div className="flex items-baseline justify-between px-5 pt-4 pb-3 border-b border-border">
        <div>
          <p className="eyebrow text-ink-3 mb-0.5">3. Оборудование</p>
        </div>
        <p className="text-sm text-ink-2 mono-num">
          {positionLabel} · {totalLabel}
        </p>
      </div>

      {/* PasteZone — has its own mx-5 margin */}
      <PasteZone
        text={text}
        onTextChange={onTextChange}
        onParse={onParse}
        onClear={onClear}
        isParsing={isParsing}
        error={error}
        resultCounts={resultCounts}
      />

      {/* EquipmentTable — wrapped in mx-5 to match PasteZone margin */}
      <div className="mx-5 mb-4">
        <EquipmentTable
          items={items}
          shifts={shifts}
          onQuantityChange={onQuantityChange}
          onDelete={onDelete}
          onSelectCandidate={onSelectCandidate}
          onSkipItem={onSkipItem}
          onSelectFromCatalog={onSelectFromCatalog}
          searchCatalog={searchCatalog}
        />
      </div>

      {/* Footer links */}
      <div className="flex items-center gap-4 px-5 pb-4 text-sm">
        <button
          type="button"
          className="text-accent-bright hover:underline"
          onClick={onAddManual}
        >
          + Добавить позицию вручную
        </button>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 px-5 pb-4 pt-0 text-xs text-ink-3">
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald inline-block" aria-hidden="true" />
          Точно
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-amber inline-block" aria-hidden="true" />
          Уточнить
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-rose inline-block" aria-hidden="true" />
          Не в каталоге
        </span>
      </div>
    </div>
  );
}
