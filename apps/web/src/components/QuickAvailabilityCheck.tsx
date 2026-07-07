"use client";

import { useState } from "react";
import { AvailabilityCheck } from "./AvailabilityCheck";
import { useAvailability } from "@/hooks/useAvailability";
import {
  defaultAvailabilityStart,
  defaultAvailabilityEnd,
} from "@/lib/availabilityConstants";

export function QuickAvailabilityCheck() {
  const [search, setSearch] = useState("");
  const [start, setStart] = useState(defaultAvailabilityStart);
  const [end, setEnd] = useState(defaultAvailabilityEnd);
  const { items, loading, error, check } = useAvailability();

  function handleCheck() {
    void check({ start, end, search });
  }

  return (
    <div className="space-y-3">
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Поиск оборудования..."
        className="w-full border border-border rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-bright/30"
      />

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor="qac-start" className="text-xs text-ink-3 block mb-0.5">Начало</label>
          <input
            id="qac-start"
            type="datetime-local"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="w-full border border-border rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-accent-bright/30"
          />
        </div>
        <div>
          <label htmlFor="qac-end" className="text-xs text-ink-3 block mb-0.5">Конец</label>
          <input
            id="qac-end"
            type="datetime-local"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className="w-full border border-border rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-accent-bright/30"
          />
        </div>
      </div>

      <button
        onClick={handleCheck}
        disabled={loading}
        className="w-full bg-accent-bright hover:bg-accent text-white text-sm py-1.5 rounded disabled:opacity-50 transition-colors"
      >
        {loading ? "Проверяю..." : "Проверить"}
      </button>

      <AvailabilityCheck
        items={items}
        loading={loading}
        error={error}
        onRetry={handleCheck}
        idleHint="Введите название и нажмите Проверить"
        buildBookingHref={(item) =>
          `/bookings/new?start=${start.slice(0, 10)}&end=${end.slice(0, 10)}&equipmentId=${item.equipmentId}`
        }
      />
    </div>
  );
}
