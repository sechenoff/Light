"use client";

import { formatMoneyRub, pluralize } from "../../../lib/format";
import type { CatalogSelectedItem, CustomItem, OffCatalogItem, QuoteResponse, TransportBreakdown, ValidationCheck } from "./types";

type SummaryPanelProps = {
  quote: QuoteResponse | null;
  localSubtotal: number;
  localDiscount: number;
  localTotal: number;
  discountPercent: number;
  itemCount: number;
  shifts: number;
  isLoadingQuote: boolean;
  checks: ValidationCheck[];
  // Create-mode buttons (required when mode="create" or mode not provided)
  onSubmitForApproval?: () => void;
  onSaveDraft?: () => void;
  // Edit-mode button
  onSaveEdit?: () => void;
  canSubmit: boolean;
  selectedItems?: Map<string, CatalogSelectedItem>;
  offCatalogItems?: OffCatalogItem[];
  customItems?: CustomItem[];
  selectedVehicleName?: string | null;
  localTransport?: TransportBreakdown | null;
  onRemoveItem?: (equipmentId: string) => void;
  onRemoveOffCatalog?: (tempId: string) => void;
  onRemoveCustom?: (tempId: string) => void;
  /** Controls which action buttons to render. Defaults to "create". */
  mode?: "create" | "edit";
  /** Whether a save/submit action is in progress. */
  submitting?: boolean;
  /** Cancel link href (edit mode). */
  cancelHref?: string;
};

const CHECK_BADGE: Record<ValidationCheck["type"], { symbol: string; colorClass: string }> = {
  ok: { symbol: "✓", colorClass: "text-emerald" },
  warn: { symbol: "!", colorClass: "text-amber" },
  tip: { symbol: "i", colorClass: "text-accent" },
};

export function SummaryPanel({
  quote,
  localSubtotal,
  localDiscount,
  localTotal,
  discountPercent,
  itemCount,
  shifts,
  isLoadingQuote,
  checks,
  onSubmitForApproval,
  onSaveDraft,
  onSaveEdit,
  canSubmit,
  selectedItems,
  offCatalogItems,
  customItems,
  selectedVehicleName,
  localTransport,
  onRemoveItem,
  onRemoveOffCatalog,
  onRemoveCustom,
  mode = "create",
  submitting = false,
  cancelHref,
}: SummaryPanelProps) {
  const equipSubtotal = quote ? Number(quote.equipmentSubtotal ?? quote.subtotal) : localSubtotal;
  const discount = quote ? Number(quote.discountAmount) : localDiscount;
  const equipTotal = quote ? Number(quote.equipmentTotal ?? quote.totalAfterDiscount) : localTotal;
  const discPct = quote ? Number(quote.discountPercent) : discountPercent;
  const effectiveShifts = quote ? quote.shifts : shifts;

  // Transport: prefer server quote, fallback to local calculation
  const transport = quote?.transport ?? localTransport ?? null;
  const transportTotal = transport ? Number(transport.total) : 0;
  const vehicleName = transport?.vehicleName ?? selectedVehicleName ?? null;

  // Grand total: prefer server, fallback to local
  const grandTotal = quote?.grandTotal
    ? Number(quote.grandTotal)
    : equipTotal + transportTotal;
  // Legacy: subtotal for backward compat in display
  const subtotal = equipSubtotal;
  const total = grandTotal;

  const bigTotalFormatted = Math.round(total).toLocaleString("ru-RU");

  type MiniItem =
    | { kind: "catalog"; key: string; equipmentId: string; name: string; qty: number }
    | { kind: "off"; key: string; tempId: string; name: string; qty: number }
    | { kind: "custom"; key: string; tempId: string; name: string; qty: number; unitPrice: number };
  const miniList: MiniItem[] = [];
  if (selectedItems) {
    for (const s of selectedItems.values()) {
      miniList.push({ kind: "catalog", key: s.equipmentId, equipmentId: s.equipmentId, name: s.name, qty: s.quantity });
    }
  }
  if (offCatalogItems) {
    for (const o of offCatalogItems) {
      miniList.push({ kind: "off", key: o.tempId, tempId: o.tempId, name: o.name, qty: o.quantity });
    }
  }
  if (customItems) {
    for (const c of customItems) {
      miniList.push({ kind: "custom", key: c.tempId, tempId: c.tempId, name: c.name, qty: c.quantity, unitPrice: c.unitPrice });
    }
  }

  return (
    <aside className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 shadow-xs">
      {/* Header */}
      <div className="flex items-baseline justify-between">
        <p className="eyebrow">Расчёт</p>
        <span className="text-xs text-ink-3">
          {isLoadingQuote ? "считаю..." : "обновлено сейчас"}
        </span>
      </div>

      {/* Big total */}
      <div>
        <div className="flex items-baseline gap-1">
          <span className="font-mono text-[32px] font-semibold leading-none text-ink">
            {bigTotalFormatted}
          </span>
          <span className="text-[18px] text-ink-3">₽</span>
        </div>
        <p className="mt-1 text-xs text-ink-3">
          {effectiveShifts} {pluralize(effectiveShifts, "день", "дня", "дней")} · {itemCount} {pluralize(itemCount, "позиция", "позиции", "позиций")}
        </p>
      </div>

      {/* Breakdown */}
      <div className="flex flex-col gap-1 text-sm">
        <div className="flex justify-between">
          <span className="text-ink-2">Оборудование</span>
          <span className="mono-num text-ink">{formatMoneyRub(equipSubtotal)} ₽</span>
        </div>
        {discPct > 0 && (
          <>
            <div className="flex justify-between">
              <span className="text-ink-2">Скидка {discPct}%</span>
              <span className="mono-num text-rose">−{formatMoneyRub(discount)} ₽</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-2">Оборудование итого</span>
              <span className="mono-num text-ink">{formatMoneyRub(equipTotal)} ₽</span>
            </div>
          </>
        )}
        {transportTotal > 0 && (
          <div className="flex justify-between">
            <span className="text-ink-2">
              Транспорт{vehicleName ? ` (${vehicleName})` : ""}
            </span>
            <span className="mono-num text-ink">{formatMoneyRub(transportTotal)} ₽</span>
          </div>
        )}
        <div className="flex justify-between border-t border-border pt-1 font-semibold">
          <span className="text-ink">Итого</span>
          <span className="mono-num text-ink">{formatMoneyRub(grandTotal)} ₽</span>
        </div>
      </div>

      {/* Mini-list of selected items */}
      {miniList.length > 0 && (
        <div className="flex flex-col gap-0.5 border-t border-border pt-3">
          {miniList.map((it) => (
            <div key={it.key} className="group flex items-center gap-2 rounded px-1 py-0.5 text-[11.5px] hover:bg-surface-muted">
              <span className="min-w-0 flex-1 truncate text-ink">{it.name}</span>
              {it.kind === "custom" ? (
                <span className="font-mono text-[11px] text-ink-3">{formatMoneyRub(it.unitPrice)} × {it.qty} = {formatMoneyRub(it.unitPrice * it.qty)} ₽</span>
              ) : (
                <span className="font-mono text-[11px] text-ink-3">×{it.qty}</span>
              )}
              {(it.kind === "catalog" ? onRemoveItem : it.kind === "off" ? onRemoveOffCatalog : onRemoveCustom) && (
                <button
                  type="button"
                  aria-label={`Удалить ${it.name}`}
                  title="Удалить из корзины"
                  onClick={() => {
                    if (it.kind === "catalog") {
                      onRemoveItem?.(it.equipmentId);
                    } else if (it.kind === "off") {
                      onRemoveOffCatalog?.(it.tempId);
                    } else {
                      onRemoveCustom?.(it.tempId);
                    }
                  }}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-3 opacity-0 transition-all hover:bg-rose-soft hover:text-rose group-hover:opacity-100 focus:opacity-100"
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Action buttons */}
      {mode === "edit" ? (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            disabled={!canSubmit || submitting}
            onClick={onSaveEdit}
            className="w-full rounded bg-accent-bright px-4 py-2.5 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? "Сохранение…" : "Сохранить изменения"}
          </button>
          {cancelHref && (
            <a
              href={cancelHref}
              className="w-full rounded border border-border bg-surface px-4 py-2.5 text-sm font-medium text-ink-2 hover:bg-surface-muted text-center"
            >
              Отмена
            </a>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            disabled={!canSubmit}
            onClick={onSubmitForApproval}
            className="w-full rounded bg-ink px-4 py-2.5 text-sm font-medium text-white hover:bg-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            Отправить на согласование →
          </button>
          <button
            type="button"
            onClick={onSaveDraft}
            className="w-full rounded border border-border bg-surface px-4 py-2.5 text-sm font-medium text-ink-2 hover:bg-surface-muted"
          >
            Сохранить черновик
          </button>
        </div>
      )}

      {/* Validation checks */}
      {checks.length > 0 && (
        <ul className="flex flex-col gap-2">
          {checks.map((check, i) => {
            const badge = CHECK_BADGE[check.type];
            return (
              <li key={i} className="flex items-start gap-2">
                <span
                  className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold ${badge.colorClass}`}
                >
                  {badge.symbol}
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-medium text-ink">{check.label}</p>
                  {check.detail && <p className="text-xs text-ink-3">{check.detail}</p>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
