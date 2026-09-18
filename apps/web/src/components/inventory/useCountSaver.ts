"use client";

/**
 * Сохранение счёта строк: оптимистично и с задержкой.
 *
 * - Значение сразу видно в строке (`pending`), на сервер уходит через 500 мс
 *   тишины по ЭТОЙ строке: пять кликов «+» — один запрос с итогом.
 * - Кнопки «на месте / нет» и «= N» шлют сразу (`immediate`).
 * - По строке в полёте не больше одного запроса; новое значение ждёт и уходит
 *   последним. Сервер хранит то, что закоммитил позже, — два параллельных
 *   запроса одной строки могли бы оставить в базе старое значение, хотя на
 *   экране новое. Из нескольких ждущих значений уходит только последнее.
 * - Ответ, обогнанный более новым значением или `discard`, не применяется.
 * - Ошибка — откат к последнему сохранённому значению и объяснение наверх
 *   (если следом не ждёт более новое значение: оно сообщит о себе само).
 * - При размонтировании (уход со «Счёта» на «Итог» или со страницы; смена
 *   категории панель НЕ размонтирует) отложенные значения отправляются, а не
 *   теряются — после запроса, который по строке уже в пути.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { inventoryApi } from "./api";
import type { StockCountLineView } from "./types";

export const COUNT_DEBOUNCE_MS = 500;

export interface CountSaver {
  /** Значения, ещё не подтверждённые сервером, по id строки. */
  pending: Readonly<Record<string, number>>;
  /** Строки, по которым идёт (или ждёт своей очереди) запрос. */
  saving: Readonly<Record<string, boolean>>;
  setCount: (lineId: string, qty: number, opts?: { immediate?: boolean }) => void;
  /** Отправить отложенное значение строки сейчас (Enter в поле). */
  flush: (lineId: string) => void;
  /** Забыть отложенное и ждущее значение строки (перед «Пересчитать»). */
  discard: (lineId: string) => void;
}

/** Инвентаризация передаётся явно: цепочка по строке уходит туда, где началась. */
type SendFn = (countId: string, lineId: string, qty: number) => Promise<void>;

export function useCountSaver({
  stockCountId,
  onSaved,
  onError,
}: {
  stockCountId: string;
  onSaved: (line: StockCountLineView) => void;
  onError: (error: unknown, lineId: string) => void;
}): CountSaver {
  const [pending, setPending] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const pendingRef = useRef(new Map<string, number>());
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const seqRef = useRef(new Map<string, number>());
  /** Строки, по которым запрос уже в пути. */
  const inflightRef = useRef(new Set<string>());
  /** Значение, которое уйдёт следом за запросом в пути (только последнее). */
  const queuedRef = useRef(new Map<string, number>());
  // Колбэки — через ref: таймер, поставленный до ре-рендера, зовёт свежие.
  const handlersRef = useRef({ onSaved, onError });
  handlersRef.current = { onSaved, onError };

  const syncPending = useCallback(() => {
    setPending(Object.fromEntries(pendingRef.current));
  }, []);

  const markSaving = useCallback((lineId: string) => {
    setSaving((s) => (s[lineId] ? s : { ...s, [lineId]: true }));
  }, []);

  const clearSaving = useCallback((lineId: string) => {
    setSaving((s) => {
      if (!(lineId in s)) return s;
      const next = { ...s };
      delete next[lineId];
      return next;
    });
  }, []);

  const sendRef = useRef<SendFn>(async () => {});

  const send = useCallback<SendFn>(
    async (countId, lineId, qty) => {
      if (inflightRef.current.has(lineId)) {
        queuedRef.current.set(lineId, qty);
        markSaving(lineId);
        return;
      }
      inflightRef.current.add(lineId);
      const seq = (seqRef.current.get(lineId) ?? 0) + 1;
      seqRef.current.set(lineId, seq);
      markSaving(lineId);
      try {
        const { line } = await inventoryApi.count(countId, lineId, qty);
        if (seqRef.current.get(lineId) !== seq) return;
        // Следом уже уходит более новое значение — этот ответ устарел.
        if (queuedRef.current.has(lineId)) return;
        if (pendingRef.current.get(lineId) === qty) {
          pendingRef.current.delete(lineId);
          syncPending();
        }
        handlersRef.current.onSaved(line);
      } catch (error) {
        if (seqRef.current.get(lineId) !== seq) return;
        // Ошибка более новому значению не помеха: оно уйдёт и само сообщит о сбое.
        if (queuedRef.current.has(lineId)) return;
        const timer = timersRef.current.get(lineId);
        if (timer) clearTimeout(timer);
        timersRef.current.delete(lineId);
        pendingRef.current.delete(lineId);
        syncPending();
        handlersRef.current.onError(error, lineId);
      } finally {
        inflightRef.current.delete(lineId);
        const next = queuedRef.current.get(lineId);
        queuedRef.current.delete(lineId);
        if (next != null) void sendRef.current(countId, lineId, next);
        else if (seqRef.current.get(lineId) === seq) clearSaving(lineId);
      }
    },
    [syncPending, markSaving, clearSaving],
  );
  sendRef.current = send;

  const setCount = useCallback(
    (lineId: string, qty: number, opts: { immediate?: boolean } = {}) => {
      pendingRef.current.set(lineId, qty);
      syncPending();
      const prev = timersRef.current.get(lineId);
      if (prev) clearTimeout(prev);
      timersRef.current.delete(lineId);
      if (opts.immediate) {
        void sendRef.current(stockCountId, lineId, qty);
        return;
      }
      timersRef.current.set(
        lineId,
        setTimeout(() => {
          timersRef.current.delete(lineId);
          void sendRef.current(stockCountId, lineId, qty);
        }, COUNT_DEBOUNCE_MS),
      );
    },
    [stockCountId, syncPending],
  );

  const flush = useCallback(
    (lineId: string) => {
      const timer = timersRef.current.get(lineId);
      if (!timer) return;
      clearTimeout(timer);
      timersRef.current.delete(lineId);
      const qty = pendingRef.current.get(lineId);
      if (qty != null) void sendRef.current(stockCountId, lineId, qty);
    },
    [stockCountId],
  );

  const discard = useCallback(
    (lineId: string) => {
      const timer = timersRef.current.get(lineId);
      if (timer) clearTimeout(timer);
      timersRef.current.delete(lineId);
      // Запрос, который уже в пути, тоже не должен вернуть старое значение,
      // а ждущее значение — уйти после сброса.
      seqRef.current.set(lineId, (seqRef.current.get(lineId) ?? 0) + 1);
      queuedRef.current.delete(lineId);
      pendingRef.current.delete(lineId);
      syncPending();
      clearSaving(lineId);
    },
    [syncPending, clearSaving],
  );

  useEffect(() => {
    const countId = stockCountId;
    const timers = timersRef.current;
    const pendingValues = pendingRef.current;
    const inflight = inflightRef.current;
    const queued = queuedRef.current;
    return () => {
      timers.forEach((timer, lineId) => {
        clearTimeout(timer);
        const qty = pendingValues.get(lineId);
        if (qty == null) return;
        // По строке запрос в пути — значение уйдёт следом, из его finally.
        if (inflight.has(lineId)) queued.set(lineId, qty);
        else void send(countId, lineId, qty);
      });
      timers.clear();
    };
  }, [stockCountId, send]);

  return { pending, saving, setCount, flush, discard };
}
