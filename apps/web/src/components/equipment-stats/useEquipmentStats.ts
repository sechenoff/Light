"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "../../lib/api";
import { parsePeriod, type EquipmentStatsResponse } from "./types";

export function useEquipmentStats() {
  const searchParams = useSearchParams();
  const period = parsePeriod(searchParams.get("period"));

  const [data, setData] = useState<EquipmentStatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<EquipmentStatsResponse>(`/api/equipment-stats?period=${period}`)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Не удалось загрузить статистику");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [period]);

  useEffect(() => load(), [load]);

  const retry = useCallback(() => {
    load();
  }, [load]);

  return { data, error, loading, period, retry };
}
