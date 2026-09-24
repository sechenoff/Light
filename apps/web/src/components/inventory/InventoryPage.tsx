"use client";

/**
 * /warehouse/inventory/[id] — страница инвентаризации (мокап, экраны 1–2).
 *
 * Оркестратор: шапка, подменю склада, переключатель «Счёт · Итог» и один из
 * двух экранов. Вид и категория живут в URL (`?view=count|review&category=`),
 * чтобы ссылкой можно было поделиться и «назад» работало.
 *
 * По умолчанию, пока идёт счёт и есть непосчитанные строки, открывается
 * «Счёт», иначе «Итог». Завершённая / отменённая — только «Итог», на чтение.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { useRequireRole } from "../../hooks/useRequireRole";
import { WarehouseSubnav } from "../warehouse/WarehouseSubnav";
import { CategoryRail } from "./CategoryRail";
import { CountLinesPanel } from "./CountLinesPanel";
import { InventoryHeader } from "./InventoryHeader";
import { ReviewPanel } from "./ReviewPanel";
import type { StockCountDetail, StockCountLineView } from "./types";
import { useStockCount } from "./useStockCount";
import { BTN_PRIMARY, FOCUS, LINK } from "./ui";

type View = "count" | "review";

function defaultView(detail: StockCountDetail): View {
  return detail.status === "OPEN" && detail.totals.counted < detail.totals.lines ? "count" : "review";
}

function defaultCategory(detail: StockCountDetail): string | null {
  const cats = detail.categoryProgress;
  return (cats.find((c) => c.counted < c.lines) ?? cats[0])?.category ?? null;
}

export function InventoryPage({ id }: { id: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { authorized, loading: authLoading } = useRequireRole(["SUPER_ADMIN", "WAREHOUSE"]);
  const { detail, loading, error, notFound, reload, scheduleReload, setDetail } = useStockCount(id, authorized);

  // Умолчания замораживаются при первой загрузке: иначе последняя посчитанная
  // строка сама перебрасывала бы на «Итог», а готовая категория — на следующую.
  const [initial, setInitial] = useState<{ view: View; category: string | null } | null>(null);
  const [focusLineId, setFocusLineId] = useState<string | null>(null);

  useEffect(() => {
    if (detail && !initial) setInitial({ view: defaultView(detail), category: defaultCategory(detail) });
  }, [detail, initial]);

  const setQuery = useCallback(
    (patch: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      for (const [key, value] of Object.entries(patch)) {
        if (value == null) params.delete(key);
        else params.set(key, value);
      }
      const qs = params.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const handleRecount = useCallback(
    (line: StockCountLineView) => {
      setFocusLineId(line.id);
      setQuery({ view: "count", category: line.category });
    },
    [setQuery],
  );

  const handleFinished = useCallback(
    (next: StockCountDetail) => {
      setDetail(next);
      setQuery({ view: null, category: null });
    },
    [setDetail, setQuery],
  );

  if (authLoading) return <p className="p-6 text-sm text-ink-3">Проверка доступа…</p>;
  if (!authorized) return null;

  if (!detail) {
    return (
      <div className="mx-auto w-full max-w-[1240px] p-4 lg:p-6">
        {loading ? (
          <div aria-busy="true" aria-label="Загрузка инвентаризации" className="space-y-3">
            <div className="h-8 w-64 animate-pulse rounded bg-surface-subtle" />
            <div className="h-5 w-96 max-w-full animate-pulse rounded bg-surface-subtle" />
            <div className="h-64 animate-pulse rounded-lg bg-surface-subtle" />
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-surface px-4 py-10 text-center shadow-xs">
            <p className="text-sm font-medium text-ink-2">{notFound ? "Инвентаризация не найдена" : error}</p>
            <div className="mt-3 flex justify-center gap-4">
              {!notFound && (
                <button type="button" onClick={() => void reload()} className={LINK}>
                  Повторить
                </button>
              )}
              <Link href="/warehouse/inventory/history" className={LINK}>
                История инвентаризаций
              </Link>
            </div>
          </div>
        )}
      </div>
    );
  }

  const isOpen = detail.status === "OPEN";
  const viewParam = searchParams?.get("view");
  const view: View = !isOpen
    ? "review"
    : viewParam === "count" || viewParam === "review"
      ? viewParam
      : (initial?.view ?? defaultView(detail));
  const categoryParam = searchParams?.get("category");
  const selectedName =
    (categoryParam && detail.categoryProgress.some((c) => c.category === categoryParam) ? categoryParam : null) ??
    initial?.category ??
    defaultCategory(detail);
  const selected = detail.categoryProgress.find((c) => c.category === selectedName) ?? null;
  const uncounted = detail.totals.lines - detail.totals.counted;

  return (
    <div className="mx-auto w-full max-w-[1240px] p-4 pb-24 lg:p-6 lg:pb-24">
      <InventoryHeader
        detail={detail}
        onCancelled={handleFinished}
        onStale={() => void reload()}
        extraAction={
          isOpen && view === "review" && uncounted > 0 ? (
            <button type="button" onClick={() => setQuery({ view: "count" })} className={BTN_PRIMARY}>
              Продолжить счёт
            </button>
          ) : undefined
        }
      />
      <div className="mt-3">
        <WarehouseSubnav
          active={isOpen ? "inventory" : "history"}
          badges={isOpen ? { inventory: `№ ${detail.number} · идёт` } : undefined}
        />
      </div>

      {isOpen && (
        <ViewSwitch
          view={view}
          counted={detail.totals.counted}
          lines={detail.totals.lines}
          undecided={detail.totals.undecided}
          discrepancies={detail.totals.shortagePositions + detail.totals.surplusPositions}
          onChange={(next) => setQuery({ view: next })}
        />
      )}

      {view === "count" ? (
        <div className="mt-3.5 grid items-start gap-3.5 xl:grid-cols-[292px_minmax(0,1fr)]">
          <CategoryRail
            detail={detail}
            selected={selected?.category ?? null}
            onSelect={(category) => {
              setFocusLineId(null);
              setQuery({ category });
            }}
          />
          {selected ? (
            <CountLinesPanel
              stockCountId={detail.id}
              category={selected}
              readOnly={!isOpen}
              focusLineId={focusLineId}
              onChanged={scheduleReload}
            />
          ) : (
            <p className="rounded-lg border border-border bg-surface px-4 py-8 text-center text-sm text-ink-3">
              В охвате нет позиций для пересчёта
            </p>
          )}
        </div>
      ) : (
        <div className="mt-3.5">
          <ReviewPanel
            detail={detail}
            onChanged={scheduleReload}
            onStale={() => void reload()}
            onRecount={handleRecount}
            onCompleted={(next) => handleFinished(next)}
          />
        </div>
      )}
    </div>
  );
}

function ViewSwitch({
  view,
  counted,
  lines,
  undecided,
  discrepancies,
  onChange,
}: {
  view: View;
  counted: number;
  lines: number;
  undecided: number;
  discrepancies: number;
  onChange: (view: View) => void;
}) {
  const item = (value: View, label: string, meta: string) => (
    <button
      type="button"
      aria-pressed={view === value}
      onClick={() => onChange(value)}
      className={`inline-flex items-center gap-1.5 border-r border-border px-3.5 py-1.5 text-[12.5px] font-semibold transition-colors last:border-r-0 ${
        view === value ? "bg-accent text-surface" : "text-ink-2 hover:bg-surface-muted hover:text-ink"
      } ${FOCUS} focus-visible:outline-offset-[-2px]`}
    >
      {label}
      <span className={`mono-num text-[11px] font-normal ${view === value ? "text-surface" : "text-ink-3"}`}>{meta}</span>
    </button>
  );
  return (
    <div className="mt-3.5 flex flex-wrap items-center gap-3">
      <div role="group" aria-label="Экран инвентаризации" className="inline-flex overflow-hidden rounded border border-border bg-surface shadow-xs">
        {item("count", "Счёт", `${counted}/${lines}`)}
        {item("review", "Итог", undecided > 0 ? `без решения ${undecided}` : `расхождений ${discrepancies}`)}
      </div>
    </div>
  );
}
