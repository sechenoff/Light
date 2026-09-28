"use client";

/**
 * Карточка конфликта «+ Добор» — вынесена из `AddonSearch`, чтобы тот не
 * разрастался. Показывает держателя и даёт выбрать количество под
 * ответственность.
 */

import type { AddonConflict } from "./types";
import { holderStateText, quoted, shortDate } from "./addonConflictText";

/**
 * Красная карточка конфликта (мокап, блок 3 `.warn`). Чистая и управляемая.
 *
 * Держатель назван по-человечески (P26): «сейчас у клиента … с …», «возврат не
 * отмечен», «пока на складе». «Свободно с …» — только когда дата известна.
 * Количество выбирается до `maxQty` (`ackCap`, P4): раньше здесь был только 1.
 */
export function ConflictWarning({
  name,
  qty,
  maxQty,
  conflict,
  busy,
  onQty,
  onCancel,
  onForce,
}: {
  name: string;
  qty: number;
  /** Потолок «под ответственность»; 0 — на складе не осталось ни единицы. */
  maxQty: number;
  conflict: AddonConflict;
  busy: boolean;
  onQty: (next: number) => void;
  onCancel: () => void;
  onForce: () => void;
}) {
  const state = holderStateText(conflict);
  const blocked = maxQty < 1;
  const clamp = (n: number) => Math.max(1, Math.min(maxQty, Math.floor(n)));
  return (
    <div
      role="alert"
      className="mx-3 mb-3 rounded-lg border border-rose-border bg-rose-soft px-3 py-2.5"
    >
      <p className="text-[13px] font-semibold text-rose">
        <span aria-hidden="true">⚠ </span>
        {name} занят
      </p>
      <p className="mt-1 text-[11px] leading-snug text-rose">
        Бронь {conflict.bookingNo} {quoted(conflict.projectName)} ·{" "}
        {shortDate(conflict.from)}–{shortDate(conflict.to)}.
        {conflict.freeFrom ? ` Свободно с ${shortDate(conflict.freeFrom)}.` : ""}
      </p>
      {state && (
        <p className="mt-0.5 text-[11px] font-medium leading-snug text-rose">
          {state}.
        </p>
      )}

      {blocked ? (
        <p className="mt-2 text-[11px] leading-snug text-rose">
          На складе не осталось ни одной единицы — добрать нельзя даже под
          ответственность.
        </p>
      ) : (
        maxQty > 1 && (
          <div className="mt-2 flex items-center gap-2">
            <span className="text-[11px] text-rose">Сколько добрать:</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => onQty(clamp(qty - 1))}
                disabled={busy || qty <= 1}
                aria-label="Уменьшить — сколько добрать"
                className="flex h-10 w-10 items-center justify-center rounded border border-rose-border bg-surface text-lg font-semibold leading-none text-ink-2 transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                −
              </button>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={maxQty}
                value={qty}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n)) onQty(clamp(n));
                }}
                aria-label="Сколько добрать"
                className="mono-num h-10 w-12 rounded border border-rose-border bg-surface text-center text-[13px] font-semibold text-ink outline-none focus:border-accent-bright"
              />
              <button
                type="button"
                onClick={() => onQty(clamp(qty + 1))}
                disabled={busy || qty >= maxQty}
                aria-label="Увеличить — сколько добрать"
                className="flex h-10 w-10 items-center justify-center rounded border border-rose-border bg-surface text-lg font-semibold leading-none text-ink-2 transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                +
              </button>
            </div>
            <span className="text-[11px] text-rose/80">из {maxQty}</span>
          </div>
        )
      )}

      <div className="mt-2.5 flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          aria-label={`Отмена — не добавлять ${name}`}
          className="h-10 flex-1 rounded border border-border bg-surface text-[12px] font-medium text-ink-2 transition-colors hover:bg-surface-muted disabled:opacity-50"
        >
          Отмена
        </button>
        <button
          type="button"
          onClick={onForce}
          disabled={busy || blocked}
          aria-label={`Выдать ${qty > 1 ? `${qty} шт ` : ""}${name} под ответственность, несмотря на конфликт`}
          className="h-10 flex-[1.4] rounded bg-rose text-[12px] font-semibold text-surface transition-colors hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy
            ? "…"
            : qty > 1
              ? `Выдать ${qty} под ответственность`
              : "Выдать под ответственность"}
        </button>
      </div>
      <p className="mt-1.5 text-[10px] text-rose/80">
        Конфликт зафиксируется в аудите
      </p>
    </div>
  );
}
