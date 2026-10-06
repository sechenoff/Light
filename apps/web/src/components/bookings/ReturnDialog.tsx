"use client";

/**
 * Окно «Принять возврат» — карточка брони и реестр (мокап
 * docs/mockups/line-shifts-continuation/m4-return-dialog.html).
 *
 *  - Ничего «по плану» и ничего не оставили — одно подтверждение «Вернули всё».
 *  - Позиции «по плану у клиента» (взяты дольше брони) — сразу отмечены,
 *    главная кнопка «Принять N позиций»: остальное на склад, оставленное — в
 *    продолжение брони за 0 ₽ (уже оплачено в основной смете).
 *  - «Вернули не всё» — по каждой строке «остаётся у клиента N» и до какого
 *    срока. Дольше оплаченного — с дополнительной сметой (превью цены), а
 *    если позиция нужна другой брони — только «под ответственность».
 *  - В киоске идёт приёмка — сначала выбор: закончить там или принять здесь.
 *  - План не загрузился — «Повторить» или обычная приёмка целиком: окно не
 *    должно отнимать то, что раньше делалось одним подтверждением.
 */
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { pluralize } from "@/lib/format";
import { useDialog } from "@/hooks/useDialog";
import { toast } from "../ToastProvider";
import {
  anyBeyondPaid,
  anyStayPossible,
  formatWhen,
  initialStays,
  partialReturnBody,
  setStayAcknowledged,
  setStayChoice,
  setStayQuantity,
  summarize,
  toggleStayUnit,
  unacknowledgedConflicts,
  type ReturnPlan,
  type StayDraft,
} from "./returnDialogState";
import { ReturnStayRow } from "./ReturnStayRow";
import { ContinuationPriceBlock } from "./ContinuationPriceBlock";
import { useReturnPreview } from "./useReturnPreview";
import { announceStatusChangeNotes, staleStateMessage, type StatusChangeResponse } from "./useBookingLifecycle";

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

/** Бронь уже не та, что открыли: приняли, отменили, отделили продолжение. */
const STALE_CODES = new Set(["PARTIAL_RETURN_STALE", "INVALID_BOOKING_STATE", "PARTIAL_RETURN_NOT_ISSUED"]);

const positions = (n: number) => `${n} ${pluralize(n, "позиция", "позиции", "позиций")}`;
/** «Принять 1 позицию / 2 позиции / 5 позиций» — винительный падеж. */
const positionsAcc = (n: number) => `${n} ${pluralize(n, "позицию", "позиции", "позиций")}`;

const BTN_SECONDARY =
  "min-h-11 rounded border border-border bg-surface px-4 text-sm text-ink hover:bg-surface-subtle disabled:opacity-50 sm:min-h-10";
const BTN_PRIMARY =
  "min-h-11 rounded border border-accent bg-accent px-4 text-sm font-semibold text-surface hover:bg-accent-bright disabled:opacity-50 sm:min-h-10";

export function ReturnDialog({ bookingId, projectName, docNumber, open, onClose, onDone }: Props) {
  const [plan, setPlan] = useState<ReturnPlan | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [mode, setMode] = useState<Mode>("simple");
  const [stays, setStays] = useState<Map<string, StayDraft>>(new Map());
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  /** Сотрудник выбрал «Принять здесь» при открытой приёмке в киоске. */
  const [kioskOverride, setKioskOverride] = useState(false);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(false);
  const dialogRef = useDialog<HTMLDivElement>(open, () => !busyRef.current && onClose());

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
      .catch((e: { message?: string; code?: string }) => {
        if (cancelled) return;
        // Бронь приняли или изменили, пока строка висела в списке, — не
        // держать окно с ошибкой, а перечитать список.
        if (e?.code && STALE_CODES.has(e.code)) {
          toast.error(staleStateMessage(e.message, "Данные обновлены"));
          onDone();
          onClose();
          return;
        }
        setLoadError(e?.message ?? "Не удалось загрузить позиции брони");
      });
    return () => {
      cancelled = true;
    };
    // onDone/onClose — колбэки родителя; перезапрашивать план из-за новой
    // ссылки на них не нужно.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bookingId, attempt]);

  useEffect(() => {
    if (plan) setTimeout(() => primaryRef.current?.focus(), 30);
  }, [plan, mode, kioskOverride]);

  const summary = useMemo(() => (plan ? summarize(plan, stays) : null), [plan, stays]);
  // Превью дополнительной сметы и держателей — только в «Вернули не всё» и
  // только когда что-то остаётся дольше оплаченного: в пределах оплаченного
  // доплаты нет, а держателей не проверяют (эти дни бронь и так держала).
  const previewStays = useMemo(
    () => (plan && mode === "partial" && anyBeyondPaid(plan, stays) ? partialReturnBody(plan, stays).stays : null),
    [plan, mode, stays],
  );
  const {
    preview,
    loading: previewLoading,
    error: previewError,
    refresh: refreshPreview,
  } = useReturnPreview(bookingId, previewStays);
  if (!open) return null;

  const close = () => !busyRef.current && onClose();

  /**
   * Приёмка целиком. `allReturned` уходит только когда в брони есть позиции
   * «по плану» и сотрудник явно сказал «вернули всё»: иначе сервер сам
   * остановит приёмку (PLANNED_STAY_PENDING), если смены строки поменяли,
   * пока окно было открыто.
   */
  async function returnWhole(confirmAllReturned: boolean) {
    const res = await apiFetch<StatusChangeResponse>(`/api/bookings/${bookingId}/status`, {
      method: "POST",
      body: JSON.stringify(confirmAllReturned ? { action: "return", allReturned: true } : { action: "return" }),
    });
    toast.success("Бронь возвращена");
    announceStatusChangeNotes(res);
  }

  async function run(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await action();
      onDone();
      onClose();
    } catch (e: any) {
      if (e?.code && STALE_CODES.has(e.code)) {
        toast.error(staleStateMessage(e.message, "Данные обновлены"));
        onDone();
        onClose();
      } else if (e?.code === "CONTINUATION_CONFLICT") {
        // Позицию заняли, пока окно было открыто: пересчитать превью — у
        // строки появится карточка держателя и «Оставить под ответственность».
        toast.error(e.message ?? "Позиция нужна другой брони");
        refreshPreview();
      } else {
        toast.error(e?.message ?? "Не удалось принять возврат");
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function submitWhole() {
    return run(() => returnWhole(Boolean(plan?.hasPlannedStays)));
  }

  function submitSelection() {
    if (!plan) return;
    if (stays.size === 0) return submitWhole();
    return run(async () => {
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
    });
  }

  const visibleLines = plan
    ? plan.lines.filter((l) => !query.trim() || l.name.toLocaleLowerCase("ru-RU").includes(query.trim().toLocaleLowerCase("ru-RU")))
    : [];
  const planned = plan ? plan.lines.filter((l) => stays.has(l.bookingItemId)) : [];
  const kioskGate = Boolean(plan?.kioskSession) && !kioskOverride;
  const blockingConflicts = mode === "partial" ? unacknowledgedConflicts(preview, stays) : [];
  const primaryLabel =
    stays.size === 0
      ? "Вернули всё"
      : summary && summary.acceptedLines === 0
        ? "Оставить всё у клиента"
        : `Принять ${positionsAcc(summary?.acceptedLines ?? 0)}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-scrim/50 sm:items-start sm:px-4 sm:pt-[6vh]"
      onClick={close}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="return-dialog-title"
        className="flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-xl sm:max-h-[88vh] border border-border bg-surface shadow-xl outline-none sm:max-w-[640px] sm:rounded-lg"
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
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded text-ink-3 hover:bg-surface-subtle hover:text-ink sm:h-8 sm:w-8"
            onClick={close}
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loadError && (
            <div className="space-y-2 text-sm">
              <p className="text-rose">{loadError}</p>
              <p className="text-ink-2">
                Повторите загрузку или примите бронь целиком, если вернули всё оборудование.
              </p>
            </div>
          )}
          {!plan && !loadError && <p className="text-sm text-ink-3">Загружаем позиции…</p>}

          {plan?.kioskSession && (
            <div className="mb-4 rounded border border-amber-border bg-amber-soft px-3 py-2.5">
              <p className="text-[13px] font-semibold text-amber">
                В киоске открыта приёмка ({plan.kioskSession.workerName}, {formatWhen(plan.kioskSession.startedAt).split(", ")[1]})
              </p>
              <p className="mt-0.5 text-[12.5px] text-ink-2">
                Если принять здесь, приёмка в киоске закроется, а её отметки не сохранятся.
              </p>
            </div>
          )}

          {plan && !kioskGate && mode === "simple" && (
            <p className="text-sm text-ink-2">Всё оборудование вернули на склад? Принятое сразу станет свободным для других броней.</p>
          )}

          {plan && !kioskGate && mode === "planned" && (
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
              {summary && summary.acceptedLines > 0 && (
                <p className="mt-3 text-sm text-ink-2">
                  Остальное принимаем на склад: <span className="font-semibold text-ink">{positionsAcc(summary.acceptedLines)}</span>. Принятое сразу свободно для других броней.
                </p>
              )}
            </>
          )}

          {plan && !kioskGate && mode === "partial" && (
            <>
              {plan.lines.length > 8 && (
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Найти позицию…"
                  aria-label="Найти позицию"
                  className="mb-3 h-11 w-full rounded border border-border bg-surface px-3 text-sm text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
                />
              )}
              <ul className="divide-y divide-border rounded border border-border">
                {visibleLines.map((l) => {
                  const stay = stays.get(l.bookingItemId);
                  const previewLine =
                    preview?.continuations.flatMap((c) => c.lines).find((pl) => pl.bookingItemId === l.bookingItemId) ?? null;
                  const conflict = preview?.conflicts.find((c) => c.bookingItemId === l.bookingItemId) ?? null;
                  return (
                    <ReturnStayRow
                      key={l.bookingItemId}
                      line={l}
                      stay={stay}
                      busy={busy}
                      previewLine={previewLine}
                      discountPercent={Number(preview?.continuations[0]?.discountPercent ?? 0)}
                      previewLoading={previewLoading}
                      conflict={conflict}
                      onQuantity={(n) => setStays(setStayQuantity(stays, l, n))}
                      onToggleUnit={(unitId) => setStays(toggleStayUnit(stays, l, unitId))}
                      onChoice={(choice, customUntil) => setStays(setStayChoice(stays, l, choice, customUntil))}
                      onAcknowledge={(ack) => setStays(setStayAcknowledged(stays, l, ack))}
                    />
                  );
                })}
              </ul>
              {preview && <div className="mt-3"><ContinuationPriceBlock preview={preview} loading={previewLoading} /></div>}
              {previewError && <p className="mt-3 text-xs text-amber">{previewError}</p>}
            </>
          )}
        </div>

        {/* Отступ снизу под «домашнюю полоску» iPhone: окно — шторка у края. */}
        <footer className="flex flex-col gap-3 border-t border-border bg-surface-subtle px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:flex-row sm:items-center sm:justify-between">
          {loadError ? (
            <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button type="button" disabled={busy} className={BTN_SECONDARY} onClick={() => setAttempt((n) => n + 1)}>
                Повторить
              </button>
              <button type="button" disabled={busy} className={BTN_PRIMARY} onClick={() => run(() => returnWhole(false))}>
                {busy ? "Принимаем…" : "Вернули всё"}
              </button>
            </div>
          ) : plan && kioskGate ? (
            <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Link
                href={`/warehouse/scan?booking=${bookingId}`}
                className="inline-flex min-h-11 items-center justify-center rounded border border-border bg-surface px-4 text-sm font-medium text-ink-2 hover:bg-surface-subtle sm:min-h-10"
              >
                Закончу в киоске
              </Link>
              <button
                ref={primaryRef}
                type="button"
                className="min-h-11 rounded border border-amber bg-surface px-4 text-sm font-semibold text-amber hover:bg-amber-soft sm:min-h-10"
                onClick={() => setKioskOverride(true)}
              >
                Принять здесь, закрыть киоск
              </button>
            </div>
          ) : plan && summary ? (
            <>
              <div className="min-w-0 flex-1 text-xs text-ink-2">
                {mode === "partial" && summary.keptUnits > 0 ? (
                  blockingConflicts.length > 0 ? (
                    <span className="text-amber">
                      Нужно другой брони: {blockingConflicts.map((c) => `«${c.name}»`).join(", ")} — оставьте под ответственность
                      или сократите срок
                    </span>
                  ) : (
                    <>
                      Принимаем <span className="font-semibold text-ink">{positionsAcc(summary.acceptedLines)}</span>, у клиента остаётся{" "}
                      <span className="font-semibold text-ink">{summary.keptUnits} шт</span> → продолжение
                      {preview?.continuations[0]?.docNumber ? ` ${preview.continuations[0].docNumber}` : " брони"}
                    </>
                  )
                ) : mode !== "partial" && anyStayPossible(plan) ? (
                  <button
                    type="button"
                    className="min-h-11 text-sm font-medium text-accent underline-offset-2 hover:underline sm:min-h-0"
                    onClick={() => setMode("partial")}
                    disabled={busy}
                  >
                    Вернули не всё
                  </button>
                ) : null}
              </div>
              <div className="flex shrink-0 flex-wrap justify-end gap-2">
                {mode === "planned" ? (
                  <button type="button" disabled={busy} className={BTN_SECONDARY} onClick={submitWhole}>
                    Вернули всё · {plan.lines.length}
                  </button>
                ) : (
                  <button type="button" disabled={busy} className={BTN_SECONDARY} onClick={close}>
                    Отмена
                  </button>
                )}
                <button
                  ref={primaryRef}
                  type="button"
                  disabled={busy || (mode === "partial" && blockingConflicts.length > 0)}
                  title={blockingConflicts.length > 0 ? "Решите по позициям, нужным другим броням" : undefined}
                  className={BTN_PRIMARY}
                  onClick={submitSelection}
                >
                  {busy ? "Принимаем…" : primaryLabel}
                </button>
              </div>
            </>
          ) : (
            <div className="flex w-full justify-end">
              <button type="button" className={BTN_SECONDARY} onClick={close}>
                Отмена
              </button>
            </div>
          )}
        </footer>
      </div>
    </div>
  );
}
