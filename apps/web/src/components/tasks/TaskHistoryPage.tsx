"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { apiFetch } from "../../lib/api";
import { toast } from "../ToastProvider";
import { SectionHeader } from "../SectionHeader";
import { TaskFilterPills } from "./TaskFilterPills";
import type { TaskFilter } from "./useTasksQuery";
import type { Task } from "./groupTasks";

// ── Типы ──────────────────────────────────────────────────────────────────────

interface TasksListResponse {
  items: Task[];
  nextCursor: string | null;
}

// ── Форматирование даты ────────────────────────────────────────────────────────

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("ru-RU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  });
}

// ── TaskHistoryPage ───────────────────────────────────────────────────────────

export function TaskHistoryPage() {
  const [filter, setFilter] = useState<TaskFilter>("my");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inFlight = useRef<Set<string>>(new Set());

  // ── Загрузка ────────────────────────────────────────────────────────────────

  const loadTasks = useCallback(
    async (f: TaskFilter, cursor?: string) => {
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
          filter: f,
          status: "DONE",
          limit: "50",
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
          setError(err?.message ?? "Не удалось загрузить историю задач");
        } else {
          toast.error(err?.message ?? "Не удалось загрузить больше задач");
        }
      } finally {
        if (isInitial) setLoading(false);
        else setLoadingMore(false);
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    setError(null);
    setTasks([]);
    setNextCursor(null);

    const params = new URLSearchParams({
      filter,
      status: "DONE",
      limit: "50",
    });

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

    return () => {
      cancelled = true;
    };
  }, [filter]);

  // ── Вернуть (reopen) ────────────────────────────────────────────────────────

  const reopenTask = useCallback(async (id: string) => {
    if (inFlight.current.has(id)) return;
    inFlight.current.add(id);

    // Оптимистично убираем из истории
    setTasks((prev) => prev.filter((t) => t.id !== id));

    try {
      await apiFetch(`/api/tasks/${id}/reopen`, { method: "POST" });
      toast.success("Задача возвращена в работу");
    } catch (err: any) {
      // Возвращаем — перезагрузка не нужна, просто покажем тост
      toast.error(err?.message ?? "Не удалось вернуть задачу");
      // Не восстанавливаем в списке, страница будет чуть устаревшей до refresh
    } finally {
      inFlight.current.delete(id);
    }
  }, []);

  // ── Загрузить ещё ───────────────────────────────────────────────────────────

  const loadMore = useCallback(() => {
    if (nextCursor) {
      void loadTasks(filter, nextCursor);
    }
  }, [filter, nextCursor, loadTasks]);

  // ── Рендер ──────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 max-w-3xl mx-auto">
      {/* Шапка с навигацией назад */}
      <div className="flex items-center gap-3 mb-4">
        <Link
          href="/tasks"
          className="text-sm text-accent hover:underline"
          aria-label="Назад к задачам"
        >
          ← Задачи
        </Link>
      </div>

      <SectionHeader eyebrow="ЗАДАЧИ" title="История выполненных" className="mb-4" />

      <div className="mb-4">
        <TaskFilterPills value={filter} onChange={setFilter} />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <span className="text-sm text-ink-3">Загрузка…</span>
        </div>
      ) : error ? (
        <div className="py-8 text-center">
          <p className="text-sm text-rose">{error}</p>
        </div>
      ) : tasks.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-sm text-ink-3 italic">Выполненных задач нет</p>
        </div>
      ) : (
        <>
          <ul className="divide-y divide-border bg-surface border border-border rounded-lg">
            {tasks.map((task) => {
              const completedByName = task.completedBy
                ? task.completedByUser?.username ?? task.completedBy
                : null;
              const assignedName = task.assignedToUser?.username ?? null;
              const showCompletedBy =
                completedByName &&
                completedByName !== (task.assignedToUser?.username ?? null) &&
                completedByName !== (task.assignedTo ?? null);

              return (
                <li
                  key={task.id}
                  className="px-4 py-3 flex items-start gap-3 hover:bg-surface-muted/50 transition-colors"
                >
                  {/* Иконка галочки */}
                  <span className="text-emerald mt-0.5 shrink-0" aria-hidden>✓</span>

                  {/* Основная информация */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-ink-3 line-through truncate">
                      {task.title.trim() ? task.title : <span className="italic">Без названия</span>}
                    </p>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
                      {assignedName && (
                        <span className="text-xs text-ink-3">
                          Кому: {assignedName}
                        </span>
                      )}
                      {showCompletedBy && (
                        <span className="text-xs text-ink-3">
                          Выполнил: {completedByName}
                        </span>
                      )}
                      {task.completedAt && (
                        <span className="text-xs text-ink-3">
                          {formatDate(task.completedAt)}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Кнопка «Вернуть» */}
                  <button
                    onClick={() => void reopenTask(task.id)}
                    className="text-xs text-accent hover:underline shrink-0 mt-0.5"
                    aria-label={`Вернуть задачу «${task.title.trim() || "Без названия"}» в работу`}
                  >
                    Вернуть
                  </button>
                </li>
              );
            })}
          </ul>

          {nextCursor && (
            <div className="mt-4 text-center">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="inline-flex items-center bg-surface border border-border text-sm text-ink-2 px-4 py-2 rounded hover:border-accent transition-colors disabled:opacity-50"
              >
                {loadingMore ? "Загрузка…" : "Загрузить ещё"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
