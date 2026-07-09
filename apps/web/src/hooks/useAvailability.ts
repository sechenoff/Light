"use client";

import { useState, useCallback, useRef } from "react";
import { apiFetch } from "@/lib/api";

export type AvailabilityStatus = "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";

export type AvailabilityItem = {
  equipmentId: string;
  name: string;
  availability: AvailabilityStatus;
  occupiedQuantity: number;
  availableQuantity: number;
  totalQuantity: number;
};

export type AvailabilityCheckParams = {
  /** datetime-local ("YYYY-MM-DDTHH:mm") или ISO — нормализуется через new Date(). */
  start: string;
  end: string;
  search?: string;
  category?: string;
  /** Исключить бронь из расчёта занятости (при редактировании). */
  excludeBookingId?: string;
};

/**
 * Единая точка обращения к GET /api/availability. Ручной триггер через check() —
 * подходит и для кнопки «Проверить» (виджет), и для useEffect (каталог/форма).
 * Заменяет три параллельные реализации fetch-логики доступности.
 */
export function useAvailability() {
  const [items, setItems] = useState<AvailabilityItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Стале-гард: при быстрой смене дат (useEffect-потребители) применяется
  // только ответ последнего check() — устаревший не затирает свежий.
  const requestIdRef = useRef(0);

  const check = useCallback(
    async (params: AvailabilityCheckParams): Promise<AvailabilityItem[] | null> => {
      const requestId = ++requestIdRef.current;
      setLoading(true);
      setError(null);
      try {
        const startIso = new Date(params.start).toISOString();
        const endIso = new Date(params.end).toISOString();
        const qs = new URLSearchParams({ start: startIso, end: endIso });
        if (params.search?.trim()) qs.set("search", params.search.trim());
        if (params.category?.trim()) qs.set("category", params.category.trim());
        if (params.excludeBookingId) qs.set("excludeBookingId", params.excludeBookingId);
        const data = await apiFetch<{ rows: AvailabilityItem[] }>(
          `/api/availability?${qs.toString()}`
        );
        if (requestId !== requestIdRef.current) return null; // устаревший ответ
        setItems(data.rows);
        return data.rows;
      } catch (e) {
        if (requestId !== requestIdRef.current) return null;
        setError(e instanceof Error ? e.message : "Ошибка при проверке доступности");
        return null;
      } finally {
        if (requestId === requestIdRef.current) setLoading(false);
      }
    },
    []
  );

  return { items, loading, error, check };
}
