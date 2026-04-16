"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useRequireRole } from "../../src/hooks/useRequireRole";
import { useCurrentUser } from "../../src/hooks/useCurrentUser";
import { apiFetch } from "../../src/lib/api";
import { formatRub, pluralize } from "../../src/lib/format";

// ── Типы ─────────────────────────────────────────────────────────────────────

type RepairStatus = "WAITING_REPAIR" | "IN_REPAIR" | "WAITING_PARTS" | "CLOSED" | "WROTE_OFF";
type RepairUrgency = "NOT_URGENT" | "NORMAL" | "URGENT";

interface RepairCard {
  id: string;
  reason: string;
  urgency: RepairUrgency;
  status: RepairStatus;
  createdAt: string;
  closedAt: string | null;
  assignedTo: string | null;
  createdBy: string;
  partsCost: string;
  totalTimeHours: string;
  unit: {
    id: string;
    barcode: string | null;
    equipmentId: string;
    equipment: { name: string; category: string };
  };
  sourceBooking: {
    id: string;
    projectName: string;
    client: { name: string };
  } | null;
  nextConflict: {
    date: string;
    clientName: string;
  } | null;
  _count: { workLog: number };
}

interface RepairStats {
  openCount: number;
  newCount: number;
  closedThisMonth: number;
  writtenOffThisMonth: number;
  spentThisMonth: string;
}

interface RepairsResponse {
  repairs: RepairCard[];
}

// ── Константы ────────────────────────────────────────────────────────────────

const ALL_ROLES = ["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"] as const;

type StatusFilter = "ALL" | "WAITING_REPAIR" | "IN_REPAIR" | "WAITING_PARTS";

const STATUS_FILTERS: { key: StatusFilter; label: string; colorClass: string; activeClass: string }[] = [
  {
    key: "ALL",
    label: "Все",
    colorClass: "border-border text-ink-2",
    activeClass: "bg-ink text-white border-ink",
  },
  {
    key: "WAITING_REPAIR",
    label: "🆕 Ждут ремонта",
    colorClass: "border-rose text-rose",
    activeClass: "bg-rose text-white border-rose",
  },
  {
    key: "IN_REPAIR",
    label: "🔧 В ремонте",
    colorClass: "border-amber text-amber",
    activeClass: "bg-amber text-white border-amber",
  },
  {
    key: "WAITING_PARTS",
    label: "⏸ Ждут запчасти",
    colorClass: "border-indigo text-indigo",
    activeClass: "bg-indigo text-white border-indigo",
  },
];

// ── Хелперы ───────────────────────────────────────────────────────────────────

function daysSince(isoDate: string): number {
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / (1000 * 60 * 60 * 24));
}

function daysBetween(from: string, to: string): number {
  return Math.floor((new Date(to).getTime() - new Date(from).getTime()) / (1000 * 60 * 60 * 24));
}

function formatDate(isoDate: string): string {
  return new Date(isoDate).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

function statusBadgeClasses(status: RepairStatus): string {
  switch (status) {
    case "WAITING_REPAIR": return "bg-rose-soft text-rose border border-rose-border";
    case "IN_REPAIR":      return "bg-amber-soft text-amber border border-amber-border";
    case "WAITING_PARTS":  return "bg-indigo-soft text-indigo border border-indigo-border";
    case "CLOSED":         return "bg-emerald-soft text-emerald border border-emerald-border";
    case "WROTE_OFF":      return "bg-surface-2 text-ink-3 border border-border";
  }
}

function statusBadgeLabel(status: RepairStatus): string {
  switch (status) {
    case "WAITING_REPAIR": return "🆕";
    case "IN_REPAIR":      return "🔧";
    case "WAITING_PARTS":  return "⏸";
    case "CLOSED":         return "✓";
    case "WROTE_OFF":      return "—";
  }
}

// ── Компонент строки списка ───────────────────────────────────────────────────

function RepairRow({
  repair,
  onTake,
}: {
  repair: RepairCard;
  onTake: (id: string) => void;
}) {
  const router = useRouter();
  const [taking, setTaking] = useState(false);

  const days = daysSince(repair.createdAt);

  async function handleTake(e: React.MouseEvent) {
    e.stopPropagation();
    setTaking(true);
    try {
      await onTake(repair.id);
    } finally {
      setTaking(false);
    }
  }

  function handleOpen(e: React.MouseEvent) {
    e.stopPropagation();
    router.push(`/repair/${repair.id}`);
  }

  return (
    <div
      onClick={() => router.push(`/repair/${repair.id}`)}
      className="px-4 py-3 bg-surface border-b border-border hover:bg-surface-2 cursor-pointer transition-colors"
    >
      {/* Desktop: 5-column grid */}
      <div
        className="hidden md:grid items-center gap-3"
        style={{ gridTemplateColumns: "50px 1fr 160px 130px 120px" }}
      >
        <div className="flex justify-center">
          <span className={`inline-flex items-center justify-center w-8 h-8 rounded-full text-sm font-semibold ${statusBadgeClasses(repair.status)}`}>
            {statusBadgeLabel(repair.status)}
          </span>
        </div>
        <div className="min-w-0">
          <div className="font-semibold text-ink text-sm leading-snug truncate">{repair.unit.equipment.name}</div>
          {repair.unit.barcode && <div className="mono-num text-xs text-ink-3 truncate">{repair.unit.barcode}</div>}
          <div className="text-xs text-ink-2 truncate mt-0.5">{repair.reason.slice(0, 70)}{repair.reason.length > 70 ? "…" : ""}</div>
        </div>
        <div className="text-xs text-ink-2 leading-snug">
          {repair.sourceBooking ? (
            <>
              <div className="text-ink-3 mb-0.5">с возврата</div>
              <div className="truncate font-medium">«{repair.sourceBooking.projectName}»</div>
              <div className="text-ink-3 mono-num">{formatDate(repair.createdAt)}</div>
            </>
          ) : (
            <>
              <div>в работе <span className="mono-num">{days} {pluralize(days, "день", "дня", "дней")}</span></div>
              <div className="text-ink-3 mono-num">{formatDate(repair.createdAt)}</div>
            </>
          )}
        </div>
        <div className="text-xs leading-snug">
          {repair.nextConflict ? (
            <>
              <div className="font-semibold text-rose">⚠ есть бронь</div>
              <div className="mono-num text-rose">{formatDate(repair.nextConflict.date)}</div>
              <div className="text-ink-2 truncate">{repair.nextConflict.clientName}</div>
            </>
          ) : (
            <span className="text-ink-3">—</span>
          )}
        </div>
        <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
          {repair.status === "WAITING_REPAIR" ? (
            <button onClick={handleTake} disabled={taking} className="px-3 py-1.5 rounded text-xs font-semibold bg-rose text-white hover:opacity-90 disabled:opacity-50 transition-opacity whitespace-nowrap">
              {taking ? "…" : "Взять в работу"}
            </button>
          ) : (
            <button onClick={handleOpen} className="px-3 py-1.5 rounded text-xs font-medium border border-border text-ink-2 hover:bg-surface-2 transition-colors whitespace-nowrap">
              Открыть
            </button>
          )}
        </div>
      </div>

      {/* Mobile: card layout */}
      <div className="md:hidden space-y-2">
        <div className="flex items-start gap-3">
          <span className={`shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-full text-sm font-semibold ${statusBadgeClasses(repair.status)}`}>
            {statusBadgeLabel(repair.status)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-ink text-sm leading-snug">{repair.unit.equipment.name}</div>
            <div className="text-xs text-ink-2 mt-0.5">{repair.reason.slice(0, 70)}{repair.reason.length > 70 ? "…" : ""}</div>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 pl-11">
          <div className="text-xs text-ink-3">
            {repair.sourceBooking
              ? `с возврата «${repair.sourceBooking.projectName}» · ${formatDate(repair.createdAt)}`
              : `в работе ${days} ${pluralize(days, "день", "дня", "дней")}`}
          </div>
          {repair.nextConflict && (
            <span className="text-xs font-semibold text-rose whitespace-nowrap">⚠ бронь {formatDate(repair.nextConflict.date)}</span>
          )}
        </div>
        <div className="pl-11" onClick={(e) => e.stopPropagation()}>
          {repair.status === "WAITING_REPAIR" ? (
            <button onClick={handleTake} disabled={taking} className="w-full h-9 rounded text-xs font-semibold bg-rose text-white hover:opacity-90 disabled:opacity-50 transition-opacity">
              {taking ? "…" : "Взять в работу"}
            </button>
          ) : (
            <button onClick={handleOpen} className="w-full h-9 rounded text-xs font-medium border border-border text-ink-2 hover:bg-surface-2 transition-colors">
              Открыть
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── KPI-карточка (SUPER_ADMIN) ────────────────────────────────────────────────

function KpiCard({ eyebrow, value }: { eyebrow: string; value: string }) {
  return (
    <div className="bg-surface border border-border rounded-lg p-4 shadow-xs">
      <p className="eyebrow mb-1">{eyebrow}</p>
      <p className="text-xl font-semibold text-ink mono-num">{value}</p>
    </div>
  );
}

// ── Скелетон ─────────────────────────────────────────────────────────────────

function SkeletonRows() {
  return (
    <div className="divide-y divide-border">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="px-4 py-3">
          {/* Desktop skeleton */}
          <div className="hidden md:grid items-center gap-3" style={{ gridTemplateColumns: "50px 1fr 160px 130px 120px" }}>
            <div className="w-8 h-8 rounded-full bg-surface-2 animate-pulse" />
            <div className="space-y-1.5">
              <div className="h-3.5 w-40 bg-surface-2 rounded animate-pulse" />
              <div className="h-3 w-24 bg-surface-2 rounded animate-pulse" />
            </div>
            <div className="h-3 w-28 bg-surface-2 rounded animate-pulse" />
            <div className="h-3 w-20 bg-surface-2 rounded animate-pulse" />
            <div className="h-7 w-24 bg-surface-2 rounded animate-pulse ml-auto" />
          </div>
          {/* Mobile skeleton */}
          <div className="md:hidden flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-surface-2 animate-pulse shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="h-3.5 w-3/4 bg-surface-2 rounded animate-pulse" />
              <div className="h-3 w-1/2 bg-surface-2 rounded animate-pulse" />
              <div className="h-8 w-full bg-surface-2 rounded animate-pulse" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Страница ──────────────────────────────────────────────────────────────────

export default function RepairQueuePage() {
  const { user, loading: authLoading } = useRequireRole(
    ALL_ROLES as unknown as ("SUPER_ADMIN" | "WAREHOUSE" | "TECHNICIAN")[],
  );
  const currentUser = useCurrentUser();

  const [repairs, setRepairs] = useState<RepairCard[]>([]);
  const [stats, setStats] = useState<RepairStats | null>(null);
  const [fetchLoading, setFetchLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [queueFilter, setQueueFilter] = useState<"all" | "mine">("all");

  const isSuperAdmin = user?.role === "SUPER_ADMIN";

  const loadRepairs = useCallback(() => {
    if (!user) return;

    let cancelled = false;
    setFetchLoading(true);
    setError(null);

    const promises: Promise<void>[] = [
      apiFetch<RepairsResponse>("/api/repairs?limit=200")
        .then((data) => { if (!cancelled) setRepairs(data.repairs); })
        .catch(() => { if (!cancelled) setError("Не удалось загрузить ремонты"); }),
    ];

    if (isSuperAdmin) {
      promises.push(
        apiFetch<RepairStats>("/api/dashboard/repair-stats")
          .then((data) => { if (!cancelled) setStats(data); })
          .catch(() => {}),
      );
    }

    Promise.all(promises).finally(() => {
      if (!cancelled) setFetchLoading(false);
    });

    return () => { cancelled = true; };
  }, [user, isSuperAdmin]);

  useEffect(() => {
    const cleanup = loadRepairs();
    return cleanup;
  }, [loadRepairs]);

  async function handleTake(id: string) {
    try {
      await apiFetch(`/api/repairs/${id}/take`, { method: "POST" });
      loadRepairs();
    } catch (err: any) {
      setError(err?.message ?? "Не удалось взять ремонт");
    }
  }

  // Подсчёт по статусам для пилюль
  const countByStatus = useMemo(() => {
    const map: Partial<Record<StatusFilter, number>> = { ALL: repairs.length };
    for (const r of repairs) {
      if (r.status === "WAITING_REPAIR") map.WAITING_REPAIR = (map.WAITING_REPAIR ?? 0) + 1;
      if (r.status === "IN_REPAIR") map.IN_REPAIR = (map.IN_REPAIR ?? 0) + 1;
      if (r.status === "WAITING_PARTS") map.WAITING_PARTS = (map.WAITING_PARTS ?? 0) + 1;
    }
    return map;
  }, [repairs]);

  const filteredRepairs = useMemo(() => {
    let r = repairs;

    if (statusFilter !== "ALL") {
      r = r.filter((rep) => rep.status === statusFilter);
    }

    if (queueFilter === "mine" && currentUser?.userId) {
      r = r.filter((rep) => rep.assignedTo === currentUser.userId);
    }

    return r;
  }, [repairs, statusFilter, queueFilter, currentUser]);

  if (authLoading || !user) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[200px]">
        <span className="text-sm text-ink-3">Загрузка…</span>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-5">
      {/* Заголовок */}
      <div>
        <p className="eyebrow">Мастерская</p>
        <h1 className="text-lg font-semibold text-ink mt-0.5">Очередь ремонтов</h1>
      </div>

      {/* KPI-карточки для SUPER_ADMIN */}
      {isSuperAdmin && stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard eyebrow="Починено за месяц" value={String(stats.closedThisMonth)} />
          <KpiCard eyebrow="Списано" value={String(stats.writtenOffThisMonth)} />
          <KpiCard eyebrow="В ремонте сейчас" value={String(stats.openCount)} />
          <KpiCard eyebrow="Расходы за месяц" value={formatRub(stats.spentThisMonth)} />
        </div>
      )}

      {/* Фильтры */}
      <div className="flex flex-wrap gap-2 items-center">
        {/* Статусные пилюли */}
        {STATUS_FILTERS.map((f) => {
          const count = countByStatus[f.key] ?? 0;
          const isActive = statusFilter === f.key;
          return (
            <button
              key={f.key}
              onClick={() => setStatusFilter(f.key)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                isActive ? f.activeClass : f.colorClass + " bg-surface hover:bg-surface-2"
              }`}
            >
              {f.label} · <span className="mono-num">{count}</span>
            </button>
          );
        })}

        {/* Разделитель */}
        <span className="text-border mx-1">|</span>

        {/* Моя очередь / Все */}
        <div className="flex rounded-lg border border-border overflow-hidden text-xs">
          <button
            onClick={() => setQueueFilter("all")}
            className={`px-3 py-1.5 transition-colors ${
              queueFilter === "all"
                ? "bg-ink text-white"
                : "bg-surface text-ink-2 hover:bg-surface-2"
            }`}
          >
            Все
          </button>
          <button
            onClick={() => setQueueFilter("mine")}
            className={`px-3 py-1.5 transition-colors border-l border-border ${
              queueFilter === "mine"
                ? "bg-ink text-white"
                : "bg-surface text-ink-2 hover:bg-surface-2"
            }`}
          >
            Моя очередь
          </button>
        </div>
      </div>

      {/* Ошибка */}
      {error && (
        <div className="bg-rose-soft border border-rose-border rounded-lg px-4 py-3 text-sm text-rose">
          {error}
        </div>
      )}

      {/* Список / скелетон */}
      <div className="bg-surface border border-border rounded-lg overflow-hidden shadow-xs">
        {/* Шапка таблицы */}
        <div
          className="hidden md:grid gap-3 px-4 py-2 bg-surface-2 border-b border-border"
          style={{ gridTemplateColumns: "50px 1fr 160px 130px 120px" }}
        >
          <div />
          <p className="eyebrow">Единица</p>
          <p className="eyebrow">Источник / срок</p>
          <p className="eyebrow">Конфликт</p>
          <div />
        </div>

        {fetchLoading ? (
          <SkeletonRows />
        ) : filteredRepairs.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-ink-3">
            {statusFilter === "ALL" && queueFilter === "all"
              ? "Нет активных ремонтов"
              : "Нет ремонтов по выбранному фильтру"}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {filteredRepairs.map((r) => (
              <RepairRow key={r.id} repair={r} onTake={handleTake} />
            ))}
          </div>
        )}
      </div>

      {/* Архивная таблица для SUPER_ADMIN */}
      {isSuperAdmin && !fetchLoading && (
        <ArchiveTable repairs={repairs} />
      )}
    </div>
  );
}

// ── Архивная таблица (SUPER_ADMIN) ────────────────────────────────────────────

function resultPill(status: RepairStatus) {
  switch (status) {
    case "CLOSED":    return <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-soft text-emerald border border-emerald-border">Починено</span>;
    case "WROTE_OFF": return <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-surface-2 text-ink-3 border border-border">Списано</span>;
    default:          return <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-amber-soft text-amber border border-amber-border">В ремонте</span>;
  }
}

function ArchiveTable({ repairs }: { repairs: RepairCard[] }) {
  const closed = repairs.filter((r) => r.status === "CLOSED" || r.status === "WROTE_OFF");

  if (closed.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="eyebrow">Архив</p>
      <div className="bg-surface border border-border rounded-lg overflow-hidden shadow-xs">
        <div className="grid gap-3 px-4 py-2 bg-surface-2 border-b border-border text-xs"
          style={{ gridTemplateColumns: "1fr 1fr 90px 100px 80px" }}>
          <p className="eyebrow">Единица</p>
          <p className="eyebrow">Поломка</p>
          <p className="eyebrow">В работе</p>
          <p className="eyebrow">Результат</p>
          <p className="eyebrow">Расход</p>
        </div>
        <div className="divide-y divide-border">
          {closed.map((r) => {
            const daysWorked = r.closedAt
              ? daysBetween(r.createdAt, r.closedAt)
              : daysSince(r.createdAt);
            const cost = Number(r.partsCost);

            return (
              <div
                key={r.id}
                className="grid gap-3 px-4 py-3 items-center hover:bg-surface-2 cursor-pointer transition-colors"
                style={{ gridTemplateColumns: "1fr 1fr 90px 100px 80px" }}
                onClick={() => {
                  router.push(`/repair/${r.id}`);
                }}
              >
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-ink truncate">
                    {r.unit.equipment.name}
                  </div>
                  {r.unit.barcode && (
                    <div className="mono-num text-xs text-ink-3 truncate">{r.unit.barcode}</div>
                  )}
                </div>
                <div className="text-xs text-ink-2 truncate">{r.reason.slice(0, 60)}{r.reason.length > 60 ? "…" : ""}</div>
                <div className="mono-num text-xs text-ink-2">
                  {daysWorked} {pluralize(daysWorked, "день", "дня", "дней")}
                </div>
                <div>{resultPill(r.status)}</div>
                <div className="mono-num text-xs text-ink-2">
                  {cost > 0 ? formatRub(cost) : "—"}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
