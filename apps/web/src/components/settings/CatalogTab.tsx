"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";

type CatalogSummaryRow = {
  id: string;
  category: string;
  name: string;
  totalQuantity: number;
  rentalRatePerShift: string;
};

export function CatalogTab() {
  const [rows, setRows] = useState<CatalogSummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<{ equipments: CatalogSummaryRow[] }>("/api/equipment");
      setRows(data.equipments);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка загрузки каталога");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const byCategory = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of rows) {
      map.set(r.category, (map.get(r.category) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], "ru"));
  }, [rows]);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-ink">Каталог техники</h2>
          <p className="text-sm text-ink-2 mt-1">
            Полный список оборудования в базе данных. Для редактирования перейдите в расширенный редактор.
          </p>
        </div>
        <Link
          href="/equipment/manage"
          className="shrink-0 inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium bg-accent text-white hover:bg-accent transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
          Редактор
        </Link>
      </div>

      {loading ? (
        <div className="py-8 text-center text-sm text-ink-3">Загрузка…</div>
      ) : error ? (
        <div className="p-4 rounded-xl border border-rose-border bg-rose-soft text-sm text-rose">
          <div className="font-medium mb-1">Ошибка загрузки</div>
          <div>{error}</div>
          <button onClick={load} className="mt-2 text-xs underline">Повторить</button>
        </div>
      ) : rows.length === 0 ? (
        <div className="p-8 text-center rounded-xl border border-dashed border-border">
          <div className="text-sm font-medium text-ink-2 mb-1">Каталог пуст</div>
          <p className="text-xs text-ink-3">
            Добавьте оборудование через вкладку{" "}
            <span className="font-medium text-ink-2">Импорт оборудования</span>{" "}
            или нажмите <span className="font-medium text-ink-2">Редактор</span>.
          </p>
        </div>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-xl border border-border bg-surface p-4">
              <div className="text-2xl font-bold text-ink">{rows.length}</div>
              <div className="text-xs text-ink-2 mt-0.5">позиций в каталоге</div>
            </div>
            <div className="rounded-xl border border-border bg-surface p-4">
              <div className="text-2xl font-bold text-ink">{byCategory.length}</div>
              <div className="text-xs text-ink-2 mt-0.5">категорий</div>
            </div>
            <div className="rounded-xl border border-border bg-surface p-4">
              <div className="text-2xl font-bold text-ink">
                {rows.reduce((s, r) => s + r.totalQuantity, 0)}
              </div>
              <div className="text-xs text-ink-2 mt-0.5">единиц всего</div>
            </div>
            <div className="rounded-xl border border-border bg-surface p-4">
              <button
                onClick={load}
                className="text-xs text-ink-2 hover:text-ink underline"
              >
                Обновить
              </button>
            </div>
          </div>

          {/* Category breakdown */}
          <div className="rounded-xl border border-border overflow-hidden">
            <div className="px-4 py-2.5 bg-surface border-b border-border text-xs font-semibold text-ink-2 uppercase tracking-wide">
              По категориям
            </div>
            <div className="divide-y divide-slate-100">
              {byCategory.map(([cat, count]) => (
                <div key={cat} className="flex items-center justify-between px-4 py-2.5">
                  <span className="text-sm text-ink">{cat}</span>
                  <span className="text-sm font-medium text-ink-2">{count} позиц.</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
