"use client";

/**
 * useStockCountKiosk — состояние экрана счёта инвентаризации в киоске.
 *
 * Держит идущую инвентаризацию, открытый участок (категорию) и его строки.
 * Счёт сохраняется оптимистично:
 *  - большие кнопки («✓ На месте», «Нет на полке», «Всё на месте») — сразу;
 *  - степпер и ручной ввод — с задержкой COUNT_SAVE_DEBOUNCE_MS: десять
 *    касаний «−» — один запрос, а не десять;
 *  - запросы по одной строке идут строго по очереди: следующий уходит только
 *    после ответа на предыдущий, иначе ответы могли бы прийти вразнобой и
 *    «откатить» строку к старому числу;
 *  - при ошибке строка возвращается к последнему подтверждённому сервером
 *    состоянию, а ошибка видна на карточке (или тостом, если участок уже
 *    закрыли, — закрытый киоск молча ничего не теряет);
 *  - «Пауза», «назад» и уход со страницы досылают отложенный счёт сразу.
 *
 * 401 → onUnauth (вход по PIN заново, как на остальных экранах киоска).
 * 409 STOCK_COUNT_NOT_OPEN / 404 STOCK_COUNT_NOT_FOUND → `ended`: инвентаризацию
 * завершили или отменили, считать больше нечего.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  StockCountDetail,
  StockCountLineView,
} from "../inventory/types";
import { scanApi } from "./api";
import { isScanApiError } from "./types";
import { toast } from "../ToastProvider";
import { clampQty, withCount, withReset } from "./StockCountFormat";

/** Задержка сохранения для степпера и ручного ввода. */
export const COUNT_SAVE_DEBOUNCE_MS = 500;

export const STOCK_COUNT_ENDED_MESSAGE =
  "Инвентаризацию завершили или отменили — считать больше нечего. Всё, что успели посчитать, сохранено.";
export const STOCK_COUNT_NONE_MESSAGE =
  "Сейчас инвентаризация не идёт — считать нечего.";

export type CountSaveMode = "now" | "debounced";

type PendingOp = { type: "count"; qty: number } | { type: "reset" };

export interface StockCountKiosk {
  detail: StockCountDetail | null;
  detailError: string | null;
  /** Сообщение, если считать больше нельзя (завершили, отменили, не идёт). */
  ended: string | null;
  reloadDetail: () => void;
  category: string | null;
  openCategory: (category: string) => void;
  /** «Пауза» — назад к участкам; отложенный счёт досылается сразу. */
  closeCategory: () => void;
  lines: StockCountLineView[] | null;
  linesError: string | null;
  reloadLines: () => void;
  /** Строки, чей счёт ещё не подтверждён сервером. */
  savingIds: ReadonlySet<string>;
  lineErrors: Readonly<Record<string, string>>;
  count: (lineId: string, qty: number, mode: CountSaveMode) => void;
  reset: (lineId: string) => void;
}

function loadErrorMessage(err: unknown, fallback: string): string {
  if (isScanApiError(err) && err.status !== 0 && err.message) return err.message;
  if (isScanApiError(err) && err.status === 0) return "Нет связи с сервером — проверьте сеть";
  return fallback;
}

function saveErrorMessage(err: unknown): string {
  if (!isScanApiError(err)) return "Не сохранилось — повторите";
  if (err.status === 0) return "Нет связи — не сохранилось. Повторите, когда появится сеть";
  // Сообщения API по-русски; коды здесь — только ради более точной подсказки.
  switch (err.code) {
    case "LINE_NOT_COUNT_MODE":
      return "Позицию перевели на штучный учёт — её сверяют по единицам в карточке оборудования";
    case "EQUIPMENT_DELETED":
      return "Позицию удалили из каталога — считать нечего";
    case "LINE_NOT_FOUND":
      return "Строки больше нет в инвентаризации — вернитесь к участкам";
    default:
      return err.message ? `Не сохранилось: ${err.message}` : "Не сохранилось — повторите";
  }
}

function replaceLine(
  lines: StockCountLineView[] | null,
  lineId: string,
  map: (l: StockCountLineView) => StockCountLineView,
): StockCountLineView[] | null {
  if (!lines) return lines;
  return lines.map((l) => (l.id === lineId ? map(l) : l));
}

export function useStockCountKiosk({
  initial,
  onUnauth,
}: {
  initial?: StockCountDetail | null;
  onUnauth: () => void;
}): StockCountKiosk {
  const initialOpen = initial && initial.status === "OPEN" ? initial : null;
  const [detail, setDetail] = useState<StockCountDetail | null>(initialOpen);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [ended, setEnded] = useState<string | null>(null);
  const [detailVersion, setDetailVersion] = useState(0);

  const [category, setCategory] = useState<string | null>(null);
  const [lines, setLines] = useState<StockCountLineView[] | null>(null);
  const [linesError, setLinesError] = useState<string | null>(null);
  const [linesVersion, setLinesVersion] = useState(0);

  const [savingIds, setSavingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [lineErrors, setLineErrors] = useState<Readonly<Record<string, string>>>({});

  const stockCountId = detail?.id ?? null;
  const idRef = useRef<string | null>(stockCountId);
  idRef.current = stockCountId;
  const hadDetailRef = useRef(initialOpen != null);
  const onUnauthRef = useRef(onUnauth);
  onUnauthRef.current = onUnauth;
  const mounted = useRef(true);
  /** id строк, которые сейчас на экране: ошибку остальных показываем тостом. */
  const shownIds = useRef<ReadonlySet<string>>(new Set());
  shownIds.current = new Set((lines ?? []).map((l) => l.id));

  // Машина сохранения — на ref'ах: она переживает перерисовки и уход с участка.
  const pending = useRef(new Map<string, PendingOp>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const inFlight = useRef(new Map<string, Promise<void>>());
  /** Последнее подтверждённое сервером состояние строки — для отката. */
  const confirmed = useRef(new Map<string, StockCountLineView>());

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** 401 и «инвентаризации больше нет» — общий исход для любого запроса. */
  const handleFatal = useCallback((err: unknown): boolean => {
    if (!isScanApiError(err)) return false;
    if (err.status === 401) {
      onUnauthRef.current();
      return true;
    }
    if (err.code === "STOCK_COUNT_NOT_OPEN" || err.code === "STOCK_COUNT_NOT_FOUND") {
      if (mounted.current) setEnded(STOCK_COUNT_ENDED_MESSAGE);
      return true;
    }
    return false;
  }, []);

  const setSaving = useCallback((lineId: string, on: boolean) => {
    setSavingIds((prev) => {
      if (prev.has(lineId) === on) return prev;
      const next = new Set(prev);
      if (on) next.add(lineId);
      else next.delete(lineId);
      return next;
    });
  }, []);

  // ── Инвентаризация ─────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setDetailError(null);
    scanApi
      .getActiveStockCount()
      .then((sc) => {
        if (cancelled) return;
        if (!sc || sc.status !== "OPEN") {
          setEnded(
            hadDetailRef.current || sc ? STOCK_COUNT_ENDED_MESSAGE : STOCK_COUNT_NONE_MESSAGE,
          );
          return;
        }
        if (idRef.current && idRef.current !== sc.id) {
          // Старую отменили и начали новую — участок и строки были от старой.
          setCategory(null);
          setLines(null);
        }
        hadDetailRef.current = true;
        setDetail(sc);
      })
      .catch((err: unknown) => {
        if (cancelled || handleFatal(err)) return;
        setDetailError(loadErrorMessage(err, "Не удалось загрузить инвентаризацию"));
      });
    return () => {
      cancelled = true;
    };
  }, [detailVersion, handleFatal]);

  // ── Строки участка ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!category || !stockCountId) return;
    let cancelled = false;
    setLines(null);
    setLinesError(null);
    scanApi
      .listStockCountLines(stockCountId, category)
      .then((list) => {
        if (cancelled) return;
        for (const l of list) confirmed.current.set(l.id, l);
        setLines(list);
      })
      .catch((err: unknown) => {
        if (cancelled || handleFatal(err)) return;
        setLinesError(loadErrorMessage(err, "Не удалось загрузить позиции"));
      });
    return () => {
      cancelled = true;
    };
  }, [category, stockCountId, linesVersion, handleFatal]);

  // ── Сохранение ─────────────────────────────────────────────────────────────
  const flushRef = useRef<(lineId: string) => void>(() => {});

  const onSaveFailed = useCallback(
    (lineId: string, err: unknown) => {
      pending.current.delete(lineId);
      const timer = timers.current.get(lineId);
      if (timer) clearTimeout(timer);
      timers.current.delete(lineId);
      const back = confirmed.current.get(lineId);
      if (mounted.current && back) setLines((prev) => replaceLine(prev, lineId, () => back));
      if (handleFatal(err)) return;
      const message = saveErrorMessage(err);
      if (mounted.current && shownIds.current.has(lineId)) {
        setLineErrors((prev) => ({ ...prev, [lineId]: message }));
        return;
      }
      // Участок уже закрыли (или ушли с экрана) — ошибка всё равно видна.
      toast.error(back ? `«${back.name}»: ${message}` : message);
    },
    [handleFatal],
  );

  flushRef.current = (lineId: string) => {
    if (inFlight.current.has(lineId)) return; // уйдёт после ответа на текущий
    const op = pending.current.get(lineId);
    const scId = idRef.current;
    if (!op || !scId) return;
    pending.current.delete(lineId);
    const request =
      op.type === "count"
        ? scanApi.countStockCountLine(scId, lineId, op.qty)
        : scanApi.resetStockCountLine(scId, lineId);
    const done = request
      .then(
        (serverLine) => {
          confirmed.current.set(lineId, serverLine);
          if (!mounted.current) return;
          // Пока пользователь продолжает жать степпер, экран показывает его
          // число, а не промежуточный ответ.
          const stillEditing = pending.current.has(lineId) || timers.current.has(lineId);
          if (!stillEditing) setLines((prev) => replaceLine(prev, lineId, () => serverLine));
        },
        (err: unknown) => onSaveFailed(lineId, err),
      )
      .finally(() => {
        inFlight.current.delete(lineId);
        if (pending.current.has(lineId) && !timers.current.has(lineId)) {
          flushRef.current(lineId);
          return;
        }
        if (mounted.current && !pending.current.has(lineId) && !timers.current.has(lineId)) {
          setSaving(lineId, false);
        }
      });
    inFlight.current.set(lineId, done);
  };

  const schedule = useCallback(
    (lineId: string, op: PendingOp, mode: CountSaveMode) => {
      pending.current.set(lineId, op);
      setSaving(lineId, true);
      setLineErrors((prev) => {
        if (!(lineId in prev)) return prev;
        const next = { ...prev };
        delete next[lineId];
        return next;
      });
      const timer = timers.current.get(lineId);
      if (timer) clearTimeout(timer);
      timers.current.delete(lineId);
      if (mode === "debounced") {
        timers.current.set(
          lineId,
          setTimeout(() => {
            timers.current.delete(lineId);
            flushRef.current(lineId);
          }, COUNT_SAVE_DEBOUNCE_MS),
        );
        return;
      }
      flushRef.current(lineId);
    },
    [setSaving],
  );

  /**
   * Дослать всё отложенное сразу; промис — когда все запросы ответили.
   * Ждём в цикле: число, отложенное за запросом «в полёте», уходит из его
   * `.finally` уже после того, как первый ответ пришёл, — одного
   * `allSettled` мало, прогресс участков перечитался бы до последнего счёта.
   */
  const flushAll = useCallback(async (): Promise<void> => {
    for (const [lineId, timer] of Array.from(timers.current.entries())) {
      clearTimeout(timer);
      timers.current.delete(lineId);
      flushRef.current(lineId);
    }
    while (inFlight.current.size > 0) {
      await Promise.allSettled(Array.from(inFlight.current.values()));
    }
  }, []);

  // Уход с экрана (смена вкладки, «назад») не теряет последнее касание.
  useEffect(() => () => void flushAll(), [flushAll]);

  const count = useCallback(
    (lineId: string, qty: number, mode: CountSaveMode) => {
      const safe = clampQty(qty);
      setLines((prev) => replaceLine(prev, lineId, (l) => withCount(l, safe)));
      schedule(lineId, { type: "count", qty: safe }, mode);
    },
    [schedule],
  );

  const reset = useCallback(
    (lineId: string) => {
      setLines((prev) => replaceLine(prev, lineId, withReset));
      schedule(lineId, { type: "reset" }, "now");
    },
    [schedule],
  );

  const openCategory = useCallback((next: string) => {
    setLineErrors({});
    setLinesError(null);
    setCategory(next);
  }, []);

  const closeCategory = useCallback(() => {
    const settled = flushAll();
    setCategory(null);
    setLines(null);
    setLinesError(null);
    setLineErrors({});
    // Прогресс участков перечитываем, когда досланный счёт уже на сервере.
    void settled.then(() => {
      if (mounted.current) setDetailVersion((v) => v + 1);
    });
  }, [flushAll]);

  const reloadDetail = useCallback(() => setDetailVersion((v) => v + 1), []);
  const reloadLines = useCallback(() => setLinesVersion((v) => v + 1), []);

  return {
    detail,
    detailError,
    ended,
    reloadDetail,
    category,
    openCategory,
    closeCategory,
    lines,
    linesError,
    reloadLines,
    savingIds,
    lineErrors,
    count,
    reset,
  };
}
