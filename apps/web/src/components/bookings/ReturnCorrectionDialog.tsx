"use client";

/**
 * «Часть не вернули» — исправление приёмки (мокап
 * docs/mockups/line-shifts-continuation/m4-return-dialog.html, состояние D).
 *
 * Бронь приняли целиком, а потом выяснилось, что часть осталась у клиента.
 * В течение 7 дней после приёмки: по строке «не вернули N» (у штучной — какие
 * единицы), до какого срока, во что обойдётся. Создаёт продолжение брони с
 * момента приёмки; склад снова считает оставленное занятым. Пока идёт
 * инвентаризация — кнопка серая.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { apiFetch } from "@/lib/api";
import { pluralize } from "@/lib/format";
import { useDialog } from "@/hooks/useDialog";
import { toast } from "../ToastProvider";
import { quoteName } from "../inventory/format";
import { ContinuationPriceBlock } from "./ContinuationPriceBlock";
import { ReturnStayRow, paidShortcutHelps } from "./ReturnStayRow";
import {
  formatWhen,
  fromWhen,
  partialReturnBody,
  setStayAcknowledged,
  setStayChoice,
  setStayQuantity,
  toggleStayUnit,
  unacknowledgedConflicts,
  type ReturnPlan,
  type ReturnPlanLine,
  type StayDraft,
} from "./returnDialogState";
import { useReturnPreview } from "./useReturnPreview";

/** Строка исправления — ответ GET /api/bookings/:id/return-correction. */
export type CorrectionLine = ReturnPlanLine & {
  /** Свободные, но зарезервированные за другой бронью единицы — отметить их здесь нельзя. */
  reservedUnits?: Array<{ id: string; label: string | null; reservedFor: string | null }>;
  booked: number;
  inContinuations: number;
  inRepair: number;
  inProblems: number;
};

export type CorrectionBlock = "NOT_RETURNED" | "NO_RETURN_RECORD" | "WINDOW_CLOSED" | "STOCK_COUNT_OPEN";

export type CorrectionPlan = {
  bookingId: string;
  docNumber: string | null;
  splitRevision: number;
  returnedAt: string | null;
  correctableUntil: string | null;
  blockedBy: CorrectionBlock | null;
  lines: CorrectionLine[];
};

/** Пункт «Часть не вернули» нужен, пока исправить можно — или ждёт конца инвентаризации. */
export function correctionOffered(plan: CorrectionPlan | null): boolean {
  return plan != null && plan.lines.length > 0 && (plan.blockedBy == null || plan.blockedBy === "STOCK_COUNT_OPEN");
}

/** «одна» вместо «1» — как в мокапе («одна уже в «Потеряшках»»). */
const count = (n: number) => (n === 1 ? "одна" : String(n));

/** «Не больше 3: было 4, одна уже в «Потеряшках»». */
export function capNoteOf(line: CorrectionLine): string | null {
  if (line.quantity >= line.booked) return null;
  const parts: string[] = [];
  if (line.inContinuations > 0) parts.push(`${count(line.inContinuations)} уже в продолжении`);
  if (line.inRepair > 0) parts.push(`${count(line.inRepair)} ${pluralize(line.inRepair, "сдана", "сданы", "сданы")} в ремонт`);
  if (line.inProblems > 0) parts.push(`${count(line.inProblems)} уже в «Потеряшках»`);
  const reserved = line.reservedUnits ?? [];
  if (reserved.length > 0) {
    const names = Array.from(new Set(reserved.map((u) => u.reservedFor).filter((n): n is string => Boolean(n))));
    parts.push(`${count(reserved.length)} зарезервирован${pluralize(reserved.length, "а", "ы", "ы")} за ${names.length > 0 ? names.map((n) => quoteName(n)).join(", ") : "другой бронью"} — сначала снимите резерв там`);
  }
  const accounted = line.inContinuations + line.inRepair + line.inProblems + reserved.length;
  if (line.unitTracked && line.booked - accounted > line.quantity) parts.push("остальные с приёмки уже побывали в других бронях или не на складе");
  return `Не больше ${line.quantity}: было ${line.booked}${parts.length > 0 ? `, ${parts.join(", ")}` : ""}.`;
}

/** Почему исправить нельзя — подпись внизу окна. */
const BLOCK_NOTE: Record<CorrectionBlock, string> = {
  STOCK_COUNT_OPEN: "Исправить после завершения инвентаризации",
  WINDOW_CLOSED: "Исправить приёмку можно в течение 7 дней — срок прошёл",
  NOT_RETURNED: "Бронь уже не «Возвращена» — обновите карточку",
  NO_RETURN_RECORD: "В журнале нет приёмки этой брони — исправить её нельзя",
};

/** «вт 13 окт.» — дата без времени. */
const dayOf = (iso: string) => formatWhen(iso).split(", ")[0];

const STALE_CODES = new Set(["PARTIAL_RETURN_STALE", "RETURN_CORRECTION_NOT_RETURNED", "RETURN_CORRECTION_WINDOW_CLOSED"]);

const BTN_SECONDARY =
  "min-h-11 rounded border border-border bg-surface px-4 text-sm text-ink hover:bg-surface-subtle disabled:opacity-50 sm:min-h-10";
const BTN_PRIMARY =
  "min-h-11 rounded border border-accent bg-accent px-4 text-sm font-semibold text-surface hover:bg-accent-bright disabled:opacity-50 sm:min-h-10";

type Props = {
  bookingId: string;
  docNumber: string | null;
  open: boolean;
  onClose: () => void;
  /** Продолжение создано — перечитать карточку. */
  onDone: () => void;
};

export function ReturnCorrectionDialog({ bookingId, docNumber, open, onClose, onDone }: Props) {
  const [plan, setPlan] = useState<CorrectionPlan | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [stays, setStays] = useState<Map<string, StayDraft>>(new Map());
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const dialogRef = useDialog<HTMLDivElement>(open, () => !busyRef.current && onClose());

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPlan(null);
    setLoadError(null);
    setStays(new Map());
    apiFetch<CorrectionPlan>(`/api/bookings/${bookingId}/return-correction`)
      .then((p) => {
        if (!cancelled) setPlan(p);
      })
      .catch((e: { message?: string }) => {
        if (!cancelled) setLoadError(e?.message ?? "Не удалось загрузить позиции брони");
      });
    return () => {
      cancelled = true;
    };
  }, [open, bookingId, attempt]);

  // Общие функции окна приёмки работают с планом приёмки — у исправления та же форма строк.
  const asPlan = useMemo(
    (): ReturnPlan | null =>
      plan ? { bookingId, splitRevision: plan.splitRevision, lines: plan.lines, hasPlannedStays: false, kioskSession: null } : null,
    [plan, bookingId],
  );
  // Превью — для любой отметки: держатель проверяется с текущего момента и
  // внутри оплаченного тоже. Исправить нельзя — считать незачем.
  const previewStays = useMemo(
    () => (asPlan && stays.size > 0 && plan?.blockedBy == null ? partialReturnBody(asPlan, stays).stays : null),
    [asPlan, stays, plan?.blockedBy],
  );
  const { preview, loading: previewLoading, error: previewError, refresh: refreshPreview } = useReturnPreview(
    bookingId,
    previewStays,
    "return-correction/preview",
  );
  if (!open) return null;

  const close = () => !busyRef.current && onClose();
  const blockedBy = plan?.blockedBy ?? null;
  const kept = Array.from(stays.values()).reduce((n, s) => n + s.quantity, 0);
  const blockingConflicts = unacknowledgedConflicts(preview, stays);
  // «Сократите срок» — только если короткий срок и правда снимает конфликт.
  const shortenHelps = blockingConflicts.some((c) => {
    const line = plan?.lines.find((l) => l.bookingItemId === c.bookingItemId);
    return line != null && Date.parse(line.paidThrough) > Date.now() && paidShortcutHelps(c, line);
  });
  const visibleLines = plan
    ? plan.lines.filter((l) => !query.trim() || l.name.toLocaleLowerCase("ru-RU").includes(query.trim().toLocaleLowerCase("ru-RU")))
    : [];

  async function submit() {
    if (!asPlan || busyRef.current || stays.size === 0) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await apiFetch<{ continuationIds: string[] }>(`/api/bookings/${bookingId}/return-correction`, {
        method: "POST",
        body: JSON.stringify(partialReturnBody(asPlan, stays)),
      });
      toast.success("Создано продолжение брони — склад снова считает оставленное занятым");
      onDone();
      onClose();
    } catch (e: any) {
      if (e?.code === "CONTINUATION_CONFLICT") {
        toast.error(e.message ?? "Позиция нужна другой брони");
        refreshPreview();
      } else if (e?.code && STALE_CODES.has(e.code)) {
        toast.error(e.message ?? "Бронь изменилась — обновите карточку");
        onDone();
        onClose();
      } else {
        toast.error(e?.message ?? "Не удалось исправить приёмку");
        // Инвентаризация началась, единицу выдали — перечитать потолки.
        if (typeof e?.code === "string" && e.code.startsWith("RETURN_CORRECTION_")) setAttempt((n) => n + 1);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-scrim/50 sm:items-start sm:px-4 sm:pt-[6vh]" onClick={close}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="return-correction-title"
        className="flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-xl sm:max-h-[88vh] border border-border bg-surface shadow-xl outline-none sm:max-w-[560px] sm:rounded-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <p className="eyebrow">Исправление приёмки{docNumber ? ` · ${docNumber}` : ""}</p>
            <h2 id="return-correction-title" className="mt-0.5 text-base font-semibold text-ink">
              Часть не вернули
            </h2>
            {plan?.returnedAt && plan.correctableUntil && (
              <p className="mt-0.5 text-[12px] text-ink-3">
                Приняли {formatWhen(plan.returnedAt)} · исправить можно до {dayOf(plan.correctableUntil)}
              </p>
            )}
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

        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {loadError && <p className="text-sm text-rose">{loadError}</p>}
          {!plan && !loadError && <p className="text-sm text-ink-3">Загружаем позиции…</p>}
          {plan && plan.lines.length === 0 && !blockedBy && (
            <p className="text-sm text-ink-2">Отметить нечего: всё, что было в брони, уже в продолжениях, ремонте или «Потеряшках».</p>
          )}
          {plan && plan.lines.length > 0 && (
            <>
              {plan.lines.length > 8 && (
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Найти позицию…"
                  aria-label="Найти позицию"
                  className="h-11 w-full rounded border border-border bg-surface px-3 text-sm text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
                />
              )}
              <ul className="divide-y divide-border rounded border border-border">
                {visibleLines.map((l) => (
                  <ReturnStayRow
                    key={l.bookingItemId}
                    line={l}
                    stay={stays.get(l.bookingItemId)}
                    busy={busy || blockedBy != null}
                    correction
                    quantityLabel="не вернули"
                    capNote={capNoteOf(l)}
                    previewLine={preview?.continuations.flatMap((c) => c.lines).find((pl) => pl.bookingItemId === l.bookingItemId) ?? null}
                    discountPercent={Number(preview?.continuations[0]?.discountPercent ?? 0)}
                    previewLoading={previewLoading}
                    conflict={preview?.conflicts.find((c) => c.bookingItemId === l.bookingItemId) ?? null}
                    onQuantity={(n) => setStays(setStayQuantity(stays, l, n))}
                    onToggleUnit={(unitId) => setStays(toggleStayUnit(stays, l, unitId))}
                    onChoice={(choice, customUntil) => setStays(setStayChoice(stays, l, choice, customUntil))}
                    onAcknowledge={(ack) => setStays(setStayAcknowledged(stays, l, ack))}
                  />
                ))}
              </ul>
              {preview && <ContinuationPriceBlock preview={preview} loading={previewLoading} />}
              {previewError && <p className="text-xs text-amber">{previewError}</p>}
              {kept > 0 && plan.returnedAt && (
                <p className="rounded-md border border-border bg-surface-subtle px-3 py-2.5 text-[12.5px] text-ink-2">
                  Создастся продолжение {preview?.continuations[0]?.docNumber ?? "брони"} {fromWhen(plan.returnedAt)}. Оставленное
                  ({kept} шт) склад снова считает занятым. Акт основной брони станет доступен, когда примут продолжение.
                </p>
              )}
            </>
          )}
        </div>

        <footer className="flex flex-col gap-3 border-t border-border bg-surface-subtle px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="min-w-0 flex-1 text-xs text-ink-2">
            {blockedBy ? (
              <span className="text-amber">{BLOCK_NOTE[blockedBy]}</span>
            ) : blockingConflicts.length > 0 ? (
              <span className="text-amber">
                Нужно другой брони: {blockingConflicts.map((c) => `«${c.name}»`).join(", ")} — оставьте под ответственность
                {shortenHelps ? " или сократите срок" : ""}
              </span>
            ) : null}
          </p>
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            <button type="button" disabled={busy} className={BTN_SECONDARY} onClick={close}>
              Отмена
            </button>
            <button
              type="button"
              disabled={busy || !plan || stays.size === 0 || blockedBy != null || blockingConflicts.length > 0}
              className={BTN_PRIMARY}
              onClick={submit}
            >
              {busy ? "Создаём…" : "Создать продолжение"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
