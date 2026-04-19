"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  getDashboard,
  type GafferDashboard,
  type GafferDashboardClientDebt,
  type GafferDashboardTeamDebt,
  type GafferDashboardVendorDebt,
} from "../../src/lib/gafferApi";
import { formatRub, pluralize, MONTHS_LOCATIVE } from "../../src/lib/format";
import { toast } from "../../src/components/ToastProvider";

// ── Localisation helpers ────────────────────────────────────────────────────

const WEEKDAYS = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];

function formatGreetDate(date: Date): string {
  const day = date.getDate();
  const month = MONTHS_LOCATIVE[date.getMonth()];
  const weekday = WEEKDAYS[date.getDay()];
  return `${weekday}, ${day} ${month}`;
}

function formatUpdateTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatLastActivity(isoStr: string | null): string {
  if (!isoStr) return "—";
  const d = new Date(isoStr);
  const day = d.getDate();
  const month = d.toLocaleString("ru-RU", { month: "long" });
  return `${day} ${month}`;
}

function formatPaymentDate(isoStr: string | null): string {
  if (!isoStr) return "—";
  const d = new Date(isoStr);
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// ── Skeleton ─────────────────────────────────────────────────────────────────

function Skeleton() {
  return (
    <div className="animate-pulse space-y-3 px-4 pt-4">
      <div className="h-5 bg-border rounded w-2/3" />
      <div className="h-12 bg-border rounded" />
      <div className="h-8 bg-border rounded mt-4" />
      <div className="h-8 bg-border rounded" />
    </div>
  );
}

// ── KPI pair ──────────────────────────────────────────────────────────────────

function KpiPair({ kpi }: { kpi: GafferDashboard["kpi"] }) {
  return (
    <div className="grid grid-cols-2 gap-2 px-4 pt-4 pb-2">
      {/* Мне должны */}
      <div className="bg-emerald-soft border border-emerald-border rounded-lg p-3">
        <p className="text-[10px] font-semibold tracking-wider text-emerald uppercase mb-1"
          style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}>
          🟢 Мне должны
        </p>
        <p className="text-[20px] font-bold text-emerald mono-num leading-tight">
          {formatRub(kpi.owedToMe)}
        </p>
        <p className="text-[10.5px] text-emerald/80 mt-1 leading-snug">
          по {kpi.owedToMeProjectCount}{" "}
          {pluralize(kpi.owedToMeProjectCount, "проекту", "проектам", "проектам")}
          {kpi.owedToMeClientCount > 0 && (
            <> · {kpi.owedToMeClientCount}{" "}
              {pluralize(kpi.owedToMeClientCount, "заказчик", "заказчика", "заказчиков")}
            </>
          )}
        </p>
      </div>
      {/* Я должен */}
      <div className="bg-rose-soft border border-rose-border rounded-lg p-3">
        <p className="text-[10px] font-semibold tracking-wider text-rose uppercase mb-1"
          style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}>
          🔴 Я должен
        </p>
        <p className="text-[20px] font-bold text-rose mono-num leading-tight">
          {formatRub(kpi.iOwe)}
        </p>
        <p className="text-[10.5px] text-rose/80 mt-1 leading-snug">
          по {kpi.iOweProjectCount}{" "}
          {pluralize(kpi.iOweProjectCount, "проекту", "проектам", "проектам")}
          {kpi.iOweMemberCount > 0 && (
            <> · {kpi.iOweMemberCount}{" "}
              {pluralize(kpi.iOweMemberCount, "человеку", "человекам", "человекам")}
            </>
          )}
          {kpi.iOweVendorCount > 0 && (
            <> · {kpi.iOweVendorCount}{" "}
              {pluralize(kpi.iOweVendorCount, "ренталу", "ренталам", "ренталам")}
            </>
          )}
        </p>
      </div>
    </div>
  );
}

// ── Client debt list row ──────────────────────────────────────────────────────

function ClientDebtRow({ item }: { item: GafferDashboardClientDebt }) {
  return (
    <Link
      href={`/gaffer/contacts/${item.id}`}
      className="flex items-center justify-between gap-2 py-2.5 px-4 border-b border-border last:border-0 hover:bg-surface-2 transition-colors"
    >
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-ink truncate">{item.name}</p>
        <p className="text-[11px] text-ink-3 mt-0.5">
          {item.projectCount}{" "}
          {pluralize(item.projectCount, "проект", "проекта", "проектов")}
          {item.lastPaymentAt && (
            <> · последний платёж {formatPaymentDate(item.lastPaymentAt)}</>
          )}
        </p>
      </div>
      <span className="text-[13.5px] font-semibold text-rose mono-num shrink-0">
        {formatRub(item.remaining)}
      </span>
    </Link>
  );
}

// ── Vendor debt list row ──────────────────────────────────────────────────────

function VendorDebtRow({ item }: { item: GafferDashboardVendorDebt }) {
  return (
    <Link
      href={`/gaffer/contacts/${item.id}`}
      className="flex items-center justify-between gap-2 py-2.5 px-4 border-b border-border last:border-0 hover:bg-surface-2 transition-colors"
    >
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-ink truncate">{item.name}</p>
        <p className="text-[11px] text-ink-3 mt-0.5">
          {item.projectCount}{" "}
          {pluralize(item.projectCount, "проект", "проекта", "проектов")}
          {item.lastPaymentAt && (
            <> · последняя выплата {formatPaymentDate(item.lastPaymentAt)}</>
          )}
        </p>
      </div>
      <span className="text-[13.5px] font-semibold text-amber mono-num shrink-0">
        {formatRub(item.remaining)}
      </span>
    </Link>
  );
}

// ── Team debt list row ────────────────────────────────────────────────────────

function TeamDebtRow({ item }: { item: GafferDashboardTeamDebt }) {
  return (
    <Link
      href={`/gaffer/contacts/${item.id}`}
      className="flex items-center justify-between gap-2 py-2.5 px-4 border-b border-border last:border-0 hover:bg-surface-2 transition-colors"
    >
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-ink truncate">{item.name}</p>
        <p className="text-[11px] text-ink-3 mt-0.5">
          {item.roleLabel && <span className="mr-1.5">{item.roleLabel}</span>}
          {item.projectCount}{" "}
          {pluralize(item.projectCount, "проект", "проекта", "проектов")}
        </p>
      </div>
      <span className="text-[13.5px] font-semibold text-indigo mono-num shrink-0">
        {formatRub(item.remaining)}
      </span>
    </Link>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function GafferDashboardPage() {
  const [data, setData] = useState<GafferDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const now = new Date();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getDashboard()
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) toast.error("Не удалось загрузить дашборд"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const activeCount = data?.meta.activeProjects ?? 0;

  return (
    <div className="min-h-screen bg-surface">
      {/* Greet bar */}
      <div className="bg-ink text-white px-4 py-4">
        <p className="text-[17px] font-semibold mb-0.5">
          {formatGreetDate(now)} · доброе утро 👋
        </p>
        <p className="text-[11.5px] text-white/60">
          обновлено {formatUpdateTime(now)} · {activeCount}{" "}
          {pluralize(activeCount, "активный проект", "активных проекта", "активных проектов")}
        </p>
      </div>

      {loading ? (
        <Skeleton />
      ) : data ? (
        <>
          {/* KPI */}
          <KpiPair kpi={data.kpi} />

          {/* Заказчики с долгом */}
          <div className="mt-3">
            <div className="px-4 pb-1.5 flex items-baseline justify-between">
              <p className="text-[11px] font-semibold tracking-wider text-ink-3 uppercase"
                style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}>
                Заказчики с долгом
              </p>
              <p className="text-[10.5px] text-ink-3">сортировка по сумме</p>
            </div>
            <div className="bg-surface border-y border-border">
              {data.clientsWithDebt.length === 0 ? (
                <div className="py-5 text-center text-[12.5px] text-ink-3 px-4">
                  Все расчёты сведены 👌
                </div>
              ) : (
                data.clientsWithDebt.map((item) => (
                  <ClientDebtRow key={item.id} item={item} />
                ))
              )}
            </div>
          </div>

          {/* Команда с долгом */}
          <div className="mt-3">
            <div className="px-4 pb-1.5 flex items-baseline justify-between">
              <p className="text-[11px] font-semibold tracking-wider text-ink-3 uppercase"
                style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}>
                Команда с долгом
              </p>
              <p className="text-[10.5px] text-ink-3">
                {data.teamWithDebt.length}{" "}
                {pluralize(data.teamWithDebt.length, "человек", "человека", "человек")}
              </p>
            </div>
            <div className="bg-surface border-y border-border">
              {data.teamWithDebt.length === 0 ? (
                <div className="py-5 text-center text-[12.5px] text-ink-3 px-4">
                  Все выплачено 👌
                </div>
              ) : (
                data.teamWithDebt.map((item) => (
                  <TeamDebtRow key={item.id} item={item} />
                ))
              )}
            </div>
          </div>

          {/* Ренталы с долгом */}
          <div className="mt-3">
            <div className="px-4 pb-1.5 flex items-baseline justify-between">
              <p className="text-[11px] font-semibold tracking-wider text-ink-3 uppercase"
                style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}>
                Ренталы с долгом
              </p>
              <p className="text-[10.5px] text-ink-3">
                {data.vendorsWithDebt.length}{" "}
                {pluralize(data.vendorsWithDebt.length, "рентал", "рентала", "ренталов")}
              </p>
            </div>
            <div className="bg-surface border-y border-border">
              {data.vendorsWithDebt.length === 0 ? (
                <div className="py-5 text-center text-[12.5px] text-ink-3 px-4">
                  Все расчёты сведены 👌
                </div>
              ) : (
                data.vendorsWithDebt.map((item) => (
                  <VendorDebtRow key={item.id} item={item} />
                ))
              )}
            </div>
          </div>

          {/* Footer meta */}
          <div className="mx-4 mt-4 pt-3 border-t border-dashed border-border">
            <p className="text-[11.5px] text-ink-3">
              {data.meta.activeProjects} активных · {data.meta.archivedProjects} архивных
              {data.meta.lastActivityAt && (
                <> · последняя активность — {formatLastActivity(data.meta.lastActivityAt)}</>
              )}
            </p>
          </div>
        </>
      ) : (
        <div className="py-12 text-center text-ink-3 text-[13px] px-4">
          <div className="text-4xl mb-3">📊</div>
          <p>Не удалось загрузить данные дашборда</p>
        </div>
      )}
    </div>
  );
}
