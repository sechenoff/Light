"use client";

/**
 * Окно «Принять возврат» — карточка брони и реестр (мокап
 * docs/mockups/line-shifts-continuation/m4-return-dialog.html).
 *
 *  - Ничего «по плану» и ничего не оставили — одно подтверждение «Вернули всё».
 *  - Позиции «по плану у клиента» (взяты дольше брони) — сразу отмечены,
 *    главная кнопка «Принять N позиций»: остальное на склад, оставленное — в
 *    продолжение брони за 0 ₽ (уже оплачено в основной смете).
 *  - «Вернули не всё» — по каждой строке «остаётся у клиента N». Пока — только
 *    в пределах оплаченного; дольше — вместе с дополнительной сметой.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { pluralize } from "@/lib/format";
import { toast } from "../ToastProvider";
import {
  anyStayPossible,
  canStay,
  formatWhen,
  initialStays,
  partialReturnBody,
  setStayQuantity,
  summarize,
  toggleStayUnit,
  type ReturnPlan,
  type StayDraft,
} from "./returnDialogState";
import { announceStatusChangeNotes, type StatusChangeResponse } from "./useBookingLifecycle";

type Mode = "simple" | "planned" | "partial";

type Props = {
  bookingId: string;
  projectName: string;
  docNumber?: string | null;
  open: boolean;
  onClose: () => void;
  /** Приёмка записана — перечитать карточку / список. */
  onDone: () => void;
};

const positions = (n: number) => `${n} ${pluralize(n, "позиция", "позиции", "позиций")}`;
/** «Принять 1 позицию / 2 позиции / 5 позиций» — винительный падеж. */
const positionsAcc = (n: number) => `${n} ${pluralize(n, "позицию", "позиции", "позиций")}`;

export function ReturnDialog({ bookingId, projectName, docNumber, open, onClose, onDone }: Props) {
  const [plan, setPlan] = useState<ReturnPlan | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("simple");
  const [stays, setStays] = useState<Map<string, StayDraft>>(new Map());
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const primaryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPlan(null);
    setLoadError(null);
    setQuery("");
    apiFetch<ReturnPlan>(`/api/bookings/${bookingId}/return-plan`)
      .then((p) => {
        if (cancelled) return;
        setPlan(p);
        setStays(initialStays(p));
        setMode(p.hasPlannedStays ? "planned" : "simple");
      })
      .catch((e: any) => !cancelled && setLoadError(e?.message ?? "Не удалось загрузить план приёмки"));
    return () => {
      cancelled = true;
    };
  }, [open, bookingId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  useEffect(() => {
    if (plan) setTimeout(() => primaryRef.current?.focus(), 30);
  }, [plan, mode]);

  const summary = useMemo(() => (plan ? summarize(plan, stays) : null), [plan, stays]);
  if (!open) return null;

  async function submit(allReturned: boolean) {
    if (!plan || busy) return;
    setBusy(true);
    try {
      if (allReturned || stays.size === 0) {
        const res = await apiFetch<StatusChangeResponse>(`/api/bookings/${bookingId}/status`, {
          method: "POST",
          body: JSON.stringify({ action: "return", allReturned: true }),
        });
        toast.success("Бронь возвращена");
        announceStatusChangeNotes(res);
      } else {
        const res = await apiFetch<StatusChangeResponse & { continuationIds: string[] }>(
          `/api/bookings/${bookingId}/return-partial`,
          { method: "POST", body: JSON.stringify(partialReturnBody(plan, stays)) },
        );
        const n = res.continuationIds.length;
        toast.success(
          n === 1
            ? "Бронь возвращена частично — оставленное перешло в продолжение"
            : `Бронь возвращена частично — продолжений: ${n}`,
        );
        announceStatusChangeNotes(res);
      }
      onDone();
      onClose();
    } catch (e: any) {
      toast.error(e?.message ?? "Не удалось принять возврат");
      if (e?.code === "PARTIAL_RETURN_STALE" || e?.code === "INVALID_BOOKING_STATE" || e?.code === "PARTIAL_RETURN_NOT_ISSUED") {
        onDone();
        onClose();
      }
    } finally {
      setBusy(false);
    }
  }

  const visibleLines = plan
    ? plan.lines.filter((l) => !query.trim() || l.name.toLocaleLowerCase("ru-RU").includes(query.trim().toLocaleLowerCase("ru-RU")))
    : [];
  const planned = plan ? plan.lines.filter((l) => stays.has(l.bookingItemId)) : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-scrim/50 sm:items-center sm:px-4"
      onClick={() => !busy && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="return-dialog-title"
        className="flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-xl border border-border bg-surface shadow-xl sm:max-w-[640px] sm:rounded-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <p className="eyebrow">Принять возврат{docNumber ? ` · ${docNumber}` : ""}</p>
            <h2 id="return-dialog-title" className="mt-1 truncate text-lg font-semibold text-ink">
              {projectName}
            </h2>
          </div>
          <button
            type="button"
            aria-label="Закрыть"
            className="rounded p-1 text-ink-3 hover:bg-surface-subtle hover:text-ink"
            onClick={() => !busy && onClose()}
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loadError && <p className="text-sm text-rose">{loadError}</p>}
          {!plan && !loadError && <p className="text-sm text-ink-3">Загружаем позиции…</p>}

          {plan?.kioskSession && (
            <div className="mb-4 rounded border border-amber-border bg-amber-soft px-3 py-2 text-sm text-amber">
              <p className="font-semibold">
                В киоске открыта приёмка ({plan.kioskSession.workerName}, {formatWhen(plan.kioskSession.startedAt).split(", ")[1]})
              </p>
              <p className="mt-0.5 text-ink-2">Если принять здесь, приёмка в киоске закроется, а её отметки не сохранятся.</p>
            </div>
          )}

          {plan && mode === "simple" && (
            <p className="text-sm text-ink-2">Всё оборудование вернули на склад? Принятое сразу станет свободным для других броней.</p>
          )}

          {plan && mode === "planned" && (
            <>
              <section className="rounded border border-indigo-border bg-indigo-soft">
                <div className="flex items-center justify-between px-3 py-2 text-sm font-semibold text-indigo">
                  <span>По плану остаются у клиента · оплачено</span>
                  <span>{positions(planned.length)}</span>
                </div>
                <ul className="divide-y divide-border bg-surface">
                  {planned.map((l) => (
                    <li key={l.bookingItemId} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                      <span className="min-w-0 truncate text-ink">
                        {l.name} <span className="text-ink-3">· {stays.get(l.bookingItemId)!.quantity} шт</span>
                      </span>
                      <span className="shrink-0 text-indigo">до {formatWhen(stays.get(l.bookingItemId)!.until)}</span>
                    </li>
                  ))}
                </ul>
                <p className="border-t border-indigo-border px-3 py-2 text-xs text-ink-2">
                  Перейдут в продолжение брони за 0 ₽ — уже оплачены в основной смете.
                </p>
              </section>
              {summary && (
                <p className="mt-3 text-sm text-ink-2">
                  Остальное принимаем на склад: <span className="font-semibold text-ink">{positionsAcc(summary.acceptedLines)}</span>. Принятое сразу свободно для других броней.
                </p>
              )}
            </>
          )}

          {plan && mode === "partial" && (
            <>
              {plan.lines.length > 8 && (
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Найти позицию…"
                  aria-label="Найти позицию"
                  className="mb-3 h-10 w-full rounded border border-border bg-surface px-3 text-sm text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
                />
              )}
              <ul className="divide-y divide-border rounded border border-border">
                {visibleLines.map((l) => {
                  const stay = stays.get(l.bookingItemId);
                  const kept = stay?.quantity ?? 0;
                  const possible = canStay(l);
                  return (
                    <li key={l.bookingItemId} className="px-3 py-3" data-testid="return-line">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-ink">{l.name}</p>
                          {l.plannedStayUntil && <p className="text-xs text-indigo">по плану до {formatWhen(l.plannedStayUntil)}</p>}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-ink-2">
                          остаётся у клиента
                          <span className="inline-flex items-center overflow-hidden rounded border border-border">
                            <button
                              type="button"
                              aria-label={`Меньше: ${l.name}`}
                              disabled={!possible || kept === 0 || busy || l.unitTracked}
                              className="flex h-9 w-9 items-center justify-center text-ink-2 hover:bg-surface-subtle disabled:opacity-40"
                              onClick={() => setStays(setStayQuantity(stays, l, kept - 1))}
                            >
                              −
                            </button>
                            <span className="mono-num flex h-9 w-9 items-center justify-center border-x border-border font-semibold text-ink">{kept}</span>
                            <button
                              type="button"
                              aria-label={`Больше: ${l.name}`}
                              disabled={!possible || kept >= l.quantity || busy || l.unitTracked}
                              className="flex h-9 w-9 items-center justify-center text-ink-2 hover:bg-surface-subtle disabled:opacity-40"
                              onClick={() => setStays(setStayQuantity(stays, l, kept + 1))}
                            >
                              +
                            </button>
                          </span>
                          из {l.quantity}
                        </div>
                      </div>
                      {l.unitTracked && possible && (
                        <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Какие единицы остались у клиента">
                          {l.units.map((u, i) => {
                            const on = stay?.unitIds.includes(u.id) ?? false;
                            return (
                              <button
                                key={u.id}
                                type="button"
                                aria-pressed={on}
                                disabled={busy}
                                className={`min-h-9 rounded border px-2.5 text-xs ${on ? "border-accent bg-accent-soft font-semibold text-accent" : "border-border text-ink-2 hover:bg-surface-subtle"}`}
                                onClick={() => setStays(toggleStayUnit(stays, l, u.id))}
                              >
                                {u.label ?? `Единица ${i + 1}`}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      <p className="mt-1.5 text-xs text-ink-3">
                        {!possible
                          ? `Оплачено до ${formatWhen(l.paidThrough)} — оставить дольше можно будет с дополнительной сметой`
                          : kept > 0
                            ? `Вернут ${formatWhen(stay!.until)} · без доплаты`
                            : `Можно оставить до ${formatWhen(l.paidThrough)} — уже оплачено`}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>

        {plan && summary && (
          <footer className="flex flex-col gap-3 border-t border-border bg-surface-subtle px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 flex-1 text-xs text-ink-2">
              {mode === "partial" && summary.keptUnits > 0 ? (
                <>
                  Принимаем <span className="font-semibold text-ink">{positionsAcc(summary.acceptedLines)}</span>, у клиента остаётся{" "}
                  <span className="font-semibold text-ink">{summary.keptUnits} шт</span> → продолжение брони
                </>
              ) : mode !== "partial" && anyStayPossible(plan) ? (
                <button
                  type="button"
                  className="text-sm font-medium text-accent underline-offset-2 hover:underline"
                  onClick={() => setMode("partial")}
                  disabled={busy}
                >
                  Вернули не всё
                </button>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-wrap justify-end gap-2">
              {mode === "planned" ? (
                <button
                  type="button"
                  disabled={busy}
                  className="min-h-10 rounded border border-border bg-surface px-4 text-sm text-ink hover:bg-surface-subtle disabled:opacity-50"
                  onClick={() => submit(true)}
                >
                  Вернули всё · {summary.totalUnits}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  className="min-h-10 rounded border border-border bg-surface px-4 text-sm text-ink hover:bg-surface-subtle disabled:opacity-50"
                  onClick={() => onClose()}
                >
                  Отмена
                </button>
              )}
              <button
                ref={primaryRef}
                type="button"
                disabled={busy}
                className="min-h-10 rounded border border-accent bg-accent px-4 text-sm font-semibold text-surface hover:bg-accent-bright disabled:opacity-50"
                onClick={() => submit(stays.size === 0)}
              >
                {busy ? "Принимаем…" : stays.size === 0 ? "Вернули всё" : `Принять ${positionsAcc(summary.acceptedLines)}`}
              </button>
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}
