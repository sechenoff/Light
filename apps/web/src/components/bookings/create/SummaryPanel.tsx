"use client";

import { EditablePrice } from "./EditablePrice";
import { EstimateExportBlock } from "./EstimateExportBlock";
import { formatMoneyRubWhole, pluralize } from "../../../lib/format";
import type { QuoteResponse, TransportBreakdown, ValidationCheck } from "./types";

type SummaryPanelProps = {
  quote: QuoteResponse | null;
  /** Зафиксированный вручную итог брони; null — считаем по смете. */
  negotiatedTotal?: number | null;
  /** Задать/сбросить договорной итог. Не передан — итог только для чтения. */
  onChangeNegotiatedTotal?: (v: number | null) => void;
  localSubtotal: number;
  /** Прайсовая часть предварительного расчёта — база процентной скидки. */
  localListedSubtotal: number;
  /** Договорная часть предварительного расчёта — процент к ней не применяется. */
  localNegotiatedSubtotal: number;
  localDiscount: number;
  localTotal: number;
  discountPercent: number;
  itemCount: number;
  shifts: number;
  isLoadingQuote: boolean;
  /** true, когда серверный пересчёт сметы упал — показываем предварительный
   *  локальный расчёт с честной пометкой, а не выдаём его за «обновлено». */
  quoteError?: boolean;
  checks: ValidationCheck[];
  // Create-mode buttons (required when mode="create" or mode not provided)
  onSubmitForApproval?: () => void;
  /** SUPER_ADMIN-only: создать и сразу подтвердить (одобряющий сам себе).
   *  Когда задан — становится основным CTA, «на согласование» уходит вторичным. */
  onCreateAndConfirm?: () => void;
  onSaveDraft?: () => void;
  // Edit-mode button
  onSaveEdit?: () => void;
  canSubmit: boolean;
  /** Per-vehicle breakdowns (multi-vehicle). Empty when no transport. */
  transportBreakdowns?: TransportBreakdown[];
  /** Controls which action buttons to render. Defaults to "create". */
  mode?: "create" | "edit";
  /** Whether a save/submit action is in progress. */
  submitting?: boolean;
  /** Cancel link href (edit mode). */
  cancelHref?: string;
  /** Правка сохранённой брони — тогда смету можно напечатать и выгрузить.
   *  На форме создания печатать нечего: снапшота ещё нет. */
  bookingId?: string;
  /** В форме есть правки, которых нет в сохранённой смете. */
  hasUnsavedChanges?: boolean;
};

const CHECK_BADGE: Record<ValidationCheck["type"], { symbol: string; colorClass: string }> = {
  ok: { symbol: "✓", colorClass: "text-emerald" },
  warn: { symbol: "!", colorClass: "text-amber" },
  tip: { symbol: "i", colorClass: "text-accent" },
  todo: { symbol: "○", colorClass: "text-ink-3" },
  error: { symbol: "!", colorClass: "text-rose" },
};

export function SummaryPanel({
  quote,
  negotiatedTotal = null,
  onChangeNegotiatedTotal,
  localSubtotal,
  localListedSubtotal,
  localNegotiatedSubtotal,
  localDiscount,
  localTotal,
  discountPercent,
  itemCount,
  shifts,
  isLoadingQuote,
  quoteError = false,
  checks,
  onSubmitForApproval,
  onCreateAndConfirm,
  onSaveDraft,
  onSaveEdit,
  canSubmit,
  transportBreakdowns,
  mode = "create",
  submitting = false,
  cancelHref,
  bookingId,
  hasUnsavedChanges = false,
}: SummaryPanelProps) {
  const equipSubtotal = quote ? Number(quote.equipmentSubtotal ?? quote.subtotal) : localSubtotal;
  const discount = quote ? Number(quote.discountAmount) : localDiscount;
  const equipTotal = quote ? Number(quote.equipmentTotal ?? quote.totalAfterDiscount) : localTotal;
  const discPct = quote ? Number(quote.discountPercent) : discountPercent;
  const effectiveShifts = quote ? quote.shifts : shifts;

  // Transport: prefer server quote, fallback to local calculation.
  // Multi-vehicle: array of per-vehicle breakdowns; total = sum.
  const transportRows = quote?.transport ?? transportBreakdowns ?? [];
  // round2 защищает суммы от float-артефактов (0.1+0.2) до отображения.
  // Это превью; авторитетный расчёт денег — на бэкенде через Decimal.
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const transportTotal = round2(transportRows.reduce((acc, t) => acc + Number(t.total), 0));

  // Grand total: prefer server, fallback to local
  const grandTotal = quote?.grandTotal
    ? Number(quote.grandTotal)
    : round2(equipTotal + transportTotal);
  // Legacy: subtotal for backward compat in display
  const subtotal = equipSubtotal;
  // Договорной итог перебивает расчётный: о сумме сговорились, и она держится,
  // даже если состав потом поменяется. Разница показывается отдельной строкой,
  // а не прячется внутрь цифры.
  const total = negotiatedTotal ?? grandTotal;
  const negotiatedDelta = negotiatedTotal != null ? round2(grandTotal - negotiatedTotal) : 0;

  // Пока сметы нет, разбивку берём из предварительного расчёта, а не считаем
  // всё прайсовым: иначе договорные строки попадали в базу скидки и панель
  // показывала итог вдвое меньше того, что вернёт сервер.
  const listedSubtotal =
    quote?.listedSubtotal != null ? Number(quote.listedSubtotal) : localListedSubtotal;
  const negotiatedLines =
    quote?.negotiatedSubtotal != null ? Number(quote.negotiatedSubtotal) : localNegotiatedSubtotal;

  const bigTotalFormatted = Math.round(total).toLocaleString("ru-RU");

  return (
    <aside className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 shadow-xs">
      {/* Header */}
      <div className="flex items-baseline justify-between">
        <p className="eyebrow">Расчёт</p>
        <span className={`text-xs ${quoteError && !isLoadingQuote ? "text-amber" : "text-ink-3"}`}>
          {isLoadingQuote
            ? "считаю..."
            : quoteError
              ? "не удалось пересчитать"
              : "обновлено сейчас"}
        </span>
      </div>
      {quoteError && !isLoadingQuote && (
        <p className="-mt-2 text-[11px] text-amber">
          Показан предварительный расчёт — сервер недоступен.
        </p>
      )}

      {/* Big total */}
      <div>
        <div className="flex items-baseline gap-1">
          {onChangeNegotiatedTotal ? (
            <EditablePrice
              value={total}
              listValue={grandTotal}
              isNegotiated={negotiatedTotal != null}
              onChange={onChangeNegotiatedTotal}
              ariaLabel="Итоговая сумма брони"
              size="lg"
            />
          ) : (
            <span className="font-mono text-[32px] font-semibold leading-none text-ink">
              {bigTotalFormatted}
            </span>
          )}
          <span className="text-[18px] text-ink-3">₽</span>
        </div>
        <p className="mt-1 text-xs text-ink-3">
          {negotiatedTotal != null ? (
            <>Итог зафиксирован вручную · по расчёту {formatMoneyRubWhole(grandTotal)} ₽</>
          ) : (
            <>
              {effectiveShifts} {pluralize(effectiveShifts, "день", "дня", "дней")} · {itemCount}{" "}
              {pluralize(itemCount, "позиция", "позиции", "позиций")}
            </>
          )}
        </p>
      </div>

      {/* Breakdown */}
      <div className="flex flex-col gap-1 text-sm">
        <div className="flex justify-between">
          <span className="text-ink-2">
            {negotiatedLines > 0 ? "Оборудование по прайсу" : "Оборудование"}
          </span>
          <span className="mono-num text-ink">
            {formatMoneyRubWhole(negotiatedLines > 0 ? listedSubtotal : equipSubtotal)} ₽
          </span>
        </div>
        {discPct > 0 && discount > 0 && (
          <div className="flex justify-between">
            <span className="text-ink-2">Скидка {discPct}%</span>
            <span className="mono-num text-rose">−{formatMoneyRubWhole(discount)} ₽</span>
          </div>
        )}
        {negotiatedLines > 0 && (
          <div className="flex justify-between">
            <span className="text-ink-2">Позиции по договорённости</span>
            <span className="mono-num text-indigo">{formatMoneyRubWhole(negotiatedLines)} ₽</span>
          </div>
        )}
        {discPct > 0 && discount > 0 && negotiatedLines === 0 && (
          <div className="flex justify-between">
            <span className="text-ink-2">Оборудование итого</span>
            <span className="mono-num text-ink">{formatMoneyRubWhole(equipTotal)} ₽</span>
          </div>
        )}
        {transportRows.map((t) => (
          <div key={t.vehicleId} className="flex justify-between">
            <span className="text-ink-2">Транспорт ({t.vehicleName})</span>
            <span className="mono-num text-ink">{formatMoneyRubWhole(Number(t.total))} ₽</span>
          </div>
        ))}
        {negotiatedTotal != null && Math.abs(negotiatedDelta) >= 1 && (
          <div className="flex justify-between">
            <span className="text-ink-2">
              {negotiatedDelta > 0 ? "Договорная скидка" : "Договорная надбавка"}
            </span>
            <span className={`mono-num ${negotiatedDelta > 0 ? "text-rose" : "text-amber"}`}>
              {negotiatedDelta > 0 ? "−" : "+"}
              {formatMoneyRubWhole(Math.abs(negotiatedDelta))} ₽
            </span>
          </div>
        )}
        <div className="flex justify-between border-t border-border pt-1 font-semibold">
          <span className="text-ink">Итого</span>
          <span className="mono-num text-ink">{formatMoneyRubWhole(total)} ₽</span>
        </div>
        {negotiatedLines > 0 && discPct > 0 && (
          <p className="mt-1 rounded border border-amber-border bg-amber-soft px-2 py-1.5 text-[11.5px] leading-snug text-ink-2">
            Скидка {discPct}% применяется только к позициям по прайсу. Вписанная вручную цена — уже
            договорная, процент к ней не добавляется.
          </p>
        )}
      </div>

      {/* Action buttons */}
      {mode === "edit" ? (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            disabled={!canSubmit || submitting}
            onClick={onSaveEdit}
            className="w-full rounded bg-accent-bright px-4 py-2.5 text-sm font-medium text-surface hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? "Сохранение…" : "Сохранить изменения"}
          </button>
          {cancelHref && (
            <a
              href={cancelHref}
              className="w-full rounded border border-border bg-surface px-4 py-2.5 text-sm font-medium text-ink-2 hover:bg-surface-muted text-center"
            >
              Отмена
            </a>
          )}
        </div>
      ) : onCreateAndConfirm ? (
        // SUPER_ADMIN: прямой путь «создать и подтвердить». «На согласование»
        // остаётся доступным вторичным действием, черновик — третьим.
        <div className="flex flex-col gap-2">
          <button
            type="button"
            disabled={!canSubmit || submitting}
            onClick={onCreateAndConfirm}
            className="w-full rounded bg-accent-bright px-4 py-2.5 text-sm font-medium text-surface hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? "Создание…" : "Создать и подтвердить →"}
          </button>
          <button
            type="button"
            disabled={!canSubmit || submitting}
            onClick={onSubmitForApproval}
            className="w-full rounded border border-border bg-surface px-4 py-2.5 text-sm font-medium text-ink-2 hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? "Отправка…" : "Отправить на согласование"}
          </button>
          <button
            type="button"
            disabled={!canSubmit || submitting}
            onClick={onSaveDraft}
            className="w-full rounded border border-border bg-surface px-4 py-2.5 text-sm font-medium text-ink-2 hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? "Сохранение…" : "Сохранить черновик"}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            disabled={!canSubmit || submitting}
            onClick={onSubmitForApproval}
            className="w-full rounded bg-inverse px-4 py-2.5 text-sm font-medium text-on-inverse hover:bg-inverse disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? "Отправка…" : "Отправить на согласование →"}
          </button>
          <button
            type="button"
            disabled={!canSubmit || submitting}
            onClick={onSaveDraft}
            className="w-full rounded border border-border bg-surface px-4 py-2.5 text-sm font-medium text-ink-2 hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? "Сохранение…" : "Сохранить черновик"}
          </button>
        </div>
      )}

      {bookingId && (
        <EstimateExportBlock bookingId={bookingId} hasUnsavedChanges={hasUnsavedChanges} />
      )}

      {/* Validation checks */}
      {checks.length > 0 && (
        <ul className="flex flex-col gap-2">
          {checks.map((check, i) => {
            const badge = CHECK_BADGE[check.type];
            return (
              <li key={i} className="flex items-start gap-2">
                <span
                  className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold ${badge.colorClass}`}
                >
                  {badge.symbol}
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-medium text-ink">{check.label}</p>
                  {check.detail && <p className="text-xs text-ink-3">{check.detail}</p>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
