"use client";
import { useEffect, useState } from "react";
import { lkApi } from "../lib/lkApi";
import type { LkMe } from "../lib/lkTypes";

export function useLkSession() {
  const [me, setMe] = useState<LkMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await lkApi.me();
        if (!cancelled) setMe(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { me, loading, error };
}
