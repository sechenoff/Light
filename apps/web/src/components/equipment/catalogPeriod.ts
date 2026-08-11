// Чистые хелперы периода доступности каталога. Вынесены из app/equipment/page.tsx,
// чтобы арифметику смен можно было тестировать без рендера страницы.

import { pluralize } from "@/lib/format";
import { DEFAULT_PICKUP_HOUR } from "@/lib/availabilityConstants";

/** Смена = 24 ч, как billableShifts24h на бэке (без грейса). */
const MS_PER_SHIFT = 24 * 60 * 60 * 1000;

export type QuickPeriodType = "today" | "tomorrow" | "week";

export type PeriodRange = { start: string; end: string };

export const QUICK_PERIODS: ReadonlyArray<{
  type: QuickPeriodType;
  label: string;
  /** Расшифровка «10-10» — на кнопке её не видно, а вопрос возникает у каждого. */
  hint: string;
}> = [
  { type: "today", label: "Сегодня", hint: "Сегодня 10:00 — завтра 10:00" },
  { type: "tomorrow", label: "Завтра", hint: "Завтра 10:00 — послезавтра 10:00" },
  { type: "week", label: "Неделя", hint: "Понедельник 10:00 — воскресенье 22:00" },
];

function toDatetimeLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day}T${h}:${min}`;
}

export function getQuickPeriod(type: QuickPeriodType, now = new Date()): PeriodRange {
  if (type === "week") {
    // Понедельник 10:00 → воскресенье 22:00 текущей недели.
    const dayOfWeek = now.getDay(); // 0 = воскресенье
    const diffToMon = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + diffToMon,
      DEFAULT_PICKUP_HOUR,
      0,
    );
    const sunday = new Date(monday.getTime() + 6 * MS_PER_SHIFT);
    sunday.setHours(22, 0, 0, 0);
    return { start: toDatetimeLocal(monday), end: toDatetimeLocal(sunday) };
  }
  const offsetDays = type === "tomorrow" ? 1 : 0;
  const s = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + offsetDays,
    DEFAULT_PICKUP_HOUR,
    0,
  );
  return { start: toDatetimeLocal(s), end: toDatetimeLocal(new Date(s.getTime() + MS_PER_SHIFT)) };
}

/** Сдвиг конца периода на N часов — «+1 смена» / «+1 сутки» в редакторе. */
export function shiftEnd(end: string, hours: number): string {
  const d = new Date(end);
  if (Number.isNaN(d.getTime())) return end;
  d.setTime(d.getTime() + hours * 60 * 60 * 1000);
  return toDatetimeLocal(d);
}

/** «11.08 10:00» — компактная подпись на чипе-якоре периода. */
export function formatCompact(dtLocal: string): string {
  const d = new Date(dtLocal);
  if (Number.isNaN(d.getTime())) return "—";
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${day}.${month} ${h}:${min}`;
}

/** «вт 11 авг 10:00» — развёрнутая подпись в строке-подвале. */
export function formatVerbose(dtLocal: string): string {
  const d = new Date(dtLocal);
  if (Number.isNaN(d.getTime())) return "—";
  return d
    .toLocaleString("ru-RU", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    })
    .replace(",", "");
}

export type PeriodSummary = {
  /** «1 смена» / «2 смены» — сколько смен тарифицируется. */
  shiftsLabel: string;
  /** «24 ч» — фактическая длительность. */
  hoursLabel: string;
};

/**
 * Длительность периода. null — когда даты ещё не засеяны (первый кадр)
 * или конец не позже начала: в этом случае подпись не выдумывается.
 */
export function summarizePeriod(start: string, end: string): PeriodSummary | null {
  if (!start || !end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const hours = ms / (60 * 60 * 1000);
  const shifts = Math.ceil(hours / 24);
  return {
    shiftsLabel: `${shifts} ${pluralize(shifts, "смена", "смены", "смен")}`,
    hoursLabel: `${Math.round(hours)} ч`,
  };
}

/** Совпадает ли текущий период с пресетом (подсветка активной кнопки). */
export function matchesPreset(
  start: string,
  end: string,
  type: QuickPeriodType,
  now = new Date(),
): boolean {
  const p = getQuickPeriod(type, now);
  return start === p.start && end === p.end;
}
