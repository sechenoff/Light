"use client";

import { useRef, useState } from "react";

import { formatMoneyRubWhole } from "../../../lib/format";

/**
 * Цифра, которую можно переписать на месте.
 *
 * Единственный жест договорной цены: кликнул по цене — вписал свою. Один и тот
 * же компонент стоит в трёх местах (цена прибора в составе, сумма машины в
 * транспорте, итог сметы), поэтому никаких модалок и режимов заводить не
 * пришлось.
 *
 * Пока поле не в фокусе, оно показывает отформатированную сумму («18 000»);
 * при фокусе — голое число, чтобы его было удобно перенабрать.
 */

interface EditablePriceProps {
  /** Действующая цена: договорная, если задана, иначе прайсовая. */
  value: number;
  /** Прайсовая цена — для сравнения и возврата. */
  listValue: number;
  /** Договорная цена задана. */
  isNegotiated: boolean;
  /** Новая цена или null — вернуть прайсовую. */
  onChange: (next: number | null) => void;
  ariaLabel: string;
  /** Крупное начертание для итога сметы. */
  size?: "sm" | "lg";
  disabled?: boolean;
}

export function EditablePrice({
  value,
  listValue,
  isNegotiated,
  onChange,
  ariaLabel,
  size = "sm",
  disabled = false,
}: EditablePriceProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Значение, положенное в поле при фокусе. Если на blur оно не изменилось —
  // человек просто ткнул мимо, и превращать это в договорную цену нельзя.
  const openedWithRef = useRef<string | null>(null);
  // Escape приходит раньше blur; без флага отмена превращалась в фиксацию.
  const cancelledRef = useRef(false);
  const editing = draft !== null;

  function commit(raw: string, el: HTMLInputElement) {
    setDraft(null);
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    // Состав рисуется двумя раскладками (таблица и мобильные строки), и переход
    // через брейкпоинт прячет ту, в которой сейчас правят цену. Браузер на
    // display:none шлёт blur — но человек ничего не завершал, и записывать
    // недонабранное число как договорную цену нельзя. В jsdom метода нет —
    // тогда считаем поле видимым и ведём себя как раньше.
    if (typeof el.checkVisibility === "function" && !el.checkVisibility()) return;
    if (raw === openedWithRef.current) return; // поле не трогали
    const digits = raw.replace(/[^\d]/g, "");
    const parsed = digits ? Number(digits) : NaN;
    if (!Number.isFinite(parsed) || parsed <= 0) {
      onChange(null); // пусто или мусор — возвращаем прайс
      return;
    }
    // Ввод прайсовой цены — это не уступка, а возврат к прайсу.
    onChange(Math.round(parsed) === Math.round(listValue) ? null : parsed);
  }

  const shown = editing ? (draft as string) : formatMoneyRubWhole(value);
  // Метрики шрифта и отступы: одинаковы у поля и у невидимого двойника,
  // поэтому размер совпадает всегда.
  const box =
    size === "lg"
      ? "mono-num text-[30px] font-semibold leading-none tracking-tight px-2 py-0.5 border"
      : "mono-num text-xs font-semibold px-1.5 py-0.5 text-right border";
  const tone = isNegotiated
    ? "text-indigo bg-indigo-soft border-indigo-border"
    : "text-ink bg-transparent border-transparent hover:bg-surface-muted hover:border-border";

  return (
    /*
     * Ширина поля меряется невидимым двойником с тем же текстом и теми же
     * стилями, а не считается в ch. Расчёт в ch врал дважды: ширина в
     * border-box включает горизонтальные отступы, так что цифрам оставалось
     * на два знака меньше — «1 800» показывалось как «1 80».
     */
    <span className="inline-grid items-center">
      <span aria-hidden className={`invisible col-start-1 row-start-1 whitespace-pre ${box}`}>
        {shown || "0"}
      </span>
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        // Без size у input своя внутренняя ширина в 20 символов, и в сетке
        // побеждала она, а не двойник: поле раздувалось до 164 px независимо
        // от суммы. С size=1 ширину диктует двойник.
        size={1}
        disabled={disabled}
        aria-label={ariaLabel}
        value={shown}
        onFocus={(e) => {
          const opened = String(Math.round(value));
          openedWithRef.current = opened;
          cancelledRef.current = false;
          setDraft(opened);
          requestAnimationFrame(() => e.target.select());
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value, e.target)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            cancelledRef.current = true;
            (e.target as HTMLInputElement).blur();
          }
        }}
        className={`col-start-1 row-start-1 w-full cursor-text rounded ${tone} ${box} focus:border-accent-bright focus:bg-surface focus:outline-none focus:ring-2 focus:ring-accent-soft disabled:cursor-not-allowed disabled:opacity-50`}
      />
    </span>
  );
}

/** Кнопка «вернуть цену по прайсу» рядом с изменённой ценой. */
export function RevertPriceButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Вернуть цену по прайсу"
      aria-label={label}
      className="rounded px-1 py-0.5 text-[13px] leading-none text-ink-3 hover:bg-rose-soft hover:text-rose focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-bright"
    >
      ↺
    </button>
  );
}

/** Пилюля «по прайсу N» рядом с договорной ценой. */
export function ListPriceBadge({ value }: { value: number }) {
  return (
    <span className="whitespace-nowrap rounded border border-indigo-border bg-indigo-soft px-1.5 py-px text-[10.5px] font-medium text-indigo">
      по прайсу {formatMoneyRubWhole(value)}
    </span>
  );
}
