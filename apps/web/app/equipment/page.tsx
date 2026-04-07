"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../src/lib/api";
import { formatMoneyRub } from "../../src/lib/format";

const UNIT_STATUS_LABELS: Record<string, string> = {
  AVAILABLE: "на складе",
  ISSUED: "выдана",
  MAINTENANCE: "ремонт",
  RETIRED: "списана",
  MISSING: "утеряна",
};

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
  comment: string | null;
  unitStatusCounts: Record<string, number> | null;
};

type AvailInfo = {
  equipmentId: string;
  occupiedQuantity: number;
  availableQuantity: number;
  availability: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";
};

function isoTodayUTC() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default function EquipmentPage() {
  const today = isoTodayUTC();
  const defaultEnd = useMemo(() => {
    const d = new Date(today + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + 1);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }, [today]);

  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(defaultEnd);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string | undefined>(undefined);
  const [categories, setCategories] = useState<string[]>([]);

  const [catalog, setCatalog] = useState<CatalogRow[]>([]);
  const [availMap, setAvailMap] = useState<Map<string, AvailInfo>>(new Map());

  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [loadingAvail, setLoadingAvail] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  // Load category list for filter
  useEffect(() => {
    apiFetch<{ categories: string[] }>("/api/equipment/categories")
      .then((r) => setCategories(r.categories))
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
        if (search.trim()) params.set("search", search.trim());
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
  }, [search, category]);

  // Load availability overlay (non-blocking — catalog shows regardless)
  useEffect(() => {
    if (!start || !end) return;
    const controller = new AbortController();
    async function load() {
      setLoadingAvail(true);
      try {
        const params = new URLSearchParams({ start, end });
        const data = await apiFetch<{ rows: AvailInfo[] }>(`/api/availability?${params.toString()}`, {
          signal: controller.signal,
        });
        setAvailMap(new Map(data.rows.map((r) => [r.equipmentId, r])));
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") return;
        // Availability is optional — show catalog without occupancy info on error
        setAvailMap(new Map());
      } finally {
        setLoadingAvail(false);
      }
    }
    load();
    return () => controller.abort();
  }, [start, end]);

  function unitStatusSummary(counts: Record<string, number> | null | undefined, total: number): string | null {
    if (!counts) return null;
    const parts = Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([status, n]) => `${n} ${UNIT_STATUS_LABELS[status] ?? status}`);
    if (parts.length === 0) return null;
    return `${total} ед: ${parts.join(", ")}`;
  }

  function statusBadge(avail: AvailInfo | undefined, total: number) {
    if (!avail) return <span className="text-xs text-slate-400">—</span>;
    if (avail.availability === "AVAILABLE")
      return (
        <span className="inline-flex items-center rounded border px-2 py-1 text-xs bg-emerald-50 text-emerald-700 border-emerald-200">
          Доступно
        </span>
      );
    if (avail.availability === "PARTIAL")
      return (
        <span className="inline-flex items-center rounded border px-2 py-1 text-xs bg-amber-50 text-amber-700 border-amber-200">
          Частично ({avail.availableQuantity} из {total})
        </span>
      );
    return (
      <span className="inline-flex items-center rounded border px-2 py-1 text-xs bg-rose-50 text-rose-700 border-rose-200">
        Занято
      </span>
    );
  }

  const availableCount = availMap.size > 0
    ? catalog.filter((r) => (availMap.get(r.id)?.availableQuantity ?? 1) > 0).length
    : catalog.length;

  return (
    <div className="p-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex flex-col">
            <label className="text-xs text-slate-600">Старт</label>
            <input
              className="rounded border border-slate-300 px-2 py-1 bg-white"
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </div>
          <div className="flex flex-col">
            <label className="text-xs text-slate-600">Конец</label>
            <input
              className="rounded border border-slate-300 px-2 py-1 bg-white"
              type="date"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </div>

          <div className="flex flex-col">
            <label className="text-xs text-slate-600">Поиск</label>
            <input
              className="rounded border border-slate-300 px-2 py-1 bg-white"
              value={search}
              placeholder="наименование, бренд, модель..."
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className="flex flex-col">
            <label className="text-xs text-slate-600">Категория</label>
            <select
              className="rounded border border-slate-300 px-2 py-1 bg-white"
              value={category ?? ""}
              onChange={(e) => setCategory(e.target.value || undefined)}
            >
              <option value="">Все</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Link
            className="rounded bg-slate-900 text-white px-4 py-2 hover:bg-slate-800"
            href={`/bookings/new?start=${start}&end=${end}`}
          >
            Создать бронь
          </Link>
        </div>
      </div>

      <div className="mt-4 rounded border border-slate-200 bg-white overflow-hidden">
        <div className="p-3 border-b border-slate-200 flex items-center justify-between">
          <div className="text-sm text-slate-700">
            Каталог на период{" "}
            <span className="font-medium">{start}</span> —{" "}
            <span className="font-medium">{end}</span>
          </div>
          <div className="text-xs text-slate-500">
            {loadingCatalog
              ? "Загрузка каталога..."
              : loadingAvail
              ? `${catalog.length} позиций — проверяем доступность...`
              : availMap.size > 0
              ? `Позиций: ${catalog.length}, доступно: ${availableCount}`
              : `Позиций в каталоге: ${catalog.length}`}
          </div>
        </div>

        {catalogError ? (
          <div className="p-8 text-center">
            <div className="inline-flex flex-col items-center gap-2">
              <svg className="w-8 h-8 text-rose-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div className="text-sm font-medium text-rose-600">Ошибка загрузки каталога</div>
              <div className="text-xs text-slate-500">{catalogError}</div>
              <button
                onClick={() => setSearch(search)}
                className="mt-2 text-xs text-slate-600 underline hover:text-slate-900"
              >
                Попробовать снова
              </button>
            </div>
          </div>
        ) : (
          <div className="overflow-auto">
            <table className="min-w-[980px] w-full text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="text-left px-3 py-2">Перечень оборудования</th>
                  <th className="text-left px-3 py-2 w-[100px]">Всего</th>
                  <th className="text-left px-3 py-2 w-[130px]">Стоимость</th>
                  <th className="text-left px-3 py-2">Категория</th>
                  <th className="text-left px-3 py-2 w-[90px]">Занято</th>
                  <th className="text-left px-3 py-2 w-[100px]">Доступно</th>
                  <th className="px-3 py-2">Статус</th>
                </tr>
              </thead>
              <tbody>
                {loadingCatalog ? (
                  <tr>
                    <td className="px-3 py-8 text-center text-slate-400" colSpan={7}>
                      Загрузка...
                    </td>
                  </tr>
                ) : catalog.length === 0 ? (
                  <tr>
                    <td className="px-3 py-8 text-center text-slate-500" colSpan={7}>
                      {search || category
                        ? "Ничего не найдено по фильтрам"
                        : "Каталог пуст — добавьте технику через Администратор → Импорт оборудования"}
                    </td>
                  </tr>
                ) : (
                  catalog.map((r) => {
                    const avail = availMap.get(r.id);
                    const isFullyUnavailable = avail && avail.availableQuantity <= 0;
                    return (
                      <tr
                        key={r.id}
                        className={`border-t border-slate-100 ${isFullyUnavailable ? "opacity-50" : ""}`}
                      >
                        <td className="px-3 py-2">
                          <div className="font-medium text-slate-900 flex items-center gap-1.5">
                            {r.name}
                            {r.model ? (
                              <span className="text-slate-500 font-normal"> · {r.model}</span>
                            ) : null}
                            {r.stockTrackingMode === "UNIT" ? (
                              <Link
                                href={`/equipment/${r.id}/units`}
                                title="Управление единицами"
                                className="text-slate-400 hover:text-slate-700 flex-shrink-0"
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                                </svg>
                              </Link>
                            ) : null}
                          </div>
                          {r.brand ? (
                            <div className="text-xs text-slate-500">{r.brand}</div>
                          ) : (
                            <div className="text-xs text-slate-500">&nbsp;</div>
                          )}
                        </td>
                        <td className="px-3 py-2 font-medium">
                          {r.stockTrackingMode === "UNIT" && r.unitStatusCounts ? (
                            <div>
                              <div>{r.totalQuantity}</div>
                              <div className="text-xs font-normal text-slate-500 whitespace-nowrap">
                                {unitStatusSummary(r.unitStatusCounts, r.totalQuantity)}
                              </div>
                            </div>
                          ) : (
                            r.totalQuantity
                          )}
                        </td>
                        <td className="px-3 py-2 font-medium">{formatMoneyRub(r.rentalRatePerShift)}</td>
                        <td className="px-3 py-2 text-slate-700">{r.category}</td>
                        <td className="px-3 py-2 text-slate-600">
                          {avail ? avail.occupiedQuantity : <span className="text-slate-300">—</span>}
                        </td>
                        <td className="px-3 py-2 font-medium">
                          {avail ? avail.availableQuantity : <span className="text-slate-300">—</span>}
                        </td>
                        <td className="px-3 py-2">{statusBadge(avail, r.totalQuantity)}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
