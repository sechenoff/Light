"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "../../lib/api";
import type { EquipmentStatsResponse, PeriodValue } from "./types";

export function useEquipmentStats() {
  const searchParams = useSearchParams();
  const rawPeriod = searchParams.get("period");
  const period: PeriodValue =
    rawPeriod === "30" || rawPeriod === "365" ? rawPeriod : "90";

  const [data, setData] = useState<EquipmentStatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
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

  return { data, error, loading, period };
}
