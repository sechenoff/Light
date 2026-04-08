"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { DayPicker } from "react-day-picker";
import "react-day-picker/style.css";
import { ru } from "date-fns/locale";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { apiFetch } from "../lib/api";

type OccupancyDay = {
  date: string;
  occupancyPercent: number;
  bookingCount: number;
};

type OccupancyResponse = {
  days: OccupancyDay[];
};

function getDayColor(percent: number): string {
  if (percent === 0) return "";
  if (percent < 50) return "bg-green-100";
  if (percent < 80) return "bg-amber-100";
  return "bg-rose-100";
}

export function MiniCalendar() {
  const router = useRouter();
  const [month, setMonth] = useState<Date>(new Date());
  const [occupancyMap, setOccupancyMap] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);

  const fetchOccupancy = useCallback(async (targetMonth: Date, signal: AbortSignal) => {
    setLoading(true);
    try {
      const start = format(startOfMonth(targetMonth), "yyyy-MM-dd");
      const end = format(endOfMonth(targetMonth), "yyyy-MM-dd");
      const data = await apiFetch<OccupancyResponse>(
        `/api/calendar/occupancy?start=${start}&end=${end}`,
        { signal }
      );
      const map: Record<string, number> = {};
      for (const d of data.days) {
        map[d.date] = d.occupancyPercent;
      }
      setOccupancyMap(map);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      // Не показываем ошибку — просто нет данных
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchOccupancy(month, controller.signal);
    return () => controller.abort();
  }, [month, fetchOccupancy]);

  return (
    <div className="relative">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/60 z-10 rounded">
          <div className="w-5 h-5 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin" />
        </div>
      )}
      <DayPicker
        locale={ru}
        month={month}
        onMonthChange={setMonth}
        showOutsideDays={false}
        onDayClick={(day) => {
          router.push(`/calendar?date=${format(day, "yyyy-MM-dd")}`);
        }}
        components={{
          DayButton: ({ day, ...props }) => {
            const dateKey = format(day.date, "yyyy-MM-dd");
            const percent = occupancyMap[dateKey] ?? 0;
            const colorClass = getDayColor(percent);
            return (
              <button
                {...props}
                className={[
                  props.className,
                  colorClass,
                  "rounded transition-colors",
                ]
                  .filter(Boolean)
                  .join(" ")}
              />
            );
          },
        }}
        classNames={{
          root: "text-sm",
          month_caption: "text-xs font-semibold text-slate-700 mb-1",
          nav: "flex items-center gap-1",
          day: "text-center",
        }}
      />
    </div>
  );
}
