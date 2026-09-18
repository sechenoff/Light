"use client";

/**
 * Карточка инвентаризации (`GET /api/stock-counts/:id`) с живым обновлением.
 *
 * - `scheduleReload()` склеивает всплеск сохранений строк в один запрос:
 *   рейл категорий и итоги догоняют счёт без запроса на каждый клик.
 * - Пока инвентаризация идёт, карточка перечитывается раз в 20 с (и не
 *   дёргается в фоновой вкладке): руководитель видит, кто где считает.
 * - Ответ, обогнанный более новым запросом, выбрасывается.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { explainInventoryError, errorCode, inventoryApi } from "./api";
import type { StockCountDetail } from "./types";

export const DETAIL_POLL_MS = 20_000;
const RELOAD_COALESCE_MS = 300;

export interface UseStockCount {
  detail: StockCountDetail | null;
  loading: boolean;
  error: string | null;
  notFound: boolean;
  reload: () => Promise<void>;
  scheduleReload: () => void;
  setDetail: (d: StockCountDetail) => void;
}

export function useStockCount(id: string, enabled: boolean): UseStockCount {
  const [detail, setDetailState] = useState<StockCountDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const seqRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(async () => {
    const seq = ++seqRef.current;
    try {
      const { stockCount } = await inventoryApi.detail(id);
      if (seq !== seqRef.current) return;
      setDetailState(stockCount);
      setError(null);
      setNotFound(false);
    } catch (e) {
      if (seq !== seqRef.current) return;
      if (errorCode(e) === "STOCK_COUNT_NOT_FOUND") setNotFound(true);
      setError(explainInventoryError(e, "Не удалось загрузить инвентаризацию"));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [id]);

  const scheduleReload = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void reload();
    }, RELOAD_COALESCE_MS);
  }, [reload]);

  const setDetail = useCallback((d: StockCountDetail) => {
    // Свежий ответ мутации авторитетнее запроса, который ещё в пути.
    seqRef.current += 1;
    setDetailState(d);
    setError(null);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    setLoading(true);
    void reload();
    return () => {
      seqRef.current += 1;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [enabled, reload]);

  const isOpen = detail?.status === "OPEN";
  useEffect(() => {
    if (!enabled || !isOpen) return;
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void reload();
    }, DETAIL_POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, isOpen, reload]);

  return { detail, loading, error, notFound, reload, scheduleReload, setDetail };
}
