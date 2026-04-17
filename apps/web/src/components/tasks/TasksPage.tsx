"use client";

import { useEffect, useState, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useRequireRole } from "../../hooks/useRequireRole";
import { useTasksQuery, type TaskFilter } from "./useTasksQuery";
import { TaskFilterPills } from "./TaskFilterPills";
import { TaskGroupList } from "./TaskGroupList";
import { TaskEditModal } from "./TaskEditModal";
import { TaskCreateModal } from "./TaskCreateModal";
import { TaskEmptyState } from "./TaskEmptyState";
import { apiFetch } from "../../lib/api";
import { pluralize } from "../../lib/format";
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
  return "my";
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

  // Фильтр из URL-параметра (с валидацией whitelist)
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

  // ── Загрузка пользователей для выпадающего списка исполнителей ────────────
  // Используем /assignable (доступно всем 3 ролям), а не /api/admin-users (SA only)

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ users: AdminUserOption[] }>("/api/admin-users/assignable")
      .then((data) => {
        if (!cancelled) setAssigneeOptions(data.users ?? []);
      })
      .catch(() => {
        // Отказ не блокирует страницу — задачи без исполнителя всё равно можно создавать
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
    async (input: { title: string; urgent: boolean; dueDate: string | null; assignedTo: string | null }) => {
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

  // ── Счётчики для подстроки заголовка ─────────────────────────────────────

  const activeCount = tasks.filter((t) => t.status === "OPEN").length;
  const urgentCount = tasks.filter((t) => t.status === "OPEN" && t.urgent).length;

  function buildCountsLine(): string {
    if (loading) return "…";
    if (activeCount === 0) return "пока пусто";
    const activePart = `${activeCount} ${pluralize(activeCount, "активная", "активные", "активных")}`;
    if (urgentCount === 0) return activePart;
    const urgentPart = `${urgentCount} ${pluralize(urgentCount, "срочная", "срочные", "срочных")}`;
    return `${activePart}, ${urgentPart}`;
  }

  // ── Рендер ────────────────────────────────────────────────────────────────

  if (authLoading || !user) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[200px]">
        <span className="text-sm text-ink-3">Загрузка…</span>
      </div>
    );
  }

  const isEmpty = !loading && tasks.length === 0;

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-3xl">
      {/* Заголовок: eyebrow + h1 + кнопка */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="eyebrow">Задачи</p>
          <h1 className="text-lg font-semibold text-ink mt-0.5">{FILTER_TITLE[filter]}</h1>
          <p className="text-xs text-ink-3 mt-0.5">
            {FILTER_TITLE[filter]} · {buildCountsLine()}
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="shrink-0 bg-accent-bright text-white px-3 py-1.5 rounded text-sm font-medium hover:opacity-90 transition-opacity"
        >
          + Создать задачу
        </button>
      </div>

      {/* Фильтры */}
      <TaskFilterPills value={filter} onChange={handleFilterChange} />

      {/* Разделитель */}
      <hr className="border-border" />

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
              <div className="w-4 h-4 rounded bg-surface-muted animate-pulse shrink-0" />
              <div className="flex-1 h-4 bg-surface-muted rounded animate-pulse" />
              <div className="h-4 w-16 bg-surface-muted rounded animate-pulse" />
            </div>
          ))}
        </div>
      )}

      {/* Список задач */}
      {!loading && !isEmpty && (
        <TaskGroupList
          tasks={tasks}
          onComplete={handleComplete}
          onReopen={handleReopen}
          onUpdate={handleUpdate}
          onDelete={handleDelete}
          onOpenEdit={setEditingTask}
        />
      )}

      {/* Пустое состояние */}
      {isEmpty && <TaskEmptyState />}

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
