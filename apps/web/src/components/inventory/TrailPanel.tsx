"use client";

/**
 * «Как пропало» (мокап, экран 2 `.how`): брони с позицией в окне между
 * пересчётами и то, как их принимали, — вердикт, совет и выбор брони для
 * «Пропало → потеряшки».
 *
 * Честность важнее уверенности: если по данным нельзя сказать, с какой брони
 * ушло, так и пишем и подсказываем, что изменить в приёмке.
 */

import { useId, useState } from "react";

import { pluralize } from "../../lib/format";
import { fmtDayMonth, fmtRange, RETURN_MODE_LABEL } from "./format";
import type { EquipmentTrail, TrailBooking } from "./types";
import { FOCUS } from "./ui";

/** Сколько броней показывать до «ещё N». */
const TRAIL_PREVIEW = 5;

export const NO_BOOKING = "";

function howReturned(b: TrailBooking): string {
  if (b.returnMode === "KIOSK") return `${RETURN_MODE_LABEL.KIOSK}${b.returnedBy ? ` · ${b.returnedBy}` : ""}`;
  // CONFIRMED с вышедшим сроком: выдачу и возврат никто не отметил.
  if (b.returnMode === "MANUAL" && b.status === "CONFIRMED") return "срок вышел, возврат не отмечен";
  return RETURN_MODE_LABEL[b.returnMode];
}

function remarkOf(b: TrailBooking): { tone: "ok" | "amber" | "muted"; text: string } {
  if (b.returnMode === "OUT") return { tone: "muted", text: "на съёмке" };
  if (b.returnMode !== "KIOSK") return { tone: "amber", text: "без пересчёта" };
  const problems = b.remarks?.problemQty ?? 0;
  const repairs = b.remarks?.repairQty ?? 0;
  if (problems === 0 && repairs === 0) return { tone: "ok", text: "без замечаний" };
  const parts = [
    problems > 0 ? `${problems} в потеряшки` : null,
    repairs > 0 ? `${repairs} в ремонт` : null,
  ].filter(Boolean);
  return { tone: "amber", text: `замечания: ${parts.join(", ")}` };
}

/** Вердикт по следу — простыми словами, без выдуманной уверенности. */
export function trailVerdict(trail: EquipmentTrail, qty: number): { lead: string; rest: string } {
  const out = trail.bookings.filter((b) => b.returnMode === "OUT").length;
  const back = Math.max(0, trail.totalBookings - out);
  const verified = trail.verifiedReturns;
  const unverified = Math.max(0, back - verified);

  if (back === 0) {
    return {
      lead: "В окне нет вернувшихся броней с этой позицией.",
      rest: " Скорее всего, недостача на складе (переложили, не нашли) или это ошибка в учёте.",
    };
  }

  let lead: string;
  if (verified === 0) {
    lead = back === 1 ? "Единственную бронь приняли без пересчёта." : `С пересчётом не принята ни одна бронь из ${back}.`;
  } else {
    const kiosk = verified === 1 ? trail.bookings.find((b) => b.returnMode === "KIOSK") : undefined;
    lead = `С пересчётом ${verified === 1 ? "принята" : "приняты"} ${verified} ${pluralize(verified, "бронь", "брони", "броней")} из ${back}${
      kiosk ? ` (${fmtRange(kiosk.startDate, kiosk.endDate)}, ${remarkOf(kiosk).text})` : ""
    }.`;
  }

  const parts: string[] = [];
  if (verified > 0 && unverified > 0) {
    parts.push(
      unverified === 1
        ? "Ещё одна закрыта отметкой статуса — никто не считал."
        : `Остальные ${unverified} закрыты отметкой статуса — никто не считал.`,
    );
  } else if (verified === 0 && back > 1) {
    parts.push("Все закрыты отметкой статуса — никто не считал.");
  }
  const suggested = trail.suggestedBookingId
    ? trail.bookings.find((b) => b.bookingId === trail.suggestedBookingId)
    : undefined;
  if (suggested) {
    parts.push(`Без пересчёта приняли только «${suggested.projectName}» — вероятнее всего, ${qty} шт ушли с ней.`);
  } else if (unverified > 1) {
    parts.push(`${qty} шт ушли в одной из них или потерялись на складе; точнее по данным не сказать.`);
  } else if (unverified === 0) {
    parts.push("Все брони приняты с пересчётом — пропажа, скорее всего, на складе или в учёте.");
  }
  return { lead, rest: parts.length > 0 ? ` ${parts.join(" ")}` : "" };
}

export interface TrailBind {
  /** Можно ли выбирать бронь (открытая инвентаризация, «Пропало» доступно). */
  editable: boolean;
  value: string;
  busy?: boolean;
  onChange: (bookingId: string) => void;
}

export function TrailPanel({
  trail,
  loading,
  error,
  onRetry,
  qty,
  name,
  bind,
  extraBooking,
}: {
  trail: EquipmentTrail | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  qty: number;
  name: string;
  bind: TrailBind | null;
  /** Бронь, уже привязанная к решению, если её нет в окне следа. */
  extraBooking?: { id: string; projectName: string; clientName: string } | null;
}) {
  const [showAll, setShowAll] = useState(false);
  const selectId = useId();

  if (loading && !trail) {
    return (
      <div className="mx-3.5 mb-3 rounded-lg border border-border px-3 py-3 text-xs text-ink-3" aria-busy="true">
        Собираем брони с этой позицией…
      </div>
    );
  }
  if (error || !trail) {
    return (
      <div className="mx-3.5 mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-rose-border bg-rose-soft px-3 py-2.5 text-xs text-rose">
        <span>{error ?? "След не загружен"}</span>
        <button type="button" onClick={onRetry} className={`rounded-sm font-semibold underline ${FOCUS}`}>
          Повторить
        </button>
      </div>
    );
  }

  const shown = showAll ? trail.bookings : trail.bookings.slice(0, TRAIL_PREVIEW);
  const hiddenLoaded = trail.bookings.slice(shown.length);
  const hiddenKiosk = hiddenLoaded.filter((b) => b.returnMode === "KIOSK").length;
  const beyondLoaded = trail.totalBookings - trail.bookings.length;
  const verdict = trailVerdict(trail, qty);
  const out = trail.bookings.filter((b) => b.returnMode === "OUT").length;
  const unverified = Math.max(0, trail.totalBookings - out - trail.verifiedReturns);
  const windowText = trail.windowIsDefault
    ? "прошлой инвентаризации не было — смотрим 60 дней"
    : `с инвентаризации ${fmtDayMonth(trail.windowFrom)}`;

  const candidates = trail.bookings.filter((b) => b.returnMode === "MANUAL" || b.returnMode === "AUTO");
  const others = trail.bookings.filter((b) => b.returnMode === "KIOSK");
  const inTrail = new Set(trail.bookings.map((b) => b.bookingId));

  return (
    <div className="mx-3.5 mb-3 overflow-hidden rounded-lg border border-border bg-surface" aria-label="Как пропало">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 border-b border-border bg-surface-muted px-3 py-2">
        <h4 className="font-cond text-sm font-bold text-ink">
          Как пропало: {qty} шт · {name}
        </h4>
        <span className="text-[11.5px] text-ink-2">
          {windowText} · {trail.totalBookings} {pluralize(trail.totalBookings, "бронь", "брони", "броней")} с этой позицией
        </span>
      </div>

      {trail.bookings.length === 0 ? (
        <p className="border-b border-border px-3 py-2 text-xs text-ink-3">В окне позицию никто не брал.</p>
      ) : (
        <ul>
          {shown.map((b) => {
            const remark = remarkOf(b);
            return (
              <li
                key={b.bookingId}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5 border-b border-border px-3 py-1.5 text-xs md:grid-cols-[96px_minmax(0,1fr)_54px] lg:grid-cols-[104px_minmax(0,1fr)_64px_minmax(0,190px)_118px] lg:gap-y-0"
              >
                <span className="mono-num col-span-2 whitespace-nowrap text-[11.5px] text-ink-2 md:col-span-1">
                  {fmtRange(b.startDate, b.endDate)}
                </span>
                <span className="min-w-0">
                  <b className="font-semibold text-ink">«{b.projectName}»</b>{" "}
                  <small className="text-ink-3">· {b.clientName}</small>
                </span>
                <span className="mono-num whitespace-nowrap text-right font-semibold text-ink">{b.quantity} шт</span>
                <span className="min-w-0 text-[11.5px] text-ink-2 md:col-start-2 lg:col-start-auto">{howReturned(b)}</span>
                <span
                  className={`whitespace-nowrap text-right text-[11px] font-semibold md:col-start-3 lg:col-start-auto ${
                    remark.tone === "ok" ? "text-emerald" : remark.tone === "amber" ? "text-amber" : "text-ink-3"
                  }`}
                >
                  {remark.text}
                </span>
              </li>
            );
          })}
          {hiddenLoaded.length > 0 && (
            <li className="border-b border-border px-3 py-1.5 text-[11.5px] text-ink-3">
              ещё {hiddenLoaded.length} {pluralize(hiddenLoaded.length, "бронь", "брони", "броней")}
              {hiddenKiosk === 0 ? " — все без пересчёта на приёмке" : ""} ·{" "}
              <button type="button" onClick={() => setShowAll(true)} className={`rounded-sm font-semibold text-accent-bright hover:underline ${FOCUS}`}>
                показать
              </button>
            </li>
          )}
          {showAll && beyondLoaded > 0 && (
            <li className="border-b border-border px-3 py-1.5 text-[11.5px] text-ink-3">
              показаны последние {trail.bookings.length} из {trail.totalBookings}
            </li>
          )}
        </ul>
      )}

      {trail.openProblems.length > 0 && (
        <p className="border-b border-border px-3 py-1.5 text-[11.5px] text-ink-2">
          <span className="font-semibold text-amber">Уже в потеряшках:</span>{" "}
          {trail.openProblems
            .map((p) => `${p.quantity} шт${p.projectName ? ` с «${p.projectName}»` : ""} (${fmtDayMonth(p.createdAt)})`)
            .join("; ")}
        </p>
      )}

      <p className="bg-amber-soft px-3 py-2 text-xs leading-relaxed text-ink">
        <b className="font-semibold">{verdict.lead}</b>
        {verdict.rest}
      </p>

      {unverified > 0 && (
        <p className="flex gap-2 border-t border-dashed border-border-strong px-3 py-2 text-[11.5px] leading-relaxed text-ink-2">
          <svg viewBox="0 0 24 24" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-bright" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v4M12 16h.01" strokeLinecap="round" />
          </svg>
          <span>
            <b className="font-semibold text-ink">Чтобы в следующий раз знать точно</b> — принимайте эту позицию в киоске с
            пересчётом. Тогда недостача всплывёт в день возврата, а виновная бронь будет одна.
          </span>
        </p>
      )}

      {bind && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2 text-[11.5px] text-ink-2">
          <label htmlFor={selectId}>Если в потеряшки — привязать к брони:</label>
          <select
            id={selectId}
            value={bind.value}
            disabled={!bind.editable || bind.busy}
            onChange={(e) => bind.onChange(e.target.value)}
            className={`max-w-full rounded border border-border bg-surface px-2 py-0.5 text-[11.5px] text-ink disabled:opacity-60 sm:max-w-[360px] ${FOCUS}`}
          >
            <option value={NO_BOOKING}>не определено</option>
            {candidates.length > 0 && (
              <optgroup label="Приняты без пересчёта">
                {candidates.map((b) => (
                  <option key={b.bookingId} value={b.bookingId}>
                    «{b.projectName}» · {b.clientName} · {fmtRange(b.startDate, b.endDate)}
                  </option>
                ))}
              </optgroup>
            )}
            {others.length > 0 && (
              <optgroup label="Приняты в киоске">
                {others.map((b) => (
                  <option key={b.bookingId} value={b.bookingId}>
                    «{b.projectName}» · {b.clientName} · {fmtRange(b.startDate, b.endDate)}
                  </option>
                ))}
              </optgroup>
            )}
            {extraBooking && !inTrail.has(extraBooking.id) && (
              <option value={extraBooking.id}>
                «{extraBooking.projectName}» · {extraBooking.clientName}
              </option>
            )}
          </select>
          <span className="text-ink-3">без брони компенсацию выставить будет некому</span>
        </div>
      )}
    </div>
  );
}
