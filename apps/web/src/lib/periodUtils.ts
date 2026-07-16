/**
 * Утилиты для period-selector на финансовых страницах.
 * Все диапазоны вычисляются относительно московского времени.
 */

import { toMoscowDateString, moscowTodayStart, addDays } from "./moscowDate";

export type PeriodKey = "today" | "7d" | "30d" | "month" | "quarter" | "year" | "all" | "custom";

export const PERIOD_LABELS: Record<PeriodKey, string> = {
  today: "Сегодня",
  "7d": "7 дней",
  "30d": "30 дней",
  month: "Месяц",
  quarter: "Квартал",
  year: "Год",
  all: "Всё время",
  custom: "Период",
};

export const PERIOD_OPTIONS: PeriodKey[] = ["today", "7d", "30d", "month", "quarter", "year", "all"];

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
    case "all": {
      // Очень широкий диапазон: захватывает весь импорт исторических платежей (с 2020-01-01)
      // до конца текущего дня. Используется когда нужно увидеть всё, без фильтра по дате.
      const farPast = new Date("2020-01-01T00:00:00+03:00");
      return {
        from: farPast.toISOString(),
        to: new Date(tomorrowStart.getTime() - 1).toISOString(),
      };
    }
    default:
      return {
        from: addDays(todayStart, -29).toISOString(),
        to: new Date(tomorrowStart.getTime() - 1).toISOString(),
      };
  }
}

/**
 * Диапазон ПРЕДЫДУЩЕГО периода той же длины — для Δ% в KPI («получено vs
 * прошлый период»). Для календарных периодов (месяц/квартал/год) — предыдущая
 * календарная единица; для скользящих (сегодня/7д/30д) — окно той же длины
 * непосредственно перед текущим. Для «всё время» сравнение не имеет смысла — null.
 */
export function derivePreviousPeriodRange(period: PeriodKey): PeriodRange | null {
  if (period === "all" || period === "custom") return null;

  // Календарные периоды: предыдущая календарная единица (сдвиг на длину окна
  // дал бы «31 мая» вместо «1 июня» для июля).
  const moscowStr = toMoscowDateString(new Date());
  const [y, m] = moscowStr.split("-").map(Number);
  const msk = (yy: number, mm: number) =>
    new Date(`${yy}-${String(mm).padStart(2, "0")}-01T00:00:00+03:00`);

  if (period === "month") {
    const prevY = m === 1 ? y - 1 : y;
    const prevM = m === 1 ? 12 : m - 1;
    return {
      from: msk(prevY, prevM).toISOString(),
      to: new Date(msk(y, m).getTime() - 1).toISOString(),
    };
  }
  if (period === "quarter") {
    const qStart = Math.floor((m - 1) / 3) * 3 + 1;
    const prevQStartM = qStart - 3;
    const prevY = prevQStartM < 1 ? y - 1 : y;
    const prevM = prevQStartM < 1 ? prevQStartM + 12 : prevQStartM;
    return {
      from: msk(prevY, prevM).toISOString(),
      to: new Date(msk(qStart === 1 ? y : y, qStart).getTime() - 1).toISOString(),
    };
  }
  if (period === "year") {
    return {
      from: msk(y - 1, 1).toISOString(),
      to: new Date(msk(y, 1).getTime() - 1).toISOString(),
    };
  }

  // Скользящие окна (today/7d/30d): окно той же длины непосредственно перед.
  const cur = derivePeriodRange(period);
  const from = new Date(cur.from);
  const to = new Date(cur.to);
  const lengthMs = to.getTime() - from.getTime() + 1;
  return {
    from: new Date(from.getTime() - lengthMs).toISOString(),
    to: new Date(from.getTime() - 1).toISOString(),
  };
}
