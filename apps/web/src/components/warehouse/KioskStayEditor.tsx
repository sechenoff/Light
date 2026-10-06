"use client";

/**
 * «Остаётся у клиента» на приёмке в киоске (мокап M3, этап 15).
 *
 * `StayTerms` — срок и деньги оставленного: чипы «до конца оплаченного /
 * +1…3 смены / дата…», «Вернут … · без доплаты» или «+N смен → X ₽», карточка
 * держателя с «Оставить под ответственность». Общий для строк «по плану» и
 * для любой строки, где нажали «Остаётся у клиента…» (`KioskStayEditor`).
 */
import { formatRub } from "../../lib/format";
import { quoteName } from "../inventory/format";
import { formatStayWhen } from "./PlannedStaysBlock";
import {
  beyondPaid,
  fromWhen,
  newStay,
  shiftsWord,
  stayChoices,
  toLocalInput,
  untilFor,
  withTerms,
  MAX_STAY_AHEAD_MS,
  type KioskStay,
  type KioskStayChoice,
  type KioskStaysPreview,
} from "./kioskStays";
import type { ChecklistItem } from "./types";

type PreviewLine = KioskStaysPreview["continuations"][number]["lines"][number];
type Conflict = KioskStaysPreview["conflicts"][number];

export function StayTerms({
  label,
  paidThrough,
  stay,
  previewLine,
  conflict,
  discountPercent,
  previewLoading,
  disabled,
  onChange,
}: {
  label: string;
  paidThrough: string | undefined;
  stay: KioskStay;
  previewLine: PreviewLine | null;
  conflict: Conflict | null;
  discountPercent: number;
  previewLoading: boolean;
  disabled: boolean;
  onChange: (next: KioskStay) => void;
}) {
  const beyond = beyondPaid(stay.until, paidThrough);
  const pick = (choice: KioskStayChoice, customUntil?: string) =>
    onChange(withTerms(stay, { choice, until: choice === "date" ? customUntil ?? stay.until : untilFor(paidThrough, choice) }));

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-4 gap-1" role="radiogroup" aria-label={`До какого срока остаётся: ${label}`}>
        {stayChoices(paidThrough).map((c) => {
          const on = stay.choice === c.choice;
          return (
            <button
              key={String(c.choice)}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={disabled}
              onClick={() => pick(c.choice)}
              className={`flex min-h-11 items-center justify-center rounded border px-1 py-1 text-center text-[12px] leading-tight hyphens-auto [overflow-wrap:anywhere] disabled:opacity-60 ${
                on ? "border-accent-bright bg-accent-soft font-semibold text-accent" : "border-border bg-surface text-ink-2"
              }`}
            >
              {c.label}
            </button>
          );
        })}
      </div>
      {stay.choice === "date" && (
        <input
          type="datetime-local"
          aria-label={`Срок возврата: ${label}`}
          value={toLocalInput(stay.until)}
          min={toLocalInput(new Date().toISOString())}
          max={toLocalInput(new Date(Date.now() + MAX_STAY_AHEAD_MS).toISOString())}
          disabled={disabled}
          onChange={(e) => {
            const d = new Date(e.target.value);
            const t = d.getTime();
            if (Number.isFinite(t) && t > Date.now() && t <= Date.now() + MAX_STAY_AHEAD_MS) pick("date", d.toISOString());
          }}
          className="h-11 w-full rounded-md border border-border bg-surface px-3 text-sm text-ink"
        />
      )}
      <p className="text-[12.5px] text-ink-2">
        Вернут <span className="font-semibold text-ink">{formatStayWhen(stay.until)}</span>
        {!beyond ? (
          " · без доплаты"
        ) : previewLoading ? (
          <span className="text-ink-3"> · считаем доплату…</span>
        ) : previewLine && previewLine.billedShifts === 0 ? (
          " · без доплаты"
        ) : previewLine && previewLine.billedShifts > 0 ? (
          <span className="text-amber">
            {" "}
            · {stay.quantity} шт × {previewLine.billedShifts} {shiftsWord(previewLine.billedShifts)} → {formatRub(previewLine.afterDiscount)}
            {previewLine.negotiated ? ", договорная цена" : discountPercent > 0 ? " со скидкой" : ""}
          </span>
        ) : (
          <span className="text-ink-3"> · сверх оплаченного</span>
        )}
      </p>
      {conflict && beyond && (
        <div className="rounded-md border border-amber-border bg-amber-soft px-3 py-2.5" role="group" aria-label={`Нужен другой брони: ${label}`}>
          <p className="text-[13px] font-semibold text-amber">
            Нужен {conflict.holder ? `брони ${quoteName(conflict.holder.projectName)}` : "другой брони"}{" "}
            {fromWhen(formatStayWhen(conflict.neededFrom ?? conflict.from))}
          </p>
          <p className="mt-0.5 text-[12px] leading-snug text-ink-2">
            Свободно {Math.max(0, conflict.available)} из {conflict.needed}. Клиент сам договорился — склад не запрещает.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              aria-pressed={stay.acknowledged === true}
              disabled={disabled}
              onClick={() => onChange({ ...stay, acknowledged: !stay.acknowledged })}
              className={`min-h-11 rounded-md border px-3 text-[13px] font-semibold ${stay.acknowledged ? "border-amber bg-amber text-surface" : "border-amber bg-surface text-amber"}`}
            >
              {stay.acknowledged ? "✓ Под ответственность" : "Оставить под ответственность"}
            </button>
            {paidThrough && Date.parse(paidThrough) > Date.now() && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => pick("paid")}
                className="min-h-11 rounded-md border border-border bg-surface px-3 text-[13px] text-ink-2"
              >
                Только до {formatStayWhen(paidThrough)}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** «Остаётся у клиента…» под строкой чек-листа: ссылка, а по нажатию — что и до когда. */
export function KioskStayEditor({
  item,
  stay,
  paidThrough,
  previewLine,
  conflict,
  discountPercent,
  previewLoading,
  disabled,
  onChange,
  maxKeep,
  lockedUnitIds = [],
}: {
  item: ChecklistItem;
  stay: KioskStay | undefined;
  /** Сколько можно оставить: ремонт и «Потеряшки» строки остаться не могут. */
  maxKeep?: number;
  /** Единицы с отметкой ремонта или проблемы — их не оставить. */
  lockedUnitIds?: string[];
  paidThrough: string | undefined;
  previewLine: PreviewLine | null;
  conflict: Conflict | null;
  discountPercent: number;
  previewLoading: boolean;
  disabled: boolean;
  onChange: (next: KioskStay | null) => void;
}) {
  const unitTracked = item.trackingMode === "UNIT" && item.units != null;
  const total = unitTracked ? item.units!.length : item.quantity;
  const cap = Math.min(total, maxKeep ?? total);
  if (!stay) {
    return (
      <button
        type="button"
        disabled={disabled || cap <= 0}
        title={cap <= 0 ? "Всё отмечено ремонтом или «Потеряшками» — оставить у клиента нечего" : undefined}
        onClick={() => onChange(newStay(paidThrough, unitTracked ? 0 : 1))}
        aria-label={`Остаётся у клиента: ${item.equipmentName}`}
        className="min-h-11 px-1.5 text-[13px] font-medium text-accent underline-offset-2 hover:underline disabled:opacity-60"
      >
        Остаётся у клиента…
      </button>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border border-teal-border bg-teal-soft/40 px-3 py-2.5" data-testid="kiosk-stay">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] font-semibold text-teal">Остаётся у клиента</p>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(null)}
          aria-label={`Не остаётся: ${item.equipmentName}`}
          className="min-h-11 rounded-md border border-border bg-surface px-3 text-[12.5px] text-ink-2"
        >
          Не остаётся
        </button>
      </div>
      {unitTracked ? (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={`Какие единицы остаются у клиента: ${item.equipmentName}`}>
          {item.units!.map((u, idx) => {
            const on = stay.unitIds.includes(u.unitId);
            const locked = !on && lockedUnitIds.includes(u.unitId);
            return (
              <button
                key={u.unitId}
                type="button"
                aria-pressed={on}
                disabled={disabled || locked}
                title={locked ? "Отмечен ремонт или «Потеряшки» — оставить у клиента нельзя" : undefined}
                onClick={() => {
                  const unitIds = on ? stay.unitIds.filter((id) => id !== u.unitId) : [...stay.unitIds, u.unitId];
                  onChange(withTerms(stay, { unitIds, quantity: unitIds.length }));
                }}
                className={`min-h-11 rounded-md border px-3 text-[13px] ${on ? "border-teal bg-teal text-surface" : "border-border bg-surface text-ink-2"}`}
              >
                прибор {idx + 1} из {total}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="flex items-center gap-2 text-[13px] text-ink-2">
          <span className="inline-flex items-center overflow-hidden rounded-md border border-teal-border bg-surface">
            <button
              type="button"
              aria-label={`Меньше остаётся: ${item.equipmentName}`}
              disabled={disabled || stay.quantity <= 1}
              onClick={() => onChange(withTerms(stay, { quantity: stay.quantity - 1 }))}
              className="flex h-11 w-11 items-center justify-center text-ink-2 disabled:opacity-40"
            >
              −
            </button>
            <span className="flex h-11 w-10 items-center justify-center border-x border-teal-border font-mono font-semibold text-teal">
              {stay.quantity}
            </span>
            <button
              type="button"
              aria-label={`Больше остаётся: ${item.equipmentName}`}
              disabled={disabled || stay.quantity >= cap}
              onClick={() => onChange(withTerms(stay, { quantity: stay.quantity + 1 }))}
              className="flex h-11 w-11 items-center justify-center text-ink-2 disabled:opacity-40"
            >
              +
            </button>
          </span>
          из {total}
        </div>
      )}
      {stay.quantity > 0 ? (
        <StayTerms
          label={item.equipmentName}
          paidThrough={paidThrough}
          stay={stay}
          previewLine={previewLine}
          conflict={conflict}
          discountPercent={discountPercent}
          previewLoading={previewLoading}
          disabled={disabled}
          onChange={onChange}
        />
      ) : (
        <p className="text-[12px] text-ink-3">Отметьте, какие приборы остаются у клиента</p>
      )}
    </div>
  );
}
