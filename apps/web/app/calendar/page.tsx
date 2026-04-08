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
  if (occupied === 0) return "text-emerald-500";
  if (total === 0) return "text-slate-400";
  const pct = occupied / total;
  if (pct >= 0.8) return "text-rose-600 bg-rose-50";
  return "text-amber-600 bg-amber-50";
}

// ──────────────────────────────────────────────────────────────────
// Скелетон загрузки
// ──────────────────────────────────────────────────────────────────

function SkeletonDesktop() {
  return (
    <div className="animate-pulse space-y-2">
      <div className="h-8 bg-slate-200 rounded w-full" />
      {[...Array(5)].map((_, i) => (
        <div key={i} className="h-10 bg-slate-100 rounded w-full" />
      ))}
    </div>
  );
}

function SkeletonMobile() {
  return (
    <div className="animate-pulse space-y-3">
      {[...Array(4)].map((_, i) => (
        <div key={i} className="h-24 bg-slate-100 rounded-lg w-full" />
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
      <h1 className="text-xl font-semibold text-slate-800">Календарь</h1>

      {/* ================================================================
          ДЕСКТОПНЫЙ ВИД
      ================================================================ */}
      <div className="hidden lg:block">
        {/* Тулбар */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          {/* Период */}
          <div className="flex rounded-md border border-slate-200 overflow-hidden text-sm">
            {([7, 14, 30] as const).map((p) => (
              <button
                key={p}
                onClick={() => {
                  setPeriod(p);
                  syncUrl(periodStart, p, category, search);
                }}
                className={`px-3 py-1.5 transition-colors ${
                  period === p
                    ? "bg-slate-800 text-white"
                    : "bg-white text-slate-700 hover:bg-slate-50"
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
            className="border border-slate-200 rounded-md px-3 py-1.5 text-sm bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-400"
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
            className="border border-slate-200 rounded-md px-3 py-1.5 text-sm w-48 focus:outline-none focus:ring-2 focus:ring-slate-400"
          />

          {/* Черновики */}
          <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeDrafts}
              onChange={(e) => setIncludeDrafts(e.target.checked)}
              className="rounded border-slate-300"
            />
            Показывать черновики
          </label>

          {/* Навигация */}
          <div className="flex items-center gap-1 ml-auto">
            <button
              onClick={navPrev}
              className="px-2 py-1.5 text-sm border border-slate-200 rounded-md hover:bg-slate-50 transition-colors"
              title="Предыдущий период"
            >
              ←
            </button>
            <button
              onClick={goToday}
              className="px-3 py-1.5 text-sm border border-slate-200 rounded-md hover:bg-slate-50 transition-colors"
            >
              Сегодня
            </button>
            <button
              onClick={navNext}
              className="px-2 py-1.5 text-sm border border-slate-200 rounded-md hover:bg-slate-50 transition-colors"
              title="Следующий период"
            >
              →
            </button>
          </div>
        </div>

        {/* Ошибка */}
        {error && (
          <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-md p-3 flex items-center justify-between gap-2 mb-4">
            <span>{error}</span>
            <button
              onClick={() => setRetryKey((k) => k + 1)}
              className="text-rose-700 underline shrink-0"
            >
              Повторить
            </button>
          </div>
        )}

        {/* Скелетон */}
        {loading && <SkeletonDesktop />}

        {/* Пустое состояние */}
        {isEmpty && (
          <p className="text-sm text-slate-400 text-center py-12">
            Нет оборудования для отображения в этом периоде.
            <br />
            Добавьте оборудование для просмотра календаря.
          </p>
        )}

        {/* Таблица */}
        {!loading && !error && !isEmpty && (
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="text-left px-3 py-2 font-medium text-slate-600 whitespace-nowrap min-w-[180px] sticky left-0 bg-slate-50">
                    Оборудование
                  </th>
                  {days.map((d) => (
                    <th
                      key={d}
                      className={`text-center px-2 py-2 font-medium text-slate-600 whitespace-nowrap min-w-[52px] ${
                        d === today
                          ? "bg-blue-50 text-blue-700"
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
                      className="bg-slate-100 border-b border-slate-200 cursor-pointer hover:bg-slate-200 transition-colors"
                      onClick={() => toggleCategory(cat)}
                    >
                      <td
                        colSpan={days.length + 1}
                        className="px-3 py-1.5 font-semibold text-slate-700 text-xs uppercase tracking-wide"
                      >
                        <span className="mr-2">
                          {collapsed.has(cat) ? "▸" : "▾"}
                        </span>
                        {cat}
                        <span className="ml-2 text-slate-500 font-normal">
                          ({catResources.length})
                        </span>
                      </td>
                    </tr>

                    {/* Строки оборудования */}
                    {!collapsed.has(cat) &&
                      catResources.map((resource) => (
                        <tr
                          key={resource.id}
                          className="border-b border-slate-100 hover:bg-slate-50 transition-colors"
                        >
                          <td className="px-3 py-1.5 text-slate-700 whitespace-nowrap sticky left-0 bg-white hover:bg-slate-50 max-w-[220px] truncate">
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
                                  d === today ? "bg-blue-50/50" : ""
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
            className="flex-1 border border-slate-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
          <select
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              syncUrl(periodStart, period, e.target.value, search);
            }}
            className="border border-slate-200 rounded-md px-2 py-2 text-sm bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-400"
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
            className="px-3 py-2 text-sm border border-slate-200 rounded-md hover:bg-slate-50 transition-colors shrink-0"
          >
            Сегодня
          </button>
        </div>

        {/* Навигация по дням */}
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={mobilePrevDay}
            disabled={mobileDay <= periodStart}
            className="px-3 py-2 text-sm border border-slate-200 rounded-md hover:bg-slate-50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            ← Пред. день
          </button>
          <span className="text-sm text-slate-700 font-medium text-center">
            {capitalize(formatDayRu(mobileDay))}
          </span>
          <button
            onClick={mobileNextDay}
            disabled={mobileDay >= periodEnd}
            className="px-3 py-2 text-sm border border-slate-200 rounded-md hover:bg-slate-50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            След. день →
          </button>
        </div>

        {/* Ошибка */}
        {error && (
          <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-md p-3 flex items-center justify-between gap-2">
            <span>{error}</span>
            <button
              onClick={() => setRetryKey((k) => k + 1)}
              className="text-rose-700 underline shrink-0"
            >
              Повторить
            </button>
          </div>
        )}

        {/* Скелетон */}
        {loading && <SkeletonMobile />}

        {/* Пустое состояние */}
        {isEmpty && (
          <p className="text-sm text-slate-400 text-center py-8">
            Нет оборудования. Добавьте оборудование для просмотра календаря.
          </p>
        )}

        {/* Карточки оборудования */}
        {!loading && !error && !isEmpty && (
          <div className="space-y-3">
            {showAllMobile && (
              <p className="text-xs text-slate-400 text-center py-2">
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
                  className="rounded-lg border border-slate-200 bg-white p-3 space-y-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-slate-800 truncate">
                      {resource.name}
                    </span>
                    <span
                      className={`text-xs font-medium px-2 py-0.5 rounded shrink-0 ${
                        occupied > 0
                          ? colorClass
                          : "text-slate-400"
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
                                  ? "bg-blue-500"
                                  : b.status === "ISSUED"
                                    ? "bg-amber-500"
                                    : "bg-slate-400"
                              }`}
                            />
                            <span className="text-slate-700">
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
    <Suspense fallback={<div className="p-8 text-slate-400">Загрузка...</div>}>
      <CalendarPageInner />
    </Suspense>
  );
}
