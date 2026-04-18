"use client";

import { useMemo } from "react";
import { groupTasks, type Task, type TaskBucket } from "./groupTasks";
import { TaskCard } from "./TaskCard";

// ── Константы ─────────────────────────────────────────────────────────────────

const BUCKET_META: Record<
  TaskBucket,
  {
    label: string;
    colorClass: string;
  }
> = {
  overdue:   { label: "Просрочено",       colorClass: "text-rose" },
  today:     { label: "Сегодня",          colorClass: "text-amber" },
  thisWeek:  { label: "На этой неделе",   colorClass: "text-teal" },
  later:     { label: "Позже",            colorClass: "text-slate" },
  noDate:    { label: "Без даты",         colorClass: "text-ink-3" },
  doneToday: { label: "Выполнено сегодня", colorClass: "text-ink-3" },
};

// OPEN buckets in display order; doneToday rendered last with its own divider
const OPEN_BUCKET_ORDER: TaskBucket[] = ["overdue", "today", "thisWeek", "later", "noDate"];

// ── TaskGroup ─────────────────────────────────────────────────────────────────

function TaskGroup({
  bucket,
  tasks,
  onComplete,
  onReopen,
  onUpdate,
  onDelete,
  onOpenEdit,
}: {
  bucket: TaskBucket;
  tasks: Task[];
  onComplete: (id: string) => void;
  onReopen: (id: string) => void;
  onUpdate: (id: string, patch: Partial<Task>) => void;
  onDelete: (id: string) => void;
  onOpenEdit: (task: Task) => void;
}) {
  const meta = BUCKET_META[bucket];

  return (
    <div>
      {/* Заголовок группы — всегда развёрнут, без кнопки */}
      <div
        className="flex items-center gap-2 px-4 py-1.5
          text-left bg-surface-muted border-b border-border"
      >
        <h3 className={`flex-1 text-[11px] font-semibold uppercase tracking-wider ${meta.colorClass}`}>
          {meta.label}
        </h3>
        <span className="text-[11px] font-mono text-ink-3">{tasks.length}</span>
      </div>

      {/* Задачи */}
      <div className="divide-y divide-border">
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            isOverdue={bucket === "overdue"}
            onComplete={onComplete}
            onReopen={onReopen}
            onUpdate={onUpdate}
            onDelete={onDelete}
            onOpenEdit={onOpenEdit}
          />
        ))}
      </div>
    </div>
  );
}

// ── TaskGroupList ─────────────────────────────────────────────────────────────

interface TaskGroupListProps {
  tasks: Task[];
  onComplete: (id: string) => void;
  onReopen: (id: string) => void;
  onUpdate: (id: string, patch: Partial<Task>) => void;
  onDelete: (id: string) => void;
  onOpenEdit: (task: Task) => void;
}

export function TaskGroupList({
  tasks,
  onComplete,
  onReopen,
  onUpdate,
  onDelete,
  onOpenEdit,
}: TaskGroupListProps) {
  const groups = useMemo(() => groupTasks(tasks), [tasks]);

  // Показываем только непустые вёдра (кроме noDate — его всегда показываем)
  const visibleOpenBuckets = useMemo(
    () => OPEN_BUCKET_ORDER.filter((b) => groups[b].length > 0 || b === "noDate"),
    [groups],
  );

  const doneTodayTasks = groups.doneToday;

  return (
    <div className="bg-surface border border-border rounded-lg shadow-xs divide-y divide-border">
      {visibleOpenBuckets.map((bucket) => (
        <TaskGroup
          key={bucket}
          bucket={bucket}
          tasks={groups[bucket]}
          onComplete={onComplete}
          onReopen={onReopen}
          onUpdate={onUpdate}
          onDelete={onDelete}
          onOpenEdit={onOpenEdit}
        />
      ))}

      {/* doneToday секция с отдельным разделителем */}
      {doneTodayTasks.length > 0 && (
        <>
          <div className="bg-surface-muted px-5 py-3 border-t border-border flex justify-between">
            <span className="text-[11px] font-mono uppercase tracking-wider text-ink-3">
              Выполнено сегодня
            </span>
            <span className="text-[11px] font-mono text-ink-3">{doneTodayTasks.length}</span>
          </div>
          <div className="divide-y divide-border">
            {doneTodayTasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                isOverdue={false}
                onComplete={onComplete}
                onReopen={onReopen}
                onUpdate={onUpdate}
                onDelete={onDelete}
                onOpenEdit={onOpenEdit}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
