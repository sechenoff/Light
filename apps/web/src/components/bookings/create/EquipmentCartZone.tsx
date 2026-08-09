"use client";

import { formatMoneyRubWhole } from "../../../lib/format";
import { EditablePrice, ListPriceBadge, RevertPriceButton } from "./EditablePrice";
import type { CatalogRowAdjustment, CatalogSelectedItem, CustomItem, OffCatalogItem } from "./types";

// Зона «Состав заявки» — смета-таблица под каталогом.
//
// Десктоп: настоящая таблица с подписанными колонками и итогом — то же, что
// уходит заказчику в PDF, поэтому цифры сверяются глазами без пересчёта.
// Телефон: те же строки в две полосы (название + счётчик сверху, арифметика
// снизу) — пять колонок в 375 px не помещаются физически.
//
// Обе раскладки читают ОДИН нормализованный список строк (`CartRow`), а не
// каждая свои ветки по типу позиции. Двойной рендер в проекте — канон
// (см. /finance/payments, /bookings), но его цена — расхождение веток по
// набору полей; общая модель строки эту цену снимает.

type Props = {
  selected: Map<string, CatalogSelectedItem>;
  customItems: CustomItem[];
  /**
   * Число смен в периоде. Цена каталога — ставка ЗА СМЕНУ, поэтому без
   * множителя строка состава врала: на трёхдневной брони показывала треть
   * настоящей суммы. Своя позиция задаётся суммой за всю бронь и на смены
   * не умножается — как и в расчёте на сервере.
   */
  shifts: number;
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
  /**
   * Договорная цена по каталожной позиции. Не передан — цены только для
   * чтения (форма редактирования подтверждённой брони).
   */
  onChangeNegotiatedRate?: (equipmentId: string, rate: number | null) => void;
  onOpenCustomModal: () => void;
};

/** Действующая ставка за смену: договорная, если есть, иначе прайсовая. */
export function rateOf(it: CatalogSelectedItem): number {
  return it.negotiatedRatePerShift ?? Number(it.dailyPrice);
}

/**
 * Итог состава — тот же, что стоит под таблицей и в шапке блока.
 * Считается в одном месте: шапка со своей копией формулы уже разошлась с
 * составом, когда появились договорные цены (брала прайс вместо уступки).
 */
export function computeCartTotal(
  selected: Map<string, CatalogSelectedItem>,
  customItems: CustomItem[],
  shifts: number,
): number {
  let sum = 0;
  for (const it of selected.values()) sum += rateOf(it) * it.quantity * shifts;
  for (const c of customItems) sum += c.unitPrice * c.quantity;
  return sum;
}

/**
 * Строка состава в общем виде. Каталожная, своя и legacy-позиция отличаются
 * только значениями полей, а не отдельной вёрсткой.
 */
type CartRow = {
  key: string;
  name: string;
  /** Метка происхождения: «своя» / «вне каталога». Каталожные — без метки. */
  badge: { label: string; tone: "indigo" | "emerald" } | null;
  quantity: number;
  atMax: boolean;
  stepperTone: "emerald" | "indigo";
  /** Действующая цена единицы. null — legacy-позиция без цены. */
  rate: number | null;
  /** Прайсовая цена; заполнена только когда задана договорная. */
  listRate: number | null;
  /**
   * Цена задана за смену (каталог), а не за всю бронь (своя позиция).
   * Отвечает только за подпись «/см» — арифметику несёт `shiftFactor`.
   */
  perShift: boolean;
  /** На сколько смен умножается строка: каталог — на все, своя — ни на одну. */
  shiftFactor: number;
  sum: number | null;
  /** Корректировка доступности после смены дат. */
  adjustment: CatalogRowAdjustment | undefined;
  onDec: () => void;
  onInc: () => void;
  onRemove: () => void;
  /** Правка цены на месте. undefined — цена только для чтения. */
  onPriceChange: ((next: number | null) => void) | undefined;
};

function Stepper({
  qty,
  atMax,
  tone,
  name,
  onDec,
  onInc,
}: {
  qty: number;
  atMax: boolean;
  tone: "emerald" | "indigo";
  /** Имя позиции в подписи кнопок: на экране без колонок «Увеличить
   *  количество» ×N неразличимы, и скринридер не понимает, чьё количество. */
  name: string;
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
        aria-label={`Уменьшить количество: ${name}`}
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
        aria-label={`Увеличить количество: ${name}`}
        disabled={atMax}
        onClick={onInc}
        className={`flex h-7 w-7 items-center justify-center text-ink-2 ${hover} disabled:cursor-not-allowed disabled:opacity-40`}
      >
        +
      </button>
    </span>
  );
}

function RemoveButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Убрать ${name}`}
      title="Убрать из состава"
      onClick={onClick}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-ink-3 hover:bg-rose-soft hover:text-rose"
    >
      ×
    </button>
  );
}

/** Подпись под названием, когда смена дат подвинула доступность. */
function AdjustmentNote({ adjustment }: { adjustment: CatalogRowAdjustment | undefined }) {
  if (!adjustment) return null;
  if (adjustment.kind === "unavailable") {
    return <div className="text-[11px] text-rose">недоступно на новые даты</div>;
  }
  if (adjustment.kind === "clampedDown") {
    return (
      <div className="text-[11px] text-amber">
        скорректировано до {adjustment.newQty} из {adjustment.previousQty} — доступность изменилась
      </div>
    );
  }
  return null;
}

function Badge({ badge }: { badge: NonNullable<CartRow["badge"]> }) {
  const tone =
    badge.tone === "indigo" ? "bg-indigo-soft text-indigo" : "bg-emerald-soft text-emerald";
  return <span className={`rounded px-1.5 py-0.5 text-[10.5px] ${tone}`}>{badge.label}</span>;
}

export function EquipmentCartZone({
  selected,
  customItems,
  shifts,
  offCatalogItems = [],
  adjustments,
  onChangeQty,
  onRemove,
  onChangeCustomQty,
  onRemoveCustom,
  onChangeOffCatalogQty,
  onRemoveOffCatalog,
  onChangeNegotiatedRate,
  onOpenCustomModal,
}: Props) {
  const rows: CartRow[] = [
    ...Array.from(selected.values()).map<CartRow>((it) => ({
      key: `eq-${it.equipmentId}`,
      name: it.name,
      badge: null,
      quantity: it.quantity,
      atMax: it.quantity >= it.availableQuantity,
      stepperTone: "emerald",
      rate: rateOf(it),
      listRate: it.negotiatedRatePerShift != null ? Number(it.dailyPrice) : null,
      perShift: true,
      shiftFactor: shifts,
      sum: rateOf(it) * it.quantity * shifts,
      adjustment: adjustments?.get(it.equipmentId),
      onDec: () =>
        it.quantity - 1 <= 0 ? onRemove(it.equipmentId) : onChangeQty(it.equipmentId, it.quantity - 1),
      onInc: () => onChangeQty(it.equipmentId, it.quantity + 1),
      onRemove: () => onRemove(it.equipmentId),
      onPriceChange: onChangeNegotiatedRate
        ? (next) => onChangeNegotiatedRate(it.equipmentId, next)
        : undefined,
    })),
    ...customItems.map<CartRow>((it) => ({
      key: `custom-${it.tempId}`,
      name: it.name,
      badge: { label: "своя", tone: "indigo" },
      quantity: it.quantity,
      atMax: false,
      stepperTone: "indigo",
      rate: it.unitPrice,
      listRate: null,
      // Цена своей позиции — за всю бронь, а не за смену: множителя нет.
      perShift: false,
      shiftFactor: 1,
      sum: it.unitPrice * it.quantity,
      adjustment: undefined,
      onDec: () =>
        it.quantity - 1 <= 0
          ? onRemoveCustom?.(it.tempId)
          : onChangeCustomQty?.(it.tempId, it.quantity - 1),
      onInc: () => onChangeCustomQty?.(it.tempId, it.quantity + 1),
      onRemove: () => onRemoveCustom?.(it.tempId),
      onPriceChange: undefined,
    })),
    ...offCatalogItems.map<CartRow>((it) => ({
      key: `off-${it.tempId}`,
      name: it.name,
      badge: { label: "вне каталога", tone: "emerald" },
      quantity: it.quantity,
      atMax: false,
      stepperTone: "emerald",
      rate: null,
      listRate: null,
      perShift: false,
      shiftFactor: 1,
      sum: null,
      adjustment: undefined,
      onDec: () =>
        it.quantity - 1 <= 0
          ? onRemoveOffCatalog?.(it.tempId)
          : onChangeOffCatalogQty?.(it.tempId, it.quantity - 1),
      onInc: () => onChangeOffCatalogQty?.(it.tempId, it.quantity + 1),
      onRemove: () => onRemoveOffCatalog?.(it.tempId),
      onPriceChange: undefined,
    })),
  ];

  const total = computeCartTotal(selected, customItems, shifts);

  const header = (
    <div className="flex items-center justify-between px-5 pb-1 pt-2.5">
      <span className="font-cond text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
        Состав заявки{rows.length > 0 && <span className="ml-1 font-mono text-emerald">· {rows.length}</span>}
      </span>
      <button
        type="button"
        onClick={onOpenCustomModal}
        className="rounded border border-border bg-surface px-2.5 py-1 text-[12px] text-ink-2 hover:bg-surface-muted hover:text-ink"
      >
        + Своя позиция
      </button>
    </div>
  );

  if (rows.length === 0) {
    return (
      <div>
        {header}
        <div className="mx-5 mb-3 rounded-md border border-dashed border-border-strong px-4 py-3 text-center text-[12px] leading-relaxed text-ink-3">
          Пока пусто. Выберите оборудование в каталоге выше
          <br className="hidden sm:block" /> или вставьте список от гафера — AI разберёт по позициям.
        </div>
      </div>
    );
  }

  return (
    <div>
      {header}

      {/* ── Десктоп: смета-таблица ──
          Брейкпоинты нелинейны намеренно. Колонка формы шире всего НЕ на
          широком экране: с lg включаются сайдбар навигации (224) и панель
          расчёта (320+20), и на 1024 px под форму остаётся 412 px — меньше,
          чем на планшетных 768 (736 px). Поэтому таблица живёт на 768–1023 и
          от 1280 (668 px), а в провале 1024–1279 состав показывают строки:
          они текучие и в 412 px читаются, а таблица там либо жалась бы, либо
          ездила вбок. overflow-x-auto оставлен подстраховкой на зум браузера. */}
      <div className="hidden overflow-x-auto md:block lg:hidden xl:block">
        <table className="w-full min-w-[540px] text-sm">
          <thead>
            <tr className="border-y border-border bg-surface-subtle">
              <th scope="col" className="eyebrow px-3 py-2 text-left">Позиция</th>
              <th scope="col" className="eyebrow px-3 py-2 text-right">Кол-во</th>
              <th scope="col" className="eyebrow px-3 py-2 text-right">Цена/смена</th>
              <th scope="col" className="eyebrow px-3 py-2 text-right">Смен</th>
              <th scope="col" className="eyebrow px-3 py-2 text-right">Сумма</th>
              <th scope="col" className="w-11 px-3 py-2">
                <span className="sr-only">Убрать позицию</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isHardUnavail = row.adjustment?.kind === "unavailable";
              return (
                <tr
                  key={row.key}
                  className={`border-b border-border ${isHardUnavail ? "bg-rose-soft" : "hover:bg-surface-muted"}`}
                >
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-medium text-ink">{row.name}</span>
                      {row.badge && <Badge badge={row.badge} />}
                      {row.listRate != null && <ListPriceBadge value={row.listRate} />}
                    </div>
                    <AdjustmentNote adjustment={row.adjustment} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    {isHardUnavail ? (
                      // Прибавлять нечего, но количество показать обязаны:
                      // с прочерком строка читалась «— × 14 500 × 2 = 29 000»,
                      // и было не видно, за сколько единиц выставлены деньги.
                      <span className="mono-num font-semibold text-rose">{row.quantity}</span>
                    ) : (
                      <Stepper
                        qty={row.quantity}
                        atMax={row.atMax}
                        tone={row.stepperTone}
                        name={row.name}
                        onDec={row.onDec}
                        onInc={row.onInc}
                      />
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span className="inline-flex items-center justify-end gap-1">
                      {row.onPriceChange && row.listRate != null && (
                        <RevertPriceButton
                          onClick={() => row.onPriceChange?.(null)}
                          label={`Вернуть прайсовую цену: ${row.name}`}
                        />
                      )}
                      {row.rate == null ? (
                        <span className="mono-num text-ink-3">—</span>
                      ) : row.onPriceChange ? (
                        <EditablePrice
                          value={row.rate}
                          listValue={row.listRate ?? row.rate}
                          isNegotiated={row.listRate != null}
                          onChange={row.onPriceChange}
                          ariaLabel={`Цена за смену: ${row.name}`}
                        />
                      ) : (
                        <span className="mono-num font-semibold text-ink">
                          {formatMoneyRubWhole(row.rate)}
                        </span>
                      )}
                    </span>
                  </td>
                  {/* У своей позиции цена задана за всю бронь: «1» здесь
                      читалось бы как «оплачена одна смена из трёх». */}
                  <td className="mono-num px-3 py-2 text-right text-ink-3">
                    {row.perShift ? row.shiftFactor : "—"}
                  </td>
                  <td className="mono-num whitespace-nowrap px-3 py-2 text-right font-semibold text-ink">
                    {row.sum == null ? <span className="text-ink-3">—</span> : formatMoneyRubWhole(row.sum)}
                  </td>
                  <td className="px-3 py-2">
                    <RemoveButton name={row.name} onClick={row.onRemove} />
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-ink">
              <th scope="row" colSpan={4} className="px-3 py-2.5 text-left font-semibold text-ink">
                Сумма позиций
              </th>
              <td className="mono-num whitespace-nowrap px-3 py-2.5 text-right text-[15px] font-bold text-ink">
                {formatMoneyRubWhole(total)} ₽
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      {/* ── Телефон и узкая колонка: две полосы на позицию ──
          Пять колонок в 375 px не помещаются, поэтому название со счётчиком
          идут первой полосой, арифметика — второй. Видна также на 1024–1279,
          где колонка формы сжата сайдбарами (см. комментарий у таблицы).
          Данные и действия те же: обе раскладки собираются из одного `rows`. */}
      <div className="px-3 pb-2.5 md:hidden lg:block xl:hidden">
        {rows.map((row) => {
          const isHardUnavail = row.adjustment?.kind === "unavailable";
          return (
            <div
              key={row.key}
              className={`grid grid-cols-[6px_1fr_auto_auto_auto] items-center gap-x-2.5 gap-y-1 rounded-md px-2 py-1.5 ${isHardUnavail ? "bg-rose-soft" : "hover:bg-surface-muted"}`}
            >
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${isHardUnavail ? "bg-rose" : row.stepperTone === "indigo" ? "bg-indigo" : "bg-emerald"}`}
              />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                  <span className="truncate text-[13px] font-medium text-ink">{row.name}</span>
                  {row.badge && <Badge badge={row.badge} />}
                </div>
                <AdjustmentNote adjustment={row.adjustment} />
              </div>
              {row.onPriceChange && row.listRate != null ? (
                <RevertPriceButton
                  onClick={() => row.onPriceChange?.(null)}
                  label={`Вернуть прайсовую цену: ${row.name}`}
                />
              ) : (
                <span />
              )}
              {isHardUnavail ? (
                <span />
              ) : (
                <Stepper
                  qty={row.quantity}
                  atMax={row.atMax}
                  tone={row.stepperTone}
                  name={row.name}
                  onDec={row.onDec}
                  onInc={row.onInc}
                />
              )}
              <RemoveButton name={row.name} onClick={row.onRemove} />
              {row.rate != null && (
                <span className="col-start-2 col-end-[-1] row-start-2 flex flex-wrap items-center gap-1.5 whitespace-nowrap font-mono text-[12px] text-ink-2">
                  {row.onPriceChange ? (
                    <EditablePrice
                      value={row.rate}
                      listValue={row.listRate ?? row.rate}
                      isNegotiated={row.listRate != null}
                      onChange={row.onPriceChange}
                      ariaLabel={`Цена за смену: ${row.name}`}
                    />
                  ) : (
                    <span className="font-semibold text-ink">{formatMoneyRubWhole(row.rate)}</span>
                  )}
                  <span className="text-ink-3">
                    {row.perShift && "/см"} × {row.quantity}
                    {row.shiftFactor > 1 && <> × {row.shiftFactor} см</>} =
                  </span>
                  <span className="font-semibold text-ink">
                    {formatMoneyRubWhole(row.sum ?? 0)} ₽
                  </span>
                  {row.listRate != null && <ListPriceBadge value={row.listRate} />}
                </span>
              )}
            </div>
          );
        })}
        <div className="mt-1 flex items-center justify-between border-t-2 border-ink px-2 pt-2">
          <span className="text-[13px] font-semibold text-ink">Сумма позиций</span>
          <span className="mono-num text-[15px] font-bold text-ink">{formatMoneyRubWhole(total)} ₽</span>
        </div>
      </div>
    </div>
  );
}
