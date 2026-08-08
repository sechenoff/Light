"use client";

import { useEffect, useRef, useState } from "react";

import { formatMoneyRub } from "../../../lib/format";

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
  const editing = draft !== null;

  // Пока идёт правка, внешнее значение не перетирает набранное: пересчёт сметы
  // прилетает асинхронно и иначе выбивал бы цифру из-под пальцев.
  useEffect(() => {
    if (!editing) setDraft(null);
  }, [value, editing]);

  function commit(raw: string) {
    const digits = raw.replace(/[^\d]/g, "");
    const parsed = digits ? Number(digits) : NaN;
    setDraft(null);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      onChange(null); // пусто или мусор — возвращаем прайс
      return;
    }
    onChange(parsed === listValue ? null : parsed);
  }

  const base =
    size === "lg"
      ? "mono-num text-[30px] font-semibold leading-none tracking-tight w-[9ch] px-2 py-0.5"
      : "mono-num text-xs font-semibold w-[9ch] px-1.5 py-0.5 text-right";
  const tone = isNegotiated
    ? "text-indigo bg-indigo-soft border-indigo-border"
    : "text-ink bg-transparent border-transparent hover:bg-surface-muted hover:border-border";

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="numeric"
      disabled={disabled}
      aria-label={ariaLabel}
      value={editing ? (draft as string) : formatMoneyRub(value)}
      onFocus={(e) => {
        setDraft(String(Math.round(value)));
        requestAnimationFrame(() => e.target.select());
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setDraft(null);
          (e.target as HTMLInputElement).blur();
        }
      }}
      className={`cursor-text rounded border ${tone} ${base} focus:border-accent-bright focus:bg-surface focus:outline-none focus:ring-2 focus:ring-accent-soft disabled:cursor-not-allowed disabled:opacity-50`}
    />
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
      по прайсу {formatMoneyRub(value)}
    </span>
  );
}
