"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import Link from "next/link";
import { apiFetch } from "../../lib/api";
import { toast } from "../ToastProvider";
import { TaskAssigneePill } from "./TaskAssigneePill";
import type { Task } from "./groupTasks";

// ── Типы ──────────────────────────────────────────────────────────────────────

interface TasksListResponse {
  items: Task[];
  nextCursor: string | null;
}

// ── Форматирование ────────────────────────────────────────────────────────────

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  });
}

function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "numeric",
    year: "numeric",
    timeZone: "Europe/Moscow",
  });
}

// ── Группировка по дате выполнения ────────────────────────────────────────────

type ArchiveGroup = "today" | "yesterday" | "thisWeek" | "earlier";

const GROUP_ORDER: ArchiveGroup[] = ["today", "yesterday", "thisWeek", "earlier"];

const GROUP_LABEL: Record<ArchiveGroup, string> = {
  today: "Сегодня",
  yesterday: "Вчера",
  thisWeek: "На этой неделе",
  earlier: "Раньше",
};

function archiveGroupOf(completedAt: string, now: Date): ArchiveGroup {
  const d = new Date(completedAt);
  const diffMs = now.getTime() - d.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  if (diffDays < 1) return "today";
  if (diffDays < 2) return "yesterday";
  if (diffDays < 7) return "thisWeek";
  return "earlier";
}

// ── Stats strip ───────────────────────────────────────────────────────────────

function computeStats(tasks: Task[], now: Date) {
  const total = tasks.length;
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const thisMonth = tasks.filter(
    (t) => t.completedAt && new Date(t.completedAt) >= monthStart,
  ).length;

  // Среднее количество в день за этот месяц (к прошедшим дням)
  const daysElapsed = Math.max(1, Math.floor((now.getTime() - monthStart.getTime()) / (1000 * 60 * 60 * 24)) + 1);
  const monthlyAvgPerDay = thisMonth > 0 ? thisMonth / daysElapsed : 0;

  // Лидер месяца — тот, кто выполнил больше всего за этот месяц
  const completedByMap = new Map<string, { id: string; name: string; count: number }>();
  for (const t of tasks) {
    if (!t.completedAt || new Date(t.completedAt) < monthStart) continue;
    const uid = t.completedBy ?? "";
    const name = t.completedByUser?.username ?? uid;
    if (!uid) continue;
    const entry = completedByMap.get(uid) ?? { id: uid, name, count: 0 };
    entry.count += 1;
    completedByMap.set(uid, entry);
  }
  let topLeaderId = "";
  let topLeader = "";
  let topCount = 0;
  for (const [, v] of completedByMap) {
    if (v.count > topCount) {
      topCount = v.count;
      topLeader = v.name;
      topLeaderId = v.id;
    }
  }

  // Среднее время закрытия (в днях), считаем от createdAt до completedAt
  const withBoth = tasks.filter((t) => t.createdAt && t.completedAt);
  let avgDays: number | null = null;
  if (withBoth.length > 0) {
    const totalMs = withBoth.reduce((sum, t) => {
      return sum + (new Date(t.completedAt!).getTime() - new Date(t.createdAt).getTime());
    }, 0);
    avgDays = totalMs / withBoth.length / (1000 * 60 * 60 * 24);
  }

  return { total, thisMonth, monthlyAvgPerDay, topLeaderId, topLeader, topCount, avgDays };
}

// ── Детерминированный цвет аватарки для лидера месяца ─────────────────────────
// Повторяет логику TaskAssigneePill, чтобы кружок был тем же, что на главной
const AVATAR_BG_CLASSES = ["bg-teal", "bg-amber", "bg-indigo", "bg-rose", "bg-emerald"];
function leaderAvatarColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) & 0xffff;
  }
  return AVATAR_BG_CLASSES[hash % AVATAR_BG_CLASSES.length];
}

// ── TaskArchivePage ───────────────────────────────────────────────────────────

export function TaskArchivePage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Client-side фильтры
  const [search, setSearch] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState("");
  const [creatorFilter, setCreatorFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const inFlight = useRef<Set<string>>(new Set());
  const now = useMemo(() => new Date(), []);

  // ── Загрузка ────────────────────────────────────────────────────────────────

  const loadTasks = useCallback(async (cursor?: string) => {
    const isInitial = !cursor;
    if (isInitial) {
      setLoading(true);
      setError(null);
      setTasks([]);
      setNextCursor(null);
    } else {
      setLoadingMore(true);
    }

    try {
      const params = new URLSearchParams({
        filter: "all",
        status: "DONE",
        limit: "200",
      });
      if (cursor) params.set("cursor", cursor);

      const data = await apiFetch<TasksListResponse>(`/api/tasks?${params.toString()}`);
      if (isInitial) {
        setTasks(data.items ?? []);
      } else {
        setTasks((prev) => [...prev, ...(data.items ?? [])]);
      }
      setNextCursor(data.nextCursor ?? null);
    } catch (err: any) {
      if (isInitial) {
        setError(err?.message ?? "Не удалось загрузить архив");
      } else {
        toast.error(err?.message ?? "Не удалось загрузить больше задач");
      }
    } finally {
      if (isInitial) setLoading(false);
      else setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const params = new URLSearchParams({ filter: "all", status: "DONE", limit: "200" });
    setLoading(true);
    setError(null);

    apiFetch<TasksListResponse>(`/api/tasks?${params.toString()}`)
      .then((data) => {
        if (cancelled) return;
        setTasks(data.items ?? []);
        setNextCursor(data.nextCursor ?? null);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, []);

  // ── Вернуть (reopen) ────────────────────────────────────────────────────────

  const reopenTask = useCallback(async (id: string) => {
    if (inFlight.current.has(id)) return;
    inFlight.current.add(id);
    setTasks((prev) => prev.filter((t) => t.id !== id));
    try {
      await apiFetch(`/api/tasks/${id}/reopen`, { method: "POST" });
      toast.success("Задача возвращена в работу");
    } catch (err: any) {
      toast.error(err?.message ?? "Не удалось вернуть задачу");
    } finally {
      inFlight.current.delete(id);
    }
  }, []);

  // ── Фильтрация ──────────────────────────────────────────────────────────────

  const filteredTasks = useMemo(() => {
    return tasks
      .filter((t) => {
        if (search) {
          const s = search.toLowerCase();
          if (!t.title.toLowerCase().includes(s)) return false;
        }
        if (assigneeFilter) {
          if (t.assignedTo !== assigneeFilter) return false;
        }
        if (creatorFilter) {
          if (t.createdBy !== creatorFilter) return false;
        }
        if (dateFrom && t.completedAt) {
          if (t.completedAt < dateFrom) return false;
        }
        if (dateTo && t.completedAt) {
          if (t.completedAt > dateTo + "T23:59:59Z") return false;
        }
        return true;
      })
      .sort((a, b) => {
        const ca = a.completedAt ?? a.createdAt;
        const cb = b.completedAt ?? b.createdAt;
        return cb.localeCompare(ca);
      });
  }, [tasks, search, assigneeFilter, creatorFilter, dateFrom, dateTo]);

  // ── Stats ────────────────────────────────────────────────────────────────────

  const stats = useMemo(() => computeStats(tasks, now), [tasks, now]);

  // ── Уникальные назначенные / создатели для фильтров ──────────────────────────

  const uniqueAssignees = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of tasks) {
      if (t.assignedTo && t.assignedToUser) {
        map.set(t.assignedTo, t.assignedToUser.username);
      }
    }
    return [...map.entries()];
  }, [tasks]);

  const uniqueCreators = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of tasks) {
      if (t.createdBy && t.createdByUser) {
        map.set(t.createdBy, t.createdByUser.username);
      }
    }
    return [...map.entries()];
  }, [tasks]);

  // ── Группировка ──────────────────────────────────────────────────────────────

  const groups = useMemo(() => {
    const g: Record<ArchiveGroup, Task[]> = {
      today: [], yesterday: [], thisWeek: [], earlier: [],
    };
    for (const t of filteredTasks) {
      const group = t.completedAt ? archiveGroupOf(t.completedAt, now) : "earlier";
      g[group].push(t);
    }
    return g;
  }, [filteredTasks, now]);

  // ── Рендер ──────────────────────────────────────────────────────────────────

  return (
    <div className="p-4 md:p-6 max-w-3xl">
      {/* Хлебные крошки */}
      <div className="text-xs text-ink-3 mb-2.5">
        <Link href="/tasks" className="text-accent font-medium hover:underline">
          ← Все задачи
        </Link>
        <span> · Архив</span>
      </div>

      {/* Заголовок */}
      <div className="mb-4">
        <p className="eyebrow">Задачи · Архив</p>
        <h1 className="text-[22px] font-semibold text-ink mt-0.5 tracking-tight">
          Архив выполненных
        </h1>
        <p className="text-[13px] text-ink-2 mt-1 max-w-[760px] leading-[1.65]">
          Задачи, выполненные более 24 часов назад. Фильтруй по датам, исполнителю или тексту.
          Нужно вернуть что-то в работу — наведи на строку и нажми «Вернуть».
        </p>
      </div>

      {/* Stats strip */}
      {!loading && (
        <div className="grid grid-cols-4 bg-surface border border-border rounded-[10px] overflow-hidden mb-4">
          <div className="px-5 py-4 border-r border-border flex flex-col gap-1">
            <span className="text-[10px] font-mono uppercase tracking-[0.07em] text-ink-3 font-medium">
              Выполнено всего
            </span>
            <span className="text-[22px] font-mono font-medium text-emerald tabular-nums">
              {stats.total}
            </span>
            <span className="text-[11px] text-ink-3">за всё время</span>
          </div>
          <div className="px-5 py-4 border-r border-border flex flex-col gap-1">
            <span className="text-[10px] font-mono uppercase tracking-[0.07em] text-ink-3 font-medium">
              За этот месяц
            </span>
            <span className="text-[22px] font-mono font-medium text-ink tabular-nums">
              {stats.thisMonth}
            </span>
            <span className="text-[11px] text-ink-3">
              {stats.monthlyAvgPerDay > 0
                ? `в среднем ${stats.monthlyAvgPerDay.toFixed(1)} в день`
                : "пока ничего"}
            </span>
          </div>
          <div className="px-5 py-4 border-r border-border flex flex-col gap-1">
            <span className="text-[10px] font-mono uppercase tracking-[0.07em] text-ink-3 font-medium">
              Лидер месяца
            </span>
            {stats.topLeader ? (
              <span className="text-[15px] font-medium text-ink flex items-center gap-2 min-w-0">
                <span
                  className={`w-[26px] h-[26px] rounded-full ${leaderAvatarColor(stats.topLeaderId)} text-white text-xs font-semibold flex items-center justify-center shrink-0`}
                >
                  {stats.topLeader.charAt(0).toUpperCase()}
                </span>
                <span className="truncate">{stats.topLeader}</span>
              </span>
            ) : (
              <span className="text-[22px] font-mono font-medium text-ink-3 tabular-nums">—</span>
            )}
            {stats.topCount > 0 && (
              <span className="text-[11px] text-ink-3">
                {stats.topCount} {stats.topCount === 1 ? "задача" : stats.topCount < 5 ? "задачи" : "задач"} из {stats.thisMonth}
              </span>
            )}
          </div>
          <div className="px-5 py-4 flex flex-col gap-1">
            <span className="text-[10px] font-mono uppercase tracking-[0.07em] text-ink-3 font-medium">
              Среднее время закрытия
            </span>
            <span className="text-[22px] font-mono font-medium text-ink tabular-nums">
              {stats.avgDays !== null ? `${stats.avgDays.toFixed(1)} д` : "—"}
            </span>
            <span className="text-[11px] text-ink-3">от создания до выполнения</span>
          </div>
        </div>
      )}

      {/* Filter bar */}
      <div className="bg-surface border border-border rounded-[10px] px-4 py-3 flex justify-between items-center gap-3 flex-wrap mb-4">
        {/* Поиск */}
        <div className="relative flex-1 min-w-[200px] max-w-[340px]">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[13px] opacity-60 pointer-events-none">
            🔍
          </span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по названию…"
            className="w-full text-[13px] pl-8 pr-3 py-2 border border-border rounded-md bg-surface text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft"
          />
        </div>

        {/* Правые фильтры */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Дата от–до */}
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="text-[13px] px-2.5 py-1.5 border border-border rounded-md bg-surface text-ink focus:border-accent focus:outline-none"
              title="Выполнено с"
            />
            <span className="text-xs text-ink-3">—</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="text-[13px] px-2.5 py-1.5 border border-border rounded-md bg-surface text-ink focus:border-accent focus:outline-none"
              title="Выполнено по"
            />
          </div>

          {/* Исполнитель */}
          {uniqueAssignees.length > 0 && (
            <select
              value={assigneeFilter}
              onChange={(e) => setAssigneeFilter(e.target.value)}
              className="text-[13px] px-2.5 py-1.5 border border-border rounded-md bg-surface text-ink focus:border-accent focus:outline-none"
            >
              <option value="">Исполнитель</option>
              {uniqueAssignees.map(([id, name]) => (
                <option key={id} value={id}>{name}</option>
              ))}
            </select>
          )}

          {/* Создатель */}
          {uniqueCreators.length > 0 && (
            <select
              value={creatorFilter}
              onChange={(e) => setCreatorFilter(e.target.value)}
              className="text-[13px] px-2.5 py-1.5 border border-border rounded-md bg-surface text-ink focus:border-accent focus:outline-none"
            >
              <option value="">Автор</option>
              {uniqueCreators.map(([id, name]) => (
                <option key={id} value={id}>{name}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* Список */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <span className="text-sm text-ink-3">Загрузка…</span>
        </div>
      ) : error ? (
        <div className="py-8 text-center">
          <p className="text-sm text-rose">{error}</p>
        </div>
      ) : filteredTasks.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-sm text-ink-3 italic">Ничего не найдено</p>
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-lg">
          {GROUP_ORDER.map((grp) => {
            const grpTasks = groups[grp];
            if (grpTasks.length === 0) return null;
            return (
              <div key={grp} className="border-b border-border last:border-0">
                {/* Заголовок группы */}
                <div className="flex items-baseline gap-2.5 px-5 py-3.5 border-b border-border bg-surface-muted">
                  <span className="text-[11px] font-mono font-semibold uppercase tracking-[0.07em] text-emerald">
                    {GROUP_LABEL[grp]}
                  </span>
                  <span className="text-[11px] font-mono text-ink-3">{grpTasks.length}</span>
                </div>

                {/* Строки задач */}
                <div className="divide-y divide-border">
                  {grpTasks.map((task) => (
                    <ArchiveTaskRow
                      key={task.id}
                      task={task}
                      onReopen={reopenTask}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Кнопка «Загрузить ещё» */}
      {nextCursor && !loading && (
        <div className="mt-4 text-center">
          <button
            onClick={() => void loadTasks(nextCursor)}
            disabled={loadingMore}
            className="inline-flex items-center bg-surface border border-border text-sm text-ink-2 px-4 py-2 rounded hover:border-accent transition-colors disabled:opacity-50"
          >
            {loadingMore ? "Загрузка…" : "Загрузить ещё"}
          </button>
        </div>
      )}
    </div>
  );
}

// ── ArchiveTaskRow ────────────────────────────────────────────────────────────

function ArchiveTaskRow({
  task,
  onReopen,
}: {
  task: Task;
  onReopen: (id: string) => void;
}) {
  const creator = task.createdByUser;

  return (
    <div className="grid grid-cols-[22px_1fr_auto_auto_auto_auto] gap-3.5 items-center px-5 py-3 opacity-85 hover:bg-surface-muted hover:opacity-100 transition-all group">
      {/* Зелёная галочка */}
      <span className="w-5 h-5 rounded-[6px] bg-emerald border-2 border-emerald text-white text-xs font-bold flex items-center justify-center shrink-0">
        ✓
      </span>

      {/* Заголовок + мета */}
      <div className="min-w-0">
        <p className="text-[14px] font-medium text-ink-2 line-through decoration-ink-3 leading-snug truncate">
          {task.title.trim() || <span className="italic">Без названия</span>}
        </p>
        <div className="flex gap-2.5 mt-0.5 flex-wrap">
          {creator && (
            <span className="text-[11px] text-ink-3">
              поставил <b className="text-ink-2 font-medium">{creator.username}</b>
            </span>
          )}
          {task.createdAt && (
            <span className="text-[11px] text-ink-3">{formatShortDate(task.createdAt)}</span>
          )}
        </div>
      </div>

      {/* Исполнитель */}
      <TaskAssigneePill user={task.assignedToUser} />

      {/* Время выполнения */}
      <span className="text-[11px] font-mono text-ink-3 whitespace-nowrap">
        {formatTime(task.completedAt)}
      </span>

      {/* Кнопка «Вернуть» — скрыта, появляется при hover */}
      <button
        onClick={() => void onReopen(task.id)}
        aria-label={`Вернуть задачу «${task.title.trim() || "Без названия"}» в работу`}
        className="text-xs font-medium px-2.5 py-1.5 rounded-md border border-border bg-surface text-ink-2 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-accent-soft hover:text-accent-bright hover:border-accent-border inline-flex items-center gap-1 whitespace-nowrap"
      >
        ↩ Вернуть
      </button>

      {/* Row-menu — появляется при hover */}
      <span
        aria-hidden="true"
        className="text-base text-ink-3 px-1.5 py-0.5 opacity-0 group-hover:opacity-100 transition-opacity select-none"
      >
        ⋯
      </span>
    </div>
  );
}
