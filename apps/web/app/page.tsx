"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { apiFetch } from "../src/lib/api";
import { MiniCalendar } from "../src/components/MiniCalendar";
import { DashboardOpsCard, DashboardBooking } from "../src/components/DashboardOpsCard";
import { QuickAvailabilityCheck } from "../src/components/QuickAvailabilityCheck";

type DashboardToday = {
  pickups: DashboardBooking[];
  returns: DashboardBooking[];
  active: DashboardBooking[];
};

function todayLabel(): string {
  return new Date().toLocaleDateString("ru-RU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function SectionHeader({
  title,
  count,
}: {
  title: string;
  count: number;
}) {
  return (
    <h2 className="text-sm font-semibold text-slate-700 mb-2">
      {title}{" "}
      <span className="text-slate-400 font-normal">({count})</span>
    </h2>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <p className="text-xs text-slate-400 py-3 text-center">{text}</p>
  );
}

function CardList({
  bookings,
  emptyText,
}: {
  bookings: DashboardBooking[];
  emptyText: string;
}) {
  if (bookings.length === 0) return <EmptyState text={emptyText} />;
  return (
    <div className="space-y-2">
      {bookings.map((b) => (
        <DashboardOpsCard key={b.id} booking={b} />
      ))}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-2">
      {[1, 2].map((i) => (
        <div
          key={i}
          className="h-16 bg-slate-100 rounded-lg animate-pulse"
        />
      ))}
    </div>
  );
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardToday | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const retry = useCallback(() => setRetryCount((c) => c + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    async function fetchData() {
      setLoading(true);
      setError(null);
      try {
        const result = await apiFetch<DashboardToday>("/api/dashboard/today", { signal: controller.signal });
        setData(result);
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Ошибка загрузки");
      } finally {
        setLoading(false);
      }
    }
    fetchData();
    return () => controller.abort();
  }, [retryCount]);

  return (
    <div className="p-4 lg:p-6 max-w-screen-xl mx-auto">
      {/* Header */}
      <h1 className="text-lg font-semibold text-slate-900 mb-4 capitalize">
        Сегодня, {todayLabel()}
      </h1>

      {/* Error state */}
      {error && (
        <div className="mb-4 bg-rose-50 border border-rose-200 text-rose-700 text-sm rounded-lg p-3 flex items-center justify-between">
          <span>{error}</span>
          <button
            onClick={retry}
            className="ml-2 underline text-rose-700 shrink-0"
          >
            Повторить
          </button>
        </div>
      )}

      {/* Desktop layout */}
      <div className="hidden lg:grid lg:grid-cols-4 lg:gap-6">
        {/* Left: 3 sections */}
        <div className="lg:col-span-3 grid grid-cols-3 gap-4">
          {/* Выдачи */}
          <div>
            <SectionHeader
              title="Выдачи"
              count={data?.pickups.length ?? 0}
            />
            {loading ? (
              <Skeleton />
            ) : (
              <CardList
                bookings={data?.pickups ?? []}
                emptyText="Нет запланированных выдач"
              />
            )}
          </div>

          {/* Возвраты */}
          <div>
            <SectionHeader
              title="Возвраты"
              count={data?.returns.length ?? 0}
            />
            {loading ? (
              <Skeleton />
            ) : (
              <CardList
                bookings={data?.returns ?? []}
                emptyText="Нет запланированных возвратов"
              />
            )}
          </div>

          {/* На площадке */}
          <div>
            <SectionHeader
              title="На площадке"
              count={data?.active.length ?? 0}
            />
            {loading ? (
              <Skeleton />
            ) : (
              <CardList
                bookings={data?.active ?? []}
                emptyText="На площадке нет оборудования"
              />
            )}
          </div>
        </div>

        {/* Right: Calendar + Availability */}
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-lg p-3">
            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
              Календарь
            </h3>
            <MiniCalendar />
          </div>

          <div className="bg-white border border-slate-200 rounded-lg p-3">
            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
              Проверка доступности
            </h3>
            <QuickAvailabilityCheck />
          </div>

          <Link
            href="/calendar"
            className="block text-center text-sm text-slate-600 hover:text-slate-900 transition-colors"
          >
            Открыть полный календарь →
          </Link>
        </div>
      </div>

      {/* Mobile layout */}
      <div className="lg:hidden space-y-4">
        {/* Mini Calendar */}
        <div className="bg-white border border-slate-200 rounded-lg p-3">
          <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
            Календарь
          </h3>
          <MiniCalendar />
        </div>

        {/* Quick Availability */}
        <div className="bg-white border border-slate-200 rounded-lg p-3">
          <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
            Проверка доступности
          </h3>
          <QuickAvailabilityCheck />
        </div>

        {/* Calendar link */}
        <Link
          href="/calendar"
          className="block text-center text-sm text-slate-600 hover:text-slate-900 transition-colors"
        >
          Открыть полный календарь →
        </Link>

        {/* Sections */}
        <div>
          <SectionHeader
            title="Выдачи"
            count={data?.pickups.length ?? 0}
          />
          {loading ? (
            <Skeleton />
          ) : (
            <CardList
              bookings={data?.pickups ?? []}
              emptyText="Нет запланированных выдач"
            />
          )}
        </div>

        <div>
          <SectionHeader
            title="Возвраты"
            count={data?.returns.length ?? 0}
          />
          {loading ? (
            <Skeleton />
          ) : (
            <CardList
              bookings={data?.returns ?? []}
              emptyText="Нет запланированных возвратов"
            />
          )}
        </div>

        <div>
          <SectionHeader
            title="На площадке"
            count={data?.active.length ?? 0}
          />
          {loading ? (
            <Skeleton />
          ) : (
            <CardList
              bookings={data?.active ?? []}
              emptyText="На площадке нет оборудования"
            />
          )}
        </div>
      </div>
    </div>
  );
}
