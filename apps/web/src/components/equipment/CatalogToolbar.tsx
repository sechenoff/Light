"use client";

import Link from "next/link";

import { PeriodPopover } from "./PeriodPopover";
import { CategoryPopover } from "./CategoryPopover";
import {
  QUICK_PERIODS,
  formatVerbose,
  getQuickPeriod,
  matchesPreset,
  summarizePeriod,
} from "./catalogPeriod";

export type CatalogToolbarProps = {
  start: string;
  end: string;
  onPeriodChange: (range: { start: string; end: string }) => void;
  search: string;
  onSearchChange: (value: string) => void;
  category: string | undefined;
  categories: string[];
  categoryCounts: Record<string, number>;
  onCategoryChange: (category: string | undefined) => void;
  isSuperAdmin: boolean;
  bookingHref: string;
  /** Позиций сейчас в списке (после фильтров). */
  shownCount: number;
  /** Позиций в каталоге всего — сумма счётчиков категорий. 0 = ещё не загрузились. */
  totalCount: number;
  /** Позиций со свободным остатком на выбранный период; null — доступность не загружена. */
  availableCount: number | null;
  loadingCatalog: boolean;
  loadingAvail: boolean;
};

const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-bright";

/** Призрачная кнопка строки: рамка появляется только на наведении/фокусе. */
const GHOST =
  "inline-flex flex-none items-center gap-1.5 rounded border border-transparent px-2.5 text-xs font-medium text-ink-2 transition-colors hover:border-border hover:bg-surface-subtle hover:text-ink";

/**
 * Тулбар каталога — одна строка 40 px без карточки-обёртки: экран отдан таблице.
 * Контролы призрачные, единственный постоянно обведённый элемент — период,
 * потому что он определяет колонки «Занято / Доступно / Статус».
 *
 * Полоса липкая: на десктопе к верху вьюпорта, на мобильном — под шапкой
 * AppShell (она сама sticky top-0 z-20 высотой ≈46 px, отсюда top-12 — то же
 * смещение, что у CatalogBrowser в форме брони). z-10, чтобы не спорить с
 * этой шапкой и не перекрывать скрим мобильного меню (z-40).
 */
export function CatalogToolbar(props: CatalogToolbarProps) {
  const {
    start,
    end,
    onPeriodChange,
    search,
    onSearchChange,
    category,
    categories,
    categoryCounts,
    onCategoryChange,
    isSuperAdmin,
    bookingHref,
    shownCount,
    totalCount,
    availableCount,
    loadingCatalog,
    loadingAvail,
  } = props;

  const summary = summarizePeriod(start, end);
  const isFiltered = Boolean(search.trim() || category);

  return (
    <div className="sticky top-12 z-10 border-b border-border bg-surface lg:top-0">
      {/* ── Десктоп: одна строка ──────────────────────────────
          Три группы (период+пресеты / поиск+категория / действия) переносятся
          как целое. Перенос вместо жёсткого брейкпоинта потому, что ширину
          определяет не вьюпорт, а колонка контента: на 1024 сайдбар забирает
          224 px, и 800 px семь кластеров в 40 px уже не держат. Так строка
          честно становится двумя, а не уезжает в горизонтальный скролл. */}
      <div className="hidden min-h-[40px] flex-wrap items-center gap-x-1.5 gap-y-1 px-4 py-1 md:flex lg:px-6">
        <div className="flex flex-none items-center gap-1.5">
        <PeriodPopover start={start} end={end} onApply={onPeriodChange} />

        <div className="flex flex-none items-center gap-0.5" role="group" aria-label="Быстрый выбор периода">
          {QUICK_PERIODS.map((p) => {
            const isActive = matchesPreset(start, end, p.type);
            return (
              <button
                key={p.type}
                type="button"
                title={p.hint}
                aria-pressed={isActive}
                onClick={() => onPeriodChange(getQuickPeriod(p.type))}
                className={`h-7 rounded border px-2.5 text-xs transition-colors ${
                  isActive
                    ? "border-accent-border bg-accent-soft font-semibold text-accent-bright"
                    : "border-transparent font-medium text-ink-2 hover:bg-surface-subtle hover:text-ink"
                } ${FOCUS_RING}`}
              >
                {p.label}
              </button>
            );
          })}
        </div>

        </div>

        <span aria-hidden className="mx-1 hidden h-4 w-px flex-none bg-border xl:block" />

        <div className="flex min-w-0 flex-[1_1_260px] items-center gap-1.5">
          {/* Поиск — единственный сжимаемый элемент группы: при нехватке ширины
              страдает плейсхолдер, а не кластеры. */}
          <SearchField
            value={search}
            onChange={onSearchChange}
            className="h-7 min-w-[150px] flex-[0_1_238px]"
          />

          <CategoryPopover
            categories={categories}
            counts={categoryCounts}
            value={category}
            onChange={onCategoryChange}
          />
        </div>

        <div className="ml-auto flex flex-none items-center gap-1.5">
        {isSuperAdmin && (
          <Link
            href="/equipment/manage"
            aria-label="Управление каталогом"
            title="Управление каталогом"
            className={`${GHOST} h-7 ${FOCUS_RING}`}
          >
            <SlidersIcon />
            {/* Порог 2xl, а не xl: на 1280 сайдбар съедает 224 px, и на xl
                подпись уже не влезала — строка уезжала в горизонтальный скролл. */}
            <span className="hidden 2xl:inline">Управление каталогом</span>
          </Link>
        )}
        <Link
          href={bookingHref}
          className={`inline-flex h-7 flex-none items-center gap-1.5 rounded bg-accent-bright px-3 text-xs font-semibold text-surface transition-colors hover:bg-accent ${FOCUS_RING}`}
        >
          <PlusIcon />
          Создать бронь
        </Link>
        </div>
      </div>

      {/* ── Мобильный: два ряда, тач-таргеты 44 px ───────────── */}
      <div className="md:hidden">
        <div className="flex items-center gap-2 px-4 pt-2">
          <PeriodPopover start={start} end={end} onApply={onPeriodChange} variant="mobile" />
          {isSuperAdmin && (
            <Link
              href="/equipment/manage"
              aria-label="Управление каталогом"
              className={`flex h-11 w-11 flex-none items-center justify-center rounded border border-border bg-surface text-ink-2 ${FOCUS_RING}`}
            >
              <SlidersIcon />
            </Link>
          )}
          <Link
            href={bookingHref}
            aria-label="Создать бронь"
            className={`flex h-11 w-11 flex-none items-center justify-center rounded bg-accent-bright text-surface ${FOCUS_RING}`}
          >
            <PlusIcon />
          </Link>
        </div>
        <div className="flex items-center gap-2 px-4 pb-1.5 pt-2">
          <SearchField value={search} onChange={onSearchChange} className="h-11 flex-1" />
          <CategoryPopover
            categories={categories}
            counts={categoryCounts}
            value={category}
            onChange={onCategoryChange}
            variant="mobile"
          />
        </div>
        {/* Пресеты остаются на экране и на мобильном: они же есть в редакторе
            периода, но там это два тапа вместо одного — а смена «сегодня /
            завтра» и есть самое частое действие кладовщика. */}
        <div className="flex flex-wrap gap-1 px-4 pb-1.5" role="group" aria-label="Быстрый выбор периода">
          {QUICK_PERIODS.map((p) => {
            const isActive = matchesPreset(start, end, p.type);
            return (
              <button
                key={p.type}
                type="button"
                aria-pressed={isActive}
                onClick={() => onPeriodChange(getQuickPeriod(p.type))}
                className={`h-7 rounded border px-3 text-xs transition-colors ${
                  isActive
                    ? "border-accent-border bg-accent-soft font-semibold text-accent-bright"
                    : "border-border font-medium text-ink-2"
                } ${FOCUS_RING}`}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Служебный подвал: длительность слева, счётчики справа ── */}
      <div className="flex items-center justify-between gap-3 border-t border-border bg-surface-muted px-4 py-1 text-[11.5px] text-ink-2 lg:px-6">
        <div className="min-w-0 truncate">
          {summary ? (
            <>
              <b className="font-semibold text-ink">{summary.shiftsLabel}</b>
              <Dot />
              <span className="hidden sm:inline">
                {formatVerbose(start)} → {formatVerbose(end)}
                <Dot />
              </span>
              <span className="mono-num">{summary.hoursLabel}</span>
            </>
          ) : (
            "Период не задан"
          )}
        </div>
        <div className="flex-none truncate" role="status" aria-live="polite">
          {loadingCatalog ? (
            "Загрузка каталога…"
          ) : (
            <>
              {isFiltered && totalCount > 0 ? (
                <>
                  <span className="hidden sm:inline">
                    Позиций <span className="mono-num">{totalCount}</span>
                    <Dot />
                  </span>
                  в фильтре <span className="mono-num">{shownCount}</span>
                </>
              ) : (
                <>
                  Позиций <span className="mono-num">{shownCount}</span>
                </>
              )}
              <Dot />
              {loadingAvail ? (
                "считаем свободные…"
              ) : availableCount === null ? (
                "доступность недоступна"
              ) : (
                <>
                  свободно <span className="mono-num">{availableCount}</span>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Dot() {
  return (
    <span aria-hidden className="mx-1.5 text-border-strong">
      ·
    </span>
  );
}

function SearchField({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  className: string;
}) {
  return (
    <div
      className={`flex min-w-0 items-center gap-1.5 rounded border border-transparent px-2 transition-colors hover:bg-surface-subtle focus-within:border-accent-bright focus-within:bg-surface focus-within:ring-4 focus-within:ring-accent-soft ${className}`}
    >
      <SearchIcon />
      <input
        value={value}
        aria-label="Поиск по каталогу"
        placeholder="Название, бренд, модель"
        onChange={(e) => onChange(e.target.value)}
        // h-full, а не натуральная высота: обёртка на мобильном 44 px, и без
        // растяжения тапабельны только 16 px в её центре — палец в 6 px от
        // края визуального поля попадал по div, и поле не фокусировалось.
        className="h-full w-full min-w-0 border-0 bg-transparent text-xs text-ink outline-none placeholder:text-ink-2"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Очистить поиск"
          className={`flex h-6 w-6 flex-none items-center justify-center rounded text-ink-2 transition-colors hover:bg-border hover:text-ink ${FOCUS_RING}`}
        >
          <svg aria-hidden width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}

function SearchIcon() {
  return (
    <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" className="flex-none text-ink-2">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.2-3.2" />
    </svg>
  );
}

function SlidersIcon() {
  return (
    <svg aria-hidden width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="flex-none">
      <path d="M4 6h16M4 12h16M4 18h10" />
      <circle cx="18" cy="18" r="2.6" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg aria-hidden width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="flex-none">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
