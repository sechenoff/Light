"use client";

/**
 * Строка окна «Принять возврат» в режиме «Вернули не всё» (мокап M4,
 * состояние B): сколько остаётся у клиента, до какого срока, во что это
 * обойдётся и не нужна ли позиция другой брони.
 */
import { formatRub } from "@/lib/format";
import { quoteName } from "../inventory/format";
import {
  canStay,
  formatWhen,
  isBeyondPaid,
  stayChoicesFor,
  type ContinuationPreview,
  type ReturnPlanLine,
  type StayChoice,
  type StayConflict,
  type StayDraft,
} from "./returnDialogState";

type Props = {
  line: ReturnPlanLine;
  stay: StayDraft | undefined;
  busy: boolean;
  /** Строка из превью дополнительной сметы (сумма лишних смен). */
  previewLine: ContinuationPreview["lines"][number] | null;
  previewLoading: boolean;
  conflict: StayConflict | null;
  onQuantity: (next: number) => void;
  onToggleUnit: (unitId: string) => void;
  onChoice: (choice: StayChoice, customUntil?: string) => void;
  onAcknowledge: (ack: boolean) => void;
};

const shiftsWord = (n: number) =>
  n % 10 === 1 && n % 100 !== 11 ? "смена" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "смены" : "смен";

/** ISO → значение для <input type="datetime-local"> (время браузера). */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ReturnStayRow({
  line,
  stay,
  busy,
  previewLine,
  previewLoading,
  conflict,
  onQuantity,
  onToggleUnit,
  onChoice,
  onAcknowledge,
}: Props) {
  const kept = stay?.quantity ?? 0;
  const choices = stayChoicesFor(line);
  const beyond = stay ? isBeyondPaid(stay, line) : false;

  return (
    <li className="space-y-2 px-3 py-3" data-testid="return-line">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">{line.name}</p>
          {line.plannedStayUntil && <p className="text-xs text-indigo">по плану до {formatWhen(line.plannedStayUntil)}</p>}
        </div>
        {line.unitTracked ? (
          <p className="text-xs text-ink-2">
            остаётся у клиента <span className="mono-num font-semibold text-ink">{kept}</span> из {line.quantity}
          </p>
        ) : (
          <div className="flex items-center gap-2 text-xs text-ink-2">
            остаётся у клиента
            <span className={`inline-flex items-center overflow-hidden rounded border ${kept > 0 ? "border-teal-border" : "border-border"}`}>
              <button
                type="button"
                aria-label={`Меньше: ${line.name}`}
                disabled={kept === 0 || busy}
                className="flex h-11 w-11 items-center justify-center text-ink-2 hover:bg-surface-subtle disabled:opacity-40 sm:h-9 sm:w-9"
                onClick={() => onQuantity(kept - 1)}
              >
                −
              </button>
              <span
                className={`mono-num flex h-11 w-9 items-center justify-center border-x font-semibold sm:h-9 ${kept > 0 ? "border-teal-border text-teal" : "border-border text-ink"}`}
              >
                {kept}
              </span>
              <button
                type="button"
                aria-label={`Больше: ${line.name}`}
                disabled={kept >= line.quantity || busy}
                className="flex h-11 w-11 items-center justify-center text-ink-2 hover:bg-surface-subtle disabled:opacity-40 sm:h-9 sm:w-9"
                onClick={() => onQuantity(kept + 1)}
              >
                +
              </button>
            </span>
            из {line.quantity}
          </div>
        )}
      </div>

      {line.unitTracked && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={`Какие единицы остались у клиента: ${line.name}`}>
          {line.units.map((u, i) => {
            const on = stay?.unitIds.includes(u.id) ?? false;
            return (
              <button
                key={u.id}
                type="button"
                aria-pressed={on}
                disabled={busy}
                className={`min-h-11 rounded border px-3 text-xs sm:min-h-9 ${on ? "border-accent bg-accent-soft font-semibold text-accent" : "border-border text-ink-2 hover:bg-surface-subtle"}`}
                onClick={() => onToggleUnit(u.id)}
              >
                {u.label ?? `Единица ${i + 1}`}
              </button>
            );
          })}
        </div>
      )}

      {stay && kept > 0 && (
        <>
          <div className="grid grid-cols-4 gap-1" role="radiogroup" aria-label={`До какого срока остаётся: ${line.name}`}>
            {choices.map((c) => {
              const on = stay.choice === c.choice;
              return (
                <button
                  key={String(c.choice)}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={busy}
                  onClick={() => onChoice(c.choice)}
                  className={`flex min-h-11 items-center justify-center rounded border px-1 py-1 text-center text-[11.5px] leading-tight sm:min-h-10 ${on ? "border-accent-bright bg-accent-soft font-semibold text-accent" : "border-border bg-surface text-ink-2 hover:bg-surface-subtle"}`}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
          {stay.choice === "date" && (
            <input
              type="datetime-local"
              aria-label={`Срок возврата: ${line.name}`}
              value={toLocalInput(stay.until)}
              disabled={busy}
              onChange={(e) => {
                const d = new Date(e.target.value);
                if (Number.isFinite(d.getTime()) && d.getTime() > Date.now()) onChoice("date", d.toISOString());
              }}
              className="h-11 w-full rounded border border-border bg-surface px-3 text-sm text-ink focus:border-accent focus:outline-none sm:h-10 sm:w-auto"
            />
          )}
          <p className="text-[12px] text-ink-2">
            Вернут <span className="font-semibold text-ink">{formatWhen(stay.until)}</span>
            {!beyond ? (
              " · без доплаты"
            ) : previewLine && previewLine.billedShifts > 0 ? (
              <span className="whitespace-nowrap text-amber">
                {" "}
                · {kept} шт × {previewLine.billedShifts} {shiftsWord(previewLine.billedShifts)} → {formatRub(previewLine.afterDiscount)}
                {previewLine.negotiated ? ", договорная цена" : " со скидкой"}
              </span>
            ) : (
              <span className="text-ink-3"> · {previewLoading ? "считаем доплату…" : "сверх оплаченного"}</span>
            )}
          </p>
          {conflict && beyond && (
            <div className="rounded-md border border-amber-border bg-amber-soft px-3 py-2.5" role="group" aria-label={`Нужен другой брони: ${line.name}`}>
              <p className="text-[12.5px] font-semibold text-amber">
                Нужен {conflict.holder ? `брони ${quoteName(conflict.holder.projectName)}` : "другой брони"} с {formatWhen(conflict.from)}
              </p>
              <p className="mt-0.5 text-[12px] leading-snug text-ink-2">
                {conflict.holder?.clientName ? `${conflict.holder.clientName} · ` : ""}свободно {Math.max(0, conflict.available)} из{" "}
                {conflict.needed}. Прибор у клиента — склад его не удержит, решает руководитель с клиентом.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  aria-pressed={stay.acknowledged === true}
                  disabled={busy}
                  onClick={() => onAcknowledge(!stay.acknowledged)}
                  className={`inline-flex min-h-11 items-center rounded border px-3 text-[12.5px] font-semibold sm:min-h-10 ${stay.acknowledged ? "border-amber bg-amber text-surface" : "border-amber bg-surface text-amber"}`}
                >
                  {stay.acknowledged ? "✓ Под ответственность" : "Оставить под ответственность"}
                </button>
                {canStay(line) && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onChoice("paid")}
                    className="inline-flex min-h-11 items-center rounded border border-border bg-surface px-3 text-[12.5px] text-ink-2 sm:min-h-10"
                  >
                    Только до {formatWhen(line.paidThrough)}
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {kept === 0 && (
        <p className="text-xs text-ink-3">
          {line.unitTracked
            ? "Отметьте единицы, которые остались у клиента"
            : canStay(line)
              ? `Оплачено до ${formatWhen(line.paidThrough)}`
              : "Оплаченный срок прошёл — оставить можно с дополнительной сметой"}
        </p>
      )}
    </li>
  );
}
