"use client";

import { useEffect, useRef } from "react";

import { PERIOD_LABELS, PERIOD_OPTIONS, type PeriodKey } from "../../lib/periodUtils";

interface Props {
  value: PeriodKey;
  onChange: (period: PeriodKey) => void;
  /** Набор периодов; по умолчанию — полный, как на сводке. */
  options?: PeriodKey[];
}

export function PeriodSelector({ value, onChange, options = PERIOD_OPTIONS }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);

  // На телефоне лента прокручивается: выбранный период («Всё время» из URL)
  // может оказаться за краем — докручиваем саму ленту, не страницу.
  useEffect(() => {
    const box = boxRef.current;
    const active = box?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!box || !active || box.scrollWidth <= box.clientWidth) return;
    const b = box.getBoundingClientRect();
    const a = active.getBoundingClientRect();
    if (a.left < b.left || a.right > b.right) box.scrollLeft += a.left - b.left - (b.width - a.width) / 2;
  }, [value]);

  return (
    // Лента прокручивается сама: min-w-0 + max-w-full не дают ей распирать ряд,
    // а shrink-0 + nowrap у кнопок — сжиматься в «7 / дней». Высоту задаёт контейнер.
    <div
      ref={boxRef}
      className="flex h-10 min-w-0 max-w-full flex-nowrap items-stretch gap-1 overflow-x-auto rounded border border-border bg-surface-subtle p-1 sm:h-9"
    >
      {options.map((key) => (
        <button
          key={key}
          type="button"
          aria-pressed={value === key}
          onClick={() => onChange(key)}
          className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-sm px-2.5 text-xs font-medium transition-colors ${
            value === key
              ? "bg-surface text-ink shadow-xs"
              : "text-ink-2 hover:text-ink"
          }`}
        >
          {PERIOD_LABELS[key]}
        </button>
      ))}
    </div>
  );
}
