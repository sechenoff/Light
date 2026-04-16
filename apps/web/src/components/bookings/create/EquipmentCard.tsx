"use client";

import { formatMoneyRub, pluralize } from "../../../lib/format";
import { PasteZone } from "./PasteZone";
import { EquipmentTable } from "./EquipmentTable";
import { ModeSwitcher } from "./ModeSwitcher";
import { ResizableContainer } from "./ResizableContainer";
import { QuickSearchBar } from "./QuickSearchBar";
import { CatalogBrowser } from "./CatalogBrowser";
import type {
  InputMode,
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
  inputMode: InputMode;
  onInputModeChange: (mode: InputMode) => void;

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

  // Catalog browser props
  pickupISO: string | null;
  returnISO: string | null;
  onCatalogAdd: (equipment: AvailabilityRow) => void;
  onCatalogQuantityChange: (equipmentId: string, qty: number) => void;

  // Quick search callback
  onQuickSearchSelect: (equipment: AvailabilityRow) => void;
};

export function EquipmentCard({
  items,
  shifts,
  totalAmount,
  inputMode,
  onInputModeChange,
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
  pickupISO,
  returnISO,
  onCatalogAdd,
  onCatalogQuantityChange,
  onQuickSearchSelect,
}: EquipmentCardProps) {
  const itemCount = items.length;
  const positionLabel = `${itemCount} ${pluralize(itemCount, "позиция", "позиции", "позиций")}`;
  const totalLabel = `${formatMoneyRub(totalAmount)} ₽ / период`;

  const hasDates = Boolean(pickupISO && returnISO);

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

      {/* Mode switcher */}
      <ModeSwitcher mode={inputMode} onModeChange={onInputModeChange} />

      {/* Content area */}
      <ResizableContainer defaultHeight={inputMode === "catalog" ? 360 : 280}>
        {inputMode === "ai" ? (
          <div>
            {/* AI paste zone */}
            <PasteZone
              text={text}
              onTextChange={onTextChange}
              onParse={onParse}
              onClear={onClear}
              isParsing={isParsing}
              error={error}
              resultCounts={resultCounts}
            />

            {/* Equipment table */}
            <div className="mx-5 mb-3">
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

            {/* Quick search bar */}
            <div className="mx-5 mb-3">
              <QuickSearchBar
                searchCatalog={searchCatalog}
                onSelect={onQuickSearchSelect}
                disabled={!hasDates}
              />
            </div>
          </div>
        ) : (
          <div className="mx-5 mt-3 mb-3">
            <CatalogBrowser
              items={items}
              pickupISO={pickupISO}
              returnISO={returnISO}
              onCatalogAdd={onCatalogAdd}
              onCatalogQuantityChange={onCatalogQuantityChange}
            />
          </div>
        )}
      </ResizableContainer>

      {/* Legend (AI mode only) */}
      {inputMode === "ai" && (
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
      )}
    </div>
  );
}
