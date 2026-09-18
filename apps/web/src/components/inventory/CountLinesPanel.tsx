"use client";

/**
 * Правая карточка «Счёта» (мокап, экран 1): строки выбранной категории.
 *
 * Счёт сохраняется сразу (useCountSaver): оптимистично, с задержкой 500 мс на
 * строку, с откатом и объяснением при ошибке. После каждого сохранения
 * страница перечитывает карточку инвентаризации — рейл и итоги живые.
 * Строки категории перечитываются раз в 20 с, пока нет несохранённого ввода
 * и сброса в пути: второй кладовщик считает параллельно. Ответ опроса,
 * ушедшего до своего изменения (сохранение, «Пересчитать») или до смены
 * категории, выбрасывается — иначе он вернул бы строки, прочитанные раньше.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { StatusPill } from "../StatusPill";
import { toast } from "../ToastProvider";
import { pluralize } from "../../lib/format";
import { errorCode, explainInventoryError, inventoryApi } from "./api";
import { CountLineRow, displayDiff } from "./CountLineRow";
import type { StockCountCategory, StockCountLineView } from "./types";
import { useCountSaver } from "./useCountSaver";
import { CARD, CARD_TITLE, FOCUS } from "./ui";

export const LINES_POLL_MS = 20_000;

export interface CountLinesPanelProps {
  stockCountId: string;
  category: StockCountCategory;
  readOnly: boolean;
  /** Строка, к которой вернуться (из итога по «Пересчитать»). */
  focusLineId?: string | null;
  /** Счёт изменился — перечитать карточку инвентаризации. */
  onChanged: () => void;
}

export function CountLinesPanel({ stockCountId, category, readOnly, focusLineId, onChanged }: CountLinesPanelProps) {
  const [lines, setLines] = useState<StockCountLineView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [hideMatched, setHideMatched] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(focusLineId ?? null);
  const [resetting, setResetting] = useState<Record<string, boolean>>({});
  // Поколение строк на экране: растёт при каждой своей записи. Ответ опроса,
  // начатого в прошлом поколении, уже не авторитетен.
  const linesGenRef = useRef(0);

  const replaceLine = useCallback((line: StockCountLineView) => {
    linesGenRef.current += 1;
    setLines((prev) => prev.map((l) => (l.id === line.id ? line : l)));
  }, []);

  const saver = useCountSaver({
    stockCountId,
    onSaved: (line) => {
      replaceLine(line);
      onChanged();
    },
    onError: (e) => {
      toast.error(explainInventoryError(e, "Не удалось сохранить счёт"));
      const code = errorCode(e);
      if (code === "STOCK_COUNT_NOT_OPEN") onChanged();
      if (code === "LINE_NOT_COUNT_MODE" || code === "EQUIPMENT_DELETED") setReloadKey((k) => k + 1);
    },
  });

  const hasUnsaved = Object.keys(saver.pending).length > 0 || Object.keys(saver.saving).length > 0;
  const busy = hasUnsaved || Object.keys(resetting).length > 0;

  useEffect(() => {
    let cancelled = false;
    linesGenRef.current += 1;
    setLoading(true);
    setError(null);
    // Строки прошлой категории под новой шапкой только путали бы.
    setLines([]);
    inventoryApi
      .lines(stockCountId, { category: category.category })
      .then(({ lines: data }) => {
        if (!cancelled) setLines(data);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(explainInventoryError(e, "Не удалось загрузить строки категории"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [stockCountId, category.category, reloadKey]);

  useEffect(() => {
    if (focusLineId) setActiveId(focusLineId);
  }, [focusLineId]);

  // Тихое перечитывание: чужой счёт в той же категории. Пока есть свой
  // несохранённый ввод или сброс в пути — не трогаем, чтобы не мигали значения.
  // Эффект сносится на каждом своём изменении и на смене категории, и
  // `cancelled` выбрасывает ответ опроса, который к этому моменту был в пути.
  useEffect(() => {
    if (readOnly || busy) return;
    let cancelled = false;
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const gen = linesGenRef.current;
      inventoryApi
        .lines(stockCountId, { category: category.category })
        .then(({ lines: data }) => {
          if (!cancelled && linesGenRef.current === gen) setLines(data);
        })
        .catch(() => {
          // Фоновое обновление: ошибку сети покажет следующее действие пользователя.
        });
    }, LINES_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [stockCountId, category.category, readOnly, busy]);

  const handleReset = useCallback(
    async (line: StockCountLineView) => {
      saver.discard(line.id);
      linesGenRef.current += 1;
      setResetting((r) => ({ ...r, [line.id]: true }));
      try {
        const { line: fresh } = await inventoryApi.reset(stockCountId, line.id);
        replaceLine(fresh);
        setActiveId(line.id);
        onChanged();
      } catch (e) {
        toast.error(explainInventoryError(e, "Не удалось сбросить счёт строки"));
        if (errorCode(e) === "STOCK_COUNT_NOT_OPEN") onChanged();
      } finally {
        setResetting((r) => {
          const next = { ...r };
          delete next[line.id];
          return next;
        });
      }
    },
    [saver, stockCountId, replaceLine, onChanged],
  );

  const rows = useMemo(
    () =>
      lines.map((line) => {
        const value = saver.pending[line.id] ?? line.countedQty;
        return { line, value, diff: displayDiff(line, value) };
      }),
    [lines, saver.pending],
  );
  const visible = hideMatched ? rows.filter((r) => r.diff !== 0 || r.line.id === activeId) : rows;
  const hiddenCount = rows.length - visible.length;

  const state = category.counted >= category.lines ? "done" : category.counted > 0 ? "progress" : "idle";
  const who =
    category.counters.length > 0
      ? `${category.counters.length > 1 ? "считают" : "считает"} ${category.counters.join(", ")}`
      : "ещё никто не считал";

  return (
    <section className={CARD} aria-label={`Строки категории «${category.category}»`}>
      <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-3.5 py-2.5">
        <div className="min-w-0">
          <h3 className={CARD_TITLE}>{category.category}</h3>
          <p className="text-[11.5px] text-ink-2">
            {who} · {category.counted} из {category.lines}
            {readOnly ? "" : " · строки сохраняются сразу"}
          </p>
        </div>
        <div className="flex items-center gap-2 sm:ml-auto">
          <button
            type="button"
            aria-pressed={hideMatched}
            onClick={() => setHideMatched((v) => !v)}
            className={`rounded-full border px-2.5 text-[11px] font-semibold leading-[1.7] transition-colors ${
              hideMatched ? "border-accent bg-accent text-surface" : "border-border bg-surface text-ink-2 hover:text-ink"
            } ${FOCUS}`}
          >
            свернуть сошедшиеся
          </button>
          <StatusPill
            variant={state === "done" ? "ok" : state === "progress" ? "info" : "none"}
            label={state === "done" ? "посчитано" : state === "progress" ? "в работе" : "не начато"}
          />
        </div>
      </div>

      {error && (
        <div className="flex flex-wrap items-center gap-3 border-b border-rose-border bg-rose-soft px-3.5 py-2.5 text-sm text-rose">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className={`rounded-sm text-xs font-semibold underline ${FOCUS}`}
          >
            Повторить
          </button>
        </div>
      )}

      {loading && lines.length === 0 ? (
        <ul aria-busy="true" aria-label="Загрузка строк">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="flex items-center gap-3 border-b border-border px-3.5 py-3 last:border-b-0">
              <span className="h-4 flex-1 animate-pulse rounded bg-surface-subtle" />
              <span className="h-6 w-24 animate-pulse rounded bg-surface-subtle" />
            </li>
          ))}
        </ul>
      ) : (
        <ul>
          {visible.map(({ line, value }) => (
            <CountLineRow
              key={line.id}
              line={line}
              value={value}
              saving={Boolean(saver.saving[line.id] || resetting[line.id])}
              active={activeId === line.id}
              readOnly={readOnly}
              autoFocus={focusLineId === line.id}
              onSet={(qty, opts) => saver.setCount(line.id, qty, opts)}
              onCommit={() => saver.flush(line.id)}
              onReset={() => void handleReset(line)}
              onActivate={() => setActiveId(line.id)}
            />
          ))}
        </ul>
      )}

      {hiddenCount > 0 && (
        <div className="bg-surface-muted px-3.5 py-2 text-[11.5px] text-ink-3">
          свёрнуто {hiddenCount} {pluralize(hiddenCount, "сошедшаяся строка", "сошедшиеся строки", "сошедшихся строк")}
          {" · "}
          <button type="button" onClick={() => setHideMatched(false)} className={`rounded-sm font-semibold text-accent-bright hover:underline ${FOCUS}`}>
            показать
          </button>
        </div>
      )}
    </section>
  );
}
