"use client";

import { useEffect, useState } from "react";
import type { UserRole } from "../../src/lib/auth";
import { useRequireRole } from "../../src/hooks/useRequireRole";
import { apiFetch } from "../../src/lib/api";
import { formatRub } from "../../src/lib/format";

// ── Placeholder card ──────────────────────────────────────────────────────────

function PlaceholderCard({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="bg-surface border border-border rounded-lg p-4 shadow-xs">
      <p className="text-sm font-semibold text-ink">{title}</p>
      {hint && <p className="mt-1 text-xs text-ink-3">{hint}</p>}
    </div>
  );
}

// ── Role-specific day views ───────────────────────────────────────────────────

interface FinanceDashboard {
  totalOutstanding: string;
  upcomingWeek: Array<{
    bookingId: string;
    projectName: string;
    clientName: string;
    amountOutstanding: string;
    expectedPaymentDate: string | null;
  }>;
}

function DaySuperAdmin() {
  const [fin, setFin] = useState<FinanceDashboard | null>(null);

  useEffect(() => {
    apiFetch<FinanceDashboard>("/api/finance/dashboard")
      .then(setFin)
      .catch(() => { /* не блокируем страницу при ошибке */ });
  }, []);

  return (
    <div className="space-y-4">
      <div>
        <p className="eyebrow">Руководитель</p>
        <h1 className="text-lg font-semibold text-ink mt-0.5">Мой день</h1>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Долги клиентов */}
        <div className="bg-rose-soft border border-rose-border rounded-lg p-4 shadow-xs">
          <p className="eyebrow text-rose">Долги клиентов</p>
          <p className="mono-num text-xl mt-1 text-ink">
            {fin ? formatRub(fin.totalOutstanding) : "—"}
          </p>
        </div>
        {/* Ближайшие платежи */}
        <div className="bg-amber-soft border border-amber-border rounded-lg p-4 shadow-xs">
          <p className="eyebrow text-amber">Ближайшие платежи (7 дней)</p>
          {fin && fin.upcomingWeek.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {fin.upcomingWeek.slice(0, 3).map((u) => (
                <li key={u.bookingId} className="text-xs text-ink-2">
                  <span className="font-medium">{u.clientName}</span> · {u.projectName}
                  <span className="mono-num ml-1 text-amber font-medium">{formatRub(u.amountOutstanding)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-ink-3 mt-1">{fin ? "Нет платежей" : "—"}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function DayWarehouse() {
  return (
    <div className="space-y-4">
      <div>
        <p className="eyebrow">Кладовщик</p>
        <h1 className="text-lg font-semibold text-ink mt-0.5">Мой день</h1>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <PlaceholderCard title="Выдачи сегодня" hint="скоро" />
        <PlaceholderCard title="Возвраты сегодня" hint="скоро" />
        <PlaceholderCard title="Конфликты" hint="скоро" />
      </div>
    </div>
  );
}

function DayTechnician() {
  return (
    <div className="space-y-4">
      <div>
        <p className="eyebrow">Техник</p>
        <h1 className="text-lg font-semibold text-ink mt-0.5">Мой день</h1>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <PlaceholderCard title="В очереди" hint="WAITING_REPAIR — скоро" />
        <PlaceholderCard title="В работе" hint="IN_REPAIR — скоро" />
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

const VIEWS: Record<UserRole, React.ComponentType> = {
  SUPER_ADMIN: DaySuperAdmin,
  WAREHOUSE:   DayWarehouse,
  TECHNICIAN:  DayTechnician,
};

const ALL_ROLES: UserRole[] = ["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"];

export default function DayPage() {
  const { user, loading } = useRequireRole(ALL_ROLES);

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[200px]">
        <span className="text-sm text-ink-3">Загрузка…</span>
      </div>
    );
  }
  if (!user) return null; // hook already redirected

  const View = VIEWS[user.role];
  return (
    <div className="p-6">
      <View />
    </div>
  );
}
