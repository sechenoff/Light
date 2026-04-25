"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import Link from "next/link";
import { apiFetch } from "../../lib/api";
import { toast } from "../ToastProvider";
import { toMoscowDateString } from "../../lib/moscowDate";
import { pluralize } from "../../lib/format";
import { TaskCreateModal } from "../tasks/TaskCreateModal";

// ── Типы ──────────────────────────────────────────────────────────────────────

interface TaskSummary {
  id: string;
  title: string;
  dueDate: string | null;
  urgent: boolean;
  status?: "OPEN" | "DONE";
}

interface DashboardTodayWithTasks {
  myTasks?: TaskSummary[];
}

// ── Chip дня ──────────────────────────────────────────────────────────────────

function dayChip(task: TaskSummary): { label: string; className: string } {
  if (!task.dueDate) {
    if (task.urgent) return { label: "сегодня", className: "text-amber font-medium" };
    return { label: "", className: "" };
  }
  const now = new Date();
  const todayStr = toMoscowDateString(now);
  const dueStr = toMoscowDateString(new Date(task.dueDate));
  if (dueStr < todayStr) {
    const ms = now.getTime() - new Date(task.dueDate).getTime();
    const days = Math.max(1, Math.floor(ms / 86_400_000));
    return { label: `← ${days} ${pluralize(days, "день", "дня", "дней")}`, className: "text-rose font-medium" };
  }
  if (dueStr === todayStr) return { label: "сегодня", className: "text-amber font-medium" };
  const ms = new Date(task.dueDate).getTime() - now.getTime();
  const days = Math.max(1, Math.ceil(ms / 86_400_000));
  return { label: `+${days} ${pluralize(days, "день", "дня", "дней")}`, className: "text-ink-3" };
}

// ── DayTasksWidget ────────────────────────────────────────────────────────────

export function DayTasksWidget({
  className = "",
  dashboard,
}: {
  className?: string;
  dashboard?: DashboardTodayWithTasks | null;
}) {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [openCount, setOpenCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(dashboard === undefined);
  const [creating, setCreating] = useState(false);
  const [assigneeOptions, setAssigneeOptions] = useState<Array<{ id: string; username: string }>>([]);

  const inFlight = useRef<Set<string>>(new Set());

  // ── Загрузка ────────────────────────────────────────────────────────────────

  const loadTasks = useCallback(() => {
    let cancelled = false;
    setLoading(true);

    apiFetch<DashboardTodayWithTasks>("/api/dashboard/today")
      .then((d) => {
        if (cancelled) return;
        setTasks(d.myTasks ?? []);
      })
      .catch(() => {
        if (!cancelled) setTasks([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Если dashboard передан как prop — берём myTasks из него, не делаем отдельный запрос
  useEffect(() => {
    if (dashboard !== undefined) {
      setTasks(dashboard?.myTasks ?? []);
      setLoading(false);
      return;
    }
    const cleanup = loadTasks();
    return cleanup;
  }, [dashboard, loadTasks]);

  // task-stats всегда загружается независимо от наличия dashboard prop
  useEffect(() => {
    let cancelled = false;
    apiFetch<{ myOpen: number }>("/api/dashboard/task-stats")
      .then((d) => {
        if (!cancelled) setOpenCount(d.myOpen);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ users: Array<{ id: string; username: string }> }>("/api/admin-users/assignable")
      .then((d) => {
        if (!cancelled) setAssigneeOptions(d.users ?? []);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // ── Оптимистичные мутации ────────────────────────────────────────────────────

  const reopenTask = useCallback(async (id: string) => {
    if (inFlight.current.has(`reopen-${id}`)) return;
    inFlight.current.add(`reopen-${id}`);
    // Оптимистично отмечаем как OPEN
    setTasks((prev) => prev.map((t) => t.id === id ? { ...t, status: "OPEN" as const } : t));
    try {
      await apiFetch(`/api/tasks/${id}/reopen`, { method: "POST" });
    } catch (err: any) {
      // Сервер отклонил — откатываем обратно на DONE
      setTasks((prev) => prev.map((t) => t.id === id ? { ...t, status: "DONE" as const } : t));
      toast.error(err?.message ?? "Не удалось вернуть задачу");
    } finally {
      inFlight.current.delete(`reopen-${id}`);
    }
  }, []);

  const completeTask = useCallback(async (id: string) => {
    if (inFlight.current.has(`complete-${id}`)) return;
    inFlight.current.add(`complete-${id}`);

    let snapshot: TaskSummary | undefined;
    // Оптимистично помечаем как DONE (не удаляем из списка)
    setTasks((prev) => {
      snapshot = prev.find((t) => t.id === id);
      return prev.map((t) => t.id === id ? { ...t, status: "DONE" as const } : t);
    });

    try {
      await apiFetch(`/api/tasks/${id}/complete`, { method: "POST" });
      if (snapshot) {
        toast.success("Задача выполнена", {
          durationMs: 6000,
          action: { label: "Отменить", onClick: () => { void reopenTask(id); } },
        });
      }
    } catch (err: any) {
      // Откат — возвращаем прежний статус
      if (snapshot) {
        const snap = snapshot;
        setTasks((prev) => prev.map((t) => t.id === id ? snap : t));
      }
      toast.error(err?.message ?? "Не удалось выполнить задачу");
    } finally {
      inFlight.current.delete(`complete-${id}`);
    }
  }, [reopenTask]);

  // ── Рендер ──────────────────────────────────────────────────────────────────

  const visible = tasks.slice(0, 5);

  return (
    <div className={`bg-surface border border-border rounded-lg p-3 ${className}`}>
      <div className="flex items-center justify-between mb-2">
        <p className="eyebrow">МОИ ЗАДАЧИ</p>
        <button
          onClick={() => setCreating(true)}
          aria-label="Создать задачу"
          className="text-accent hover:text-accent-bright text-base leading-none transition-colors"
        >
          +
        </button>
      </div>

      {loading ? (
        <p className="text-xs text-ink-3">Загрузка…</p>
      ) : visible.length === 0 ? (
        <p className="text-xs text-ink-3 italic">Задач на сегодня нет</p>
      ) : (
        <ul className="divide-y divide-border">
          {visible.map((task) => {
            const chip = dayChip(task);
            const isDone = task.status === "DONE";
            return (
              <li key={task.id} className={`py-1.5 flex items-center gap-2 ${isDone ? "opacity-60" : ""}`}>
                <input
                  type="checkbox"
                  checked={isDone}
                  className="accent-teal w-4 h-4 rounded-sm shrink-0 cursor-pointer"
                  aria-label={isDone ? "Вернуть в работу" : "Отметить выполненным"}
                  onChange={() => isDone ? void reopenTask(task.id) : void completeTask(task.id)}
                />
                <span className={`flex-1 text-sm truncate ${isDone ? "line-through text-ink-3" : "text-ink"}`}>
                  {task.urgent && !isDone && (
                    <span className="text-rose font-bold mr-1" aria-label="Срочно">!</span>
                  )}
                  {task.title}
                </span>
                {chip.label && !isDone && (
                  <span className={`text-xs shrink-0 ${chip.className}`}>{chip.label}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-2 text-right">
        <Link
          href="/tasks?filter=my"
          className="text-xs text-accent hover:underline"
        >
          Все мои →{openCount !== null ? ` (${openCount} открыто)` : ""}
        </Link>
      </div>

      {/* Модалка создания */}
      {creating && (
        <TaskCreateModal
          onSubmit={async (input) => {
            await apiFetch("/api/tasks", {
              method: "POST",
              body: JSON.stringify(input),
            });
            setCreating(false);
            // Перезагружаем список задач
            loadTasks();
          }}
          onClose={() => setCreating(false)}
          assigneeOptions={assigneeOptions}
        />
      )}
    </div>
  );
}
