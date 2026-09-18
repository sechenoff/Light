"use client";

/**
 * «Итог и решения» (мокап, экран 2): баннер первой инвентаризации, пять
 * плиток, группы «Недостача» и «Излишек» с фильтром «без решения / все» и
 * справа — «Завершить инвентаризацию».
 *
 * У завершённой и отменённой — то же, но только чтение: записанные решения
 * видны, менять их нельзя.
 *
 * Строки расхождений перечитываются, когда меняется сам состав расхождений
 * (посчитано / недостач / излишков) или когда свежие итоги карточки не
 * сходятся с тем, что на экране: строку поменяли не отсюда — кладовщик
 * пересчитал её в киоске и сервер снял решение (спека §4.2), решение сняли
 * в другой вкладке. Своё решение перечитывания не вызывает: сервер
 * возвращает строку, и она заменяется на месте.
 *
 * Подсказки «Как пропало» для всех недостач приходят одним запросом вместе со
 * строками (GET …/trail-suggestions): полный след строка грузит только по
 * «Как пропало ▾». Иначе каждое возвращение на «Итог» слало бы по запросу
 * следа на каждую недостачу — сотни на первой инвентаризации.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { explainInventoryError, inventoryApi } from "./api";
import { ClosedPanel, CompletePanel } from "./CompletePanel";
import { DiscrepancyRow } from "./DiscrepancyRow";
import { fmtDayMonth, isLineUndecided } from "./format";
import { SummaryTiles } from "./SummaryTiles";
import type { CompleteResult, StockCountDetail, StockCountLineView, TrailSuggestion } from "./types";
import { CARD, FOCUS } from "./ui";

type GroupFilter = "undecided" | "all";

export interface ReviewPanelProps {
  detail: StockCountDetail;
  onChanged: () => void;
  onStale: () => void;
  onRecount: (line: StockCountLineView) => void;
  onCompleted: (detail: StockCountDetail, result: CompleteResult) => void;
}

export function ReviewPanel({ detail, onChanged, onStale, onRecount, onCompleted }: ReviewPanelProps) {
  const readOnly = detail.status !== "OPEN";
  const [lines, setLines] = useState<StockCountLineView[] | null>(null);
  const [suggestions, setSuggestions] = useState<Record<string, TrailSuggestion | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const { counted, shortagePositions, surplusPositions, shortageQty, surplusQty, undecided } = detail.totals;
  useEffect(() => {
    let cancelled = false;
    setError(null);
    inventoryApi
      .lines(detail.id, { filter: "discrepancy" })
      .then(({ lines: data }) => {
        if (!cancelled) setLines(data);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(explainInventoryError(e, "Не удалось загрузить расхождения"));
      });
    // Подсказки — только у идущей; сбой молчит: строки остаются с разбивкой,
    // а полный след по «Как пропало ▾» покажет свою ошибку.
    if (detail.status === "OPEN") {
      inventoryApi
        .trailSuggestions(detail.id)
        .then(({ suggestions: data }) => {
          if (!cancelled) setSuggestions(data);
        })
        .catch(() => {
          if (!cancelled) setSuggestions({});
        });
    } else {
      setSuggestions({});
    }
    return () => {
      cancelled = true;
    };
  }, [detail.id, detail.status, counted, shortagePositions, surplusPositions, reloadKey]);

  // Сверка списка с итогами — только когда пришла свежая карточка (опрос,
  // перечитывание после действия), а не когда поменялся список: после своего
  // решения список уже впереди карточки, и перечитывать его незачем.
  const linesRef = useRef<StockCountLineView[] | null>(lines);
  linesRef.current = lines;
  const compositionKey = `${detail.id}|${detail.status}|${counted}|${shortagePositions}|${surplusPositions}`;
  const compositionRef = useRef(compositionKey);
  const resyncedForRef = useRef<string | null>(null);
  useEffect(() => {
    const compositionChanged = compositionRef.current !== compositionKey;
    compositionRef.current = compositionKey;
    const local = linesRef.current;
    // Состав сменился — список уже перечитывается эффектом выше.
    if (readOnly || !local || compositionChanged) return;
    const serverSig = `${undecided}|${shortageQty}|${surplusQty}`;
    if (discrepancySignature(local) === serverSig) {
      resyncedForRef.current = null;
      return;
    }
    // Один раз на состояние сервера: стойкое расхождение не зацикливает запросы.
    if (resyncedForRef.current === serverSig) return;
    resyncedForRef.current = serverSig;
    setReloadKey((k) => k + 1);
  }, [detail, compositionKey, readOnly, undecided, shortageQty, surplusQty]);

  const replaceLine = useCallback((line: StockCountLineView) => {
    setLines((prev) => (prev ? prev.map((l) => (l.id === line.id ? line : l)) : prev));
  }, []);

  const handleStale = useCallback(() => {
    setReloadKey((k) => k + 1);
    onStale();
  }, [onStale]);

  const handleRecount = useCallback(
    (line: StockCountLineView) => {
      setLines((prev) => (prev ? prev.filter((l) => l.id !== line.id) : prev));
      onRecount(line);
    },
    [onRecount],
  );

  const shortage = useMemo(() => (lines ?? []).filter((l) => (l.diff ?? 0) < 0), [lines]);
  const surplus = useMemo(() => (lines ?? []).filter((l) => (l.diff ?? 0) > 0), [lines]);
  const decidedOf = (list: StockCountLineView[]) => list.filter((l) => !isLineUndecided(l)).length;

  const matchedNote =
    detail.status === "CLOSED"
      ? `отмечены «сверено ${fmtDayMonth(detail.closedAt)}»`
      : "без расхождений — всё на месте";

  return (
    <div>
      {detail.isFirst && !readOnly && (
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-border border-l-[3px] border-l-amber bg-amber-soft px-3.5 py-2.5 text-[12.5px] leading-normal text-ink">
          <svg viewBox="0 0 24 24" className="mt-[3px] h-3.5 w-3.5 shrink-0 text-amber" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
            <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <p>
            <b className="font-semibold">Это первая инвентаризация.</b> Каталог ни разу не пересчитывали, а на приёмке брони
            почти всегда закрывают без пересчёта. Часть расхождений — ошибки в учёте, а не пропажи: решайте по каждой
            строке. Со следующей инвентаризации «как пропало» станет точнее — окно сузится до броней между пересчётами.
          </p>
        </div>
      )}

      <SummaryTiles
        totals={detail.totals}
        shortageDecided={lines ? decidedOf(shortage) : null}
        surplusDecided={lines ? decidedOf(surplus) : null}
        matchedNote={matchedNote}
        finished={readOnly}
      />

      <div className="mt-3 grid items-start gap-3.5 xl:grid-cols-[minmax(0,1fr)_300px]">
        <section className={CARD} aria-label="Расхождения">
          {error && (
            <div className="flex flex-wrap items-center gap-3 border-b border-rose-border bg-rose-soft px-3.5 py-2.5 text-sm text-rose">
              <span>{error}</span>
              <button type="button" onClick={() => setReloadKey((k) => k + 1)} className={`rounded-sm text-xs font-semibold underline ${FOCUS}`}>
                Повторить
              </button>
            </div>
          )}
          {lines == null && !error ? (
            <div aria-busy="true" aria-label="Загрузка расхождений">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-3 border-b border-border px-3.5 py-4 last:border-b-0">
                  <span className="h-4 flex-1 animate-pulse rounded bg-surface-subtle" />
                  <span className="h-6 w-40 animate-pulse rounded bg-surface-subtle" />
                </div>
              ))}
            </div>
          ) : lines && lines.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <p className="text-sm font-medium text-ink-2">
                {counted > 0 ? "Расхождений нет" : readOnly ? "Ничего не посчитали" : "Пока ничего не посчитано"}
              </p>
              <p className="mt-1 text-[13px] text-ink-3">
                {counted > 0
                  ? "Всё посчитанное сошлось с учётом"
                  : readOnly
                    ? "В этой инвентаризации не посчитано ни одной позиции"
                    : "Начните со вкладки «Счёт» — расхождения появятся здесь по мере счёта"}
              </p>
            </div>
          ) : (
            lines && (
              <>
                <DiscrepancyGroup
                  title="Недостача"
                  tone="rose"
                  lines={shortage}
                  suggestions={suggestions}
                  readOnly={readOnly}
                  detail={detail}
                  onLineChange={replaceLine}
                  onRecount={handleRecount}
                  onChanged={onChanged}
                  onStale={handleStale}
                />
                <DiscrepancyGroup
                  title="Излишек"
                  tone="emerald"
                  lines={surplus}
                  suggestions={suggestions}
                  readOnly={readOnly}
                  detail={detail}
                  onLineChange={replaceLine}
                  onRecount={handleRecount}
                  onChanged={onChanged}
                  onStale={handleStale}
                />
              </>
            )
          )}
        </section>

        {readOnly ? (
          <ClosedPanel detail={detail} />
        ) : (
          <CompletePanel detail={detail} onCompleted={onCompleted} onStale={handleStale} />
        )}
      </div>
    </div>
  );
}

/**
 * «без решения | недостача шт | излишек шт» по строкам на экране — те же
 * правила, что `computeTotals` на сервере (`isLineUndecided` — зеркало
 * `isUndecided`: штучные строки решения не ждут, решение с неподходящим знаком
 * считается отсутствующим).
 */
function discrepancySignature(lines: StockCountLineView[]): string {
  let undecided = 0;
  let shortageQty = 0;
  let surplusQty = 0;
  for (const line of lines) {
    const diff = line.diff ?? 0;
    if (diff < 0) shortageQty += -diff;
    else if (diff > 0) surplusQty += diff;
    if (isLineUndecided(line)) undecided += 1;
  }
  return `${undecided}|${shortageQty}|${surplusQty}`;
}

function DiscrepancyGroup({
  title,
  tone,
  lines,
  suggestions,
  readOnly,
  detail,
  onLineChange,
  onRecount,
  onChanged,
  onStale,
}: {
  title: string;
  tone: "rose" | "emerald";
  lines: StockCountLineView[];
  suggestions: Record<string, TrailSuggestion | null>;
  readOnly: boolean;
  detail: StockCountDetail;
  onLineChange: (line: StockCountLineView) => void;
  onRecount: (line: StockCountLineView) => void;
  onChanged: () => void;
  onStale: () => void;
}) {
  const [filter, setFilter] = useState<GroupFilter | null>(null);
  // Решённые в этом заходе строки не исчезают из «без решения» сразу —
  // иначе строка уезжала бы из-под курсора в момент нажатия.
  const [sticky, setSticky] = useState<ReadonlySet<string>>(new Set());

  const undecided = lines.filter(isLineUndecided);
  const effective: GroupFilter = readOnly ? "all" : (filter ?? (undecided.length > 0 ? "undecided" : "all"));
  const visible = effective === "all" ? lines : lines.filter((l) => isLineUndecided(l) || sticky.has(l.id));
  const hiddenDecided = lines.length - visible.length;

  if (lines.length === 0) return null;

  const handleLineChange = (line: StockCountLineView) => {
    setSticky((prev) => new Set(prev).add(line.id));
    onLineChange(line);
  };

  const chip = (value: GroupFilter, label: string) => (
    <button
      type="button"
      aria-pressed={effective === value}
      onClick={() => {
        setFilter(value);
        setSticky(new Set());
      }}
      className={`whitespace-nowrap rounded-full border px-2.5 text-[11px] font-semibold leading-[1.7] transition-colors ${
        effective === value ? "border-accent bg-accent text-surface" : "border-border bg-surface text-ink-2 hover:text-ink"
      } ${FOCUS}`}
    >
      {label}
    </button>
  );

  return (
    <div className="border-b border-border last:border-b-0">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-border bg-surface-muted px-3.5 py-2">
        <h3 className={`font-cond text-sm font-bold ${tone === "rose" ? "text-rose" : "text-emerald"}`}>{title}</h3>
        <span className="mono-num text-[11.5px] font-semibold text-ink-3">{lines.length}</span>
        {!readOnly && (
          <div className="ml-auto flex items-center gap-1.5" role="group" aria-label={`Фильтр: ${title.toLowerCase()}`}>
            {chip("undecided", `без решения · ${undecided.length}`)}
            {chip("all", "все")}
          </div>
        )}
      </div>
      {visible.length === 0 ? (
        <p className="px-3.5 py-3 text-xs text-ink-3">По всем строкам решение принято.</p>
      ) : (
        <ul>
          {visible.map((line) => (
            <DiscrepancyRow
              key={line.id}
              stockCountId={detail.id}
              line={line}
              status={detail.status}
              suggestion={suggestions[line.id] ?? null}
              onLineChange={handleLineChange}
              onRecount={onRecount}
              onChanged={onChanged}
              onStale={onStale}
            />
          ))}
        </ul>
      )}
      {hiddenDecided > 0 && (
        <div className="flex flex-wrap gap-2.5 bg-surface-muted px-3.5 py-2 text-[11.5px] text-ink-2">
          <span>ещё {hiddenDecided} с решением</span>
          <button
            type="button"
            onClick={() => {
              setFilter("all");
              setSticky(new Set());
            }}
            className={`rounded-sm font-semibold text-accent-bright hover:underline ${FOCUS}`}
          >
            показать все
          </button>
        </div>
      )}
    </div>
  );
}
