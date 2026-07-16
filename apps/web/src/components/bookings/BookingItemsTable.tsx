"use client";

import { formatMoneyRub } from "@/lib/format";
import type { RetroEditItem } from "./useRetroEdit";

// Таблица «Позиции брони» (фаза 4.10, вынос из bookings/[id]/page.tsx,
// поведение 1:1). Единый список позиций: когда есть снапшот сметы — цены/суммы
// показываются прямо здесь (сопоставление по equipmentId, затем по имени).
// В retro-режиме источник правды — retroEdits.items (степперы кол-ва, пометка
// на удаление, подсветка изменений, live-пересчёт суммы строки).

export type ItemsTableBooking = {
  items: Array<{
    id: string;
    equipmentId: string | null;
    customName?: string | null;
    customCategory?: string | null;
    quantity: number;
    equipment?: {
      id: string;
      name: string;
      category: string;
      brand?: string | null;
      model?: string | null;
    } | null;
  }>;
  estimate?: {
    lines?: Array<{
      equipmentId?: string | null;
      nameSnapshot: string;
      unitPrice: string;
      lineSum: string;
    }> | null;
  } | null;
};

export interface BookingItemsTableProps {
  booking: ItemsTableBooking;
  retroEditMode: boolean;
  retroItems: RetroEditItem[] | undefined;
  onOpenPicker: () => void;
  onUpdateQty: (itemId: string, qty: number) => void;
  onToggleDeleted: (itemId: string) => void;
}

export function BookingItemsTable({
  booking,
  retroEditMode,
  retroItems,
  onOpenPicker,
  onUpdateQty,
  onToggleDeleted,
}: BookingItemsTableProps) {
  const estLines = booking.estimate?.lines ?? [];
  const priceByEquipmentId = new Map<string, { unitPrice: string; lineSum: string }>();
  const priceByName = new Map<string, { unitPrice: string; lineSum: string }>();
  for (const l of estLines) {
    if (l.equipmentId) priceByEquipmentId.set(l.equipmentId, { unitPrice: l.unitPrice, lineSum: l.lineSum });
    priceByName.set(l.nameSnapshot, { unitPrice: l.unitPrice, lineSum: l.lineSum });
  }
  const showPrices = estLines.length > 0;
  // В retro-edit добавляется столбец «✕» (delete) + цены в таблице отображаются read-only.
  const colCount = (showPrices ? 5 : 3) + (retroEditMode ? 1 : 0);
  // Источник правды для рендера: либо живые items, либо retro-edits.
  // В retro-edits сохранены original quantities — нужно для подсветки изменений.
  const displayItems = retroEditMode && retroItems
    ? retroItems
    : booking.items.map((it) => ({
        id: it.id,
        equipmentId: it.equipmentId,
        equipment: it.equipment,
        customName: it.customName ?? null,
        customCategory: it.customCategory ?? null,
        quantity: it.quantity,
        originalQuantity: it.quantity,
        _deleted: false,
        _added: false,
      }));

  return (
    <div className="lg:col-span-8 rounded-lg border border-border bg-surface shadow-xs overflow-hidden">
      <div className="p-3 border-b border-border bg-surface-subtle flex items-center justify-between">
        <p className="eyebrow">Позиции брони ({displayItems.filter((i) => !(i as any)._deleted).length})</p>
        {retroEditMode && (
          <button
            type="button"
            onClick={onOpenPicker}
            className="rounded border border-amber-border bg-amber-soft text-amber px-2.5 py-1 text-xs font-medium hover:bg-amber hover:text-white transition-colors no-print"
          >
            + Добавить позицию
          </button>
        )}
      </div>
      <div className="overflow-auto max-h-[560px]">
        <table className="min-w-[860px] w-full text-sm">
          <thead className="bg-surface-subtle text-ink-2 border-b border-border sticky top-0">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Категория</th>
              <th className="text-left px-3 py-2 font-medium">Наименование</th>
              <th className="px-3 py-2 w-[100px] font-medium text-right">Кол-во</th>
              {showPrices && <th className="px-3 py-2 w-[120px] font-medium text-right">Цена</th>}
              {showPrices && <th className="px-3 py-2 w-[130px] font-medium text-right">Сумма</th>}
              {retroEditMode && <th className="px-3 py-2 w-[40px] no-print"></th>}
            </tr>
          </thead>
          <tbody>
            {displayItems.map((it) => {
              const price =
                (it.equipmentId ? priceByEquipmentId.get(it.equipmentId) : undefined) ??
                priceByName.get(it.equipment?.name ?? it.customName ?? "");
              const anyIt = it as RetroEditItem;
              const qtyChanged =
                retroEditMode &&
                anyIt.originalQuantity !== undefined &&
                anyIt.quantity !== anyIt.originalQuantity &&
                !anyIt._added;
              const rowClass = anyIt._deleted
                ? "border-t border-border bg-rose-soft"
                : anyIt._added
                  ? "border-t border-border bg-emerald-soft"
                  : qtyChanged
                    ? "border-t border-border bg-amber-soft"
                    : "border-t border-border";
              return (
                <tr key={it.id} className={rowClass}>
                  <td className="px-3 py-2 text-ink-2">{it.equipment?.category ?? it.customCategory ?? "—"}</td>
                  <td className="px-3 py-2">
                    <div className={`font-medium text-ink ${anyIt._deleted ? "line-through text-ink-3" : ""}`}>
                      {it.equipment?.name ?? it.customName ?? "—"}
                    </div>
                    <div className="text-xs text-ink-3">
                      {it.equipment?.brand ? it.equipment.brand : ""} {it.equipment?.model ? `· ${it.equipment.model}` : ""}
                      {qtyChanged && (
                        <span className="text-amber ml-1">
                          · было {anyIt.originalQuantity} → стало {anyIt.quantity}
                        </span>
                      )}
                      {anyIt._added && <span className="text-emerald ml-1">· новая позиция</span>}
                      {anyIt._deleted && <span className="text-rose ml-1">· к удалению</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right mono-num">
                    {retroEditMode ? (
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={anyIt.quantity}
                        disabled={anyIt._deleted}
                        onChange={(e) =>
                          onUpdateQty(it.id, Number(e.target.value) || 0)
                        }
                        className="w-16 text-right rounded border border-amber-border bg-white px-1 py-0.5 mono-num text-sm focus:outline-none focus:ring-1 focus:ring-amber disabled:bg-rose-soft disabled:text-ink-3"
                      />
                    ) : (
                      <span className="font-medium">{it.quantity}</span>
                    )}
                  </td>
                  {showPrices && (
                    <td className="px-3 py-2 text-right mono-num text-ink-2">
                      {price ? formatMoneyRub(price.unitPrice) : "—"}
                    </td>
                  )}
                  {showPrices && (
                    <td className={`px-3 py-2 text-right mono-num font-medium ${qtyChanged ? "text-amber" : "text-ink"}`}>
                      {price
                        ? retroEditMode && !anyIt._deleted
                          // Live-пересчёт суммы строки при правке кол-ва:
                          // цена за смену × текущее кол-во (бэкенд пересчитает
                          // окончательно на сохранении, но оператор видит эффект сразу).
                          ? formatMoneyRub(String(Number(price.unitPrice) * anyIt.quantity))
                          : formatMoneyRub(price.lineSum)
                        : "—"}
                    </td>
                  )}
                  {retroEditMode && (
                    <td className="px-3 py-2 text-center no-print">
                      <button
                        type="button"
                        onClick={() => onToggleDeleted(it.id)}
                        aria-label={anyIt._deleted ? "Вернуть строку" : "Удалить строку"}
                        title={anyIt._deleted ? "Вернуть строку" : "Удалить строку"}
                        className={`text-base ${anyIt._deleted ? "text-accent-bright hover:text-accent" : "text-rose hover:text-rose/80"}`}
                      >
                        {anyIt._deleted ? "↩" : "✕"}
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
            {displayItems.length === 0 ? (
              <tr>
                <td className="px-3 py-6 text-center text-ink-3" colSpan={colCount}>
                  Нет позиций
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
