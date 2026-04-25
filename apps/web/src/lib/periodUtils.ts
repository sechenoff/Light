/**
 * Утилиты для period-selector на финансовых страницах.
 * Все диапазоны вычисляются относительно московского времени.
 */

import { toMoscowDateString, moscowTodayStart, addDays } from "./moscowDate";

export type PeriodKey = "today" | "7d" | "30d" | "month" | "quarter" | "year" | "custom";

export const PERIOD_LABELS: Record<PeriodKey, string> = {
  today: "Сегодня",
  "7d": "7 дней",
  "30d": "30 дней",
  month: "Месяц",
  quarter: "Квартал",
  year: "Год",
  custom: "Период",
};

export const PERIOD_OPTIONS: PeriodKey[] = ["today", "7d", "30d", "month", "quarter", "year"];

export interface PeriodRange {
  from: string; // ISO datetime
  to: string;   // ISO datetime
}

export function derivePeriodRange(period: PeriodKey): PeriodRange {
  const todayStart = moscowTodayStart();
  const tomorrowStart = addDays(todayStart, 1);

  switch (period) {
    case "today":
      return {
        from: todayStart.toISOString(),
        to: new Date(tomorrowStart.getTime() - 1).toISOString(),
      };
    case "7d": {
      const from = addDays(todayStart, -6);
      return {
        from: from.toISOString(),
        to: new Date(tomorrowStart.getTime() - 1).toISOString(),
      };
    }
    case "30d": {
      const from = addDays(todayStart, -29);
      return {
        from: from.toISOString(),
        to: new Date(tomorrowStart.getTime() - 1).toISOString(),
      };
    }
    case "month": {
      const now = new Date();
      const moscowStr = toMoscowDateString(now);
      const [y, m] = moscowStr.split("-").map(Number);
      const monthStart = new Date(`${String(y)}-${String(m).padStart(2, "0")}-01T00:00:00+03:00`);
      const nextMonthStart = new Date(y, m, 1, 0, 0, 0, 0);
      nextMonthStart.setMonth(nextMonthStart.getMonth()); // already set
      const nextMs = m === 12
        ? new Date(`${y + 1}-01-01T00:00:00+03:00`)
        : new Date(`${String(y)}-${String(m + 1).padStart(2, "0")}-01T00:00:00+03:00`);
      return {
        from: monthStart.toISOString(),
        to: new Date(nextMs.getTime() - 1).toISOString(),
      };
    }
    case "quarter": {
      const now = new Date();
      const moscowStr = toMoscowDateString(now);
      const [y, m] = moscowStr.split("-").map(Number);
      const qStart = Math.floor((m - 1) / 3) * 3 + 1;
      const qMs = new Date(`${String(y)}-${String(qStart).padStart(2, "0")}-01T00:00:00+03:00`);
      const qEndMonth = qStart + 3;
      const qEndMs = qEndMonth > 12
        ? new Date(`${y + 1}-01-01T00:00:00+03:00`)
        : new Date(`${String(y)}-${String(qEndMonth).padStart(2, "0")}-01T00:00:00+03:00`);
      return {
        from: qMs.toISOString(),
        to: new Date(qEndMs.getTime() - 1).toISOString(),
      };
    }
    case "year": {
      const now = new Date();
      const moscowStr = toMoscowDateString(now);
      const y = Number(moscowStr.slice(0, 4));
      const yearStart = new Date(`${y}-01-01T00:00:00+03:00`);
      const yearEnd = new Date(`${y + 1}-01-01T00:00:00+03:00`);
      return {
        from: yearStart.toISOString(),
        to: new Date(yearEnd.getTime() - 1).toISOString(),
      };
    }
    default:
      return {
        from: addDays(todayStart, -29).toISOString(),
        to: new Date(tomorrowStart.getTime() - 1).toISOString(),
      };
  }
}
