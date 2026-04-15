"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { UserRole } from "../../src/lib/auth";
import { useRequireRole } from "../../src/hooks/useRequireRole";
import { apiFetch } from "../../src/lib/api";
import { formatRub, pluralize, MONTHS_LOCATIVE } from "../../src/lib/format";
import { DayHeader } from "../../src/components/day/DayHeader";
import { DayAlert } from "../../src/components/day/DayAlert";
import { DayKpiCard } from "../../src/components/day/DayKpiCard";
import { DayOperationsList } from "../../src/components/day/DayOperationsList";
import type { DayOperation } from "../../src/components/day/DayOperationsList";
import { DayFooterMetrics } from "../../src/components/day/DayFooterMetrics";

// ── SUPER_ADMIN ──────────────────────────────────────────────────────────────

interface FinanceDashboard {
  totalOutstanding: string;
  earnedThisMonth: string;
  netThisMonth: string;
  trend: Array<{ month: string; earned: string; spent: string; net: string }>;
  summary?: { overdueReceivables?: string };
  upcomingWeek: Array<{
    bookingId: string;
    projectName: string;
    clientName: string;
    amountOutstanding: string;
    expectedPaymentDate: string | null;
  }>;
}

interface DashboardToday {
  pickups: Array<{
    id: string;
    projectName: string;
    clientName: string;
    startDate: string;
    endDate: string;
    finalAmount: string;
    itemCount: number;
  }>;
  returns: Array<{
    id: string;
    projectName: string;
    clientName: string;
    startDate: string;
    endDate: string;
    finalAmount: string;
    itemCount: number;
  }>;
  active: Array<{ id: string }>;
}

interface PendingApprovalsResponse {
  bookings: Array<{
    id: string;
    projectName: string;
    clientName: string;
    finalAmount: string;
    startDate: string;
    endDate: string;
  }>;
  total: number;
}

interface RepairStats {
  openCount: number;
  newCount: number;
  closedThisMonth: number;
  writtenOffThisMonth: number;
  spentThisMonth: string;
}

function sumFinal(bookings: Array<{ finalAmount: string }>): number {
  return bookings.reduce((acc, b) => acc + Number(b.finalAmount || 0), 0);
}

function deltaPct(currentStr: string, prevStr: string): number | null {
  const c = Number(currentStr);
  const p = Number(prevStr);
  if (!Number.isFinite(c) || !Number.isFinite(p) || p === 0) return null;
  return Math.round(((c - p) / p) * 100);
}

function DaySuperAdmin({ username }: { username: string }) {
  const [fin, setFin] = useState<FinanceDashboard | null>(null);
  const [dashboard, setDashboard] = useState<DashboardToday | null>(null);
  const [pending, setPending] = useState<PendingApprovalsResponse | null>(null);
  const [repairStats, setRepairStats] = useState<RepairStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<FinanceDashboard>("/api/finance/dashboard")
      .then((d) => { if (!cancelled) setFin(d); })
      .catch(() => {});
    apiFetch<DashboardToday>("/api/dashboard/today")
      .then((d) => { if (!cancelled) setDashboard(d); })
      .catch(() => {});
    apiFetch<PendingApprovalsResponse>("/api/dashboard/pending-approvals")
      .then((d) => { if (!cancelled) setPending(d); })
      .catch(() => {});
    apiFetch<RepairStats>("/api/dashboard/repair-stats")
      .then((d) => { if (!cancelled) setRepairStats(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const pickups = dashboard?.pickups ?? [];
  const returns = dashboard?.returns ?? [];

  const todayRevenue = sumFinal(pickups);
  const overdue = fin?.summary?.overdueReceivables;

  // Месячная выручка + % к прошлому
  const currEarned = fin?.earnedThisMonth ?? null;
  const prevEarned = fin?.trend && fin.trend.length >= 2 ? fin.trend[fin.trend.length - 2].earned : null;
  const pct = currEarned && prevEarned ? deltaPct(currEarned, prevEarned) : null;

  // Шапка-сводка для правого верхнего угла.
  // Показываем две НЕ-конфликтующие метрики: сегодняшние операции и выручку месяца —
  // с явными подписями, чтобы ничего не путать.
  const now = new Date();
  const monthLocative = MONTHS_LOCATIVE[now.getMonth()];
  const todayOpsCount = pickups.length + returns.length;
  const summary = currEarned
    ? `Сегодня ${todayOpsCount} ${pluralize(todayOpsCount, "операция", "операции", "операций")} · в ${monthLocative} ${formatRub(currEarned)}`
    : "—";

  // Список операций сегодня (pickup+return склеенные по времени)
  const operations: DayOperation[] = [
    ...pickups.map((p) => ({
      id: p.id,
      kind: "pickup" as const,
      startDate: p.startDate,
      endDate: p.endDate,
      projectName: p.projectName,
      clientName: p.clientName,
      itemCount: p.itemCount,
      finalAmount: p.finalAmount,
    })),
    ...returns.map((r) => ({
      id: r.id,
      kind: "return" as const,
      startDate: r.startDate,
      endDate: r.endDate,
      projectName: r.projectName,
      clientName: r.clientName,
      itemCount: r.itemCount,
      finalAmount: r.finalAmount,
    })),
  ].sort((a, b) => {
    const ta = a.kind === "pickup" ? a.startDate : a.endDate;
    const tb = b.kind === "pickup" ? b.startDate : b.endDate;
    return ta.localeCompare(tb);
  });

  return (
    <div className="bg-surface border border-border rounded-lg shadow-xs overflow-hidden">
      <DayHeader greeting={`утро, ${username} ✨`} summary={summary} />
      <div className="p-4 space-y-3">
        {pending && pending.total > 0 && (
          <DayAlert
            variant="amber"
            title={`📋 Требует твоего решения — ${pending.total} ${pluralize(pending.total, "бронь", "брони", "броней")} на согласовании`}
            linkHref="/bookings?status=PENDING_APPROVAL"
            linkLabel="Все →"
          >
            <ul className="divide-y divide-amber-border">
              {pending.bookings.slice(0, 3).map((b) => (
                <li key={b.id} className="py-1 flex justify-between items-baseline gap-2">
                  <Link href={`/bookings/${b.id}`} className="text-xs truncate hover:text-accent">
                    {b.clientName} · {b.projectName}
                  </Link>
                  <span className="mono-num text-xs text-ink shrink-0">{formatRub(b.finalAmount)}</span>
                </li>
              ))}
            </ul>
          </DayAlert>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <DayKpiCard
            eyebrow="Сегодня"
            value={formatRub(todayRevenue)}
            sub={`${pickups.length} ${pluralize(pickups.length, "выдача", "выдачи", "выдач")} · ${returns.length} ${pluralize(returns.length, "возврат", "возврата", "возвратов")}`}
          />
          <DayKpiCard
            eyebrow="Долги"
            value={fin ? formatRub(fin.totalOutstanding) : "—"}
            sub={overdue && Number(overdue) > 0 ? `из них просрочено ${formatRub(overdue)}` : "без просрочек"}
            subTone={overdue && Number(overdue) > 0 ? "rose" : "muted"}
          />
          <DayKpiCard
            eyebrow="Ремонт"
            value={
              <>
                {repairStats?.openCount ?? "—"}
                <span className="text-sm text-ink-3 font-normal ml-1">единиц</span>
              </>
            }
            sub={
              repairStats
                ? <>≈ {formatRub(repairStats.spentThisMonth)} в {monthLocative}</>
                : "—"
            }
          />
        </div>

        <div className="bg-surface border border-border rounded-lg p-3">
          <div className="flex justify-between items-baseline mb-2">
            <p className="text-sm font-semibold text-ink">Операции сегодня</p>
            <Link href="/bookings" className="text-xs text-accent hover:underline">Все →</Link>
          </div>
          <DayOperationsList operations={operations} showAmount emptyLabel="На сегодня нет операций" />
        </div>

        <DayFooterMetrics>
          {currEarned ? (
            <>
              Месячная выручка: <b className="text-ink-2 mono-num">{formatRub(currEarned)}</b>
              {pct !== null && (
                <>
                  {" · рост к прошлому месяцу: "}
                  <b className={pct >= 0 ? "text-emerald" : "text-rose"}>
                    {pct >= 0 ? "+" : ""}{pct}%
                  </b>
                </>
              )}
            </>
          ) : "Загрузка финансов…"}
        </DayFooterMetrics>
      </div>
    </div>
  );
}

// ── WAREHOUSE ────────────────────────────────────────────────────────────────

function DayWarehouse({ username }: { username: string }) {
  const [dashboard, setDashboard] = useState<DashboardToday | null>(null);
  const [pending, setPending] = useState<PendingApprovalsResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<DashboardToday>("/api/dashboard/today")
      .then((d) => { if (!cancelled) setDashboard(d); })
      .catch(() => { /* не блокируем */ });
    apiFetch<PendingApprovalsResponse>("/api/dashboard/pending-approvals")
      .then((d) => { if (!cancelled) setPending(d); })
      .catch(() => { /* не блокируем */ });
    return () => { cancelled = true; };
  }, []);

  const pickups = dashboard?.pickups ?? [];
  const returns = dashboard?.returns ?? [];
  const summary =
    dashboard
      ? `${pickups.length} ${pluralize(pickups.length, "выдача", "выдачи", "выдач")} · ${returns.length} ${pluralize(returns.length, "возврат", "возврата", "возвратов")}`
      : "—";

  return (
    <div className="bg-surface border border-border rounded-lg shadow-xs overflow-hidden">
      <DayHeader greeting={`доброе утро, ${username} 👋`} summary={summary} />
      <div className="p-4 space-y-3">
        {pending && pending.total > 0 && (
          <DayAlert
            variant="amber"
            title={`📋 ${pending.total} ${pluralize(pending.total, "бронь", "брони", "броней")} на согласовании у руководителя`}
            linkHref="/bookings?status=PENDING_APPROVAL"
            linkLabel="Все →"
          />
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="bg-surface border border-border rounded-lg p-3">
            <div className="flex justify-between items-baseline mb-2">
              <p className="text-sm font-semibold text-ink">📤 Выдачи сегодня</p>
              <span className="mono-num text-sm text-ink-3">{pickups.length}</span>
            </div>
            <DayOperationsList
              operations={pickups.map((p) => ({
                id: p.id,
                kind: "pickup",
                startDate: p.startDate,
                endDate: p.endDate,
                projectName: p.projectName,
                clientName: p.clientName,
                itemCount: p.itemCount,
              }))}
              emptyLabel="Нет выдач"
            />
          </div>
          <div className="bg-surface border border-border rounded-lg p-3">
            <div className="flex justify-between items-baseline mb-2">
              <p className="text-sm font-semibold text-ink">📥 Возвраты сегодня</p>
              <span className="mono-num text-sm text-ink-3">{returns.length}</span>
            </div>
            <DayOperationsList
              operations={returns.map((r) => ({
                id: r.id,
                kind: "return",
                startDate: r.startDate,
                endDate: r.endDate,
                projectName: r.projectName,
                clientName: r.clientName,
                itemCount: r.itemCount,
              }))}
              emptyLabel="Нет возвратов"
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-2 pt-1">
          <Link
            href="/bookings/new"
            className="inline-flex items-center bg-accent-bright text-white text-sm font-medium px-4 py-2 rounded hover:bg-accent transition-colors"
          >
            + Новая бронь
          </Link>
          <Link
            href="/calendar"
            className="inline-flex items-center bg-surface border border-border text-ink text-sm px-4 py-2 rounded hover:border-accent transition-colors"
          >
            Открыть календарь
          </Link>
        </div>

        <DayFooterMetrics>
          {pending && pending.total > 0 ? (
            <>
              <span className="font-semibold text-ink-2">{pending.total}</span>{" "}
              {pluralize(pending.total, "бронь ждёт", "брони ждут", "броней ждут")} согласования у руководителя
            </>
          ) : (
            <>Все брони на сегодня согласованы</>
          )}
        </DayFooterMetrics>
      </div>
    </div>
  );
}

// ── TECHNICIAN ───────────────────────────────────────────────────────────────

interface RepairListItem {
  id: string;
  reason: string;
  status: "WAITING_REPAIR" | "IN_REPAIR" | "WAITING_PARTS" | "CLOSED" | "WROTE_OFF";
  urgency: "NOT_URGENT" | "NORMAL" | "URGENT";
  createdAt: string;
  unit: { equipment: { name: string } };
}

function daysSince(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

function DayTechnician({ userId, username }: { userId: string; username: string }) {
  const router = useRouter();
  const [newRepairs, setNewRepairs] = useState<RepairListItem[] | null>(null);
  const [myRepairs, setMyRepairs] = useState<RepairListItem[] | null>(null);
  const [stats, setStats] = useState<RepairStats | null>(null);

  useEffect(() => {
    let cancelled = false;

    apiFetch<{ repairs: RepairListItem[] }>("/api/repairs?status=WAITING_REPAIR&limit=20")
      .then((d) => { if (!cancelled) setNewRepairs(d.repairs); })
      .catch(() => { if (!cancelled) setNewRepairs([]); });

    // Без userId нет смысла запрашивать «назначенные мне» — у пользователя
    // ещё нет связки на AdminUser (старые сессии). Сразу показываем «Свободно».
    if (userId) {
      apiFetch<{ repairs: RepairListItem[] }>(
        `/api/repairs?assignedTo=${encodeURIComponent(userId)}&status=IN_REPAIR,WAITING_PARTS&limit=20`,
      )
        .then((d) => { if (!cancelled) setMyRepairs(d.repairs); })
        .catch(() => { if (!cancelled) setMyRepairs([]); });
    } else {
      setMyRepairs([]);
    }

    apiFetch<RepairStats>("/api/dashboard/repair-stats")
      .then((d) => { if (!cancelled) setStats(d); })
      .catch(() => { /* не блокируем */ });

    return () => { cancelled = true; };
  }, [userId]);

  const newCount = newRepairs?.length ?? 0;
  const myCount = myRepairs?.length ?? 0;
  // Шапка зависит от самих списков ремонтов, а не от stats: иначе при быстрой
  // загрузке stats и медленных `/api/repairs` пользователь увидел бы «0 новых».
  const summary =
    newRepairs !== null && myRepairs !== null
      ? `${newCount} ${pluralize(newCount, "новая поломка", "новые поломки", "новых поломок")} · ${myCount} в работе`
      : "—";

  // Статус-подпись для моего ремонта
  function statusLabel(r: RepairListItem): { text: string; tone: "rose" | "amber" | "emerald" | "slate" } {
    const d = daysSince(r.createdAt);
    const dStr = `${d} ${pluralize(d, "день", "дня", "дней")}`;
    if (r.status === "WAITING_PARTS") return { text: `${dStr} · ждём поставщика`, tone: "amber" };
    if (r.urgency === "URGENT") return { text: `${dStr} · срочно`, tone: "rose" };
    if (r.status === "IN_REPAIR" && d >= 5) return { text: `${dStr} · просрочено SLA`, tone: "rose" };
    if (r.status === "IN_REPAIR") return { text: `${dStr} · в работе`, tone: "emerald" };
    return { text: dStr, tone: "slate" };
  }

  const toneClass: Record<"rose" | "amber" | "emerald" | "slate", string> = {
    rose:    "text-rose",
    amber:   "text-amber",
    emerald: "text-emerald",
    slate:   "text-slate",
  };

  return (
    <div className="bg-surface border border-border rounded-lg shadow-xs overflow-hidden">
      <DayHeader greeting={`привет, ${username} 🔧`} summary={summary} />
      <div className="p-4 space-y-3">
        {newRepairs && newRepairs.length > 0 && (
          <div className="bg-surface border border-rose-border rounded-lg p-4">
            <div className="flex justify-between items-baseline mb-2">
              <p className="text-sm font-semibold text-rose">🆕 Новые поломки — требуют твоей оценки</p>
              <span className="inline-flex items-center justify-center min-w-[20px] px-1.5 py-0.5 rounded-full text-[11px] bg-rose text-white">
                {newRepairs.length}
              </span>
            </div>
            <div className="space-y-3">
              {newRepairs.map((r) => (
                <div key={r.id} className="pt-2 border-t border-border first:border-t-0 first:pt-0">
                  <p className="text-sm font-semibold text-ink">{r.unit.equipment.name}</p>
                  <p className="text-xs text-ink-2 mt-0.5">{r.reason}</p>
                  <div className="flex gap-2 mt-2">
                    <button
                      onClick={() => router.push(`/repair/${r.id}?action=take`)}
                      className="inline-flex items-center bg-rose text-white text-xs px-3 py-1.5 rounded hover:bg-rose/90 transition-colors"
                    >
                      Взять в работу
                    </button>
                    <button
                      onClick={() => router.push(`/repair/${r.id}?action=write-off`)}
                      className="inline-flex items-center bg-surface border border-border text-ink text-xs px-3 py-1.5 rounded hover:border-rose transition-colors"
                    >
                      Списать
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="bg-surface border border-border rounded-lg p-4">
          <div className="flex justify-between items-baseline mb-2">
            <p className="text-sm font-semibold text-ink">🛠 В работе</p>
            <span className="mono-num text-sm text-ink-3">{myCount}</span>
          </div>
          {myRepairs === null ? (
            <p className="text-xs text-ink-3">Загрузка…</p>
          ) : myCount === 0 ? (
            <p className="text-xs text-ink-3 italic">Свободная очередь</p>
          ) : (
            <ul className="divide-y divide-border">
              {myRepairs.map((r) => {
                const sl = statusLabel(r);
                return (
                  <li key={r.id} className="py-2">
                    <button
                      onClick={() => router.push(`/repair/${r.id}`)}
                      className="w-full text-left flex justify-between items-baseline gap-2 hover:text-accent transition-colors"
                    >
                      <span className="text-sm text-ink truncate">{r.unit.equipment.name}</span>
                      <span className={`text-xs ${toneClass[sl.tone]} shrink-0`}>{sl.text}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <DayFooterMetrics>
          {stats ? (
            <>
              За этот месяц: починено <b className="text-ink-2">{stats.closedThisMonth}</b>,
              списано <b className="text-ink-2">{stats.writtenOffThisMonth}</b>,
              в работе <b className="text-ink-2">{stats.openCount}</b>
              {" · потрачено ≈ "}
              <b className="text-ink-2">{formatRub(stats.spentThisMonth)}</b>
            </>
          ) : "Загрузка статистики…"}
        </DayFooterMetrics>
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
      {user.role === "SUPER_ADMIN" && <DaySuperAdmin username={user.username} />}
      {user.role === "WAREHOUSE" && <DayWarehouse username={user.username} />}
      {user.role === "TECHNICIAN" && <DayTechnician userId={user.userId ?? ""} username={user.username} />}
    </div>
  );
}
