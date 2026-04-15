"use client";

import { useCurrentUser } from "../../src/lib/auth";
import type { UserRole } from "../../src/lib/auth";

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

function DaySuperAdmin() {
  return (
    <div className="space-y-4">
      <div>
        <p className="eyebrow">Руководитель</p>
        <h1 className="text-lg font-semibold text-ink mt-0.5">Мой день</h1>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <PlaceholderCard title="На согласовании" hint="soon — Sprint 3" />
        <PlaceholderCard title="Долги клиентов" hint="soon — Sprint 3" />
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

export default function DayPage() {
  const { user, loading } = useCurrentUser();

  if (loading || !user) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[200px]">
        <span className="text-sm text-ink-3">Загрузка…</span>
      </div>
    );
  }

  const View = VIEWS[user.role];
  return (
    <div className="p-6">
      <View />
    </div>
  );
}
