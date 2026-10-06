"use client";

/**
 * Смены позиции в «Составе заявки» (мокап M1, docs/mockups/line-shifts-continuation/
 * m1-form-shifts.html).
 *
 * Компьютер — число в ячейке, как договорная цена: нажать, вписать, Enter.
 * Esc отменяет, ↑ и ↓ меняют на одну смену, «↺» возвращает к сроку брони.
 * Своё значение — индиго, под ним срок возврата позиции.
 *
 * Телефон — чип «2 см ▾» в арифметике строки открывает шторку с крупным
 * степпером: цифровая клавиатура закрывает полэкрана, а в поле шириной 30 px
 * трудно попасть пальцем.
 */
import { useRef, useState } from "react";

import { useDialog } from "../../../hooks/useDialog";
import { formatMoneyRubWhole } from "../../../lib/format";
import {
  MAX_LINE_SHIFTS,
  effectiveLineShifts,
  formatDueLong,
  formatDueShort,
  isLongLine,
  parseShiftsInput,
  shiftsWord,
} from "./lineShifts";

/** Недостача склада на срок строки: «на ср свободно 1 из 2». */
export type LineShortage = { available: number; dueDay: string };

export function ShortageNote({ shortage, quantity }: { shortage: LineShortage; quantity: number }) {
  return (
    <span className="inline-flex items-center gap-1 text-amber">
      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
        <path d="M12 9v4M12 17h.01" />
      </svg>
      на {shortage.dueDay} свободно {Math.max(0, shortage.available)} из {quantity}
    </span>
  );
}

type CellProps = {
  name: string;
  /** Своё значение позиции; null — как у брони. */
  own: number | null;
  bookingShifts: number;
  /** Срок возврата строки при данном числе смен (мс). */
  dueFor: (lineShifts: number | null) => number;
  /** Новое значение или null — как у брони. Не передан — только чтение. */
  onChange?: (next: number | null) => void;
};

const NUMBER_BOX = "inline-flex h-8 min-w-[48px] items-center justify-end rounded border px-2 font-mono text-[12.5px]";

/** Ячейка «Смен» в таблице состава (компьютер). */
export function LineShiftsCell({ name, own, bookingShifts, dueFor, onChange }: CellProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const openedWithRef = useRef<string | null>(null);
  // Escape приходит раньше blur: без флага отмена превращалась в фиксацию.
  const cancelledRef = useRef(false);
  const effective = effectiveLineShifts(bookingShifts, own);
  const long = isLongLine(bookingShifts, own);
  const editing = draft !== null;

  function open() {
    if (!onChange) return;
    const opened = String(effective);
    openedWithRef.current = opened;
    cancelledRef.current = false;
    setDraft(opened);
  }

  function commit(raw: string, el: HTMLInputElement) {
    setDraft(null);
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    // Переход через брейкпоинт прячет таблицу, браузер шлёт blur — человек
    // ничего не завершал, недонабранное записывать нельзя (как в EditablePrice).
    if (typeof el.checkVisibility === "function" && !el.checkVisibility()) return;
    if (raw === openedWithRef.current) return;
    onChange?.(parseShiftsInput(raw));
  }

  const draftValue = editing ? parseShiftsInput(draft as string) : own;
  const draftLong = isLongLine(bookingShifts, draftValue);
  const caption = editing ? (
    <>
      <div className={`mt-1 whitespace-nowrap text-[11.5px] ${draftLong ? "text-indigo" : "text-ink-3"}`}>
        {draftLong ? `возврат ${formatDueShort(dueFor(draftValue))}` : "совпадает со сроком брони"}
      </div>
      <div className="mt-0.5 whitespace-nowrap font-mono text-[10.5px] text-ink-3">Enter · Esc · ↑↓</div>
    </>
  ) : long ? (
    <div className="mt-1 whitespace-nowrap text-[11.5px] text-indigo">возврат {formatDueShort(dueFor(own))}</div>
  ) : own != null ? (
    <div className="mt-1 whitespace-nowrap text-[11.5px] text-ink-3">совпадает со сроком брони</div>
  ) : null;

  return (
    <div className="flex flex-col items-end">
      <div className="flex items-center justify-end gap-1">
        {onChange && own != null && !editing && (
          <button
            type="button"
            onClick={() => onChange(null)}
            aria-label={`Как у брони: ${bookingShifts} ${shiftsWord(bookingShifts)} — ${name}`}
            title={`↺ как у брони · ${bookingShifts} ${shiftsWord(bookingShifts)}`}
            className="flex h-8 w-7 items-center justify-center rounded text-[13px] text-ink-3 hover:bg-rose-soft hover:text-rose focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-bright"
          >
            ↺
          </button>
        )}
        {editing ? (
          <input
            autoFocus
            type="text"
            inputMode="numeric"
            aria-label={`Смен для ${name}`}
            value={draft as string}
            // Выделить сразу, а не в следующем кадре: значение уже в поле, а
            // быстрый ввод успевал дописаться к нему — «2» превращалось в «12».
            onFocus={(e) => e.target.select()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={(e) => commit(e.target.value, e.target)}
            onKeyDown={(e) => {
              const el = e.target as HTMLInputElement;
              if (e.key === "Enter") {
                e.preventDefault();
                el.blur();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                cancelledRef.current = true;
                el.blur();
              } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                e.preventDefault();
                const current = parseShiftsInput(el.value) ?? bookingShifts;
                const next = e.key === "ArrowUp" ? current + 1 : current - 1;
                setDraft(String(Math.max(1, Math.min(MAX_LINE_SHIFTS, next))));
              }
            }}
            className="h-8 w-[56px] rounded border border-accent-bright bg-surface px-2 text-right font-mono text-[12.5px] font-semibold text-ink outline-none ring-[3px] ring-accent-soft"
          />
        ) : onChange ? (
          <button
            type="button"
            onClick={open}
            aria-label={
              long
                ? `Смен: ${effective}, своё значение — ${name}. Изменить`
                : `Смен: ${effective}, как у брони — ${name}. Изменить`
            }
            title={long ? undefined : "Как у брони — нажмите, чтобы изменить"}
            className={
              long
                ? `${NUMBER_BOX} border-indigo-border bg-indigo-soft font-semibold text-indigo hover:border-indigo focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-bright`
                : `${NUMBER_BOX} border-transparent border-b-border-strong text-ink-2 hover:border-border-strong hover:bg-surface-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-bright`
            }
          >
            {effective}
          </button>
        ) : (
          <span className={`${NUMBER_BOX} border-transparent ${long ? "font-semibold text-indigo" : "text-ink-3"}`}>{effective}</span>
        )}
      </div>
      {caption}
    </div>
  );
}

/** Чип «2 см ▾» в арифметике строки (телефон и узкая колонка). */
export function LineShiftsChip({
  own,
  bookingShifts,
  name,
  onOpen,
}: {
  own: number | null;
  bookingShifts: number;
  name: string;
  onOpen: () => void;
}) {
  const effective = effectiveLineShifts(bookingShifts, own);
  const long = isLongLine(bookingShifts, own);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Смены позиции: ${effective} — ${name}. Изменить`}
      aria-haspopup="dialog"
      className={`inline-flex h-9 items-center gap-1 rounded border px-2.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-bright ${
        long ? "border-indigo-border bg-indigo-soft font-semibold text-indigo" : "border-border bg-surface text-ink-2"
      }`}
    >
      {effective} см <span aria-hidden="true" className={`text-[10px] ${long ? "" : "text-ink-3"}`}>▾</span>
    </button>
  );
}

type SheetProps = {
  name: string;
  quantity: number;
  own: number | null;
  bookingShifts: number;
  /** «пн 12 окт. 10:00 → вт 13 окт. 10:00» */
  periodLabel: string | null;
  /** Действующая ставка за смену. */
  rate: number;
  dueFor: (lineShifts: number | null) => number;
  shortage: LineShortage | null;
  onChange: (next: number | null) => void;
  onClose: () => void;
};

/** Шторка «Смены позиции» со степпером (телефон). Правка применяется сразу. */
export function LineShiftsSheet({
  name,
  quantity,
  own,
  bookingShifts,
  periodLabel,
  rate,
  dueFor,
  shortage,
  onChange,
  onClose,
}: SheetProps) {
  const ref = useDialog<HTMLDivElement>(true, onClose);
  const effective = effectiveLineShifts(bookingShifts, own);
  const long = isLongLine(bookingShifts, own);
  // Степпером ниже срока брони не опуститься: до него строка и так идёт с бронью.
  const step = (next: number) => onChange(next <= bookingShifts ? null : Math.min(MAX_LINE_SHIFTS, next));
  const quick = [bookingShifts + 1, bookingShifts + 2, bookingShifts + 4].filter((n) => n <= MAX_LINE_SHIFTS);
  const sum = rate * quantity * effective;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-scrim/50" onClick={onClose}>
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="line-shifts-sheet-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[480px] rounded-t-2xl border-t border-border bg-surface px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2 shadow-sm outline-none"
      >
        <div aria-hidden="true" className="mx-auto mb-3 h-1 w-10 rounded-full bg-border-strong" />
        <p className="eyebrow">Смены позиции</p>
        <h3 id="line-shifts-sheet-title" className="mt-0.5 text-[15px] font-semibold text-ink">
          {name} · {quantity} шт
        </h3>
        <p className="mt-0.5 text-[12px] text-ink-3">
          Бронь: {bookingShifts} {shiftsWord(bookingShifts)}
          {periodLabel ? `, ${periodLabel}` : ""}
        </p>

        <div className="mt-4 flex items-center justify-between gap-3">
          <div className="inline-flex items-center overflow-hidden rounded-lg border border-indigo-border bg-surface">
            <button
              type="button"
              aria-label="На смену меньше"
              disabled={effective <= bookingShifts}
              onClick={() => step(effective - 1)}
              className="flex h-11 w-12 items-center justify-center text-xl text-ink-2 disabled:opacity-40"
            >
              −
            </button>
            <span
              aria-live="polite"
              className={`flex h-11 w-14 items-center justify-center border-x border-indigo-border font-mono text-[22px] font-semibold ${long ? "bg-indigo-soft text-indigo" : "text-ink"}`}
            >
              {effective}
            </span>
            <button
              type="button"
              aria-label="На смену больше"
              disabled={effective >= MAX_LINE_SHIFTS}
              onClick={() => step(effective + 1)}
              className="flex h-11 w-12 items-center justify-center text-xl text-ink-2 disabled:opacity-40"
            >
              +
            </button>
          </div>
          <p className="text-right text-[12px] leading-snug text-ink-3">
            смены
            <br />
            не меньше {bookingShifts}
          </p>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => onChange(null)}
            className={`inline-flex h-10 items-center rounded-full border px-3 text-[12.5px] ${own == null ? "border-indigo bg-indigo font-semibold text-surface" : "border-border bg-surface text-ink-2"}`}
          >
            ↺ как у брони · {bookingShifts}
          </button>
          {quick.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => onChange(n)}
              aria-pressed={effective === n && long}
              className={`inline-flex h-10 min-w-[44px] items-center justify-center rounded-full border px-3 font-mono text-[12.5px] ${
                effective === n && long ? "border-indigo bg-indigo font-semibold text-surface" : "border-border bg-surface text-ink-2"
              }`}
            >
              {n}
            </button>
          ))}
        </div>

        <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-md border border-border bg-surface-subtle px-3 py-2.5 text-[12.5px]">
          <dt className="text-ink-3">Возврат</dt>
          <dd className={`text-right font-medium ${long ? "text-indigo" : "text-ink-2"}`}>
            {long ? formatDueLong(dueFor(own)) : "вместе с бронью"}
          </dd>
          <dt className="text-ink-3">Сумма</dt>
          <dd className="text-right">
            <span className="mono-num whitespace-nowrap font-semibold text-ink">{formatMoneyRubWhole(sum)} ₽</span>
            <span className="block whitespace-nowrap text-[11.5px] text-ink-3">
              {formatMoneyRubWhole(rate)} × {quantity} шт × {effective} {shiftsWord(effective)}
            </span>
          </dd>
          {shortage && long && (
            <>
              <dt className="text-ink-3">Склад</dt>
              <dd className="text-right text-amber">
                на {shortage.dueDay} свободно {Math.max(0, shortage.available)} из {quantity}
              </dd>
            </>
          )}
        </dl>

        <button
          type="button"
          onClick={onClose}
          className="mt-4 flex h-11 w-full items-center justify-center rounded-lg bg-accent text-sm font-semibold text-surface hover:bg-accent-bright"
        >
          Готово
        </button>
      </div>
    </div>
  );
}
