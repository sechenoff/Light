"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { apiFetch } from "../../lib/api";
import { toast } from "../ToastProvider";
import type { Task } from "./groupTasks";

// ── Типы ──────────────────────────────────────────────────────────────────────

export type TaskFilter = "my" | "all" | "created-by-me";

interface TasksListResponse {
  items: Task[];
  nextCursor: string | null;
}

// Секция «Выполнено сегодня» показывает DONE за последние 24 часа —
// грузим их отдельным запросом с сортировкой по completedAt desc.
const DONE_RECENT_LIMIT = 50;
const DONE_TODAY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Главный список = открытые задачи + выполненные за последние 24 часа.
 *
 * Раньше был один запрос status=ALL&limit=200 с сортировкой id asc — как только
 * суммарное число задач (включая всю DONE-историю) превышало 200, свежесозданные
 * задачи тихо выпадали из первой страницы. Открытых сотни не бывает, а DONE-история
 * больше не конкурирует за окно выборки.
 */
export async function fetchMainTaskLists(filter: TaskFilter): Promise<Task[]> {
  const [open, done] = await Promise.all([
    apiFetch<TasksListResponse>(`/api/tasks?filter=${filter}&status=OPEN&limit=200`),
    apiFetch<TasksListResponse>(
      `/api/tasks?filter=${filter}&status=DONE&sort=completedAt-desc&limit=${DONE_RECENT_LIMIT}`,
    ),
  ]);
  const nowMs = Date.now();
  const recentDone = (done.items ?? []).filter(
    (t) => t.completedAt && nowMs - new Date(t.completedAt).getTime() < DONE_TODAY_WINDOW_MS,
  );
  return [...(open.items ?? []), ...recentDone];
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useTasksQuery(filter: TaskFilter) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Per-id in-flight guard — useRef avoids re-render churn and stale closures
  const inFlight = useRef<Set<string>>(new Set());

  // Suppresses the 12s poll's blind setTasks while any optimistic mutation's
  // network request is in flight — otherwise the poll clobbers temp-/optimistic
  // entries and the mutation's reconcile no-ops. Mirrors useTaskDetail (Task 7).
  const pollBlocked = useRef(false);

  // ── Загрузка ────────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchMainTaskLists(filter)
      .then((items) => {
        if (cancelled) return;
        setTasks(items);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [filter]);

  // ── Smart polling: refetch list every 12s, paused when tab hidden ──
  useEffect(() => {
    const POLL_MS = 12000;
    let timer: ReturnType<typeof setInterval> | null = null;

    const poll = () => {
      if (pollBlocked.current) return;
      fetchMainTaskLists(filter)
        .then((items) => setTasks(items))
        .catch(() => {
          /* keep last good state; errors surfaced on user actions */
        });
    };

    const start = () => {
      if (!timer) timer = setInterval(poll, POLL_MS);
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVis = () => {
      if (document.hidden) stop();
      else {
        poll();
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [filter]);

  // ── createTask ──────────────────────────────────────────────────────────────

  const createTask = useCallback(
    async (input: {
      title: string;
      urgent?: boolean;
      dueDate?: string | null;
      assignedTo?: string | null;
      description?: string | null;
    }) => {
      pollBlocked.current = true;
      const tempId = `temp-${Date.now()}`;
      const optimistic: Task = {
        id: tempId,
        title: input.title,
        status: "OPEN",
        urgent: input.urgent ?? false,
        dueDate: input.dueDate ?? null,
        description: input.description ?? null,
        createdBy: "",
        assignedTo: input.assignedTo ?? null,
        completedBy: null,
        completedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      setTasks((t) => [...t, optimistic]);

      try {
        const { task: created } = await apiFetch<{ task: Task }>("/api/tasks", {
          method: "POST",
          body: JSON.stringify(input),
        });
        setTasks((t) => t.map((x) => (x.id === tempId ? created : x)));
      } catch (err: any) {
        setTasks((t) => t.filter((x) => x.id !== tempId));
        toast.error(err?.message ?? "Не удалось создать задачу");
      } finally {
        pollBlocked.current = false;
      }
    },
    [],
  );

  // ── updateTask ──────────────────────────────────────────────────────────────

  const updateTask = useCallback(
    async (id: string, patch: Partial<Task>): Promise<boolean> => {
      if (inFlight.current.has(`update-${id}`)) return false;
      inFlight.current.add(`update-${id}`);
      pollBlocked.current = true;

      // Snapshot just the affected task for targeted rollback
      let snapshot: Task | undefined;
      setTasks((t) => {
        snapshot = t.find((x) => x.id === id);
        return t.map((x) => (x.id === id ? { ...x, ...patch } : x));
      });

      try {
        const { task: updated } = await apiFetch<{ task: Task }>(`/api/tasks/${id}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        });
        setTasks((t) => t.map((x) => (x.id === id ? updated : x)));
        return true;
      } catch (err: any) {
        setTasks((t) =>
          t.map((x) => (x.id === id && snapshot ? snapshot : x)),
        );
        toast.error(err?.message ?? "Не удалось обновить задачу");
        return false;
      } finally {
        inFlight.current.delete(`update-${id}`);
        pollBlocked.current = false;
      }
    },
    [],
  );

  // ── reopenTask ──────────────────────────────────────────────────────────────

  const reopenTask = useCallback(
    async (id: string) => {
      if (inFlight.current.has(`reopen-${id}`)) return;
      inFlight.current.add(`reopen-${id}`);
      pollBlocked.current = true;

      let snapshot: Task | undefined;
      setTasks((t) => {
        snapshot = t.find((x) => x.id === id);
        return t.map((x) =>
          x.id === id
            ? { ...x, status: "OPEN" as const, completedAt: null, completedBy: null }
            : x,
        );
      });

      try {
        await apiFetch(`/api/tasks/${id}/reopen`, { method: "POST" });
      } catch (err: any) {
        setTasks((t) =>
          t.map((x) => (x.id === id && snapshot ? snapshot : x)),
        );
        toast.error(err?.message ?? "Не удалось открыть задачу");
      } finally {
        inFlight.current.delete(`reopen-${id}`);
        pollBlocked.current = false;
      }
    },
    [],
  );

  // ── completeTask (fire-immediately + undo via toast action → reopen) ─────────

  const completeTask = useCallback(
    async (id: string) => {
      if (inFlight.current.has(`complete-${id}`)) return;
      inFlight.current.add(`complete-${id}`);
      pollBlocked.current = true;

      let snapshot: Task | undefined;
      setTasks((t) => {
        snapshot = t.find((x) => x.id === id);
        return t.map((x) =>
          x.id === id
            ? { ...x, status: "DONE" as const, completedAt: new Date().toISOString() }
            : x,
        );
      });

      try {
        await apiFetch(`/api/tasks/${id}/complete`, { method: "POST" });
        toast.success("Задача выполнена", {
          durationMs: 6000,
          action: {
            label: "Отменить",
            onClick: () => {
              void reopenTask(id);
            },
          },
        });
      } catch (err: any) {
        setTasks((t) =>
          t.map((x) => (x.id === id && snapshot ? snapshot : x)),
        );
        toast.error(err?.message ?? "Не удалось выполнить задачу");
      } finally {
        inFlight.current.delete(`complete-${id}`);
        pollBlocked.current = false;
      }
    },
    [reopenTask],
  );

  // ── deleteTask ──────────────────────────────────────────────────────────────

  const deleteTask = useCallback(
    async (id: string) => {
      pollBlocked.current = true;
      let snapshot: Task | undefined;
      setTasks((t) => {
        snapshot = t.find((x) => x.id === id);
        return t.filter((x) => x.id !== id);
      });

      try {
        await apiFetch(`/api/tasks/${id}`, { method: "DELETE" });
      } catch (err: any) {
        if (snapshot) {
          setTasks((t) => [...t, snapshot!]);
        }
        toast.error(err?.message ?? "Не удалось удалить задачу");
      } finally {
        pollBlocked.current = false;
      }
    },
    [],
  );

  return {
    tasks,
    loading,
    error,
    createTask,
    updateTask,
    completeTask,
    reopenTask,
    deleteTask,
    setTasks,
  };
}
