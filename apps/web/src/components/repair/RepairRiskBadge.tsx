"use client";

/**
 * Мелкие общие элементы раздела «Мастерская»: иконки, пилюли и — главное —
 * плашка риска.
 *
 * Плашка отвечает на вопрос «сорвёт ли эта поломка съёмку» тремя разными
 * ответами, а не одним флажком «конфликт»: «подмены нет и не успеваем»,
 * «подмены нет, но успеваем» и «подмена есть» — это три разных решения для
 * человека, и выглядеть они обязаны по-разному.
 */

import { pluralize } from "../../lib/format";
import {
  REPAIR_STATUS_LABEL,
  REPAIR_STATUS_PILL,
  formatDayMonth,
  type RepairListItem,
  type RepairStatus,
  type RepairRisk,
} from "./types";

// ── Иконки ───────────────────────────────────────────────────────────────────

export type RepairIconName =
  | "alert"
  | "arrow"
  | "block"
  | "check"
  | "pause"
  | "clock"
  | "cam"
  | "wrench"
  | "user"
  | "plus"
  | "rub"
  | "search"
  | "x"
  | "chev"
  | "box"
  | "hist";

const ICON_PATHS: Record<RepairIconName, JSX.Element> = {
  alert: (
    <>
      <path d="M8 2.4 1.6 13.2h12.8z" />
      <path d="M8 6.3v3.3M8 11.5h.01" />
    </>
  ),
  arrow: (
    <>
      <path d="M2.6 8h10.8" />
      <path d="M9.4 4l4 4-4 4" />
    </>
  ),
  block: (
    <>
      <circle cx="8" cy="8" r="5.9" />
      <path d="M3.9 3.9l8.2 8.2" />
    </>
  ),
  check: <path d="M2.8 8.4l3.3 3.3 7.1-7.4" />,
  pause: (
    <>
      <rect x="3.2" y="2.8" width="3.4" height="10.4" rx="1" />
      <rect x="9.4" y="2.8" width="3.4" height="10.4" rx="1" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="5.9" />
      <path d="M8 4.6V8l2.4 1.7" />
    </>
  ),
  cam: (
    <>
      <path d="M1.9 5.2h2.6l1-1.6h5l1 1.6h2.6v7.2H1.9z" />
      <circle cx="8" cy="8.6" r="2.2" />
    </>
  ),
  wrench: (
    <path d="M10.5 2.4a3.6 3.6 0 0 0-4.3 4.6l-3.6 3.6a1.45 1.45 0 0 0 2.05 2.05l3.6-3.6a3.6 3.6 0 0 0 4.6-4.3l-2 2-1.85-.5-.5-1.85z" />
  ),
  user: (
    <>
      <circle cx="8" cy="5.4" r="2.6" />
      <path d="M2.9 13.6c.7-2.6 2.7-3.9 5.1-3.9s4.4 1.3 5.1 3.9" />
    </>
  ),
  plus: <path d="M8 3.4v9.2M3.4 8h9.2" />,
  rub: (
    <>
      <path d="M5.6 13.4V3.1h3.3a2.75 2.75 0 0 1 0 5.5H5.6" />
      <path d="M4 10.9h4.6" />
    </>
  ),
  search: (
    <>
      <circle cx="7.1" cy="7.1" r="4.5" />
      <path d="M10.4 10.4l3 3" />
    </>
  ),
  x: <path d="M4 4l8 8M12 4l-8 8" />,
  chev: <path d="M6 3.6L10.4 8 6 12.4" />,
  box: (
    <>
      <path d="M2.4 4.9 8 2.2l5.6 2.7v6.2L8 13.8l-5.6-2.7z" />
      <path d="M2.4 4.9 8 7.6l5.6-2.7M8 7.6v6.2" />
    </>
  ),
  hist: (
    <>
      <path d="M2.6 8a5.4 5.4 0 1 0 1.6-3.8" />
      <path d="M2.3 2.6v3.1h3.1" />
      <path d="M8 5.2V8l2 1.4" />
    </>
  ),
};

export function RepairIcon({
  name,
  className = "",
  large = false,
}: {
  name: RepairIconName;
  className?: string;
  large?: boolean;
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={`${large ? "h-[17px] w-[17px]" : "h-[13px] w-[13px]"} shrink-0 fill-none stroke-current ${className}`}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

// ── Пилюли ───────────────────────────────────────────────────────────────────

const PILL_BASE =
  "inline-flex items-center gap-1 rounded border px-[7px] py-px text-[11px] font-semibold leading-[1.55] whitespace-nowrap";

export function RepairStatusPill({ status }: { status: RepairStatus }) {
  return (
    <span className={`${PILL_BASE} ${REPAIR_STATUS_PILL[status]}`}>
      {REPAIR_STATUS_LABEL[status]}
    </span>
  );
}

export function UrgencyPill({ urgency }: { urgency: RepairListItem["urgency"] }) {
  if (urgency !== "URGENT") return null;
  return (
    <span className={`${PILL_BASE} bg-rose-soft text-rose border-rose-border`}>Срочно</span>
  );
}

/** «N шт» рядом с названием — у позиций без штучного учёта ломается сразу несколько. */
export function QuantityTag({ quantity }: { quantity: number }) {
  if (quantity <= 1) return null;
  return (
    <span className="mono-num rounded border border-border bg-surface-subtle px-1.5 text-[11px] font-semibold leading-[1.7] text-ink-2">
      {quantity} шт
    </span>
  );
}

/**
 * Откуда взято название. Если позиция не штучная, названия единицы нет — и это
 * надо честно сказать, иначе человек ищет в мастерской конкретный прибор.
 */
export function TitleSourceTag({ source }: { source: RepairListItem["titleSource"] }) {
  if (source === "unit" || source === "gone") return null;
  const label = source === "estimate" ? "название из сметы" : "название из каталога";
  return (
    <span
      title={
        source === "estimate"
          ? "Название взято из строки сметы: экземпляров у позиции нет"
          : "Название взято из каталога: экземпляров у позиции нет"
      }
      className="rounded-[3px] border border-dashed border-border-strong px-1 font-cond text-[9.5px] font-semibold uppercase leading-[1.7] tracking-[0.05em] text-ink-3"
    >
      {label}
    </span>
  );
}

// ── Плашка риска ─────────────────────────────────────────────────────────────

const CONF_BASE = "flex items-start gap-1.5 rounded border px-2 py-1 text-xs leading-[1.45]";

function shortfallText(risk: RepairRisk): string {
  return `не хватает ${risk.shortfall} шт`;
}

/** «13 авг, Клип «Валя Карнавал», Марина Дробыш» — кому именно звонить. */
function bookingText(risk: RepairRisk): string {
  if (!risk.booking) return "";
  return `${formatDayMonth(risk.booking.startDate)}, ${risk.booking.projectName}, ${risk.booking.clientName}`;
}

export function RepairRiskBadge({
  repair,
  compact = false,
}: {
  repair: RepairListItem;
  /** На телефоне и в хвосте очереди печатаем короткую версию без цифр парка. */
  compact?: boolean;
}) {
  const { risk } = repair;

  if (risk.level === "BLOCKS") {
    const late =
      risk.slackDays !== null && risk.slackDays < 0 ? Math.abs(risk.slackDays) : null;
    return (
      <p className={`${CONF_BASE} border-rose-border bg-rose-soft text-rose`}>
        <RepairIcon name="block" className="mt-0.5" />
        <span>
          <b className="font-bold">Подмены нет</b> — {bookingText(risk)}
          <span className="font-normal text-ink-2">
            , {shortfallText(risk)}
            {!compact &&
              `: в парке ${risk.inPark}, в ремонте ${risk.inRepair}, забронировано ${risk.booked}`}
            {late !== null && repair.expectedReadyAt
              ? `. Обещан к ${formatDayMonth(repair.expectedReadyAt)} — на ${late} ${pluralize(late, "день", "дня", "дней")} позже брони.`
              : ""}
          </span>
        </span>
      </p>
    );
  }

  if (risk.level === "TIGHT") {
    const slack = risk.slackDays ?? 0;
    return (
      <p className={`${CONF_BASE} border-rose-border bg-rose-soft text-rose`}>
        <RepairIcon name="block" className="mt-0.5" />
        <span>
          <b className="font-bold">Подмены нет</b> — {bookingText(risk)}
          <span className="font-normal text-ink-2">, {shortfallText(risk)}.</span>{" "}
          <span className="font-semibold text-emerald">
            Успеваем: ремонт до {formatDayMonth(repair.expectedReadyAt)}, запас {slack}{" "}
            {pluralize(slack, "день", "дня", "дней")}.
          </span>
        </span>
      </p>
    );
  }

  // COVERED / NONE — тихое зелёное. Экран не должен кричать там, где всё в порядке.
  const hasSpares = risk.sparesLeft > 0;
  return (
    <p className={`${CONF_BASE} border-emerald-border bg-emerald-soft text-emerald`}>
      <RepairIcon name="check" className="mt-0.5" />
      {hasSpares ? (
        <span>
          <b className="font-bold">Подмена есть</b> — в парке ещё {risk.sparesLeft}
          {!compact && (
            <span className="text-emerald">
              {risk.booking
                ? `, ближайшая бронь ${formatDayMonth(risk.booking.startDate)} берёт ${risk.booked}`
                : ", броней на ближайшие 30 дней нет"}
            </span>
          )}
        </span>
      ) : (
        <span>
          <b className="font-bold">Броней на ближайшие 30 дней нет</b>
          {!compact && <span className="text-emerald"> — свободных в парке не осталось</span>}
        </span>
      )}
    </p>
  );
}
