"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import Link from "next/link";
import { apiFetch } from "../../lib/api";
import { toast } from "../ToastProvider";
import { toMoscowDateString } from "../../lib/moscowDate";
import { pluralize } from "../../lib/format";

// ── Типы ──────────────────────────────────────────────────────────────────────

interface TaskSummary {
  id: string;
  title: string;
  dueDate: string | null;
  urgent: boolean;
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

export function DayTasksWidget({ className = "" }: { className?: string }) {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [openCount, setOpenCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const inFlight = useRef<Set<string>>(new Set());

  // ── Загрузка ────────────────────────────────────────────────────────────────

  useEffect(() => {
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

    // Отдельный запрос для подсчёта «открытых»
    apiFetch<{ myOpen: number }>("/api/dashboard/task-stats")
      .then((d) => {
        if (!cancelled) setOpenCount(d.myOpen);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  // ── Оптимистичное выполнение ────────────────────────────────────────────────

  const reopenTask = useCallback(async (id: string, snapshot: TaskSummary) => {
    if (inFlight.current.has(`reopen-${id}`)) return;
    inFlight.current.add(`reopen-${id}`);
    // Возвращаем задачу обратно в список
    setTasks((prev) => prev.some((t) => t.id === id) ? prev : [snapshot, ...prev]);
    try {
      await apiFetch(`/api/tasks/${id}/reopen`, { method: "POST" });
    } catch (err: any) {
      // Сервер отклонил — убираем снова
      setTasks((prev) => prev.filter((t) => t.id !== id));
      toast.error(err?.message ?? "Не удалось вернуть задачу");
    } finally {
      inFlight.current.delete(`reopen-${id}`);
    }
  }, []);

  const completeTask = useCallback(async (id: string) => {
    if (inFlight.current.has(`complete-${id}`)) return;
    inFlight.current.add(`complete-${id}`);

    let snapshot: TaskSummary | undefined;
    setTasks((prev) => {
      snapshot = prev.find((t) => t.id === id);
      return prev.filter((t) => t.id !== id);
    });

    try {
      await apiFetch(`/api/tasks/${id}/complete`, { method: "POST" });
      if (snapshot) {
        const snap = snapshot;
        toast.success("Задача выполнена", {
          durationMs: 6000,
          action: { label: "Отменить", onClick: () => { void reopenTask(id, snap); } },
        });
      }
    } catch (err: any) {
      if (snapshot) {
        const snap = snapshot;
        setTasks((prev) => (prev.some((t) => t.id === id) ? prev : [snap, ...prev]));
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
      <p className="eyebrow mb-2">МОИ ЗАДАЧИ</p>

      {loading ? (
        <p className="text-xs text-ink-3">Загрузка…</p>
      ) : visible.length === 0 ? (
        <p className="text-xs text-ink-3 italic">Задач на сегодня нет</p>
      ) : (
        <ul className="divide-y divide-border">
          {visible.map((task) => {
            const chip = dayChip(task);
            return (
              <li key={task.id} className="py-1.5 flex items-center gap-2">
                <input
                  type="checkbox"
                  className="accent-teal w-4 h-4 rounded-sm shrink-0 cursor-pointer"
                  aria-label="Отметить выполненным"
                  onChange={() => void completeTask(task.id)}
                />
                <span className="flex-1 text-sm text-ink truncate">
                  {task.urgent && (
                    <span className="text-rose font-bold mr-1" aria-label="Срочно">!</span>
                  )}
                  {task.title}
                </span>
                {chip.label && (
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
    </div>
  );
}
