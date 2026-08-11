"use client";

import { useState } from "react";
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  useClick,
  useDismiss,
  useRole,
  useInteractions,
  FloatingFocusManager,
  FloatingPortal,
} from "@floating-ui/react";

type Props = {
  categories: string[];
  /** Позиций в каталоге по категории — список работает как карта склада, а не только как фильтр. */
  counts: Record<string, number>;
  value: string | undefined;
  onChange: (category: string | undefined) => void;
  variant?: "bar" | "mobile";
};

const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-bright";

export function CategoryPopover({
  categories,
  counts,
  value,
  onChange,
  variant = "bar",
}: Props) {
  const [open, setOpen] = useState(false);
  const active = Boolean(value);

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: variant === "mobile" ? "bottom-end" : "bottom-start",
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  const click = useClick(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: "listbox" });
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role]);

  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

  function pick(next: string | undefined) {
    onChange(next);
    setOpen(false);
  }

  // Иконка-кнопка на мобильном: 44 px тач-таргет, активность — точкой-бейджем.
  if (variant === "mobile") {
    return (
      <>
        <button
          type="button"
          ref={refs.setReference}
          {...getReferenceProps()}
          aria-label={value ? `Категория: ${value}. Изменить` : "Фильтр по категории"}
          className={`relative flex h-11 w-11 flex-none items-center justify-center rounded border transition-colors ${
            active
              ? "border-accent-border bg-accent-soft text-accent-bright"
              : "border-border bg-surface text-ink-2"
          } ${FOCUS_RING}`}
        >
          <FilterIcon size={18} />
          {active && (
            <span
              aria-hidden
              className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-accent-bright ring-2 ring-surface"
            />
          )}
        </button>
        {open && (
          <List
            refs={refs}
            floatingStyles={floatingStyles}
            context={context}
            getFloatingProps={getFloatingProps}
            categories={categories}
            counts={counts}
            total={total}
            value={value}
            onPick={pick}
          />
        )}
      </>
    );
  }

  return (
    <>
      <span
        className={`inline-flex flex-none items-center rounded border transition-colors ${
          active ? "border-accent-border bg-accent-soft" : "border-transparent"
        }`}
      >
        <button
          type="button"
          ref={refs.setReference}
          {...getReferenceProps()}
          aria-label={value ? `Категория: ${value}. Изменить` : "Фильтр по категории"}
          className={`inline-flex h-7 max-w-[190px] items-center gap-1.5 rounded px-2 text-xs font-medium transition-colors ${
            active
              ? "text-accent-bright"
              : "text-ink-2 hover:bg-surface-subtle hover:text-ink"
          } ${FOCUS_RING}`}
        >
          <FilterIcon size={14} />
          <span className="truncate">{value ?? "Категория"}</span>
          {active && (
            <span className="mono-num text-[11px] opacity-70">{counts[value!] ?? 0}</span>
          )}
        </button>
        {active && (
          // Отдельная кнопка, а не иконка внутри триггера: вложенные <button>
          // невалидны, а сброс в один тап — самое частое действие после фильтра.
          <button
            type="button"
            onClick={() => onChange(undefined)}
            aria-label={`Сбросить фильтр категории «${value}»`}
            className={`flex h-7 w-7 flex-none items-center justify-center rounded text-accent-bright transition-colors hover:bg-accent-border ${FOCUS_RING}`}
          >
            <CloseIcon />
          </button>
        )}
      </span>
      {open && (
        <List
          refs={refs}
          floatingStyles={floatingStyles}
          context={context}
          getFloatingProps={getFloatingProps}
          categories={categories}
          counts={counts}
          total={total}
          value={value}
          onPick={pick}
        />
      )}
    </>
  );
}

type ListProps = {
  refs: ReturnType<typeof useFloating>["refs"];
  floatingStyles: React.CSSProperties;
  context: ReturnType<typeof useFloating>["context"];
  getFloatingProps: (props?: Record<string, unknown>) => Record<string, unknown>;
  categories: string[];
  counts: Record<string, number>;
  total: number;
  value: string | undefined;
  onPick: (next: string | undefined) => void;
};

function List({
  refs,
  floatingStyles,
  context,
  getFloatingProps,
  categories,
  counts,
  total,
  value,
  onPick,
}: ListProps) {
  return (
    <FloatingPortal>
      <FloatingFocusManager context={context} modal={false}>
        <div
          ref={refs.setFloating}
          style={floatingStyles}
          {...getFloatingProps()}
          className="z-50 max-h-[min(70vh,420px)] w-[260px] overflow-y-auto rounded-lg border border-border-strong bg-surface py-1 shadow-lg"
        >
          <Row
            label="Все категории"
            count={total}
            selected={!value}
            onSelect={() => onPick(undefined)}
          />
          <div className="my-1 border-t border-border" />
          {categories.map((c) => (
            <Row
              key={c}
              label={c}
              count={counts[c] ?? 0}
              selected={value === c}
              onSelect={() => onPick(c)}
            />
          ))}
        </div>
      </FloatingFocusManager>
    </FloatingPortal>
  );
}

function Row({
  label,
  count,
  selected,
  onSelect,
}: {
  label: string;
  count: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-xs transition-colors ${
        selected ? "bg-accent-soft font-semibold text-accent-bright" : "text-ink hover:bg-surface-subtle"
      } ${FOCUS_RING}`}
    >
      <span className="truncate">{label}</span>
      <span className={`mono-num flex-none text-[11px] ${selected ? "" : "text-ink-2"}`}>
        {count}
      </span>
    </button>
  );
}

function FilterIcon({ size }: { size: number }) {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      className="flex-none"
    >
      <path d="M4 6h16M7 12h10M10 18h4" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      aria-hidden
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
