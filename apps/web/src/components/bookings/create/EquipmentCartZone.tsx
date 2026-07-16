"use client";

import { formatMoneyRub } from "../../../lib/format";
import type { CatalogRowAdjustment, CatalogSelectedItem, CustomItem, OffCatalogItem } from "./types";

// Зона «Состав» (редизайн блока «Оборудование», мокап booking-equipment-v2):
// выбранное живёт собственным списком наверху блока — менеджеру на телефоне
// не нужно выискивать зелёные строки по каталогу. Строки каталога и «Состав»
// синхронны: степпер в любом месте меняет одно и то же количество.

type Props = {
  selected: Map<string, CatalogSelectedItem>;
  customItems: CustomItem[];
  /** Legacy-позиции «вне каталога» без цены (новый флоу их не создаёт). */
  offCatalogItems?: OffCatalogItem[];
  /** Корректировки доступности после смены дат (clamp/unavailable). */
  adjustments?: Map<string, CatalogRowAdjustment>;
  onChangeQty: (equipmentId: string, newQty: number) => void;
  onRemove: (equipmentId: string) => void;
  onChangeCustomQty?: (tempId: string, newQty: number) => void;
  onRemoveCustom?: (tempId: string) => void;
  onChangeOffCatalogQty?: (tempId: string, newQty: number) => void;
  onRemoveOffCatalog?: (tempId: string) => void;
  onOpenCustomModal: () => void;
};

function Stepper({
  qty,
  atMax,
  tone,
  onDec,
  onInc,
}: {
  qty: number;
  atMax: boolean;
  tone: "emerald" | "indigo";
  onDec: () => void;
  onInc: () => void;
}) {
  const border = tone === "emerald" ? "border-emerald-border" : "border-indigo-border";
  const text = tone === "emerald" ? "text-emerald" : "text-indigo";
  const hover = tone === "emerald" ? "hover:bg-emerald-soft" : "hover:bg-indigo-soft";
  return (
    <span className={`inline-flex shrink-0 items-center overflow-hidden rounded border ${border} bg-surface`}>
      <button
        type="button"
        aria-label="Уменьшить количество"
        onClick={onDec}
        className={`flex h-7 w-7 items-center justify-center text-ink-2 ${hover}`}
      >
        −
      </button>
      <span className={`flex h-7 w-8 items-center justify-center border-x ${border} font-mono text-[12px] font-semibold ${text}`}>
        {qty}
      </span>
      <button
        type="button"
        aria-label="Увеличить количество"
        disabled={atMax}
        onClick={onInc}
        className={`flex h-7 w-7 items-center justify-center text-ink-2 ${hover} disabled:cursor-not-allowed disabled:opacity-40`}
      >
        +
      </button>
    </span>
  );
}

export function EquipmentCartZone({
  selected,
  customItems,
  offCatalogItems = [],
  adjustments,
  onChangeQty,
  onRemove,
  onChangeCustomQty,
  onRemoveCustom,
  onChangeOffCatalogQty,
  onRemoveOffCatalog,
  onOpenCustomModal,
}: Props) {
  const count = selected.size + customItems.length + offCatalogItems.length;

  return (
    <div>
      <div className="flex items-center justify-between px-5 pb-1 pt-2.5">
        <span className="font-cond text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
          Состав{count > 0 && <span className="ml-1 font-mono text-emerald">· {count}</span>}
        </span>
        <button
          type="button"
          onClick={onOpenCustomModal}
          className="rounded border border-border bg-surface px-2.5 py-1 text-[12px] text-ink-2 hover:bg-surface-muted hover:text-ink"
        >
          + Своя позиция
        </button>
      </div>

      {count === 0 ? (
        <div className="mx-5 mb-3 rounded-md border border-dashed border-border-strong px-4 py-3 text-center text-[12px] leading-relaxed text-ink-3">
          Пока пусто. Найдите оборудование в каталоге ниже
          <br className="hidden sm:block" /> или вставьте список от гафера — AI разберёт по позициям.
        </div>
      ) : (
        <div className="px-3 pb-2.5">
          {Array.from(selected.values()).map((it) => {
            const adj = adjustments?.get(it.equipmentId);
            const isHardUnavail = adj?.kind === "unavailable";
            const isClamped = adj?.kind === "clampedDown";
            return (
              <div
                key={it.equipmentId}
                className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 ${isHardUnavail ? "bg-rose-soft" : "hover:bg-surface-muted"}`}
              >
                <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${isHardUnavail ? "bg-rose" : "bg-emerald"}`} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-ink">{it.name}</div>
                  {isHardUnavail ? (
                    <div className="text-[11px] text-rose">недоступно на новые даты</div>
                  ) : isClamped ? (
                    <div className="text-[11px] text-amber">
                      скорректировано до {adj.newQty} из {adj.previousQty} — доступность изменилась
                    </div>
                  ) : null}
                </div>
                <span className="hidden whitespace-nowrap font-mono text-[12px] text-ink-2 sm:inline">
                  {formatMoneyRub(Number(it.dailyPrice))} × {it.quantity} = {formatMoneyRub(Number(it.dailyPrice) * it.quantity)} ₽
                </span>
                {!isHardUnavail && (
                  <Stepper
                    qty={it.quantity}
                    atMax={it.quantity >= it.availableQuantity}
                    tone="emerald"
                    onDec={() => (it.quantity - 1 <= 0 ? onRemove(it.equipmentId) : onChangeQty(it.equipmentId, it.quantity - 1))}
                    onInc={() => onChangeQty(it.equipmentId, it.quantity + 1)}
                  />
                )}
                <button
                  type="button"
                  aria-label={`Убрать ${it.name}`}
                  title="Убрать из состава"
                  onClick={() => onRemove(it.equipmentId)}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-ink-3 hover:bg-rose-soft hover:text-rose"
                >
                  ×
                </button>
              </div>
            );
          })}

          {customItems.map((it) => (
            <div key={it.tempId} className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-surface-muted">
              <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-indigo" />
              <div className="min-w-0 flex-1">
                <span className="truncate text-[13px] font-medium text-ink">{it.name}</span>
                <span className="ml-1.5 rounded bg-indigo-soft px-1.5 py-0.5 text-[10.5px] text-indigo">своя</span>
              </div>
              <span className="hidden whitespace-nowrap font-mono text-[12px] text-ink-2 sm:inline">
                {formatMoneyRub(it.unitPrice)} × {it.quantity} = {formatMoneyRub(it.unitPrice * it.quantity)} ₽
              </span>
              <Stepper
                qty={it.quantity}
                atMax={false}
                tone="indigo"
                onDec={() => (it.quantity - 1 <= 0 ? onRemoveCustom?.(it.tempId) : onChangeCustomQty?.(it.tempId, it.quantity - 1))}
                onInc={() => onChangeCustomQty?.(it.tempId, it.quantity + 1)}
              />
              <button
                type="button"
                aria-label={`Убрать ${it.name}`}
                title="Убрать из состава"
                onClick={() => onRemoveCustom?.(it.tempId)}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-ink-3 hover:bg-rose-soft hover:text-rose"
              >
                ×
              </button>
            </div>
          ))}

          {offCatalogItems.map((it) => (
            <div key={it.tempId} className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-surface-muted">
              <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald" />
              <div className="min-w-0 flex-1">
                <span className="truncate text-[13px] font-medium text-ink">{it.name}</span>
                <span className="ml-1.5 rounded bg-emerald-soft px-1.5 py-0.5 text-[10.5px] text-emerald">вне каталога</span>
              </div>
              <Stepper
                qty={it.quantity}
                atMax={false}
                tone="emerald"
                onDec={() => (it.quantity - 1 <= 0 ? onRemoveOffCatalog?.(it.tempId) : onChangeOffCatalogQty?.(it.tempId, it.quantity - 1))}
                onInc={() => onChangeOffCatalogQty?.(it.tempId, it.quantity + 1)}
              />
              <button
                type="button"
                aria-label={`Убрать ${it.name}`}
                title="Убрать из состава"
                onClick={() => onRemoveOffCatalog?.(it.tempId)}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-ink-3 hover:bg-rose-soft hover:text-rose"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
