"use client";

import { useMemo } from "react";
import { SmartInput } from "./SmartInput";
import { AiResultBanner } from "./AiResultBanner";
import { CatalogList } from "./CatalogList";
import type { AvailabilityRow, CatalogRowAdjustment, CatalogSelectedItem, OffCatalogItem } from "./types";
import { formatMoneyRub, pluralize } from "../../../lib/format";

type Props = {
  catalog: AvailabilityRow[];
  catalogLoading: boolean;
  selected: Map<string, CatalogSelectedItem>;
  offCatalogItems: OffCatalogItem[];

  // Smart input / AI
  gafferText: string;
  onGafferTextChange: (v: string) => void;
  parsing: boolean;
  parsed: boolean;
  parseResolved: number;
  parseTotal: number;
  unmatchedFromAi: string[];
  successBannerDismissed: boolean;
  onParse: () => void;
  onClear: () => void;
  onDismissSuccess: () => void;
  onIgnoreUnmatched: () => void;
  onAddOffCatalog: (phrase: string) => void;

  // Catalog callbacks
  onAdd: (row: AvailabilityRow) => void;
  onChangeQty: (equipmentId: string, newQty: number) => void;
  onRemove: (equipmentId: string) => void;
  onChangeOffCatalogQty: (tempId: string, newQty: number) => void;
  onRemoveOffCatalog: (tempId: string) => void;

  // Search + tab state (controlled)
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  activeTab: string;
  onActiveTabChange: (t: string) => void;

  shifts: number;
  adjustments: Map<string, CatalogRowAdjustment>;
};

export function EquipmentCard({
  catalog,
  catalogLoading,
  selected,
  offCatalogItems,
  gafferText,
  onGafferTextChange,
  parsing,
  parsed,
  parseResolved,
  parseTotal,
  unmatchedFromAi,
  successBannerDismissed,
  onParse,
  onClear,
  onDismissSuccess,
  onIgnoreUnmatched,
  onAddOffCatalog,
  onAdd,
  onChangeQty,
  onRemove,
  onChangeOffCatalogQty,
  onRemoveOffCatalog,
  searchQuery,
  onSearchQueryChange,
  activeTab,
  onActiveTabChange,
  shifts,
  adjustments,
}: Props) {
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const r of catalog) set.add(r.category);
    return Array.from(set);
  }, [catalog]);

  const selectedByCat = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of selected.values()) map.set(item.category, (map.get(item.category) ?? 0) + 1);
    return map;
  }, [selected]);

  const totalPositions = selected.size + offCatalogItems.length;
  const totalUnits =
    Array.from(selected.values()).reduce((acc, it) => acc + it.quantity, 0) +
    offCatalogItems.reduce((acc, it) => acc + it.quantity, 0);

  const totalPrice = useMemo(() => {
    let sum = 0;
    for (const item of selected.values()) {
      sum += Number(item.dailyPrice) * item.quantity * shifts;
    }
    return sum;
  }, [selected, shifts]);

  const isAi = gafferText.includes("\n") || gafferText.length > 40;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-xs">
      {/* Sticky header */}
      <div className="sticky top-12 z-10 bg-surface">
        <div className="flex items-center justify-between px-5 pb-3 pt-4">
          <h2 className="text-[15px] font-semibold">Оборудование</h2>
          <div className="font-mono text-[12px] text-ink-2">
            {totalPositions} {pluralize(totalPositions, "позиция", "позиции", "позиций")} · {formatMoneyRub(totalPrice)} ₽
          </div>
        </div>

        {/* Smart input */}
        <div className="px-5 pb-2">
          <SmartInput
            value={gafferText}
            onValueChange={(v) => {
              onGafferTextChange(v);
              if (!isAi) onSearchQueryChange(v);
            }}
            onParse={onParse}
            onClear={onClear}
            parsing={parsing}
            parsed={parsed}
          />
        </div>

        {/* Tabs */}
        <div className="flex gap-0 border-b border-border px-5 pt-1">
          <TabButton label="Все" active={activeTab === "all"} onClick={() => onActiveTabChange("all")} count={null} />
          {categories.map((cat) => (
            <TabButton
              key={cat}
              label={cat}
              active={activeTab === cat}
              onClick={() => onActiveTabChange(cat)}
              count={selectedByCat.get(cat) ?? null}
            />
          ))}
        </div>
      </div>

      {/* AI banner */}
      <AiResultBanner
        resolved={parseResolved}
        total={parseTotal}
        unmatched={unmatchedFromAi}
        successDismissed={successBannerDismissed}
        onDismissSuccess={onDismissSuccess}
        onAddOffCatalog={onAddOffCatalog}
        onIgnoreUnmatched={onIgnoreUnmatched}
      />

      {/* Catalog */}
      {catalogLoading ? (
        <div className="px-5 py-12 text-center text-[13px] text-ink-3">Загружаю каталог...</div>
      ) : (
        <CatalogList
          rows={catalog}
          selected={selected}
          offCatalogItems={offCatalogItems}
          activeTab={activeTab}
          searchQuery={isAi ? "" : searchQuery}
          adjustments={adjustments}
          onAdd={onAdd}
          onChangeQty={onChangeQty}
          onRemove={onRemove}
          onChangeOffCatalogQty={onChangeOffCatalogQty}
          onRemoveOffCatalog={onRemoveOffCatalog}
        />
      )}

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-border bg-surface-muted px-5 py-3">
        <div className="text-[12.5px] text-ink-2">
          {totalPositions === 0 ? (
            <span>Ничего не выбрано</span>
          ) : (
            <>
              <strong className="text-ink">{totalPositions} {pluralize(totalPositions, "позиция", "позиции", "позиций")}</strong>
              <span> · {totalUnits} {pluralize(totalUnits, "единица", "единицы", "единиц")}</span>
            </>
          )}
        </div>
        <div className="font-mono text-[14px] font-semibold">{formatMoneyRub(totalPrice)} ₽</div>
      </div>
    </div>
  );
}

function TabButton({
  label,
  active,
  onClick,
  count,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  count: number | null;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-px whitespace-nowrap px-3.5 py-2 text-[12.5px] font-medium transition-colors ${
        active
          ? "border-b-2 border-accent-bright font-semibold text-accent-bright"
          : "border-b-2 border-transparent text-ink-3 hover:text-ink-2"
      }`}
    >
      {label}
      {count !== null && count > 0 && <span className="ml-1 font-mono text-[10px] text-emerald">{count}</span>}
    </button>
  );
}
