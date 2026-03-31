"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../src/lib/api";
import { formatMoneyRub } from "../../src/lib/format";

type AvailabilityRow = {
  equipmentId: string;
  category: string;
  name: string;
  brand: string | null;
  model: string | null;
  stockTrackingMode: "COUNT" | "UNIT";
  totalQuantity: number;
  rentalRatePerShift: string;
  occupiedQuantity: number;
  availableQuantity: number;
  availability: "UNAVAILABLE" | "PARTIAL" | "AVAILABLE";
  comment: string | null;
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
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }, [today]);

  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(defaultEnd);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string | undefined>(undefined);
  const [categories, setCategories] = useState<string[]>([]);
  const [rows, setRows] = useState<AvailabilityRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    apiFetch<{ categories: string[] }>("/api/equipment/categories")
      .then((r) => setCategories(r.categories))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      try {
        const params = new URLSearchParams({ start, end });
        if (search.trim()) params.set("search", search.trim());
        if (category) params.set("category", category);
        const data = await apiFetch<{ rows: AvailabilityRow[] }>(`/api/availability?${params.toString()}`, {
          signal: controller.signal,
        });
        setRows(data.rows);
        setLoading(false);
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") return;
        setLoading(false);
      }
    }
    load();
    return () => controller.abort();
  }, [start, end, search, category]);

  const statusColor = (s: AvailabilityRow["availability"]) => {
    if (s === "AVAILABLE") return "bg-emerald-50 text-emerald-700 border-emerald-200";
    if (s === "PARTIAL") return "bg-amber-50 text-amber-700 border-amber-200";
    return "bg-rose-50 text-rose-700 border-rose-200";
  };

  return (
    <div className="p-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex flex-col">
            <label className="text-xs text-slate-600">Старт</label>
            <input className="rounded border border-slate-300 px-2 py-1 bg-white" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div className="flex flex-col">
            <label className="text-xs text-slate-600">Конец</label>
            <input className="rounded border border-slate-300 px-2 py-1 bg-white" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
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
            <select className="rounded border border-slate-300 px-2 py-1 bg-white" value={category ?? ""} onChange={(e) => setCategory(e.target.value || undefined)}>
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
          <Link className="rounded bg-slate-900 text-white px-4 py-2 hover:bg-slate-800" href={`/bookings/new?start=${start}&end=${end}`}>
            Создать бронь
          </Link>
          <Link className="rounded border border-slate-300 bg-white px-4 py-2 hover:bg-slate-50" href="/settings">
            ⚙️
          </Link>
        </div>
      </div>

      <div className="mt-4 rounded border border-slate-200 bg-white overflow-hidden">
        <div className="p-3 border-b border-slate-200 flex items-center justify-between">
          <div className="text-sm text-slate-700">
            Остатки на период <span className="font-medium">{start}</span> — <span className="font-medium">{end}</span>
          </div>
          <div className="text-xs text-slate-500">
            {loading ? "Загрузка..." : `Доступно: ${rows.filter((r) => r.availableQuantity > 0).length} из ${rows.length}`}
          </div>
        </div>

        <div className="overflow-auto">
          <table className="min-w-[980px] w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="text-left px-3 py-2">Перечень оборудования</th>
                <th className="text-left px-3 py-2 w-[100px]">Кол-во</th>
                <th className="text-left px-3 py-2 w-[130px]">Стоимость</th>
                <th className="text-left px-3 py-2">Категория</th>
                <th className="text-left px-3 py-2 w-[90px]">Занято</th>
                <th className="text-left px-3 py-2 w-[100px]">Доступно</th>
                <th className="px-3 py-2">Статус</th>
              </tr>
            </thead>
            <tbody>
              {rows.filter((r) => r.availableQuantity > 0).map((r) => (
                <tr key={r.equipmentId} className="border-t border-slate-100">
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-900">
                      {r.name}
                      {r.model ? <span className="text-slate-500 font-normal"> · {r.model}</span> : null}
                    </div>
                    {r.brand ? <div className="text-xs text-slate-500">{r.brand}</div> : <div className="text-xs text-slate-500">&nbsp;</div>}
                  </td>
                  <td className="px-3 py-2 font-medium">{r.totalQuantity}</td>
                  <td className="px-3 py-2 font-medium">{formatMoneyRub(r.rentalRatePerShift)}</td>
                  <td className="px-3 py-2 text-slate-700">{r.category}</td>
                  <td className="px-3 py-2">{r.occupiedQuantity}</td>
                  <td className="px-3 py-2 font-medium">{r.availableQuantity}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex items-center rounded border px-2 py-1 text-xs ${statusColor(r.availability)}`}>
                      {r.availableQuantity < r.totalQuantity ? "Частично" : "Доступно"}
                    </span>
                  </td>
                </tr>
              ))}
              {rows.filter((r) => r.availableQuantity > 0).length === 0 ? (
                <tr>
                  <td className="px-3 py-6 text-center text-slate-500" colSpan={7}>
                    {rows.length > 0 ? "Всё оборудование занято на этот период" : "Ничего не найдено по фильтрам"}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

