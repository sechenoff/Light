"use client";

import { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useRequireRole } from "../../src/hooks/useRequireRole";
import { useCurrentUser } from "../../src/hooks/useCurrentUser";
import { apiFetch } from "../../src/lib/api";

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
  unit: {
    id: string;
    barcode: string | null;
    equipment: { name: string; category: string };
  };
}

interface RepairsResponse {
  repairs: RepairCard[];
}

// ── Константы ────────────────────────────────────────────────────────────────

const COLUMNS: { status: RepairStatus; label: string }[] = [
  { status: "WAITING_REPAIR", label: "В очереди" },
  { status: "IN_REPAIR",      label: "В работе" },
  { status: "WAITING_PARTS",  label: "Ждут запчасти" },
  { status: "CLOSED",         label: "Закрыто (30 дн)" },
];

const URGENCY_LABELS: Record<RepairUrgency, string> = {
  URGENT:     "Срочно",
  NORMAL:     "Обычно",
  NOT_URGENT: "Не срочно",
};

const URGENCY_CLASSES: Record<RepairUrgency, string> = {
  URGENT:     "bg-rose-100 text-rose-700 border border-rose-200",
  NORMAL:     "bg-amber-100 text-amber-700 border border-amber-200",
  NOT_URGENT: "bg-slate-100 text-slate-600 border border-slate-200",
};

const ALL_ROLES = ["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"] as const;

// ── Хелперы ───────────────────────────────────────────────────────────────────

function daysInStatus(repair: RepairCard): number {
  const from = repair.status === "CLOSED" && repair.closedAt
    ? new Date(repair.closedAt)
    : new Date(repair.createdAt);
  return Math.floor((Date.now() - from.getTime()) / (1000 * 60 * 60 * 24));
}

// ── Компонент карточки ────────────────────────────────────────────────────────

function RepairCardItem({ repair }: { repair: RepairCard }) {
  const router = useRouter();
  const days = daysInStatus(repair);

  return (
    <button
      onClick={() => router.push(`/repair/${repair.id}`)}
      className="w-full text-left bg-surface border border-border rounded-lg p-3 shadow-xs hover:border-accent transition-colors space-y-1.5"
    >
      <div className="font-semibold text-ink text-sm leading-snug">
        {repair.unit.equipment.name}
      </div>
      {repair.unit.barcode && (
        <div className="mono-num text-xs text-ink-3">{repair.unit.barcode}</div>
      )}
      <div className="text-xs text-ink-2 line-clamp-2">
        {repair.reason.slice(0, 80)}
        {repair.reason.length > 80 ? "…" : ""}
      </div>
      <div className="flex items-center justify-between mt-1">
        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${URGENCY_CLASSES[repair.urgency]}`}>
          {URGENCY_LABELS[repair.urgency]}
        </span>
        <span className="text-xs text-ink-3 mono-num">{days} дн</span>
      </div>
    </button>
  );
}

// ── Страница ──────────────────────────────────────────────────────────────────

export default function RepairQueuePage() {
  const { user, loading: authLoading } = useRequireRole(ALL_ROLES as unknown as ("SUPER_ADMIN" | "WAREHOUSE" | "TECHNICIAN")[]);
  const [repairs, setRepairs] = useState<RepairCard[]>([]);
  const [fetchLoading, setFetchLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Фильтр: "mine" | "all"
  const [filter, setFilter] = useState<"mine" | "all">("all");
  // Urgency multi-select
  const [urgencyFilter, setUrgencyFilter] = useState<RepairUrgency[]>([]);

  useEffect(() => {
    if (!user) return;

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const statusParam = "WAITING_REPAIR,IN_REPAIR,WAITING_PARTS,CLOSED";
    apiFetch<RepairsResponse>(`/api/repairs?status=${statusParam}&limit=200`)
      .then((data) => setRepairs(data.repairs))
      .catch(() => setError("Не удалось загрузить ремонты"))
      .finally(() => setFetchLoading(false));
  }, [user]);

  const filteredRepairs = useMemo(() => {
    let r = repairs;
    if (filter === "mine" && user?.userId) {
      r = r.filter((rep) => rep.assignedTo === user.userId);
    }
    if (urgencyFilter.length > 0) {
      r = r.filter((rep) => urgencyFilter.includes(rep.urgency));
    }
    return r;
  }, [repairs, filter, user, urgencyFilter]);

  function toggleUrgency(u: RepairUrgency) {
    setUrgencyFilter((prev) =>
      prev.includes(u) ? prev.filter((x) => x !== u) : [...prev, u],
    );
  }

  if (authLoading || !user) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[200px]">
        <span className="text-sm text-ink-3">Загрузка…</span>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-4">
      {/* Заголовок */}
      <div>
        <p className="eyebrow">Мастерская</p>
        <h1 className="text-lg font-semibold text-ink mt-0.5">Очередь ремонтов</h1>
      </div>

      {/* Фильтры */}
      <div className="flex flex-wrap gap-2 items-center">
        {/* Моя очередь / Все */}
        <div className="flex rounded-lg border border-border overflow-hidden text-sm">
          <button
            onClick={() => setFilter("all")}
            className={`px-3 py-1.5 transition-colors ${
              filter === "all"
                ? "bg-accent text-white"
                : "bg-surface text-ink-2 hover:bg-surface-2"
            }`}
          >
            Все
          </button>
          <button
            onClick={() => setFilter("mine")}
            className={`px-3 py-1.5 transition-colors border-l border-border ${
              filter === "mine"
                ? "bg-accent text-white"
                : "bg-surface text-ink-2 hover:bg-surface-2"
            }`}
          >
            Моя очередь
          </button>
        </div>

        {/* Urgency pills */}
        {(["URGENT", "NORMAL", "NOT_URGENT"] as RepairUrgency[]).map((u) => (
          <button
            key={u}
            onClick={() => toggleUrgency(u)}
            className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
              urgencyFilter.includes(u)
                ? URGENCY_CLASSES[u] + " ring-2 ring-offset-1 ring-current"
                : "border-border text-ink-2 bg-surface hover:bg-surface-2"
            }`}
          >
            {URGENCY_LABELS[u]}
          </button>
        ))}
      </div>

      {/* Ошибка */}
      {error && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {/* Загрузка */}
      {fetchLoading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {COLUMNS.map((col) => (
            <div key={col.status} className="space-y-2">
              <div className="h-4 w-24 bg-slate-100 rounded animate-pulse" />
              {[1, 2].map((i) => (
                <div key={i} className="h-24 bg-slate-100 rounded-lg animate-pulse" />
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Kanban-колонки */}
      {!fetchLoading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {COLUMNS.map((col) => {
            const cards = filteredRepairs.filter((r) => r.status === col.status);
            return (
              <div key={col.status} className="space-y-2">
                <p className="eyebrow">
                  {col.label}
                  {cards.length > 0 && (
                    <span className="ml-1 mono-num text-ink-3">({cards.length})</span>
                  )}
                </p>
                {cards.length === 0 ? (
                  <div className="text-xs text-ink-3 italic py-2">Пусто</div>
                ) : (
                  cards.map((r) => <RepairCardItem key={r.id} repair={r} />)
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
