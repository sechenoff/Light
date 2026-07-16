"use client";

import { useMemo } from "react";
import { CatalogRow } from "./CatalogRow";
import { matchesCatalogRow } from "./searchNormalize";
import { pluralize } from "../../../lib/format";
import type { AvailabilityRow, CatalogRowAdjustment, CatalogSelectedItem } from "./types";

// Каталог-«проводник» (утверждённые мокапы booking-equipment-variants, вариант C
// + booking-equipment-mobile, вариант М1):
// - desktop (lg+): категории колонкой слева, позиции активной категории справа;
// - mobile: drill-down — список категорий на всю ширину, тап → позиции
//   с кнопкой «← Категории».
// Общее состояние — activeTab: "all" = категория не выбрана (desktop показывает
// весь каталог с группировкой, mobile — список категорий). Поиск от 2 символов
// в обоих режимах схлопывает навигацию в плоский список совпадений с ярлыком
// категории (понимает кириллицу — searchNormalize).

type Props = {
  rows: AvailabilityRow[];
  selected: Map<string, CatalogSelectedItem>;
  adjustments?: Map<string, CatalogRowAdjustment>;
  /** "all" — категория не выбрана; иначе название активной категории. */
  activeTab: string;
  onActiveTabChange: (t: string) => void;
  searchQuery: string;
  onAdd: (row: AvailabilityRow) => void;
  onChangeQty: (equipmentId: string, newQty: number) => void;
  onRemove: (equipmentId: string) => void;
};

const SEARCH_MIN_CHARS = 2;

export function CatalogBrowser({
  rows,
  selected,
  adjustments,
  activeTab,
  onActiveTabChange,
  searchQuery,
  onAdd,
  onChangeQty,
  onRemove,
}: Props) {
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) set.add(r.category);
    return Array.from(set);
  }, [rows]);

  const selectedByCat = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of selected.values()) map.set(item.category, (map.get(item.category) ?? 0) + 1);
    return map;
  }, [selected]);

  const query = searchQuery.trim();
  const searching = query.length >= SEARCH_MIN_CHARS;

  const searchResults = useMemo(
    () => (searching ? rows.filter((r) => matchesCatalogRow(r, query)) : []),
    [rows, query, searching],
  );

  const renderRow = (row: AvailabilityRow, showCategoryLabel: boolean) => (
    <CatalogRow
      key={row.equipmentId}
      row={row}
      selectedQty={selected.get(row.equipmentId)?.quantity ?? 0}
      adjustment={adjustments?.get(row.equipmentId)}
      showCategoryLabel={showCategoryLabel}
      onAdd={onAdd}
      onChangeQty={onChangeQty}
      onRemove={onRemove}
    />
  );

  // ── Плоские результаты поиска (общие для desktop и mobile) ──
  if (searching) {
    return (
      <div className="border-t border-border">
        {searchResults.length === 0 ? (
          <div className="px-5 py-10 text-center text-[13px] text-ink-3">Ничего не найдено</div>
        ) : (
          <>
            <div className="border-b border-border bg-surface-subtle px-5 py-2 font-cond text-[10px] font-semibold uppercase tracking-wider text-ink-3">
              Найдено: {searchResults.length}
            </div>
            <div className="max-h-[480px] overflow-y-auto">
              {searchResults.map((r) => renderRow(r, true))}
            </div>
          </>
        )}
      </div>
    );
  }

  const catMeta = (cat: string) => {
    const total = rows.filter((r) => r.category === cat).length;
    const sel = selectedByCat.get(cat) ?? 0;
    return { total, sel };
  };

  const activeRows = activeTab === "all" ? [] : rows.filter((r) => r.category === activeTab);

  return (
    <div className="border-t border-border">
      {/* ── Desktop: проводник в две панели ── */}
      <div className="hidden lg:flex">
        <div className="max-h-[480px] w-[230px] flex-none overflow-y-auto border-r border-border bg-surface-muted">
          <button
            type="button"
            onClick={() => onActiveTabChange("all")}
            className={`flex min-h-[38px] w-full items-center gap-2 px-3.5 py-2 text-left text-[12.5px] ${
              activeTab === "all"
                ? "bg-surface font-semibold text-ink shadow-[inset_3px_0_0_theme(colors.accent.bright)]"
                : "text-ink-2 hover:bg-surface-deep"
            }`}
          >
            <span className="min-w-0 flex-1">Весь каталог</span>
            <span className="font-mono text-[10.5px] text-ink-3">{rows.length}</span>
          </button>
          {categories.map((cat) => {
            const { total, sel } = catMeta(cat);
            return (
              <button
                key={cat}
                type="button"
                onClick={() => onActiveTabChange(cat)}
                className={`flex min-h-[38px] w-full items-center gap-2 px-3.5 py-2 text-left text-[12.5px] ${
                  activeTab === cat
                    ? "bg-surface font-semibold text-ink shadow-[inset_3px_0_0_theme(colors.accent.bright)]"
                    : "text-ink-2 hover:bg-surface-deep"
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{cat}</span>
                <span className="whitespace-nowrap font-mono text-[10.5px] text-ink-3">
                  {total}
                  {sel > 0 && <span className="font-semibold text-emerald"> · {sel}✓</span>}
                </span>
              </button>
            );
          })}
        </div>
        <div className="max-h-[480px] min-w-0 flex-1 overflow-y-auto">
          {activeTab === "all" ? (
            categories.map((cat) => {
              const { sel } = catMeta(cat);
              return (
                <div key={cat}>
                  <div className="flex items-center justify-between border-b border-t border-border bg-surface-subtle px-5 py-2 font-cond text-[10px] font-semibold uppercase tracking-wider text-ink-3 first:border-t-0">
                    <span>{cat}</span>
                    {sel > 0 && <span className="font-mono text-emerald">{sel} выбрано</span>}
                  </div>
                  {rows.filter((r) => r.category === cat).map((r) => renderRow(r, false))}
                </div>
              );
            })
          ) : (
            <>
              <div className="border-b border-border bg-surface-subtle px-5 py-2 font-cond text-[10px] font-semibold uppercase tracking-wider text-ink-3">
                {activeTab}
              </div>
              {activeRows.map((r) => renderRow(r, false))}
            </>
          )}
        </div>
      </div>

      {/* ── Mobile: drill-down (М1) ── */}
      <div className="lg:hidden">
        {activeTab === "all" ? (
          <div>
            {categories.map((cat) => {
              const { total, sel } = catMeta(cat);
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => onActiveTabChange(cat)}
                  className="flex min-h-[46px] w-full items-center gap-2.5 border-b border-surface-deep px-5 py-2 text-left last:border-b-0 hover:bg-surface-muted"
                >
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{cat}</span>
                  <span className="whitespace-nowrap font-mono text-[11px] text-ink-3">
                    {total} {pluralize(total, "позиция", "позиции", "позиций")}
                    {sel > 0 && <span className="font-semibold text-emerald"> · {sel}✓</span>}
                  </span>
                  <span aria-hidden="true" className="text-[13px] text-ink-3">›</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div>
            <div className="sticky top-12 z-10 flex items-center gap-2.5 border-b border-border bg-surface-muted px-4 py-2">
              <button
                type="button"
                onClick={() => onActiveTabChange("all")}
                className="whitespace-nowrap text-[13px] font-semibold text-accent-bright"
              >
                ← Категории
              </button>
              <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{activeTab}</span>
              <span className="font-mono text-[11px] text-ink-3">{activeRows.length}</span>
            </div>
            {activeRows.map((r) => renderRow(r, false))}
          </div>
        )}
      </div>
    </div>
  );
}
