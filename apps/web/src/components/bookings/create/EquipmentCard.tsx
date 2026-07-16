"use client";

import { useEffect, useMemo, useState } from "react";
import { AiRequestModal } from "./AiRequestModal";
import { AiResultBanner } from "./AiResultBanner";
import { CatalogBrowser } from "./CatalogBrowser";
import { EquipmentCartZone } from "./EquipmentCartZone";
import { ReviewPanel } from "./ReviewPanel";
import type { AvailabilityRow, CatalogRowAdjustment, CatalogSelectedItem, CustomItem, OffCatalogItem, PendingReviewItem } from "./types";
import { formatMoneyRub, pluralize } from "../../../lib/format";

// Блок «3. Оборудование» v2 (утверждённые мокапы booking-equipment-v2 /
// -variants «C» / -mobile «М1»). Две зоны вместо стены чипов и вложенного
// скролла: «Состав» (выбранное — сверху, собственным списком) и «Добавить»
// (поиск + кнопка AI-заявки + каталог-проводник: desktop — категории слева,
// mobile — drill-down). Контракт props сохранён — state живёт в BookingForm.

type EquipmentSelection = {
  equipmentId: string;
  name: string;
  category: string;
  rentalRatePerShift: string;
  availableQuantity: number;
};

type Props = {
  catalog: AvailabilityRow[];
  catalogLoading: boolean;
  selected: Map<string, CatalogSelectedItem>;
  /** Legacy: позиции «вне каталога» без цены. Новый флоу конвертирует их
   *  в произвольные позиции с ценой, поэтому проп опционален. */
  offCatalogItems?: OffCatalogItem[];
  customItems?: CustomItem[];

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
  onChangeOffCatalogQty?: (tempId: string, newQty: number) => void;
  onRemoveOffCatalog?: (tempId: string) => void;
  onChangeCustomQty?: (tempId: string, newQty: number) => void;
  onRemoveCustom?: (tempId: string) => void;

  // Custom item modal
  onOpenCustomModal: () => void;

  // Search + category state (controlled)
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  activeTab: string;
  onActiveTabChange: (t: string) => void;

  shifts: number;
  adjustments: Map<string, CatalogRowAdjustment>;

  // Review panel
  pendingReview: PendingReviewItem[];
  pickupISO: string;
  returnISO: string;
  onReviewConfirm: (reviewId: string, equipment: EquipmentSelection, quantity: number) => void;
  onReviewOffCatalog: (reviewId: string) => void;
  onReviewSkip: (reviewId: string) => void;
  onReviewSkipAll: () => void;
};

export function EquipmentCard({
  catalog,
  catalogLoading,
  selected,
  offCatalogItems = [],
  customItems = [],
  gafferText,
  onGafferTextChange,
  parsing,
  parseResolved,
  parseTotal,
  unmatchedFromAi,
  successBannerDismissed,
  onParse,
  onDismissSuccess,
  onIgnoreUnmatched,
  onAddOffCatalog,
  onAdd,
  onChangeQty,
  onRemove,
  onChangeOffCatalogQty,
  onRemoveOffCatalog,
  onChangeCustomQty,
  onRemoveCustom,
  onOpenCustomModal,
  searchQuery,
  onSearchQueryChange,
  activeTab,
  onActiveTabChange,
  shifts,
  adjustments,
  pendingReview,
  pickupISO,
  returnISO,
  onReviewConfirm,
  onReviewOffCatalog,
  onReviewSkip,
  onReviewSkipAll,
}: Props) {
  // Модалка AI-заявки: открывается кнопкой или пастой многострочного текста
  // в поиск. Закрытие (Esc/крестик/фон/Отмена) НЕ стирает текст — gafferText
  // живёт в BookingForm и автосейвится в черновик.
  const [aiOpen, setAiOpen] = useState(false);

  // AI разобрал заявку → появилась панель подтверждения; модалку закрываем
  // (текст к этому моменту уже очищен parent'ом).
  useEffect(() => {
    if (pendingReview.length > 0) setAiOpen(false);
  }, [pendingReview.length]);

  const totalPositions = selected.size + offCatalogItems.length + customItems.length;
  const totalPrice = useMemo(() => {
    let sum = 0;
    for (const item of selected.values()) {
      sum += Number(item.dailyPrice) * item.quantity * shifts;
    }
    for (const c of customItems) sum += c.unitPrice * c.quantity;
    return sum;
  }, [selected, shifts, customItems]);

  function handleSearchPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text");
    if (!text.includes("\n")) return;
    // Многострочная паста — это заявка от гафера, не поисковый запрос:
    // перекидываем текст в модалку (input всё равно съел бы переводы строк).
    e.preventDefault();
    onGafferTextChange(text);
    onSearchQueryChange("");
    setAiOpen(true);
  }

  return (
    <div className="bg-surface border border-border rounded-md shadow-xs overflow-hidden mb-3.5">
      {/* Eyebrow header — matches ClientProjectCard / DatesCard style */}
      <div className="px-5 py-3 border-b border-border bg-surface-muted flex items-center justify-between">
        <h3 className="eyebrow text-ink">3. Оборудование</h3>
        <span className="font-mono text-[12px] text-ink-2">
          {totalPositions > 0 ? (
            <>
              <span className="font-semibold text-ink">
                {totalPositions} {pluralize(totalPositions, "позиция", "позиции", "позиций")}
              </span>{" "}
              · {formatMoneyRub(totalPrice)} ₽
            </>
          ) : (
            "нет позиций"
          )}
        </span>
      </div>

      {/* ── Зона 1: Состав ── */}
      <EquipmentCartZone
        selected={selected}
        customItems={customItems}
        offCatalogItems={offCatalogItems}
        adjustments={adjustments}
        onChangeQty={onChangeQty}
        onRemove={onRemove}
        onChangeCustomQty={onChangeCustomQty}
        onRemoveCustom={onRemoveCustom}
        onChangeOffCatalogQty={onChangeOffCatalogQty}
        onRemoveOffCatalog={onRemoveOffCatalog}
        onOpenCustomModal={onOpenCustomModal}
      />

      {/* AI banner — no-op when pendingReview is active (parseResolved/parseTotal are zeroed) */}
      {pendingReview.length === 0 && (
        <AiResultBanner
          resolved={parseResolved}
          total={parseTotal}
          unmatched={unmatchedFromAi}
          successDismissed={successBannerDismissed}
          onDismissSuccess={onDismissSuccess}
          onAddOffCatalog={onAddOffCatalog}
          onIgnoreUnmatched={onIgnoreUnmatched}
        />
      )}

      {/* Review panel — shown above catalog when AI parse yields items */}
      {pendingReview.length > 0 && (
        <div className="mx-5 mb-3 mt-1">
          <ReviewPanel
            items={pendingReview}
            pickupISO={pickupISO}
            returnISO={returnISO}
            onConfirm={onReviewConfirm}
            onOffCatalog={onReviewOffCatalog}
            onSkip={onReviewSkip}
            onSkipAll={onReviewSkipAll}
          />
        </div>
      )}

      {/* ── Зона 2: Добавить (поиск + AI + каталог-проводник) ── */}
      <div className="sticky top-12 z-10 border-t border-border bg-surface-muted px-5 py-2.5">
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <svg
              aria-hidden="true"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchQueryChange(e.target.value)}
              onPaste={handleSearchPaste}
              placeholder="Найти: название, бренд, модель…"
              className="h-[38px] w-full rounded-md border border-border bg-surface pl-8 pr-3 text-[13px] text-ink outline-none focus:border-accent-bright focus:shadow-[0_0_0_3px_theme(colors.accent.soft)]"
            />
          </div>
          <button
            type="button"
            onClick={() => setAiOpen(true)}
            className="flex h-[38px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink-2 hover:border-accent-border hover:bg-accent-soft hover:text-accent-bright"
          >
            <span className="hidden sm:inline">Заявка от гафера</span>
            <span className="sm:hidden">Заявка</span>
            <span className="rounded bg-surface-deep px-1.5 py-0.5 font-mono text-[10px] text-ink-3">AI</span>
          </button>
        </div>
      </div>

      <AiRequestModal
        open={aiOpen}
        text={gafferText}
        onTextChange={onGafferTextChange}
        onParse={onParse}
        onClose={() => setAiOpen(false)}
        parsing={parsing}
      />

      {/* Каталог */}
      {catalogLoading ? (
        <div className="border-t border-border px-5 py-12 text-center text-[13px] text-ink-3">
          Загружаю каталог...
        </div>
      ) : (
        <CatalogBrowser
          rows={catalog}
          selected={selected}
          adjustments={adjustments}
          activeTab={activeTab}
          onActiveTabChange={onActiveTabChange}
          searchQuery={searchQuery}
          onAdd={onAdd}
          onChangeQty={onChangeQty}
          onRemove={onRemove}
        />
      )}
    </div>
  );
}
