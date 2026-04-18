"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useRequireRole } from "../../hooks/useRequireRole";
import { useTasksQuery, type TaskFilter } from "./useTasksQuery";
import { TaskFilterPills } from "./TaskFilterPills";
import { TaskGroupList } from "./TaskGroupList";
import { TaskEditModal } from "./TaskEditModal";
import { TaskCreateModal } from "./TaskCreateModal";
import { TaskEmptyState } from "./TaskEmptyState";
import { apiFetch } from "../../lib/api";
import { pluralize } from "../../lib/format";
import { toMoscowDateString } from "../../lib/moscowDate";
import type { Task } from "./groupTasks";

// ── Типы ──────────────────────────────────────────────────────────────────────

interface AdminUserOption {
  id: string;
  username: string;
}

const VALID_FILTERS: readonly TaskFilter[] = ["my", "all", "created-by-me"] as const;

function parseFilter(raw: string | null | undefined): TaskFilter {
  if (raw && (VALID_FILTERS as readonly string[]).includes(raw)) {
    return raw as TaskFilter;
  }
  return "all"; // v2: default = "all"
}

const FILTER_TITLE: Record<TaskFilter, string> = {
  my: "Мои задачи",
  all: "Все задачи",
  "created-by-me": "Я поставил",
};

// ── TasksPage ─────────────────────────────────────────────────────────────────

export function TasksPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading: authLoading } = useRequireRole([
    "SUPER_ADMIN",
    "WAREHOUSE",
    "TECHNICIAN",
  ]);

  // Фильтр из URL-параметра
  const initialFilter = parseFilter(searchParams?.get("filter"));
  const [filter, setFilter] = useState<TaskFilter>(initialFilter);

  const {
    tasks,
    loading,
    error,
    createTask,
    updateTask,
    completeTask,
    reopenTask,
    deleteTask,
  } = useTasksQuery(filter);

  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [creating, setCreating] = useState(false);
  const [assigneeOptions, setAssigneeOptions] = useState<AdminUserOption[]>([]);

  // Клиентские фильтры поверх загруженных задач
  const [assigneeFilter, setAssigneeFilter] = useState<string>(""); // "" = любой
  const [urgentOnly, setUrgentOnly] = useState(false);

  // ── Загрузка пользователей ────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ users: AdminUserOption[] }>("/api/admin-users/assignable")
      .then((data) => {
        if (!cancelled) setAssigneeOptions(data.users ?? []);
      })
      .catch(() => {
        // Не блокирует страницу
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Синхронизация фильтра с URL ───────────────────────────────────────────

  function handleFilterChange(f: TaskFilter) {
    setFilter(f);
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    params.set("filter", f);
    router.replace(`/tasks?${params.toString()}`);
  }

  // ── Клавиша N — открыть модалку создания ─────────────────────────────────

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "n" && e.key !== "N") return;
      const tag = (document.activeElement?.tagName ?? "").toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (document.querySelector("[role=dialog]")) return;
      e.preventDefault();
      setCreating(true);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleCreate = useCallback(
    async (input: { title: string; urgent: boolean; dueDate: string | null; assignedTo: string | null; description?: string | null }) => {
      await createTask(input);
    },
    [createTask],
  );

  const handleUpdate = useCallback(
    async (id: string, patch: Partial<Task>) => {
      await updateTask(id, patch);
    },
    [updateTask],
  );

  const handleComplete = useCallback(
    (id: string) => {
      completeTask(id);
    },
    [completeTask],
  );

  const handleReopen = useCallback(
    (id: string) => {
      reopenTask(id);
    },
    [reopenTask],
  );

  const handleDelete = useCallback(
    (id: string) => {
      deleteTask(id);
    },
    [deleteTask],
  );

  const handleSaveEdit = useCallback(
    (id: string, patch: Partial<Task>) => {
      updateTask(id, patch);
    },
    [updateTask],
  );

  // ── Клиентская фильтрация задач ───────────────────────────────────────────

  const filteredTasks = useMemo(() => {
    return tasks.filter((t) => {
      if (assigneeFilter === "__none__" && t.assignedTo !== null) return false;
      if (assigneeFilter && assigneeFilter !== "__none__" && t.assignedTo !== assigneeFilter) return false;
      if (urgentOnly && !t.urgent) return false;
      return true;
    });
  }, [tasks, assigneeFilter, urgentOnly]);

  // ── Счётчики для подстроки заголовка ─────────────────────────────────────

  const now = useMemo(() => new Date(), []);
  const todayStr = useMemo(() => toMoscowDateString(now), [now]);

  const activeCount = tasks.filter((t) => t.status === "OPEN").length;
  const overdueCount = tasks.filter(
    (t) => t.status === "OPEN" && t.dueDate && toMoscowDateString(new Date(t.dueDate)) < todayStr,
  ).length;
  const urgentCount = tasks.filter((t) => t.status === "OPEN" && t.urgent).length;
  const doneTodayCount = tasks.filter(
    (t) =>
      t.status === "DONE" &&
      t.completedAt &&
      now.getTime() - new Date(t.completedAt).getTime() < 24 * 60 * 60 * 1000,
  ).length;

  function buildCountsLine(): string {
    if (loading) return "…";
    const parts: string[] = [];
    if (activeCount > 0) {
      parts.push(`${activeCount} ${pluralize(activeCount, "активная", "активные", "активных")}`);
    }
    if (overdueCount > 0) {
      parts.push(`${overdueCount} ${pluralize(overdueCount, "просрочена", "просрочены", "просрочено")}`);
    }
    if (urgentCount > 0) {
      parts.push(`${urgentCount} ${pluralize(urgentCount, "срочная", "срочные", "срочных")}`);
    }
    if (doneTodayCount > 0) {
      parts.push(`${doneTodayCount} ${pluralize(doneTodayCount, "выполнена сегодня", "выполнены сегодня", "выполнено сегодня")}`);
    }
    return parts.length > 0 ? parts.join(" · ") : "пока пусто";
  }

  // ── Рендер ────────────────────────────────────────────────────────────────

  if (authLoading || !user) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[200px]">
        <span className="text-sm text-ink-3">Загрузка…</span>
      </div>
    );
  }

  const isEmpty = !loading && filteredTasks.length === 0;

  return (
    <div className="p-4 md:p-6 space-y-4 w-full">
      {/* Заголовок: eyebrow + h1 + кнопка */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="eyebrow">Задачи</p>
          <h1 className="text-[22px] font-semibold text-ink mt-0.5 tracking-tight">
            {FILTER_TITLE[filter]}
          </h1>
          <p className="text-[13px] text-ink-3 mt-0.5">
            {buildCountsLine()}
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="shrink-0 bg-accent-bright text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:opacity-90 transition-opacity inline-flex items-center gap-1.5"
        >
          + Создать задачу
        </button>
      </div>

      {/* Filter bar */}
      <div className="bg-surface border border-border rounded-[10px] px-4 py-3 flex justify-between items-center gap-4 flex-wrap">
        {/* Левые пилюли */}
        <TaskFilterPills value={filter} onChange={handleFilterChange} />

        {/* Правые контролы */}
        <div className="flex items-center gap-2.5 flex-wrap">
          {/* Исполнитель */}
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] text-ink-3 uppercase tracking-[0.04em] font-medium">
              Исполнитель
            </label>
            <select
              value={assigneeFilter}
              onChange={(e) => setAssigneeFilter(e.target.value)}
              className="text-[13px] px-2.5 py-1.5 border border-border rounded-md bg-surface text-ink focus:outline-none focus:border-accent"
            >
              <option value="">Любой</option>
              {assigneeOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.username}
                </option>
              ))}
              <option value="__none__">— Никому</option>
            </select>
          </div>

          {/* Только срочные */}
          <button
            type="button"
            onClick={() => setUrgentOnly((v) => !v)}
            className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border transition-colors ${
              urgentOnly
                ? "bg-rose-soft text-rose border-rose-border font-medium"
                : "bg-surface text-ink-2 border-border hover:border-border-strong"
            }`}
          >
            🔥 Только срочные
          </button>
        </div>
      </div>

      {/* Ошибка */}
      {error && (
        <div className="bg-rose-soft border border-rose-border rounded-lg px-4 py-3 text-sm text-rose">
          {error}
        </div>
      )}

      {/* Скелетон при загрузке */}
      {loading && (
        <div className="bg-surface border border-border rounded-lg overflow-hidden shadow-xs">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3 border-b border-border last:border-0">
              <div className="w-5 h-5 rounded bg-surface-muted animate-pulse shrink-0" />
              <div className="flex-1 h-4 bg-surface-muted rounded animate-pulse" />
              <div className="h-4 w-20 bg-surface-muted rounded animate-pulse" />
            </div>
          ))}
        </div>
      )}

      {/* Список задач */}
      {!loading && !isEmpty && (
        <TaskGroupList
          tasks={filteredTasks}
          onComplete={handleComplete}
          onReopen={handleReopen}
          onUpdate={handleUpdate}
          onDelete={handleDelete}
          onOpenEdit={setEditingTask}
        />
      )}

      {/* Пустое состояние */}
      {isEmpty && <TaskEmptyState />}

      {/* Архивная прomo-карточка */}
      <div className="flex justify-between items-center gap-3 mt-5 p-4 bg-surface border border-border rounded-lg">
        <div className="text-sm">
          <b className="text-ink font-medium">Архив задач</b>
          <span className="text-ink-3"> · выполненные старше 24 часов уходят сюда</span>
        </div>
        <Link
          href="/tasks/archive"
          className="text-sm font-medium px-4 py-2 rounded-md border border-border-strong text-ink hover:bg-surface-muted inline-flex items-center gap-2 whitespace-nowrap"
        >
          📁 Открыть архив →
        </Link>
      </div>

      {/* Модалка редактирования */}
      {editingTask && (
        <TaskEditModal
          task={editingTask}
          assigneeOptions={assigneeOptions}
          onSave={handleSaveEdit}
          onClose={() => setEditingTask(null)}
        />
      )}

      {/* Модалка создания */}
      {creating && (
        <TaskCreateModal
          onSubmit={async (input) => {
            await handleCreate(input);
            setCreating(false);
          }}
          onClose={() => setCreating(false)}
          assigneeOptions={assigneeOptions}
        />
      )}
    </div>
  );
}
