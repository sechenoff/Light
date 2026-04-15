"use client";

import { Fragment, useEffect, useState, useMemo, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { apiFetch } from "../../src/lib/api";
import { CalendarTooltip } from "../../src/components/CalendarTooltip";
import { buildOccupancyMap, type CalendarEvent } from "../../src/lib/calendarUtils";
import { format, parseISO } from "date-fns";
import { ru } from "date-fns/locale";

// ──────────────────────────────────────────────────────────────────
// Типы
// ──────────────────────────────────────────────────────────────────

type CalendarResource = {
  id: string;
  name: string;
  category: string;
  totalQuantity: number;
  trackingMode: "COUNT" | "UNIT";
};

type CalendarResponse = {
  resources: CalendarResource[];
  events: CalendarEvent[];
};

// ──────────────────────────────────────────────────────────────────
// Вспомогательные функции
// ──────────────────────────────────────────────────────────────────

function addDaysStr(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function buildDays(start: string, count: number): string[] {
  const days: string[] = [];
  for (let i = 0; i < count; i++) {
    days.push(addDaysStr(start, i));
  }
  return days;
}

function formatDayHeader(dateStr: string): string {
  const d = parseISO(dateStr + "T12:00:00Z");
  return format(d, "EE d", { locale: ru });
}

function formatDayRu(dateStr: string): string {
  const d = parseISO(dateStr + "T12:00:00Z");
  return format(d, "EEEE, d MMMM", { locale: ru });
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function cellColorClass(occupied: number, total: number): string {
  if (occupied === 0) return "text-emerald";
  if (total === 0) return "text-ink-3";
  const pct = occupied / total;
  if (pct >= 0.8) return "text-rose bg-rose-soft";
  return "text-amber bg-amber-soft";
}

// ──────────────────────────────────────────────────────────────────
// Скелетон загрузки
// ──────────────────────────────────────────────────────────────────

function SkeletonDesktop() {
  return (
    <div className="animate-pulse space-y-2">
      <div className="h-8 bg-surface-muted rounded w-full" />
      {[...Array(5)].map((_, i) => (
        <div key={i} className="h-10 bg-surface rounded w-full" />
      ))}
    </div>
  );
}

function SkeletonMobile() {
  return (
    <div className="animate-pulse space-y-3">
      {[...Array(4)].map((_, i) => (
        <div key={i} className="h-24 bg-surface rounded-lg w-full" />
      ))}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Главная страница
// ──────────────────────────────────────────────────────────────────

function CalendarPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // ── Ключ повтора для retry ──
  const [retryKey, setRetryKey] = useState(0);

  // ── Состояние параметров ──
  const [period, setPeriod] = useState<number>(() => {
    const p = Number(searchParams.get("period"));
    return [7, 14, 30].includes(p) ? p : 7;
  });
  const [category, setCategory] = useState<string>(
    () => searchParams.get("category") ?? ""
  );
  const [search, setSearch] = useState<string>(
    () => searchParams.get("search") ?? ""
  );
  const [includeDrafts, setIncludeDrafts] = useState<boolean>(false);
  const [periodStart, setPeriodStart] = useState<string>(
    () => searchParams.get("date") ?? todayStr()
  );
  // Мобильный выбранный день
  const [mobileDay, setMobileDay] = useState<string>(
    () => searchParams.get("date") ?? todayStr()
  );

  // ── Данные ──
  const [resources, setResources] = useState<CalendarResource[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ── Свёрнутые категории ──
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // ── Вычисляем конец периода ──
  const periodEnd = addDaysStr(periodStart, period - 1);
  const days = buildDays(periodStart, period);
  const today = todayStr();

  // ── Обновляем URL при изменении параметров ──
  const syncUrl = useCallback(
    (date: string, per: number, cat: string, q: string) => {
      const params = new URLSearchParams();
      params.set("date", date);
      params.set("period", String(per));
      if (cat) params.set("category", cat);
      if (q) params.set("search", q);
      router.replace(`/calendar?${params.toString()}`);
    },
    [router]
  );

  // ── Загрузка данных ──
  const fetchData = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          start: periodStart,
          end: periodEnd,
        });
        if (category) params.set("category", category);
        if (includeDrafts) params.set("includeDrafts", "true");

        const data = await apiFetch<CalendarResponse>(
          `/api/calendar?${params.toString()}`,
          { signal }
        );
        setResources(data.resources);
        setEvents(data.events);

        // Собираем уникальные категории из ресурсов
        const cats = [...new Set(data.resources.map((r) => r.category))].sort();
        setCategories(cats);
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Ошибка загрузки");
      } finally {
        setLoading(false);
      }
    },
    [periodStart, periodEnd, category, includeDrafts]
  );

  useEffect(() => {
    const controller = new AbortController();
    fetchData(controller.signal);
    return () => controller.abort();
  }, [fetchData, retryKey]);

  // ── Фильтрация ресурсов по поисковому запросу (клиентская сторона) ──
  const filteredResources = useMemo(() => {
    if (!search.trim()) return resources;
    const needle = search.trim().toLowerCase();
    return resources.filter((r) => r.name.toLowerCase().includes(needle));
  }, [resources, search]);

  // ── Фильтрация событий для отображаемых ресурсов ──
  const filteredEvents = useMemo(() => {
    const resourceIds = new Set(filteredResources.map((r) => r.id));
    return events.filter((e) => resourceIds.has(e.resourceId));
  }, [events, filteredResources]);

  // ── Карта занятости ──
  const occupancyMap = useMemo(
    () => buildOccupancyMap(filteredEvents, periodStart, periodEnd),
    [filteredEvents, periodStart, periodEnd]
  );

  // ── Группировка ресурсов по категории ──
  const grouped = useMemo(() => {
    const map = new Map<string, CalendarResource[]>();
    for (const r of filteredResources) {
      const arr = map.get(r.category) ?? [];
      arr.push(r);
      map.set(r.category, arr);
    }
    return map;
  }, [filteredResources]);

  // ── Навигация по периоду ──
  function navPrev() {
    const newStart = addDaysStr(periodStart, -period);
    setPeriodStart(newStart);
    setMobileDay(newStart);
    syncUrl(newStart, period, category, search);
  }
  function navNext() {
    const newStart = addDaysStr(periodStart, period);
    setPeriodStart(newStart);
    setMobileDay(newStart);
    syncUrl(newStart, period, category, search);
  }
  function goToday() {
    setPeriodStart(today);
    setMobileDay(today);
    syncUrl(today, period, category, search);
  }

  function toggleCategory(cat: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }

  // ── Мобильная навигация ──
  function mobilePrevDay() {
    setMobileDay((d) => addDaysStr(d, -1));
  }
  function mobileNextDay() {
    setMobileDay((d) => addDaysStr(d, 1));
  }

  // ── Карточки для мобильного дня ──
  const mobileDayResources = useMemo(() => {
    return filteredResources.filter((r) => {
      const entry = occupancyMap.get(`${r.id}-${mobileDay}`);
      return entry && entry.occupied > 0;
    });
  }, [filteredResources, occupancyMap, mobileDay]);

  const showAllMobile = mobileDayResources.length === 0;
  const mobileDisplayResources = showAllMobile ? filteredResources : mobileDayResources;

  // ── Поиск: применяем с задержкой или кнопкой ──
  function applySearch() {
    syncUrl(periodStart, period, category, search);
  }

  // ── Пустое состояние ──
  const isEmpty = !loading && !error && filteredResources.length === 0;

  return (
    <div className="p-4 lg:p-6 space-y-4">
      <h1 className="text-xl font-semibold text-ink">Календарь</h1>

      {/* ================================================================
          ДЕСКТОПНЫЙ ВИД
      ================================================================ */}
      <div className="hidden lg:block">
        {/* Тулбар */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          {/* Период */}
          <div className="flex rounded-md border border-border overflow-hidden text-sm">
            {([7, 14, 30] as const).map((p) => (
              <button
                key={p}
                onClick={() => {
                  setPeriod(p);
                  syncUrl(periodStart, p, category, search);
                }}
                className={`px-3 py-1.5 transition-colors ${
                  period === p
                    ? "bg-accent text-white"
                    : "bg-surface text-ink-2 hover:bg-surface-muted"
                }`}
              >
                {p} дн.
              </button>
            ))}
          </div>

          {/* Категория */}
          <select
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              syncUrl(periodStart, period, e.target.value, search);
            }}
            className="border border-border rounded-md px-3 py-1.5 text-sm bg-surface text-ink-2 focus:outline-none focus:ring-2 focus:ring-accent-bright"
          >
            <option value="">Все категории</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>

          {/* Поиск */}
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && applySearch()}
            placeholder="Поиск..."
            className="border border-border rounded-md px-3 py-1.5 text-sm w-48 focus:outline-none focus:ring-2 focus:ring-accent-bright"
          />

          {/* Черновики */}
          <label className="flex items-center gap-2 text-sm text-ink-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeDrafts}
              onChange={(e) => setIncludeDrafts(e.target.checked)}
              className="rounded border-border"
            />
            Показывать черновики
          </label>

          {/* Навигация */}
          <div className="flex items-center gap-1 ml-auto">
            <button
              onClick={navPrev}
              className="px-2 py-1.5 text-sm border border-border rounded-md hover:bg-surface-muted transition-colors"
              title="Предыдущий период"
            >
              ←
            </button>
            <button
              onClick={goToday}
              className="px-3 py-1.5 text-sm border border-border rounded-md hover:bg-surface-muted transition-colors"
            >
              Сегодня
            </button>
            <button
              onClick={navNext}
              className="px-2 py-1.5 text-sm border border-border rounded-md hover:bg-surface-muted transition-colors"
              title="Следующий период"
            >
              →
            </button>
          </div>
        </div>

        {/* Ошибка */}
        {error && (
          <div className="text-sm text-rose bg-rose-soft border border-rose-border rounded-md p-3 flex items-center justify-between gap-2 mb-4">
            <span>{error}</span>
            <button
              onClick={() => setRetryKey((k) => k + 1)}
              className="text-rose underline shrink-0"
            >
              Повторить
            </button>
          </div>
        )}

        {/* Скелетон */}
        {loading && <SkeletonDesktop />}

        {/* Пустое состояние */}
        {isEmpty && (
          <p className="text-sm text-ink-3 text-center py-12">
            Нет оборудования для отображения в этом периоде.
            <br />
            Добавьте оборудование для просмотра календаря.
          </p>
        )}

        {/* Таблица */}
        {!loading && !error && !isEmpty && (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-surface-subtle border-b border-border">
                  <th className="text-left px-3 py-2 font-medium text-ink-2 whitespace-nowrap min-w-[180px] sticky left-0 bg-surface-subtle">
                    Оборудование
                  </th>
                  {days.map((d) => (
                    <th
                      key={d}
                      className={`text-center px-2 py-2 font-medium text-ink-2 whitespace-nowrap min-w-[52px] ${
                        d === today
                          ? "bg-accent-soft text-accent"
                          : ""
                      }`}
                    >
                      {formatDayHeader(d)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...grouped.entries()].map(([cat, catResources]) => (
                  <Fragment key={cat}>
                    {/* Заголовок категории */}
                    <tr
                      className="bg-surface-subtle border-b border-border cursor-pointer hover:bg-surface-muted transition-colors"
                      onClick={() => toggleCategory(cat)}
                    >
                      <td
                        colSpan={days.length + 1}
                        className="px-3 py-1.5 font-semibold text-ink-2 text-xs uppercase tracking-wide"
                      >
                        <span className="mr-2">
                          {collapsed.has(cat) ? "▸" : "▾"}
                        </span>
                        {cat}
                        <span className="ml-2 text-ink-3 font-normal">
                          ({catResources.length})
                        </span>
                      </td>
                    </tr>

                    {/* Строки оборудования */}
                    {!collapsed.has(cat) &&
                      catResources.map((resource) => (
                        <tr
                          key={resource.id}
                          className="border-b border-border hover:bg-surface-muted transition-colors"
                        >
                          <td className="px-3 py-1.5 text-ink whitespace-nowrap sticky left-0 bg-surface hover:bg-surface-muted max-w-[220px] truncate">
                            {resource.name}
                          </td>
                          {days.map((d) => {
                            const entry = occupancyMap.get(
                              `${resource.id}-${d}`
                            );
                            const occupied = entry?.occupied ?? 0;
                            const bookingsOnDay = entry?.bookings ?? [];
                            const colorClass = cellColorClass(
                              occupied,
                              resource.totalQuantity
                            );

                            // Для черновиков — opacity-50
                            const isDraftOnly =
                              bookingsOnDay.length > 0 &&
                              bookingsOnDay.every((b) => b.status === "DRAFT");

                            return (
                              <td
                                key={d}
                                className={`text-center px-1 py-1.5 ${
                                  d === today ? "bg-accent-soft/50" : ""
                                }`}
                              >
                                {bookingsOnDay.length > 0 ? (
                                  <CalendarTooltip
                                    equipmentName={resource.name}
                                    date={d}
                                    occupiedCount={occupied}
                                    totalCount={resource.totalQuantity}
                                    bookings={bookingsOnDay.map((b) => ({
                                      id: b.bookingId,
                                      projectName: b.title,
                                      clientName: b.clientName,
                                      start: b.start,
                                      end: b.end,
                                      quantity: b.quantity,
                                      status: b.status,
                                    }))}
                                  >
                                    <span
                                      className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium cursor-default ${colorClass} ${
                                        isDraftOnly ? "opacity-50" : ""
                                      }`}
                                    >
                                      {occupied}/{resource.totalQuantity}
                                    </span>
                                  </CalendarTooltip>
                                ) : (
                                  <span className={`text-xs ${cellColorClass(0, resource.totalQuantity)}`}>
                                    0/{resource.totalQuantity}
                                  </span>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ================================================================
          МОБИЛЬНЫЙ ВИД
      ================================================================ */}
      <div className="lg:hidden space-y-4">
        {/* Тулбар мобильный */}
        <div className="flex gap-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && applySearch()}
            placeholder="Поиск оборудования..."
            className="flex-1 border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-bright"
          />
          <select
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              syncUrl(periodStart, period, e.target.value, search);
            }}
            className="border border-border rounded-md px-2 py-2 text-sm bg-surface text-ink-2 focus:outline-none focus:ring-2 focus:ring-accent-bright"
          >
            <option value="">Все</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <button
            onClick={goToday}
            className="px-3 py-2 text-sm border border-border rounded-md hover:bg-surface-muted transition-colors shrink-0"
          >
            Сегодня
          </button>
        </div>

        {/* Навигация по дням */}
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={mobilePrevDay}
            disabled={mobileDay <= periodStart}
            className="px-3 py-2 text-sm border border-border rounded-md hover:bg-surface-muted transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            ← Пред. день
          </button>
          <span className="text-sm text-ink-2 font-medium text-center">
            {capitalize(formatDayRu(mobileDay))}
          </span>
          <button
            onClick={mobileNextDay}
            disabled={mobileDay >= periodEnd}
            className="px-3 py-2 text-sm border border-border rounded-md hover:bg-surface-muted transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            След. день →
          </button>
        </div>

        {/* Ошибка */}
        {error && (
          <div className="text-sm text-rose bg-rose-soft border border-rose-border rounded-md p-3 flex items-center justify-between gap-2">
            <span>{error}</span>
            <button
              onClick={() => setRetryKey((k) => k + 1)}
              className="text-rose underline shrink-0"
            >
              Повторить
            </button>
          </div>
        )}

        {/* Скелетон */}
        {loading && <SkeletonMobile />}

        {/* Пустое состояние */}
        {isEmpty && (
          <p className="text-sm text-ink-3 text-center py-8">
            Нет оборудования. Добавьте оборудование для просмотра календаря.
          </p>
        )}

        {/* Карточки оборудования */}
        {!loading && !error && !isEmpty && (
          <div className="space-y-3">
            {showAllMobile && (
              <p className="text-xs text-ink-3 text-center py-2">
                На этот день нет бронирований — показывается всё оборудование
              </p>
            )}
            {mobileDisplayResources.map((resource) => {
              const entry = occupancyMap.get(`${resource.id}-${mobileDay}`);
              const occupied = entry?.occupied ?? 0;
              const bookingsOnDay = entry?.bookings ?? [];
              const colorClass = cellColorClass(
                occupied,
                resource.totalQuantity
              );

              return (
                <div
                  key={resource.id}
                  className="rounded-lg border border-border bg-surface p-3 space-y-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-ink truncate">
                      {resource.name}
                    </span>
                    <span
                      className={`text-xs font-medium px-2 py-0.5 rounded shrink-0 ${
                        occupied > 0
                          ? colorClass
                          : "text-ink-3"
                      }`}
                    >
                      {occupied}/{resource.totalQuantity} занято
                    </span>
                  </div>

                  {bookingsOnDay.length > 0 && (
                    <ul className="space-y-1">
                      {bookingsOnDay.map((b) => {
                        const isDraft = b.status === "DRAFT";
                        return (
                          <li
                            key={b.id}
                            className={`flex items-start gap-1.5 text-xs ${
                              isDraft ? "opacity-50" : ""
                            }`}
                          >
                            <span
                              className={`mt-1 flex-shrink-0 w-2 h-2 rounded-full ${
                                b.status === "CONFIRMED"
                                  ? "bg-accent-bright"
                                  : b.status === "ISSUED"
                                    ? "bg-amber"
                                    : "bg-ink-3"
                              }`}
                            />
                            <span className="text-ink-2">
                              {b.clientName} · {b.quantity} шт.
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default function CalendarPage() {
  return (
    <Suspense fallback={<div className="p-8 text-ink-3">Загрузка...</div>}>
      <CalendarPageInner />
    </Suspense>
  );
}
