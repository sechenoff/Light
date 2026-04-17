"use client";

import { useMemo, useState } from "react";
import { groupTasks, type Task, type TaskBucket } from "./groupTasks";
import { TaskCard } from "./TaskCard";

// ── Константы ─────────────────────────────────────────────────────────────────

const BUCKET_META: Record<
  TaskBucket,
  {
    label: string;
    defaultOpen: boolean;
    accent: "rose" | "amber" | "teal" | "ink" | "slate";
  }
> = {
  overdue:  { label: "Просрочено",       defaultOpen: true,  accent: "rose" },
  today:    { label: "Сегодня",          defaultOpen: true,  accent: "amber" },
  thisWeek: { label: "На этой неделе",   defaultOpen: true,  accent: "teal" },
  later:    { label: "Позже",            defaultOpen: false, accent: "ink" },
  noDate:   { label: "Без даты",         defaultOpen: false, accent: "slate" },
};

const BUCKET_ORDER: TaskBucket[] = ["overdue", "today", "thisWeek", "later", "noDate"];

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
  const [open, setOpen] = useState(meta.defaultOpen);

  const headerColorClass = {
    rose:  "text-rose",
    amber: "text-amber",
    teal:  "text-teal",
    ink:   "text-ink-2",
    slate: "text-ink-3",
  }[meta.accent];

  return (
    <div>
      {/* Заголовок группы */}
      <button
        onClick={() => setOpen((v) => !v)}
        className={`w-full flex items-center gap-2 px-4 py-1.5 text-left
          text-[11px] font-semibold uppercase tracking-wider bg-surface-muted
          hover:bg-surface-subtle border-b border-border transition-colors ${headerColorClass}`}
        aria-expanded={open}
      >
        <h3 className="flex-1">{meta.label}</h3>
        <span className="font-normal text-ink-3">{tasks.length}</span>
        <span className="text-ink-3 text-[10px]">{open ? "▲" : "▼"}</span>
      </button>

      {/* Задачи */}
      {open && (
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
      )}
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

  // Определяем, какие вёдра показывать: всегда "noDate" (даже пустое); остальные — только если есть задачи
  const visibleBuckets = useMemo(
    () => BUCKET_ORDER.filter((b) => groups[b].length > 0 || b === "noDate"),
    [groups],
  );

  return (
    <div className="bg-surface border border-border rounded-lg shadow-xs divide-y divide-border">
      {visibleBuckets.map((bucket) => (
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
    </div>
  );
}
