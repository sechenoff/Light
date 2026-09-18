/**
 * Подписи и форматирование раздела «Инвентаризация».
 *
 * Словарь — строго по спеке §1: в интерфейсе только русские слова, никаких
 * кодов статусов и решений. Даты и время — по Москве (как весь склад).
 */

import type { StatusPillVariant } from "../StatusPill";
import { pluralize } from "../../lib/format";
import { toMoscowDateString } from "../../lib/moscowDate";
import type {
  Breakdown,
  Decision,
  ReturnMode,
  StockCountLineView,
  StockCountStatus,
  StockCountSummary,
  StockCountTotals,
} from "./types";

// ── Словарь ──────────────────────────────────────────────────────────────────

export const STATUS_LABEL: Record<StockCountStatus, string> = {
  OPEN: "идёт",
  CLOSED: "завершена",
  CANCELLED: "отменена",
};

export const STATUS_VARIANT: Record<StockCountStatus, StatusPillVariant> = {
  OPEN: "info",
  CLOSED: "ok",
  CANCELLED: "none",
};

export const DECISION_LABEL: Record<Decision, string> = {
  LOST: "Пропало → потеряшки",
  ADJUST: "Ошибка учёта",
  FOUND: "Нашлось",
};

export const RESET_LABEL = "Пересчитать";

export const RETURN_MODE_LABEL: Record<ReturnMode, string> = {
  KIOSK: "принято в киоске",
  MANUAL: "возврат отмечен вручную",
  AUTO: "отмечен автоматически",
  OUT: "ещё у клиента",
};

// ── Числа и деньги ───────────────────────────────────────────────────────────

/** Знак минуса — типографский (U+2212), как в мокапе. */
/**
 * Название в «ёлочках» без удвоения: проекты часто уже записаны с кавычками
 * («Северный ветер», „Лето“, "Река") — оборачивать их второй раз нельзя.
 */
export function quoteName(name: string): string {
  const t = name.trim();
  if (/^[«„"“]/.test(t) && /[»“"”]$/.test(t)) return t;
  return `«${t}»`;
}

export function signed(n: number): string {
  if (n > 0) return `+${n}`;
  if (n < 0) return `−${Math.abs(n)}`;
  return "0";
}

/** «6 450» — рубли без копеек, с разрядами. */
export function rubWhole(value: number): string {
  return Math.round(value).toLocaleString("ru-RU");
}

/** Ставка позиции × |расхождение| — «сколько ₽ за смену выпадает из оборота». */
export function ratePerShiftOf(ratePerShift: string, diff: number): number {
  const rate = Number(ratePerShift);
  return Number.isFinite(rate) ? rate * Math.abs(diff) : 0;
}

export function positions(n: number): string {
  return `${n} ${pluralize(n, "позиция", "позиции", "позиций")}`;
}

// ── Даты (Москва) ────────────────────────────────────────────────────────────

const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

function ymd(iso: string): { y: number; m: number; d: number } | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const [y, m, d] = toMoscowDateString(date).split("-").map(Number);
  return { y: y!, m: m!, d: d! };
}

/** «18.09» */
export function fmtDayMonth(iso: string | null | undefined): string {
  if (!iso) return "—";
  const p = ymd(iso);
  if (!p) return "—";
  return `${String(p.d).padStart(2, "0")}.${String(p.m).padStart(2, "0")}`;
}

/** «18.09.2026» */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const p = ymd(iso);
  if (!p) return "—";
  return `${fmtDayMonth(iso)}.${p.y}`;
}

/** «09:30» */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("ru-RU", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** «18.09 в 09:30» */
export function fmtDayTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return `${fmtDayMonth(iso)} в ${fmtTime(iso)}`;
}

/** Период брони: «14–16 сен», «30 авг – 1 сен», «30 дек 2025 – 2 янв 2026». */
export function fmtRange(startIso: string, endIso: string): string {
  const a = ymd(startIso);
  const b = ymd(endIso);
  if (!a || !b) return "—";
  const mon = (m: number) => MONTHS_SHORT[m - 1] ?? "";
  if (a.y !== b.y) return `${a.d} ${mon(a.m)} ${a.y} – ${b.d} ${mon(b.m)} ${b.y}`;
  if (a.m !== b.m) return `${a.d} ${mon(a.m)} – ${b.d} ${mon(b.m)}`;
  if (a.d !== b.d) return `${a.d}–${b.d} ${mon(a.m)}`;
  return `${a.d} ${mon(a.m)}`;
}

// ── Инвентаризация целиком ───────────────────────────────────────────────────

/** Охват: «весь склад» или перечень категорий. */
export function scopeLabel(categories: string[] | null): string {
  if (!categories || categories.length === 0) return "весь склад";
  if (categories.length <= 2) return categories.join(", ");
  return `${categories.length} ${pluralize(categories.length, "категория", "категории", "категорий")}`;
}

/** Строка под заголовком: когда, охват, кто. */
export function stockCountSubline(sc: StockCountSummary): string {
  const scope = scopeLabel(sc.categories);
  if (sc.status === "CLOSED") {
    return `завершена ${fmtDayTime(sc.closedAt)}${sc.closedByName ? ` · ${sc.closedByName}` : ""} · ${scope}`;
  }
  if (sc.status === "CANCELLED") {
    return `отменена ${fmtDayTime(sc.cancelledAt)} · ${scope} · в учёт ничего не записано`;
  }
  return `${scope} · начата ${fmtDayTime(sc.startedAt)} · ${sc.createdByName}`;
}

/** Расхождений всего (позиций). */
export function discrepancyCount(totals: StockCountTotals): number {
  return totals.shortagePositions + totals.surplusPositions;
}

// ── Строка ───────────────────────────────────────────────────────────────────

/**
 * Решение, которое завершение применит: знак должен подходить расхождению
 * (зеркало `decisionFits` на сервере). «Пропало» у строки, ушедшей в излишек
 * после пересчёта, считается отсутствующим.
 */
export function effectiveDecision(line: Pick<StockCountLineView, "decision" | "diff">): Decision | null {
  const { decision, diff } = line;
  if (!decision || diff == null || diff === 0) return null;
  if (decision === "ADJUST") return decision;
  if (decision === "LOST" && diff < 0) return decision;
  if (decision === "FOUND" && diff > 0) return decision;
  return null;
}

/** Расхождение ждёт решения (зеркало `isUndecided`: штучные строки не ждут). */
export function isLineUndecided(line: StockCountLineView): boolean {
  if (line.diff == null || line.diff === 0) return false;
  if (line.allowedDecisions.length === 0) return false;
  return effectiveDecision(line) == null;
}

/**
 * Пояснение к «на полке должно быть»: почему ожидание меньше учёта.
 * amber — брони по календарю (подтверждены, но не отмечены выданными),
 * остальное — приглушённо.
 */
export interface ExpectationNote {
  tone: "amber" | "muted";
  text: string;
}

export function expectationNotes(line: StockCountLineView, showZeroIssued = false): ExpectationNote[] {
  const b: Breakdown = line.expected;
  const notes: ExpectationNote[] = [];
  if (b.calendar > 0) {
    const named = line.calendarBookings.filter((c) => c.quantity > 0);
    if (named.length === 1) {
      notes.push({
        tone: "amber",
        text: `${named[0]!.quantity} по календарю у ${quoteName(named[0]!.projectName)} — бронь подтверждена, но не отмечена выданной`,
      });
    } else if (named.length > 1) {
      const list = named.map((c) => `${c.quantity} у ${quoteName(c.projectName)}`).join(", ");
      notes.push({
        tone: "amber",
        text: `по календарю: ${list} — брони подтверждены, но не отмечены выданными`,
      });
    } else {
      notes.push({
        tone: "amber",
        text: `${b.calendar} по календарю на съёмке — бронь подтверждена, но не отмечена выданной`,
      });
    }
  }
  if (b.issued > 0 || showZeroIssued) notes.push({ tone: "muted", text: `на съёмках — ${b.issued}` });
  if (b.repair > 0) notes.push({ tone: "muted", text: `${b.repair} в мастерской` });
  if (b.lost > 0) notes.push({ tone: "muted", text: `${b.lost} в потеряшках` });
  return notes;
}
