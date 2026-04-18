import { toMoscowDateString, addDays } from "../../lib/moscowDate";

// ── Типы ──────────────────────────────────────────────────────────────────────

export type TaskBucket = "overdue" | "today" | "thisWeek" | "later" | "noDate" | "doneToday";

export interface Task {
  id: string;
  title: string;
  status: "OPEN" | "DONE";
  urgent: boolean;
  dueDate: string | null;
  description: string | null;
  createdBy: string;
  assignedTo: string | null;
  completedBy: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  assignedToUser?: { id: string; username: string } | null;
  createdByUser?: { id: string; username: string } | null;
  completedByUser?: { id: string; username: string } | null;
}

// ── bucketOf ──────────────────────────────────────────────────────────────────

/**
 * Определяет группу для задачи на основе dueDate + urgent.
 * Все сравнения дат — в московском часовом поясе.
 */
export function bucketOf(task: Task, now: Date): TaskBucket {
  // DONE tasks: check if completed within 24h → doneToday, otherwise noDate
  if (task.status === "DONE") {
    if (task.completedAt) {
      const elapsed = now.getTime() - new Date(task.completedAt).getTime();
      if (elapsed < 24 * 60 * 60 * 1000) return "doneToday";
    }
    return "noDate";
  }

  if (task.dueDate) {
    const todayStr = toMoscowDateString(now);
    const dueStr = toMoscowDateString(new Date(task.dueDate));
    if (dueStr < todayStr) return "overdue";
    if (dueStr === todayStr) return "today";
    const inSevenStr = toMoscowDateString(addDays(now, 7));
    if (dueStr < inSevenStr) return "thisWeek";
    return "later";
  }
  // Без даты — срочные повышаются до "сегодня"
  if (task.urgent) return "today";
  return "noDate";
}

// ── groupTasks ────────────────────────────────────────────────────────────────

/**
 * Группирует задачи по 5 вёдрам.
 * Сортировка внутри ведра: сначала срочные, затем по дате asc, затем по createdAt desc.
 */
export function groupTasks(
  tasks: Task[],
  now: Date = new Date(),
): Record<TaskBucket, Task[]> {
  const groups: Record<TaskBucket, Task[]> = {
    overdue: [],
    today: [],
    thisWeek: [],
    later: [],
    noDate: [],
    doneToday: [],
  };

  for (const t of tasks) {
    groups[bucketOf(t, now)].push(t);
  }

  for (const k of Object.keys(groups) as TaskBucket[]) {
    groups[k].sort((a, b) => {
      if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
      if (a.dueDate && b.dueDate) {
        return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
      }
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }

  return groups;
}
