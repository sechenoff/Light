"use client";

import { useEffect, useState } from "react";
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

import {
  QUICK_PERIODS,
  formatCompact,
  getQuickPeriod,
  shiftEnd,
  summarizePeriod,
} from "./catalogPeriod";

type Props = {
  start: string;
  end: string;
  onApply: (range: { start: string; end: string }) => void;
  /** Мобильная презентация: чип во всю ширину и тач-высота 44 px. */
  variant?: "bar" | "mobile";
};

const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-bright";

/**
 * Период доступности — единственный постоянно обведённый элемент тулбара:
 * он смысловой якорь колонок «Занято / Доступно / Статус».
 *
 * Правки копятся в черновике и уходят наверх по «Применить». Мгновенное
 * применение здесь недопустимо: datetime-local шлёт onChange на каждое
 * нажатие, и каждый промежуточный кадр («2026-08-0…») дёргал бы
 * /api/availability. Пресеты в самой строке тулбара, наоборот, применяются
 * сразу — там один клик даёт готовый диапазон.
 */
export function PeriodPopover({ start, end, onApply, variant = "bar" }: Props) {
  const [open, setOpen] = useState(false);
  const [draftStart, setDraftStart] = useState(start);
  const [draftEnd, setDraftEnd] = useState(end);

  // Каждое открытие начинается с актуального периода: пресет, нажатый в
  // строке тулбара, не должен воскрешать брошенный черновик.
  useEffect(() => {
    if (open) {
      setDraftStart(start);
      setDraftEnd(end);
    }
  }, [open, start, end]);

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: variant === "mobile" ? "bottom" : "bottom-start",
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  const click = useClick(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: "dialog" });
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role]);

  const draftSummary = summarizePeriod(draftStart, draftEnd);
  const invalid = Boolean(draftStart && draftEnd) && draftSummary === null;

  function apply() {
    if (invalid || !draftStart || !draftEnd) return;
    onApply({ start: draftStart, end: draftEnd });
    setOpen(false);
  }

  const triggerBase =
    "inline-flex items-center rounded border border-border-strong bg-surface text-ink transition-colors hover:border-accent-border hover:bg-accent-soft";
  // На мобильном отступы и зазор урезаны: «11.08 10:00 → 12.08 10:00» ровно
  // впритык влезает в 375 px рядом с двумя тач-кнопками, и лишние 4 px
  // означали бы «11.08 10:…» вместо времени, ради которого чип и существует.
  const triggerSize =
    variant === "mobile" ? "h-11 w-full min-w-0 gap-1 px-2" : "h-7 flex-none gap-1.5 px-2";
  const triggerOpen = open ? "border-accent-bright bg-accent-soft text-accent" : "";

  return (
    <>
      <button
        type="button"
        ref={refs.setReference}
        {...getReferenceProps()}
        aria-label="Период проверки доступности — изменить"
        title="Период доступности: по нему считаются колонки «Занято», «Доступно» и «Статус»"
        className={`${triggerBase} ${triggerSize} ${triggerOpen} ${FOCUS_RING}`}
      >
        <CalendarIcon />
        <span className="mono-num truncate text-xs font-medium">{formatCompact(start)}</span>
        <span aria-hidden className="text-ink-3">
          →
        </span>
        <span className="mono-num truncate text-xs font-medium">{formatCompact(end)}</span>
        <ChevronIcon open={open} />
      </button>

      {open && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false}>
            <div
              ref={refs.setFloating}
              style={floatingStyles}
              {...getFloatingProps()}
              aria-label="Период доступности"
              className="z-50 w-[min(92vw,480px)] rounded-lg border border-border-strong bg-surface p-3 shadow-lg"
            >
              <div className="mb-2.5 flex items-center justify-between gap-3">
                <span className="eyebrow">Период доступности</span>
                <span className="mono-num text-[11px] text-ink-2">
                  {draftSummary ? `${draftSummary.hoursLabel} · ${draftSummary.shiftsLabel}` : "—"}
                </span>
              </div>

              <div className="flex items-end gap-2">
                <label className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="eyebrow">Начало</span>
                  <input
                    type="datetime-local"
                    value={draftStart}
                    onChange={(e) => setDraftStart(e.target.value)}
                    className={`mono-num h-9 w-full rounded border border-border-strong bg-surface px-2 text-xs text-ink ${FOCUS_RING}`}
                  />
                </label>
                <span aria-hidden className="pb-2 text-ink-3">
                  →
                </span>
                <label className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="eyebrow">Конец</span>
                  <input
                    type="datetime-local"
                    value={draftEnd}
                    onChange={(e) => setDraftEnd(e.target.value)}
                    className={`mono-num h-9 w-full rounded border border-border-strong bg-surface px-2 text-xs text-ink ${FOCUS_RING}`}
                  />
                </label>
              </div>

              <div className="mt-3 flex flex-wrap gap-1.5">
                {QUICK_PERIODS.map((p) => (
                  <button
                    key={p.type}
                    type="button"
                    title={p.hint}
                    onClick={() => {
                      const r = getQuickPeriod(p.type);
                      setDraftStart(r.start);
                      setDraftEnd(r.end);
                    }}
                    className={`h-7 rounded border border-border px-2.5 text-xs font-medium text-ink-2 transition-colors hover:bg-surface-subtle hover:text-ink ${FOCUS_RING}`}
                  >
                    {p.label}
                  </button>
                ))}
                {[
                  { label: "+1 смена", hours: 24 },
                  { label: "−1 смена", hours: -24 },
                ].map((a) => (
                  <button
                    key={a.label}
                    type="button"
                    onClick={() => setDraftEnd((prev) => shiftEnd(prev, a.hours))}
                    className={`h-7 rounded border border-border px-2.5 text-xs font-medium text-ink-2 transition-colors hover:bg-surface-subtle hover:text-ink ${FOCUS_RING}`}
                  >
                    {a.label}
                  </button>
                ))}
              </div>

              <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-2.5">
                <span className="text-[11px] text-ink-2">
                  {invalid
                    ? "Конец периода должен быть позже начала"
                    : "Колонки «Занято / Доступно / Статус» пересчитаются по этому периоду"}
                </span>
                <span className="flex flex-none gap-1.5">
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className={`h-7 rounded border border-border px-2.5 text-xs font-medium text-ink-2 transition-colors hover:bg-surface-subtle hover:text-ink ${FOCUS_RING}`}
                  >
                    Отмена
                  </button>
                  <button
                    type="button"
                    onClick={apply}
                    disabled={invalid}
                    className={`h-7 rounded bg-accent-bright px-3 text-xs font-semibold text-surface transition-colors hover:bg-accent disabled:opacity-50 ${FOCUS_RING}`}
                  >
                    Применить
                  </button>
                </span>
              </div>
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  );
}

function CalendarIcon() {
  return (
    <svg
      aria-hidden
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-none text-ink-3"
    >
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`flex-none text-ink-3 transition-transform ${open ? "rotate-180" : ""}`}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
