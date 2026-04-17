"use client";

import type { TaskFilter } from "./useTasksQuery";

const PILLS: { key: TaskFilter; label: string }[] = [
  { key: "my", label: "Мои" },
  { key: "all", label: "Все" },
  { key: "created-by-me", label: "Я поставил" },
];

interface TaskFilterPillsProps {
  value: TaskFilter;
  onChange: (f: TaskFilter) => void;
}

export function TaskFilterPills({ value, onChange }: TaskFilterPillsProps) {
  return (
    <div className="flex gap-2 flex-wrap" role="group" aria-label="Фильтр задач">
      {PILLS.map((pill) => {
        const active = value === pill.key;
        return (
          <button
            key={pill.key}
            onClick={() => onChange(pill.key)}
            aria-pressed={active}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
              active
                ? "bg-ink text-white border-ink"
                : "bg-surface text-ink-2 border-border hover:bg-surface-muted"
            }`}
          >
            {pill.label}
          </button>
        );
      })}
    </div>
  );
}
