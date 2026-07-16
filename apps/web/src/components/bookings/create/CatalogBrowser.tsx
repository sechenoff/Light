"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

// Высота списка каталога — управляемая (drag-хендл снизу). Значение переживает
// перезагрузку. Мин — чтобы не схлопнуть в ничто; макс — чтобы каталог не съел
// весь экран.
const PANEL_DEFAULT_H = 480;
const PANEL_MIN_H = 280;
const PANEL_MAX_H = 900;
const PANEL_STORAGE_KEY = "lr:catalog:panelHeight";

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

  // ── Управляемая высота: тянешь нижнюю кромку каталога, чтобы видеть больше
  //    позиций сразу. maxHeight (а не height) — короткие категории не оставляют
  //    пустоту, а на длинных drag реально раздвигает область до скролла. ──
  const [panelHeight, setPanelHeight] = useState<number>(PANEL_DEFAULT_H);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(PANEL_STORAGE_KEY);
    if (!raw) return;
    const n = Number.parseInt(raw, 10);
    if (!Number.isNaN(n)) {
      setPanelHeight(Math.min(PANEL_MAX_H, Math.max(PANEL_MIN_H, n)));
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const t = setTimeout(
      () => window.localStorage.setItem(PANEL_STORAGE_KEY, String(panelHeight)),
      300,
    );
    return () => clearTimeout(t);
  }, [panelHeight]);

  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { startY: e.clientY, startH: panelHeight };
    },
    [panelHeight],
  );

  const onHandlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const delta = e.clientY - dragRef.current.startY;
    const next = Math.min(
      PANEL_MAX_H,
      Math.max(PANEL_MIN_H, dragRef.current.startH + delta),
    );
    setPanelHeight(next);
  }, []);

  const onHandlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }, []);

  const onHandleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const STEP = 40;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setPanelHeight((h) => Math.min(PANEL_MAX_H, h + STEP));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setPanelHeight((h) => Math.max(PANEL_MIN_H, h - STEP));
    }
  }, []);

  const panelStyle = { maxHeight: `${panelHeight}px` } as const;

  const resizeHandle = (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Изменить высоту каталога — потяните или стрелками ↑↓"
      aria-valuenow={panelHeight}
      aria-valuemin={PANEL_MIN_H}
      aria-valuemax={PANEL_MAX_H}
      tabIndex={0}
      onPointerDown={onHandlePointerDown}
      onPointerMove={onHandlePointerMove}
      onPointerUp={onHandlePointerUp}
      onKeyDown={onHandleKeyDown}
      className="group flex h-4 cursor-ns-resize touch-none select-none items-center justify-center border-t border-border bg-surface-muted transition-colors hover:bg-surface-deep focus:outline-none focus-visible:bg-surface-deep focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-bright"
    >
      <span
        aria-hidden="true"
        className="h-1 w-10 rounded-full bg-border-strong transition-colors group-hover:bg-ink-3"
      />
    </div>
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
            <div className="overflow-y-auto" style={panelStyle}>
              {searchResults.map((r) => renderRow(r, true))}
            </div>
            {resizeHandle}
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
        <div
          className="w-[230px] flex-none overflow-y-auto border-r border-border bg-surface-muted"
          style={panelStyle}
        >
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
        <div className="min-w-0 flex-1 overflow-y-auto" style={panelStyle}>
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
      {/* Тянулка высоты — только desktop (на мобиле список листается страницей). */}
      <div className="hidden lg:block">{resizeHandle}</div>

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
