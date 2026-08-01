"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

import { apiFetch } from "../../lib/api";
import { parseFleetPeriod, type FleetDashboardResponse } from "./types";

/**
 * Данные витрины автопарка. Период живёт в URL (?period=30|90|365) — как в
 * «Статистике техники», чтобы ссылку можно было переслать.
 */
export function useFleetDashboard() {
  const searchParams = useSearchParams();
  const period = parseFleetPeriod(searchParams.get("period"));

  const [data, setData] = useState<FleetDashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<FleetDashboardResponse>(
      `/api/vehicles/fleet/dashboard?period=${period}&includeInactive=1`,
    )
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Не удалось загрузить автопарк");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [period]);

  useEffect(() => load(), [load]);

  return { data, error, loading, period, reload: load };
}
