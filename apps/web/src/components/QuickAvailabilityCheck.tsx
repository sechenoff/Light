"use client";

import { useState } from "react";
import { apiFetch } from "../lib/api";
import { StatusPill } from "./StatusPill";

type AvailabilityItem = {
  equipmentId: string;
  name: string;
  availability: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";
  occupiedQuantity: number;
  availableQuantity: number;
  totalQuantity: number;
};

function defaultDatetimeLocal(offsetHours = 0): string {
  const d = new Date();
  d.setHours(10 + offsetHours, 0, 0, 0);
  if (offsetHours >= 24) {
    d.setDate(d.getDate() + Math.floor(offsetHours / 24));
    d.setHours(10, 0, 0, 0);
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day}T${h}:${min}`;
}

function StatusBadgeAvailability({
  status,
}: {
  status: AvailabilityItem["availability"];
}) {
  const variant =
    status === "AVAILABLE" ? "full" : status === "PARTIAL" ? "limited" : "none";
  const label =
    status === "AVAILABLE" ? "Доступно" : status === "PARTIAL" ? "Частично" : "Занято";
  return <StatusPill variant={variant} label={label} />;
}

export function QuickAvailabilityCheck() {
  const [search, setSearch] = useState("");
  const [start, setStart] = useState(defaultDatetimeLocal(0));
  const [end, setEnd] = useState(defaultDatetimeLocal(24));
  const [results, setResults] = useState<AvailabilityItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCheck() {
    setLoading(true);
    setError(null);
    try {
      const startIso = new Date(start).toISOString();
      const endIso = new Date(end).toISOString();
      const params = new URLSearchParams({ start: startIso, end: endIso });
      if (search.trim()) params.set("search", search.trim());
      const data = await apiFetch<{ rows: AvailabilityItem[] }>(
        `/api/availability?${params.toString()}`
      );
      setResults(data.rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка при проверке");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Поиск оборудования..."
        className="w-full border border-slate-200 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
      />

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs text-slate-500 block mb-0.5">Начало</label>
          <input
            type="datetime-local"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="w-full border border-slate-200 rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
        </div>
        <div>
          <label className="text-xs text-slate-500 block mb-0.5">Конец</label>
          <input
            type="datetime-local"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className="w-full border border-slate-200 rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
        </div>
      </div>

      <button
        onClick={handleCheck}
        disabled={loading}
        className="w-full bg-accent-bright hover:bg-accent text-white text-sm py-1.5 rounded disabled:opacity-50 transition-colors"
      >
        {loading ? "Проверяю..." : "Проверить"}
      </button>

      {error && (
        <div className="text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded p-2 flex items-center justify-between gap-2">
          <span>{error}</span>
          <button
            onClick={handleCheck}
            className="text-rose-700 underline shrink-0"
          >
            Повторить
          </button>
        </div>
      )}

      {results === null && !error && (
        <p className="text-xs text-slate-400 text-center py-2">
          Введите название и нажмите Проверить
        </p>
      )}

      {results !== null && results.length === 0 && (
        <p className="text-xs text-slate-400 text-center py-2">
          Ничего не найдено
        </p>
      )}

      {results !== null && results.length > 0 && (
        <ul className="space-y-1.5">
          {results.map((item) => (
            <li
              key={item.equipmentId}
              className="flex items-center justify-between gap-2 text-xs"
            >
              <span className="text-slate-700 truncate">{item.name}</span>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-slate-400">
                  {item.occupiedQuantity}/{item.totalQuantity}
                </span>
                <StatusBadgeAvailability status={item.availability} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
