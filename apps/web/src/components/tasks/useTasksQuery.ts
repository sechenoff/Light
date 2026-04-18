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

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useTasksQuery(filter: TaskFilter) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Per-id in-flight guard — useRef avoids re-render churn and stale closures
  const inFlight = useRef<Set<string>>(new Set());

  // ── Загрузка ────────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    apiFetch<TasksListResponse>(`/api/tasks?filter=${filter}&status=ALL&limit=200`)
      .then((data) => {
        if (cancelled) return;
        setTasks(data.items ?? []);
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

  // ── createTask ──────────────────────────────────────────────────────────────

  const createTask = useCallback(
    async (input: {
      title: string;
      urgent?: boolean;
      dueDate?: string | null;
      assignedTo?: string | null;
      description?: string | null;
    }) => {
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
      }
    },
    [],
  );

  // ── updateTask ──────────────────────────────────────────────────────────────

  const updateTask = useCallback(
    async (id: string, patch: Partial<Task>) => {
      if (inFlight.current.has(`update-${id}`)) return;
      inFlight.current.add(`update-${id}`);

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
      } catch (err: any) {
        setTasks((t) =>
          t.map((x) => (x.id === id && snapshot ? snapshot : x)),
        );
        toast.error(err?.message ?? "Не удалось обновить задачу");
      } finally {
        inFlight.current.delete(`update-${id}`);
      }
    },
    [],
  );

  // ── reopenTask ──────────────────────────────────────────────────────────────

  const reopenTask = useCallback(
    async (id: string) => {
      if (inFlight.current.has(`reopen-${id}`)) return;
      inFlight.current.add(`reopen-${id}`);

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
      }
    },
    [],
  );

  // ── completeTask (fire-immediately + undo via toast action → reopen) ─────────

  const completeTask = useCallback(
    async (id: string) => {
      if (inFlight.current.has(`complete-${id}`)) return;
      inFlight.current.add(`complete-${id}`);

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
      }
    },
    [reopenTask],
  );

  // ── deleteTask ──────────────────────────────────────────────────────────────

  const deleteTask = useCallback(
    async (id: string) => {
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
