"use client";

/**
 * Шаг 1 счёта в киоске — выбор участка (категории каталога).
 *
 * Участок: название, кто считает и сколько расхождений (второй строкой),
 * справа — узкий блок «посчитано / всего» с зелёной галочкой для законченных,
 * как в мокапе («✓ 51/51»). Всё переменной ширины живёт под названием: иначе
 * на 375 px две плашки съедали строку и название участка исчезало.
 * Двое считают параллельно — каждый берёт свой.
 * Порядок — как в каталоге (сервер отдаёт categoryProgress в порядке строк).
 */

import type { StockCountDetail } from "../inventory/types";
import { pluralize } from "../../lib/format";
import { countersText } from "./StockCountFormat";

export function StockCountCategoryList({
  detail,
  onOpen,
}: {
  detail: StockCountDetail;
  onOpen: (category: string) => void;
}) {
  const { totals, categoryProgress, unitModeExcluded, categories } = detail;
  const scope = categories && categories.length > 0
    ? `${categories.length} ${pluralize(categories.length, "категория", "категории", "категорий")}`
    : "весь склад";

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 px-3 py-3 lg:px-5 lg:py-4">
      <section className="rounded-lg border border-border bg-surface px-3.5 py-3 shadow-xs">
        <p className="eyebrow">Охват: {scope}</p>
        <p className="mt-1 text-[13px] text-ink-2">
          посчитано <b className="mono-num text-ink">{totals.counted}</b> из{" "}
          <b className="mono-num text-ink">{totals.lines}</b>{" "}
          {pluralize(totals.lines, "позиции", "позиций", "позиций")}
          {totals.counted > 0 && (
            <>
              {" "}· сошлось <b className="mono-num text-ink">{totals.matched}</b>
            </>
          )}
        </p>
        <p className="mt-1.5 text-[11.5px] leading-snug text-ink-3">
          Выберите участок. Каждая строка сохраняется сразу — «Пауза» ничего не
          теряет. Решения по расхождениям руководитель примет после счёта.
        </p>
      </section>

      {categoryProgress.length === 0 ? (
        <p className="rounded-lg border border-border bg-surface px-3.5 py-6 text-center text-sm text-ink-3">
          В этой инвентаризации нет позиций для счёта.
        </p>
      ) : (
        <ul className="overflow-hidden rounded-lg border border-border bg-surface shadow-xs">
          {categoryProgress.map((c) => {
            const done = c.lines > 0 && c.counted >= c.lines;
            return (
              <li key={c.category} className="border-b border-surface-subtle last:border-b-0">
                <button
                  type="button"
                  onClick={() => onOpen(c.category)}
                  className={`flex min-h-[56px] w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-bright sm:gap-3 ${
                    done ? "bg-surface-muted" : ""
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block truncate text-[14px] font-semibold ${done ? "text-ink-2" : "text-ink"}`}
                    >
                      {c.category}
                    </span>
                    <span className="block truncate text-[11.5px] text-ink-3">
                      {countersText(c)}
                      {c.discrepancies > 0 && (
                        <>
                          {" · "}
                          <span className="font-semibold text-rose">
                            {c.discrepancies}{" "}
                            {pluralize(c.discrepancies, "расхождение", "расхождения", "расхождений")}
                          </span>
                        </>
                      )}
                    </span>
                  </span>
                  <span
                    className={`mono-num flex shrink-0 items-center gap-1 text-[12.5px] font-semibold ${done ? "text-emerald" : "text-ink-2"}`}
                  >
                    {done && (
                      <>
                        <svg
                          aria-hidden
                          viewBox="0 0 24 24"
                          className="h-3.5 w-3.5"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2.5}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="m5 12 5 5L20 7" />
                        </svg>
                        <span className="sr-only">посчитано, </span>
                      </>
                    )}
                    <span>
                      {c.counted} / {c.lines}
                    </span>
                  </span>
                  <span aria-hidden className="shrink-0 text-[18px] leading-none text-ink-3">
                    ›
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {unitModeExcluded > 0 && (
        <p className="px-1 text-[11.5px] text-ink-3">
          {unitModeExcluded}{" "}
          {pluralize(
            unitModeExcluded,
            "позиция со штучным учётом сверяется",
            "позиции со штучным учётом сверяются",
            "позиций со штучным учётом сверяются",
          )}{" "}
          в карточке единиц.
        </p>
      )}
    </div>
  );
}
