"use client";

/**
 * «Начать инвентаризацию»: охват — весь склад (по умолчанию) или выбранные
 * категории (`GET /api/stock-counts/scope` — порядок каталога и сколько в
 * категории позиций с учётом количеством). Позиции со штучным учётом не
 * входят: их сверяют по единицам в карточке. Категорию, где пересчитывать
 * нечего (только штучные), выбрать нельзя — иначе старт упёрся бы в
 * «нет позиций для пересчёта».
 */

import { useEffect, useId, useState } from "react";

import { toast } from "../ToastProvider";
import { errorCode, explainInventoryError, inventoryApi } from "./api";
import type { StockCountDetail } from "./types";
import { BTN_PRIMARY, CARD, FOCUS } from "./ui";

type Scope = "all" | "categories";

export function StartInventoryPanel({
  onStarted,
  onAlreadyOpen,
}: {
  onStarted: (detail: StockCountDetail) => void;
  /** Кто-то уже начал — перейти в идущую. */
  onAlreadyOpen: () => void;
}) {
  const groupId = useId();
  const [scope, setScope] = useState<Scope>("all");
  const [categories, setCategories] = useState<string[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [unitCounts, setUnitCounts] = useState<Record<string, number>>({});
  const [catError, setCatError] = useState<string | null>(null);
  const [catReload, setCatReload] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (scope !== "categories" || categories) return;
    let cancelled = false;
    setCatError(null);
    inventoryApi
      .scope()
      .then((data) => {
        if (cancelled) return;
        setCategories(data.categories);
        setCounts(data.counts ?? {});
        setUnitCounts(data.unitCounts ?? {});
      })
      .catch((e: unknown) => {
        if (!cancelled) setCatError(explainInventoryError(e, "Не удалось загрузить категории"));
      });
    return () => {
      cancelled = true;
    };
  }, [scope, categories, catReload]);

  const toggle = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  /** Есть что пересчитать количеством. */
  const countable = categories ? categories.filter((c) => (counts[c] ?? 0) > 0) : [];
  const chosen = countable.filter((c) => selected.has(c));
  const allChosen = countable.length > 0 && chosen.length === countable.length;
  const canStart = !busy && (scope === "all" || chosen.length > 0);

  const start = async () => {
    if (!canStart) return;
    setBusy(true);
    try {
      const { stockCount } = await inventoryApi.start(scope === "all" ? null : chosen);
      toast.success(`Инвентаризация № ${stockCount.number} началась`);
      onStarted(stockCount);
    } catch (e) {
      toast.error(explainInventoryError(e, "Не удалось начать инвентаризацию"));
      if (errorCode(e) === "STOCK_COUNT_ALREADY_OPEN") onAlreadyOpen();
    } finally {
      setBusy(false);
    }
  };

  const radio = (value: Scope, label: string, hint: string) => (
    <label
      className={`flex cursor-pointer items-start gap-2.5 rounded border px-3 py-2 transition-colors ${
        scope === value ? "border-accent-border bg-accent-soft" : "border-border hover:bg-surface-muted"
      }`}
    >
      <input
        type="radio"
        name={groupId}
        value={value}
        checked={scope === value}
        onChange={() => setScope(value)}
        className={`mt-[3px] accent-accent-bright ${FOCUS}`}
      />
      <span>
        <span className="block text-[13px] font-semibold text-ink">{label}</span>
        <span className="block text-[11.5px] text-ink-2">{hint}</span>
      </span>
    </label>
  );

  return (
    <section className={CARD} aria-labelledby={`${groupId}-title`}>
      <div className="border-b border-border px-4 py-3">
        <h2 id={`${groupId}-title`} className="font-cond text-base font-bold text-ink">
          Начать инвентаризацию
        </h2>
        <p className="text-[11.5px] text-ink-2">что пересчитываем</p>
      </div>

      <fieldset className="space-y-2 px-4 py-3">
        <legend className="sr-only">Охват инвентаризации</legend>
        {radio("all", "Весь склад", "все позиции каталога — двое могут считать разные категории параллельно")}
        {radio("categories", "Выбранные категории", "например, только то, что чаще всего пропадает")}

        {scope === "categories" && (
          <div className="mt-1 rounded border border-border">
            {catError ? (
              <div className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-xs text-rose">
                <span>{catError}</span>
                <button
                  type="button"
                  onClick={() => {
                    setCategories(null);
                    setCatReload((k) => k + 1);
                  }}
                  className={`rounded-sm font-semibold underline ${FOCUS}`}
                >
                  Повторить
                </button>
              </div>
            ) : !categories ? (
              <p className="px-3 py-2.5 text-xs text-ink-3" aria-busy="true">
                Загружаем категории…
              </p>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2 border-b border-border bg-surface-muted px-3 py-1.5 text-[11.5px] text-ink-2">
                  <span>
                    выбрано {chosen.length} из {countable.length}
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelected(allChosen ? new Set() : new Set(countable))}
                    className={`rounded-sm font-semibold text-accent-bright hover:underline ${FOCUS}`}
                  >
                    {allChosen ? "снять все" : "выбрать все"}
                  </button>
                </div>
                <ul className="max-h-72 overflow-y-auto py-1">
                  {categories.map((name) => {
                    const n = counts[name] ?? 0;
                    const unitOnly = n === 0;
                    return (
                      <li key={name}>
                        <label
                          className={`flex items-center gap-2.5 px-3 py-1 text-[12.5px] ${
                            unitOnly ? "cursor-not-allowed text-ink-3" : "cursor-pointer text-ink hover:bg-surface-muted"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={!unitOnly && selected.has(name)}
                            disabled={unitOnly}
                            onChange={() => toggle(name)}
                            className={`accent-accent-bright ${FOCUS}`}
                          />
                          <span className="min-w-0 flex-1 truncate">{name}</span>
                          {unitOnly ? (
                            <span className="text-[11px] text-ink-3">
                              {(unitCounts[name] ?? 0) > 0
                                ? "только штучный учёт — сверяется в карточке единиц"
                                : "нет позиций"}
                            </span>
                          ) : (
                            <span className="mono-num text-[11px] text-ink-3">{n} поз.</span>
                          )}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>
        )}
      </fieldset>

      <p className="px-4 pb-3 text-[11.5px] leading-snug text-ink-3">
        Позиции со штучным учётом в инвентаризацию не входят — их сверяют по единицам в карточке оборудования.
      </p>

      <div className="border-t border-border bg-surface-muted px-4 py-3">
        <button type="button" onClick={() => void start()} disabled={!canStart} className={`${BTN_PRIMARY} w-full py-1.5`}>
          {busy ? "Начинаем…" : "Начать инвентаризацию"}
        </button>
        {scope === "categories" && categories && chosen.length === 0 && (
          <p className="mt-1.5 text-center text-[11px] text-ink-3">Отметьте хотя бы одну категорию</p>
        )}
      </div>
    </section>
  );
}
