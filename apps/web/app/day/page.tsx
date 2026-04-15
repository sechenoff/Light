"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { UserRole } from "../../src/lib/auth";
import { useRequireRole } from "../../src/hooks/useRequireRole";
import { useCurrentUser } from "../../src/hooks/useCurrentUser";
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

// ── Типы ──────────────────────────────────────────────────────────────────────

interface RepairCardData {
  id: string;
  reason: string;
  urgency: "NOT_URGENT" | "NORMAL" | "URGENT";
  status: string;
  createdAt: string;
  unit: { equipment: { name: string } };
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
  const [openRepairCount, setOpenRepairCount] = useState<number | null>(null);

  useEffect(() => {
    apiFetch<{ repairs: RepairCardData[] }>(
      "/api/repairs?status=WAITING_REPAIR,IN_REPAIR,WAITING_PARTS&limit=100",
    )
      .then((data) => setOpenRepairCount(data.repairs.length))
      .catch(() => { /* не блокируем */ });
  }, []);

  return (
    <div className="space-y-4">
      <div>
        <p className="eyebrow">Кладовщик</p>
        <h1 className="text-lg font-semibold text-ink mt-0.5">Мой день</h1>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <PlaceholderCard title="Выдачи сегодня" hint="скоро" />
        <PlaceholderCard title="Возвраты сегодня" hint="скоро" />
        {openRepairCount !== null && openRepairCount > 0 ? (
          <a href="/repair" className="block">
            <div className="bg-amber-50 border border-amber-border rounded-lg p-4 shadow-xs hover:border-amber transition-colors">
              <p className="eyebrow text-amber">Мастерская</p>
              <p className="mono-num text-xl mt-1 text-ink">{openRepairCount}</p>
              <p className="text-xs text-ink-3 mt-0.5">открытых ремонтов</p>
            </div>
          </a>
        ) : (
          <PlaceholderCard title="Конфликты" hint="скоро" />
        )}
      </div>
    </div>
  );
}

function DayTechnician({ userId }: { userId: string }) {
  const router = useRouter();
  const [repairs, setRepairs] = useState<RepairCardData[] | null>(null);
  const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;

  useEffect(() => {
    apiFetch<{ repairs: RepairCardData[] }>(
      `/api/repairs?assignedTo=${userId}&status=WAITING_REPAIR,IN_REPAIR,WAITING_PARTS&limit=50`,
    )
      .then((data) => setRepairs(data.repairs))
      .catch(() => setRepairs([]));
  }, [userId]);

  const overdueRepairs = repairs?.filter(
    (r) => r.status === "IN_REPAIR" &&
      Date.now() - new Date(r.createdAt).getTime() > FIVE_DAYS_MS,
  ) ?? [];

  return (
    <div className="space-y-4">
      <div>
        <p className="eyebrow">Техник</p>
        <h1 className="text-lg font-semibold text-ink mt-0.5">Мой день</h1>
      </div>

      {/* Просрочено по SLA */}
      {overdueRepairs.length > 0 && (
        <div className="bg-rose-soft border border-rose-border rounded-lg p-4">
          <p className="eyebrow text-rose mb-2">Просрочено по SLA ({overdueRepairs.length})</p>
          <div className="space-y-2">
            {overdueRepairs.map((r) => (
              <button
                key={r.id}
                onClick={() => router.push(`/repair/${r.id}`)}
                className="w-full text-left"
              >
                <div className="text-sm font-medium text-rose">{r.unit.equipment.name}</div>
                <div className="text-xs text-rose/70 mt-0.5">{r.reason.slice(0, 60)}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Мои ремонты */}
      <div className="space-y-2">
        <p className="eyebrow">Мои ремонты</p>
        {repairs === null ? (
          <div className="text-xs text-ink-3">Загрузка…</div>
        ) : repairs.length === 0 ? (
          <div className="bg-surface border border-border rounded-lg p-4">
            <p className="text-sm text-ink-3 italic">Свободная очередь</p>
          </div>
        ) : (
          repairs.map((r) => (
            <button
              key={r.id}
              onClick={() => router.push(`/repair/${r.id}`)}
              className="w-full text-left bg-surface border border-border rounded-lg p-3 hover:border-accent transition-colors space-y-1"
            >
              <div className="text-sm font-semibold text-ink">{r.unit.equipment.name}</div>
              <div className="text-xs text-ink-2">{r.reason.slice(0, 60)}</div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

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

  return (
    <div className="p-6">
      {user.role === "SUPER_ADMIN" && <DaySuperAdmin />}
      {user.role === "WAREHOUSE" && <DayWarehouse />}
      {user.role === "TECHNICIAN" && <DayTechnician userId={user.userId ?? ""} />}
    </div>
  );
}
