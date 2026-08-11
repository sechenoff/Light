"use client";

import { useEffect, useState, useDeferredValue, useMemo, useCallback } from "react";
import Link from "next/link";

import { apiFetch } from "../../src/lib/api";
import { StatusPill } from "../../src/components/StatusPill";
import { formatRub } from "../../src/lib/format";
import { toMoscowDateString } from "../../src/lib/moscowDate";
import { useCurrentUser } from "../../src/hooks/useCurrentUser";
import { unitStatusLabel } from "../../src/lib/unitStatus";
import { useAvailability, type AvailabilityItem } from "../../src/hooks/useAvailability";
import { addHoursToDatetimeLocal, datetimeLocalToISO } from "../../src/lib/rentalTime";
import { DEFAULT_PICKUP_HOUR } from "../../src/lib/availabilityConstants";
import { CatalogToolbar } from "../../src/components/equipment/CatalogToolbar";

type CatalogRow = {
  id: string;
  sortOrder: number;
  category: string;
  name: string;
  brand: string | null;
  model: string | null;
  totalQuantity: number;
  stockTrackingMode: "COUNT" | "UNIT";
  rentalRatePerShift: string;
  rentalRateTwoShifts: string | null;
  rentalRatePerProject: string | null;
  comment: string | null;
  unitStatusCounts: Record<string, number> | null;
};

/** Подложка колонок, которые считаются по выбранному периоду. */
const PERIOD_COL_HEAD = "bg-accent-soft/70";
const PERIOD_COL_CELL = "bg-accent-soft/30";

// Called only from a post-mount effect (never during render) so the
// new Date() here is the client clock — no SSR/CSR hydration mismatch.
// Каталожный дефолт — московская дата + DEFAULT_PICKUP_HOUR (в отличие от
// формы брони, где rentalTime.defaultPickupDatetimeLocal() берёт текущий час).
function defaultPickupDatetimeLocal(): string {
  return `${toMoscowDateString(new Date())}T${String(DEFAULT_PICKUP_HOUR).padStart(2, "0")}:00`;
}

export default function EquipmentPage() {
  const { user } = useCurrentUser();
  const isSuperAdmin = user?.role === "SUPER_ADMIN";
  // Empty until mounted: server and client render the same markup, then the
  // effect below fills the real Moscow-TZ default (avoids hydration mismatch).
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [category, setCategory] = useState<string | undefined>(undefined);
  const [categories, setCategories] = useState<string[]>([]);
  const [categoryCounts, setCategoryCounts] = useState<Record<string, number>>({});
  // eq-retry: инкремент перезапускает эффект загрузки каталога (кнопка «Попробовать снова»).
  const [reloadNonce, setReloadNonce] = useState(0);

  const [catalog, setCatalog] = useState<CatalogRow[]>([]);

  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  // Единый примитив доступности (фаза 2): стале-гард внутри хука заменяет
  // прежний AbortController — при быстрой смене дат применяется свежий ответ.
  const {
    items: availRows,
    loading: loadingAvail,
    error: availError,
    check: checkAvailability,
  } = useAvailability();

  // Доступность опциональна: при ошибке каталог показывается без overlay (пустая карта).
  const availMap = useMemo<Map<string, AvailabilityItem>>(
    () => (availError || !availRows ? new Map() : new Map(availRows.map((r) => [r.equipmentId, r]))),
    [availRows, availError]
  );

  // Seed the default date range on the client after mount.
  useEffect(() => {
    const s = defaultPickupDatetimeLocal();
    setStart(s);
    setEnd(addHoursToDatetimeLocal(s, 24));
  }, []);

  // Список категорий + счётчики позиций (счётчики делают фильтр картой склада).
  useEffect(() => {
    apiFetch<{ categories: string[]; counts?: Record<string, number> }>(
      "/api/equipment/categories"
    )
      .then((r) => {
        setCategories(r.categories);
        setCategoryCounts(r.counts ?? {});
      })
      .catch(() => {});
  }, []);

  // Load the full catalog (primary source)
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoadingCatalog(true);
      setCatalogError(null);
      try {
        const params = new URLSearchParams();
        if (deferredSearch.trim()) params.set("search", deferredSearch.trim());
        if (category) params.set("category", category);
        const q = params.toString() ? `?${params.toString()}` : "";
        const data = await apiFetch<{ equipments: CatalogRow[] }>(`/api/equipment${q}`, {
          signal: controller.signal,
        });
        setCatalog(data.equipments);
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") return;
        setCatalogError(e instanceof Error ? e.message : "Ошибка загрузки каталога");
      } finally {
        setLoadingCatalog(false);
      }
    }
    load();
    return () => controller.abort();
  }, [deferredSearch, category, reloadNonce]);

  // Load availability overlay (non-blocking — catalog shows regardless)
  useEffect(() => {
    if (!start || !end) return;
    void checkAvailability({ start, end });
  }, [start, end, checkAvailability]);

  const applyPeriod = useCallback((range: { start: string; end: string }) => {
    setStart(range.start);
    setEnd(range.end);
  }, []);

  // Вторичная строка ставок: «2 смены … · проект …» — если поля заполнены.
  function secondaryRates(r: CatalogRow): string | null {
    const parts: string[] = [];
    if (r.rentalRateTwoShifts && Number(r.rentalRateTwoShifts) > 0) {
      parts.push(`2 смены ${formatRub(r.rentalRateTwoShifts)}`);
    }
    if (r.rentalRatePerProject && Number(r.rentalRatePerProject) > 0) {
      parts.push(`проект ${formatRub(r.rentalRatePerProject)}`);
    }
    return parts.length > 0 ? parts.join(" · ") : null;
  }

  function unitStatusSummary(counts: Record<string, number> | null | undefined, total: number): string | null {
    if (!counts) return null;
    const parts = Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([status, n]) => `${n} ${unitStatusLabel(status)}`);
    if (parts.length === 0) return null;
    return `${total} ед: ${parts.join(", ")}`;
  }

  function statusBadge(avail: AvailabilityItem | undefined, total: number) {
    if (!avail) return <span className="text-xs text-ink-2">—</span>;
    if (avail.availability === "AVAILABLE")
      return <StatusPill variant="full" label="Доступно" />;
    if (avail.availability === "PARTIAL")
      return <StatusPill variant="limited" label={`Частично (${avail.availableQuantity} из ${total})`} />;
    return <StatusPill variant="none" label="Занято" />;
  }

  const availableCount =
    availMap.size > 0
      ? catalog.filter((r) => (availMap.get(r.id)?.availableQuantity ?? 0) > 0).length
      : null;

  const totalCatalogCount = useMemo(
    () => Object.values(categoryCounts).reduce((sum, n) => sum + n, 0),
    [categoryCounts]
  );

  // rentalTime.datetimeLocalToISO NaN-safe: null до сидинга дефолтных дат
  // или при недопечатанном вводе — тогда ссылка без префилла.
  const startIso = start ? datetimeLocalToISO(start) : null;
  const endIso = end ? datetimeLocalToISO(end) : null;
  const bookingHref =
    startIso && endIso
      ? `/bookings/new?start=${startIso}&end=${endIso}`
      : "/bookings/new";

  return (
    <div className="pb-6">
      <CatalogToolbar
        start={start}
        end={end}
        onPeriodChange={applyPeriod}
        search={search}
        onSearchChange={setSearch}
        category={category}
        categories={categories}
        categoryCounts={categoryCounts}
        onCategoryChange={setCategory}
        isSuperAdmin={isSuperAdmin}
        bookingHref={bookingHref}
        shownCount={catalog.length}
        totalCount={totalCatalogCount}
        availableCount={availableCount}
        loadingCatalog={loadingCatalog}
        loadingAvail={loadingAvail}
      />

      <div className="bg-surface">
        {catalogError ? (
          <div className="p-8 text-center">
            <div className="inline-flex flex-col items-center gap-2">
              <svg className="w-8 h-8 text-rose" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div className="text-sm font-medium text-rose">Ошибка загрузки каталога</div>
              <div className="text-xs text-ink-2">{catalogError}</div>
              <button
                onClick={() => setReloadNonce((n) => n + 1)}
                className="mt-2 text-xs text-ink-2 underline hover:text-ink"
              >
                Попробовать снова
              </button>
            </div>
          </div>
        ) : (
          <>
          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="min-w-[980px] w-full text-sm">
              <thead className="bg-surface text-ink-2">
                {/* Три правые колонки зависят от периода в тулбаре — они
                    подписаны и затонированы, иначе цифра выглядит свойством
                    позиции, а не среза на выбранные даты. */}
                <tr>
                  <th rowSpan={2} className="border-b border-border-strong px-3 py-2 text-left align-bottom font-medium">Оборудование</th>
                  <th rowSpan={2} className="border-b border-border-strong px-3 py-2 text-left align-bottom font-medium w-[100px]">Всего</th>
                  <th rowSpan={2} className="border-b border-border-strong px-3 py-2 text-right align-bottom font-medium w-[130px]">Стоимость</th>
                  <th rowSpan={2} className="border-b border-border-strong px-3 py-2 text-left align-bottom font-medium">Категория</th>
                  <th colSpan={3} className={`${PERIOD_COL_HEAD} border-b border-accent-border px-3 pt-1.5 pb-0.5 text-center`}>
                    <span className="eyebrow !text-accent">За выбранный период</span>
                  </th>
                </tr>
                <tr>
                  <th className={`${PERIOD_COL_HEAD} border-b border-border-strong px-3 pb-2 text-right font-medium w-[90px]`}>Занято</th>
                  <th className={`${PERIOD_COL_HEAD} border-b border-border-strong px-3 pb-2 text-right font-medium w-[100px]`}>Доступно</th>
                  <th className={`${PERIOD_COL_HEAD} border-b border-border-strong px-3 pb-2 font-medium`}>Статус</th>
                </tr>
              </thead>
              <tbody>
                {loadingCatalog ? (
                  <tr>
                    <td className="px-3 py-8 text-center text-ink-2" colSpan={7}>
                      Загрузка...
                    </td>
                  </tr>
                ) : catalog.length === 0 ? (
                  <tr>
                    <td className="px-3 py-8 text-center text-ink-2" colSpan={7}>
                      {search || category ? (
                        "Ничего не найдено по фильтрам"
                      ) : (
                        <>
                          Каталог пуст — добавьте позиции в{" "}
                          <Link href="/equipment/manage" className="underline hover:text-ink">
                            управлении каталогом
                          </Link>{" "}
                          или импортируйте из Excel (Администратор → Ещё → Импорт оборудования)
                        </>
                      )}
                    </td>
                  </tr>
                ) : (
                  catalog.map((r) => {
                    const avail = availMap.get(r.id);
                    const isFullyUnavailable = avail && avail.availableQuantity <= 0;
                    return (
                      <tr
                        key={r.id}
                        className={`border-t border-border hover:bg-surface-muted transition-colors ${isFullyUnavailable ? "opacity-60" : ""}`}
                      >
                        <td className="px-3 py-2">
                          <div className="font-medium text-ink flex items-center gap-1.5">
                            {r.name}
                            {r.model ? (
                              <span className="text-ink-2 font-normal"> · {r.model}</span>
                            ) : null}
                            {r.stockTrackingMode === "UNIT" ? (
                              <Link
                                href={`/equipment/${r.id}/units`}
                                title="Управление единицами"
                                aria-label={`Управление единицами: ${r.name}`}
                                className="text-ink-2 hover:text-ink flex-shrink-0"
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                                </svg>
                              </Link>
                            ) : null}
                          </div>
                          {r.brand ? (
                            <div className="text-xs text-ink-2 font-mono">{r.brand}</div>
                          ) : (
                            <div className="text-xs">&nbsp;</div>
                          )}
                        </td>
                        <td className="px-3 py-2 font-medium mono-num">
                          {r.stockTrackingMode === "UNIT" && r.unitStatusCounts ? (
                            <div>
                              <div>{r.totalQuantity}</div>
                              <div className="text-xs font-normal text-ink-2 whitespace-nowrap">
                                {unitStatusSummary(r.unitStatusCounts, r.totalQuantity)}
                              </div>
                            </div>
                          ) : (
                            r.totalQuantity
                          )}
                        </td>
                        <td className="px-3 py-2 font-medium text-right mono-num">
                          {formatRub(r.rentalRatePerShift)}
                          {secondaryRates(r) && (
                            <div className="text-[11px] font-normal text-ink-2 whitespace-nowrap">{secondaryRates(r)}</div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-ink-2">{r.category}</td>
                        <td className={`${PERIOD_COL_CELL} px-3 py-2 text-right mono-num text-ink-2`}>
                          {avail ? avail.occupiedQuantity : <span className="text-ink-2">—</span>}
                        </td>
                        <td className={`${PERIOD_COL_CELL} px-3 py-2 text-right mono-num font-medium`}>
                          {avail ? avail.availableQuantity : <span className="text-ink-2">—</span>}
                        </td>
                        <td className={`${PERIOD_COL_CELL} px-3 py-2`}>{statusBadge(avail, r.totalQuantity)}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Mobile card list (паттерн PaymentsOverviewPage) */}
          <div className="md:hidden">
            {loadingCatalog ? (
              <div className="px-3 py-8 text-center text-ink-2 text-sm">Загрузка...</div>
            ) : catalog.length === 0 ? (
              <div className="px-3 py-8 text-center text-ink-2 text-sm">
                {search || category ? (
                  "Ничего не найдено по фильтрам"
                ) : (
                  <>
                    Каталог пуст — добавьте позиции в{" "}
                    <Link href="/equipment/manage" className="underline hover:text-ink">
                      управлении каталогом
                    </Link>
                  </>
                )}
              </div>
            ) : (
              <div className="divide-y divide-border">
                {catalog.map((r) => {
                  const avail = availMap.get(r.id);
                  const isFullyUnavailable = avail && avail.availableQuantity <= 0;
                  return (
                    <div
                      key={r.id}
                      className={`px-4 py-2.5 ${isFullyUnavailable ? "opacity-60" : ""}`}
                    >
                      <div className="flex justify-between items-start gap-2">
                        <div className="min-w-0">
                          <div className="font-medium text-ink text-[13px]">
                            {r.name}
                            {r.model ? <span className="text-ink-2 font-normal"> · {r.model}</span> : null}
                          </div>
                          <div className="text-[11px] text-ink-2 mt-0.5">
                            {r.category}
                            {r.brand ? ` · ${r.brand}` : ""}
                          </div>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <div className="mono-num font-semibold text-[14px] text-ink">{formatRub(r.rentalRatePerShift)}</div>
                          {secondaryRates(r) && (
                            <div className="text-[10px] text-ink-2 whitespace-nowrap">{secondaryRates(r)}</div>
                          )}
                        </div>
                      </div>
                      <div className="flex justify-between items-center mt-1.5">
                        <div className="text-[11px] text-ink-2">
                          {avail
                            ? `Доступно ${avail.availableQuantity} из ${r.totalQuantity}`
                            : `Всего ${r.totalQuantity}`}
                        </div>
                        {statusBadge(avail, r.totalQuantity)}
                      </div>
                      {r.stockTrackingMode === "UNIT" && unitStatusSummary(r.unitStatusCounts, r.totalQuantity) && (
                        <div className="text-[11px] text-ink-2 mt-1">
                          {unitStatusSummary(r.unitStatusCounts, r.totalQuantity)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          </>
        )}
      </div>
    </div>
  );
}
