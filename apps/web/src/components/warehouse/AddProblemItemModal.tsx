"use client";

/**
 * «Завести потеряшку» — ручной вход в реестр (мокап concept-a-reestr.html,
 * врезка 1; без «Ищет» и «Объявить в поиск» — вне релиза).
 *
 * Пропажу замечают не только на приёмке: на полке, при погрузке, по звонку
 * гаффера. Три шага:
 *  1. Что пропало — поиск позиции, наличие по учёту (та же формула, что у
 *     календаря и инвентаризации) и количество не больше «должно быть на
 *     полке»; у штучной позиции — выбор единицы.
 *  2. Что случилось — причина и «где видели в последний раз»: вернувшиеся брони
 *     окна с прошлой сверки, с подсказкой сервера. Брони на съёмке не
 *     предлагаются: их пропажу отметит приёмка (сервер: BOOKING_STILL_OUT).
 *  3. Детали — обязательный комментарий и «ожидается к» для «Остался на площадке».
 *
 * Сеть: GET /api/equipment?search=, GET /api/problem-items/trail,
 * GET /api/equipment/:id/units, POST /api/problem-items. Штрихкодов нет нигде:
 * единицы называются серийным номером или порядковым «ед. N».
 *
 * Overlay-канон ResolveProblemModal / RejectBookingModal: Esc и клик по фону
 * закрывают, фокус-ловушка, фокус в первое поле, возврат фокуса, scroll-lock.
 * Шаги и загрузка данных позиции — в AddProblemItemParts.tsx.
 */

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { apiFetch } from "../../lib/api";
import { toast } from "../ToastProvider";
import type { EquipmentSearchItem } from "../repair/types";
import {
  COMMENT_MIN,
  FIELD,
  MINI,
  NO_BOOKING,
  PickedPosition,
  PositionSearch,
  ReasonChips,
  Step,
  TrailRadios,
  bareDateToIso,
  errorCode,
  errorDetails,
  errorMessage,
  isPickableBooking,
  usePositionData,
} from "./AddProblemItemParts";
import type { ManualProblemPayload, ProblemItemReason, ProblemRegistryItem } from "./types";

export { formatTrailDates, trailRowNote } from "./AddProblemItemParts";

interface SubmitError {
  message: string;
  stockCountId?: string;
}

/** Ошибка сервера → понятный текст (и ссылка в инвентаризацию, если она мешает). */
function explainSubmitError(e: unknown): SubmitError {
  const code = errorCode(e);
  const details = errorDetails(e);
  if (code === "QUANTITY_EXCEEDS_SHELF") {
    const onShelf = typeof details.expected === "number" ? details.expected : null;
    if (onShelf === 0) {
      return { message: "По учёту на полке этой позиции уже нет — заводить пропажу не из чего." };
    }
    return {
      message: `Больше, чем должно лежать на полке${onShelf !== null ? `: по учёту там ${onShelf}` : ""}. Наличие обновлено.`,
    };
  }
  if (code === "STOCK_COUNT_LINE_COUNTED") {
    const number = details.stockCountNumber;
    return {
      message: `Позиция уже посчитана в идущей инвентаризации${typeof number === "number" ? ` № ${number}` : ""} — отметьте недостачу там.`,
      stockCountId: typeof details.stockCountId === "string" ? details.stockCountId : undefined,
    };
  }
  if (code === "UNIT_ALREADY_MISSING") {
    return { message: "Эта единица уже числится пропавшей или списанной — выберите другую." };
  }
  if (code === "UNIT_IN_REPAIR") {
    return { message: "Эта единица в мастерской — спишите её через ремонт или сначала закройте ремонт." };
  }
  if (code === "UNIT_ISSUED") {
    return { message: "Единица на съёмке — пропажу отметят на приёмке." };
  }
  if (code === "BOOKING_STILL_OUT") {
    return { message: "Бронь ещё на съёмке — пропажу по ней отметят на приёмке." };
  }
  return { message: errorMessage(e, "Не удалось завести потеряшку") };
}

/** Коды, после которых наличие, след или единицы на экране устарели — перечитываем. */
const STALE_DATA_CODES = new Set([
  "QUANTITY_EXCEEDS_SHELF",
  "UNIT_ALREADY_MISSING",
  "UNIT_IN_REPAIR",
  "UNIT_ISSUED",
  "BOOKING_STILL_OUT",
]);
/** Коды, после которых выбранная единица больше не годится — выбор снимаем. */
const UNIT_RESET_CODES = new Set(["UNIT_ALREADY_MISSING", "UNIT_IN_REPAIR", "UNIT_ISSUED"]);

/** Esc, scroll-lock и возврат фокуса на кнопку, открывшую модалку. */
function useOverlay(open: boolean, busy: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  useEffect(() => {
    if (!open) return;
    const prevFocused = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
      prevFocused?.focus?.();
    };
  }, [open]);
}

/** Фокус-ловушка без зависимостей: Tab / Shift+Tab по кругу внутри диалога. */
function trapFocus(e: React.KeyboardEvent<HTMLDivElement>, dialog: HTMLDivElement | null) {
  if (e.key !== "Tab" || !dialog) return;
  const focusables = dialog.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select, [tabindex]:not([tabindex="-1"])',
  );
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const activeEl = document.activeElement as HTMLElement | null;
  if (e.shiftKey && (activeEl === first || activeEl === dialog)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && activeEl === last) {
    e.preventDefault();
    first.focus();
  }
}

export function AddProblemItemModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** После успешного создания — страница перечитывает реестр. */
  onCreated: (item: ProblemRegistryItem) => void;
}) {
  const uid = useId();
  const titleId = `${uid}-title`;
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const [picked, setPicked] = useState<EquipmentSearchItem | null>(null);
  const [nonce, setNonce] = useState(0);
  const { trail, trailState, units, unitsState } = usePositionData(picked, nonce);
  const [unitId, setUnitId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);

  const [reason, setReason] = useState<ProblemItemReason>("NOT_ON_SHELF");
  const [bookingChoice, setBookingChoice] = useState<string>(NO_BOOKING);
  const [comment, setComment] = useState("");
  const [expectedDate, setExpectedDate] = useState("");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<SubmitError | null>(null);

  const reset = useCallback(() => {
    setPicked(null);
    setUnitId(null);
    setQuantity(1);
    setReason("NOT_ON_SHELF");
    setBookingChoice(NO_BOOKING);
    setComment("");
    setExpectedDate("");
    setError(null);
  }, []);

  // Открытие: чистый лист + фокус в поиск (первое поле).
  useEffect(() => {
    if (!open) return;
    reset();
    const t = setTimeout(() => searchRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [open, reset]);

  useOverlay(open, saving, onClose);

  // Пришло наличие: количество — в пределах полки, бронь — подсказка сервера,
  // если человек ещё не выбрал другую из этого же следа. Выбор, который за это
  // время уехал на съёмку, не держим: такую привязку сервер отклонит.
  useEffect(() => {
    if (!trail) return;
    setQuantity((q) => Math.max(1, Math.min(q, trail.onShelf.expected)));
    setBookingChoice((prev) => {
      if (prev !== NO_BOOKING && isPickableBooking(trail, prev)) return prev;
      const suggested = trail.suggestedBookingId;
      return suggested && isPickableBooking(trail, suggested) ? suggested : NO_BOOKING;
    });
  }, [trail]);

  if (!open) return null;

  const isUnitMode = picked?.stockTrackingMode === "UNIT";
  const qty = isUnitMode ? 1 : quantity;
  const commentLen = comment.trim().length;
  const positionReady =
    picked !== null && (isUnitMode ? unitId !== null : trail !== null && trail.onShelf.expected >= 1);
  const canSubmit = positionReady && commentLen >= COMMENT_MIN && !saving;

  function pick(e: EquipmentSearchItem) {
    setPicked(e);
    setUnitId(null);
    setQuantity(1);
    setBookingChoice(NO_BOOKING);
    setError(null);
  }

  function unpick() {
    setPicked(null);
    setUnitId(null);
    setError(null);
    setTimeout(() => searchRef.current?.focus(), 0);
  }

  function chooseReason(next: ProblemItemReason) {
    setReason(next);
    // «Ожидается к» имеет смысл только для «Остался на площадке».
    if (next !== "LEFT_ON_SITE") setExpectedDate("");
  }

  function buildPayload(position: EquipmentSearchItem): ManualProblemPayload {
    return {
      equipmentId: position.id,
      ...(isUnitMode && unitId ? { equipmentUnitId: unitId } : { quantity }),
      reason,
      comment: comment.trim(),
      ...(reason === "LEFT_ON_SITE" && expectedDate ? { expectedBackDate: bareDateToIso(expectedDate) } : {}),
      sourceBookingId: bookingChoice === NO_BOOKING ? null : bookingChoice,
    };
  }

  async function handleSubmit() {
    if (!canSubmit || !picked) return;
    setSaving(true);
    setError(null);
    try {
      const { item } = await apiFetch<{ item: ProblemRegistryItem }>("/api/problem-items", {
        method: "POST",
        body: JSON.stringify(buildPayload(picked)),
      });
      toast.success(`Потеряшка заведена: ${picked.name}${qty > 1 ? ` ×${qty}` : ""}`);
      onCreated(item);
      onClose();
    } catch (e: unknown) {
      setError(explainSubmitError(e));
      const code = errorCode(e);
      if (code && STALE_DATA_CODES.has(code)) {
        // Пока модалка была открыта, полка, бронь или единица изменились.
        if (UNIT_RESET_CODES.has(code)) setUnitId(null);
        setNonce((n) => n + 1);
      }
    } finally {
      setSaving(false);
    }
  }

  const footerNote = !picked ? (
    "Карточка встанет в реестр сразу — с источником «вручную»."
  ) : reason === "DESTROYED" ? (
    <>
      Позиция спишется: доступность уменьшится на <b className="font-semibold text-ink">{qty}</b> — календарь
      перестанет её продавать.
    </>
  ) : (
    <>
      Доступность позиции уменьшится на <b className="font-semibold text-ink">{qty}</b> до закрытия дела —
      календарь перестанет её продавать.
    </>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-scrim/40 px-4 py-6"
      onClick={() => !saving && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-[660px] overflow-hidden rounded-lg border border-border-strong bg-surface shadow-lg"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => trapFocus(e, dialogRef.current)}
      >
        <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <h3 id={titleId} className="font-cond text-[15px] font-bold text-ink">
            Завести потеряшку
          </h3>
          <span className="whitespace-nowrap rounded-[3px] border border-dashed border-border-strong px-1 font-cond text-[9.5px] font-semibold uppercase leading-[1.7] tracking-[0.05em] text-ink-3">
            вручную
          </span>
          <button
            type="button"
            aria-label="Закрыть"
            onClick={onClose}
            disabled={saving}
            className="ml-auto flex h-9 w-9 lg:h-7 lg:w-7 items-center justify-center rounded text-ink-3 hover:bg-surface-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-bright"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current stroke-2">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </header>

        <Step n="1" title="Что пропало" done={positionReady}>
          {picked ? (
            <PickedPosition
              picked={picked}
              trail={trail}
              trailState={trailState}
              units={units}
              unitsState={unitsState}
              unitId={unitId}
              quantity={quantity}
              onUnpick={unpick}
              onRetry={() => setNonce((n) => n + 1)}
              onUnitChange={setUnitId}
              onQuantityChange={setQuantity}
            />
          ) : (
            <PositionSearch inputRef={searchRef} onPick={pick} />
          )}
        </Step>

        <Step n="2" title="Что случилось" done={picked !== null}>
          <ReasonChips value={reason} onChange={chooseReason} />
          {trail ? (
            <TrailRadios trail={trail} value={bookingChoice} onChange={setBookingChoice} name={`${uid}-booking`} />
          ) : (
            <p className="mt-2 text-[11.5px] text-ink-3">
              {picked
                ? "Загружаем, где позицию видели в последний раз…"
                : "Выберите позицию — покажем, где её видели в последний раз."}
            </p>
          )}
        </Step>

        <Step n="3" title="Детали" done={commentLen >= COMMENT_MIN}>
          <label htmlFor={`${uid}-comment`} className="mb-1 block text-[11.5px] font-semibold text-ink-2">
            Комментарий <span className="text-rose">*</span>
          </label>
          <textarea
            id={`${uid}-comment`}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            maxLength={2000}
            disabled={saving}
            className={`${FIELD} resize-y`}
            placeholder="Что и где заметили: «при сверке в кейсе один набор вместо двух»"
          />
          <p className={`mt-0.5 text-[11px] ${commentLen >= COMMENT_MIN ? "text-ink-3" : "text-ink-2"}`}>
            {commentLen >= COMMENT_MIN ? `${commentLen} / 2000` : "обязательно — не короче 3 символов"}
          </p>
          {reason === "LEFT_ON_SITE" && (
            <div className="mt-2">
              <label htmlFor={`${uid}-date`} className="mb-1 block text-[11.5px] font-semibold text-ink-2">
                Ожидается к <span className="font-normal text-ink-3">— когда обещали привезти, если знаете</span>
              </label>
              <input
                id={`${uid}-date`}
                type="date"
                value={expectedDate}
                onChange={(e) => setExpectedDate(e.target.value)}
                disabled={saving}
                className={`${FIELD} max-w-[200px]`}
              />
            </div>
          )}
        </Step>

        {error && (
          <div role="alert" className="flex flex-wrap items-center gap-2 bg-rose-soft px-4 py-2 text-xs text-rose">
            <span>{error.message}</span>
            {error.stockCountId && (
              <Link
                href={`/warehouse/inventory/${error.stockCountId}`}
                className="ml-auto whitespace-nowrap font-semibold underline"
              >
                Открыть инвентаризацию →
              </Link>
            )}
          </div>
        )}

        <footer className="flex flex-wrap items-center gap-x-3.5 gap-y-2 border-t border-border bg-surface-muted px-4 py-2.5">
          <p className="min-w-0 flex-[1_1_260px] text-[11.5px] text-ink-2">{footerNote}</p>
          <div className="ml-auto flex gap-2">
            <button type="button" onClick={onClose} disabled={saving} className={MINI}>
              Отмена
            </button>
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={!canSubmit}
              className="inline-flex min-h-10 items-center rounded border border-accent-bright bg-accent-bright px-4 py-1 text-xs font-semibold text-surface lg:min-h-0 lg:px-3 transition-colors hover:border-accent hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-bright focus-visible:ring-offset-2 disabled:opacity-50"
            >
              {saving ? "Сохраняем…" : "Завести потеряшку"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
