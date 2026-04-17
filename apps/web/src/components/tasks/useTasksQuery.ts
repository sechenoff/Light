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

  // Pending undo map: taskId → { timer, prevTasks }
  const pendingUndo = useRef<Map<string, { timer: ReturnType<typeof setTimeout>; prev: Task[] }>>(
    new Map(),
  );

  // ── Загрузка ────────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    apiFetch<TasksListResponse>(`/api/tasks?filter=${filter}&limit=200`)
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
    }) => {
      const tempId = `temp-${Date.now()}`;
      const optimistic: Task = {
        id: tempId,
        title: input.title,
        status: "OPEN",
        urgent: input.urgent ?? false,
        dueDate: input.dueDate ?? null,
        description: null,
        createdBy: "",
        assignedTo: input.assignedTo ?? null,
        completedBy: null,
        completedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const prev = tasks;
      setTasks((t) => [...t, optimistic]);

      try {
        const created = await apiFetch<Task>("/api/tasks", {
          method: "POST",
          body: JSON.stringify(input),
        });
        setTasks((t) => t.map((x) => (x.id === tempId ? created : x)));
      } catch (err: any) {
        setTasks(prev);
        toast.error(err?.message ?? "Не удалось создать задачу");
      }
    },
    [tasks],
  );

  // ── updateTask ──────────────────────────────────────────────────────────────

  const updateTask = useCallback(
    async (id: string, patch: Partial<Task>) => {
      if (inFlight.current.has(`update-${id}`)) return;
      inFlight.current.add(`update-${id}`);

      const prev = tasks;
      setTasks((t) => t.map((x) => (x.id === id ? { ...x, ...patch } : x)));

      try {
        const updated = await apiFetch<Task>(`/api/tasks/${id}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        });
        setTasks((t) => t.map((x) => (x.id === id ? updated : x)));
      } catch (err: any) {
        setTasks(prev);
        toast.error(err?.message ?? "Не удалось обновить задачу");
      } finally {
        inFlight.current.delete(`update-${id}`);
      }
    },
    [tasks],
  );

  // ── completeTask (optimistic + 5s undo window) ───────────────────────────────

  const completeTask = useCallback(
    async (id: string) => {
      if (inFlight.current.has(`complete-${id}`)) return;
      inFlight.current.add(`complete-${id}`);

      const prev = tasks;
      setTasks((t) =>
        t.map((x) =>
          x.id === id
            ? { ...x, status: "DONE" as const, completedAt: new Date().toISOString() }
            : x,
        ),
      );

      // Сохраняем undo-entry; таймер на 5с отправляет на сервер
      const timer = setTimeout(async () => {
        pendingUndo.current.delete(id);
        inFlight.current.delete(`complete-${id}`);
        try {
          await apiFetch(`/api/tasks/${id}/complete`, { method: "POST" });
        } catch (err: any) {
          setTasks(prev);
          toast.error(err?.message ?? "Не удалось выполнить задачу");
        }
      }, 5000);

      pendingUndo.current.set(id, { timer, prev });
      toast.success("Готово — нажмите «Отменить» в меню задачи");
    },
    [tasks],
  );

  // ── undoComplete (вызывается из UI в течение 5с) ────────────────────────────

  const undoComplete = useCallback(
    (id: string) => {
      const entry = pendingUndo.current.get(id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pendingUndo.current.delete(id);
      inFlight.current.delete(`complete-${id}`);
      setTasks(entry.prev);
    },
    [],
  );

  // ── reopenTask ──────────────────────────────────────────────────────────────

  const reopenTask = useCallback(
    async (id: string) => {
      if (inFlight.current.has(`reopen-${id}`)) return;
      inFlight.current.add(`reopen-${id}`);

      const prev = tasks;
      setTasks((t) =>
        t.map((x) =>
          x.id === id
            ? { ...x, status: "OPEN" as const, completedAt: null, completedBy: null }
            : x,
        ),
      );

      try {
        await apiFetch(`/api/tasks/${id}/reopen`, { method: "POST" });
      } catch (err: any) {
        setTasks(prev);
        toast.error(err?.message ?? "Не удалось открыть задачу");
      } finally {
        inFlight.current.delete(`reopen-${id}`);
      }
    },
    [tasks],
  );

  // ── deleteTask ──────────────────────────────────────────────────────────────

  const deleteTask = useCallback(
    async (id: string) => {
      const prev = tasks;
      setTasks((t) => t.filter((x) => x.id !== id));

      try {
        await apiFetch(`/api/tasks/${id}`, { method: "DELETE" });
      } catch (err: any) {
        setTasks(prev);
        toast.error(err?.message ?? "Не удалось удалить задачу");
      }
    },
    [tasks],
  );

  return {
    tasks,
    loading,
    error,
    createTask,
    updateTask,
    completeTask,
    undoComplete,
    reopenTask,
    deleteTask,
    setTasks,
  };
}
