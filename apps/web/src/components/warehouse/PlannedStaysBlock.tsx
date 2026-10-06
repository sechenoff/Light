"use client";

/**
 * «По плану у клиента» на экране приёмки киоска (мокап
 * docs/mockups/line-shifts-continuation/m3-kiosk-return.html, экран 1).
 *
 * Позиции, взятые дольше брони, сейчас не принимают: по «Завершить» они
 * уходят в продолжение брони за 0 ₽ — уже оплачены в основной смете. Привезли
 * раньше — «Вернули сейчас», и строка уходит в обычный чек-лист ниже.
 * Оставить сверх оплаченного (чипы «+1 смена») — следующий этап.
 */
import type { ChecklistItem, PlannedStay } from "./types";

/** «ср 14 окт., 10:00» по Москве. */
export function formatStayWhen(iso: string): string {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month")}, ${get("hour")}:${get("minute")}`;
}

/** «ср 10:00» — короткий срок в заголовке блока. */
function formatStayShort(iso: string): string {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("weekday")} ${get("hour")}:${get("minute")}`;
}

type Props = {
  stays: readonly PlannedStay[];
  items: readonly ChecklistItem[];
  /** Строки, которые «вернули сейчас» — они в обычном чек-листе. */
  returnNow: ReadonlySet<string>;
  onToggle: (bookingItemId: string) => void;
  disabled?: boolean;
};

export function PlannedStaysBlock({ stays, items, returnNow, onToggle, disabled = false }: Props) {
  if (stays.length === 0) return null;
  const nameOf = (id: string) => items.find((i) => i.bookingItemId === id)?.equipmentName ?? "Позиция";
  const staying = stays.filter((s) => !returnNow.has(s.bookingItemId));
  const units = staying.reduce((sum, s) => sum + s.quantity, 0);
  // Срок в заголовке — по тому, что остаётся; всё «вернули сейчас» — по всем.
  const shown = staying.length > 0 ? staying : stays;
  const latest = shown.reduce((max, s) => (s.until > max ? s.until : max), shown[0].until);

  return (
    <section
      aria-labelledby="planned-stays-title"
      className="mb-3 overflow-hidden rounded-lg border border-indigo-border bg-indigo-soft"
    >
      <div className="flex items-center justify-between gap-3 px-3 pt-2.5">
        <h3 id="planned-stays-title" className="text-[13px] font-semibold text-indigo">
          По плану у клиента до {formatStayShort(latest)} · оплачено
        </h3>
        <span className="mono-num shrink-0 text-[13px] font-semibold text-indigo">{units} ед.</span>
      </div>
      <p className="px-3 pb-2.5 pt-0.5 text-[12px] leading-snug text-ink-2">
        Взяты дольше брони. Сейчас их не принимаем — перейдут в продолжение за 0 ₽. Привезли раньше — «Вернули сейчас».
      </p>
      <ul className="divide-y divide-border bg-surface">
        {stays.map((s) => {
          const back = returnNow.has(s.bookingItemId);
          return (
            <li key={s.bookingItemId} className="px-3 py-2.5" data-testid="planned-stay">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[14px] font-medium leading-snug text-ink">{nameOf(s.bookingItemId)}</p>
                  <p className="text-[12px] text-ink-3">{s.quantity} шт · по плану</p>
                </div>
                <button
                  type="button"
                  aria-label={`Вернули сейчас: ${nameOf(s.bookingItemId)}`}
                  aria-pressed={back}
                  disabled={disabled}
                  onClick={() => onToggle(s.bookingItemId)}
                  className={`min-h-11 shrink-0 rounded-md border px-3 text-[13px] font-semibold transition-colors disabled:opacity-60 ${
                    back
                      ? "border-emerald bg-emerald text-surface"
                      : "border-border bg-surface text-ink-2 hover:bg-surface-muted"
                  }`}
                >
                  ✓ Вернули сейчас
                </button>
              </div>
              <p className={`mt-1 text-[12px] ${back ? "text-emerald" : "text-indigo"}`}>
                {back
                  ? "Принимаете сейчас — отметьте в чек-листе ниже"
                  : `Вернут ${formatStayWhen(s.until)} · без доплаты`}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Тело `stays` для «Завершить»: всё «по плану», что не «вернули сейчас». */
export function staysPayload(stays: readonly PlannedStay[], returnNow: ReadonlySet<string>) {
  return stays
    .filter((s) => !returnNow.has(s.bookingItemId))
    .map((s) => ({
      bookingItemId: s.bookingItemId,
      quantity: s.quantity,
      until: s.until,
      ...(s.unitIds.length > 0 ? { equipmentUnitIds: [...s.unitIds] } : {}),
    }));
}
