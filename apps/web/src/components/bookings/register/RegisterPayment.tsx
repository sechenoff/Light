"use client";

import { useState } from "react";
import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  safePolygon,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useHover,
  useInteractions,
  useRole,
} from "@floating-ui/react";
import {
  REGISTER_FINANCE_LABELS,
  type BookingRegisterRow as Row,
} from "@light-rental/shared";
import { formatRub } from "../../../lib/format";
import { button } from "./RegisterFilters";

function totalLabel(r: Row) {
  return r.mode === "PROJECT" ? "Начислено по периодам" : "Сумма проекта";
}
function totalValue(r: Row) {
  return ["UNPRICED", "NO_CHARGES"].includes(r.financeState)
    ? "—"
    : formatRub(r.finalAmount);
}
function financeLabel(r: Row) {
  return r.mode === "PROJECT" && r.financeState === "PAID"
    ? "Начисленное оплачено"
    : REGISTER_FINANCE_LABELS[r.financeState];
}
function PaymentBadge({ row: r }: { row: Row }) {
  const paid = r.financeState === "PAID";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${paid ? "bg-emerald-soft text-emerald" : r.financeState === "PARTIAL" ? "bg-amber-soft text-amber" : "bg-surface-subtle text-ink-2"}`}
    >
      {paid && <span aria-hidden="true">✓</span>}
      {financeLabel(r)}
    </span>
  );
}

/** Also used inside the native quick-view dialog, without a nested portal. */
export function PaymentBreakdown({
  row: r,
  pay,
}: {
  row: Row;
  pay?: () => void;
}) {
  return (
    <div className="space-y-3 text-sm">
      <PaymentBadge row={r} />
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-2">
        <dt className="text-ink-2">{totalLabel(r)}</dt>
        <dd className="text-right font-mono font-semibold text-ink">
          {totalValue(r)}
        </dd>
        <dt className="text-ink-2">Получено</dt>
        <dd className="text-right font-mono text-emerald">
          {formatRub(r.amountPaid)}
        </dd>
        {Number(r.writeOffAmount) > 0 && (
          <>
            <dt className="text-ink-2">Списано по договорённости</dt>
            <dd className="text-right font-mono text-ink">
              {formatRub(r.writeOffAmount)}
            </dd>
          </>
        )}
        <dt className="border-t border-border pt-2 text-ink-2">
          Осталось получить
        </dt>
        <dd className="border-t border-border pt-2 text-right font-mono font-semibold text-ink">
          {r.financeState === "UNPRICED" ? "—" : formatRub(r.amountOutstanding)}
        </dd>
        {Number(r.creditAmount) > 0 && (
          <>
            <dt className="text-ink-2">
              {r.mode === "PROJECT"
                ? "Аванс на следующие периоды"
                : "Переплата"}
            </dt>
            <dd className="text-right font-mono text-ink">
              {formatRub(r.creditAmount)}
            </dd>
          </>
        )}
      </dl>
      {r.financeState === "UNPRICED" && (
        <p className="text-xs text-ink-3">Стоимость ещё не рассчитана.</p>
      )}
      {Number(r.writeOffAmount) > 0 && (
        <p className="text-xs text-ink-3">
          Списанная сумма уменьшает остаток, но не входит в полученные деньги.
        </p>
      )}
      {r.mode === "PROJECT" && (
        <p className="text-xs text-ink-3">
          Здесь учтены только закрытые периоды.
          {r.projectSummary?.unclosedBilling
            ? " Итог проекта ещё изменится: есть незакрытая аренда или услуги."
            : " Прогноз всей аренды — в карточке проекта."}
        </p>
      )}
      {pay && Number(r.amountOutstanding) > 0 && (
        <button type="button" className={`${button} w-full`} onClick={pay}>
          Записать платёж
        </button>
      )}
    </div>
  );
}

export function PaymentState({
  row: r,
  pay,
  centered = false,
}: {
  row: Row;
  pay?: () => void;
  centered?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: "bottom",
    strategy: "fixed",
    whileElementsMounted: autoUpdate,
    middleware: [offset(8), flip({ padding: 12 }), shift({ padding: 12 })],
  });
  const hover = useHover(context, {
    mouseOnly: true,
    delay: { open: 250, close: 100 },
    handleClose: safePolygon(),
  });
  const click = useClick(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: "dialog" });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    hover,
    click,
    dismiss,
    role,
  ]);
  return (
    <>
      <button
        type="button"
        ref={refs.setReference}
        {...getReferenceProps()}
        aria-label={`Сумма и оплата: ${r.projectName}`}
        className={`w-full max-w-sm rounded-lg px-2 py-2 text-left transition hover:bg-accent-soft/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${centered ? "mx-auto" : ""}`}
      >
        <span className="flex items-center justify-between gap-2 text-[10px] text-ink-3">
          <span>{totalLabel(r)}</span>
          <span
            aria-hidden="true"
            className="flex h-4 w-4 items-center justify-center rounded-full border border-border text-[10px]"
          >
            i
          </span>
        </span>
        <span
          className={`mt-0.5 block font-mono text-base font-semibold tabular-nums ${r.financeState === "PAID" ? "text-emerald" : "text-ink"}`}
        >
          {totalValue(r)}
        </span>
        <span className="mt-1 block">
          <PaymentBadge row={r} />
        </span>
        <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-2">
          <span>
            Получено{" "}
            <span className="whitespace-nowrap font-mono">
              {formatRub(r.amountPaid)}
            </span>
          </span>
          {Number(r.amountOutstanding) > 0 && (
            <span>
              Осталось{" "}
              <span className="whitespace-nowrap font-mono">
                {formatRub(r.amountOutstanding)}
              </span>
            </span>
          )}
        </span>
      </button>
      {open && (
        <FloatingPortal>
          <FloatingFocusManager
            context={context}
            modal={false}
            initialFocus={-1}
          >
            <div
              ref={refs.setFloating}
              style={floatingStyles}
              {...getFloatingProps()}
              aria-label={`Расчёты: ${r.projectName}`}
              className="z-[100] max-h-[min(80dvh,520px)] w-[360px] max-w-[calc(100vw-24px)] overflow-y-auto rounded-xl border border-border bg-surface p-4 text-left text-ink shadow-xl"
            >
              <div className="mb-3 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="break-words text-sm font-semibold">
                    {r.projectName || "Без названия"}
                  </h3>
                  <p className="mt-1 text-xs text-ink-3">Подробности оплаты</p>
                </div>
                <button
                  type="button"
                  aria-label="Закрыть подробности оплаты"
                  onClick={() => setOpen(false)}
                  className="-mr-2 -mt-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-lg text-ink-3 hover:bg-surface-subtle"
                >
                  ×
                </button>
              </div>
              <PaymentBreakdown
                row={r}
                pay={
                  pay
                    ? () => {
                        setOpen(false);
                        pay();
                      }
                    : undefined
                }
              />
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  );
}
