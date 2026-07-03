import { toMoscowDateString, addDays } from "../../lib/moscowDate";

// ── Типы ──────────────────────────────────────────────────────────────────────

export type TaskBucket = "overdue" | "today" | "tomorrow" | "thisWeek" | "later" | "noDate" | "doneToday";

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
  commentCount?: number;
  checklistSummary?: { done: number; total: number };
}

// ── bucketOf ──────────────────────────────────────────────────────────────────

const DONE_VISIBLE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Определяет группу для задачи на основе dueDate + urgent.
 * Все сравнения дат — в московском часовом поясе.
 *
 * Возвращает `null` для DONE-задач старше 24 часов: они «ушли в архив»
 * (/tasks/history) и в главном списке не показываются вовсе. Раньше они
 * оседали в «Без даты» вперемешку с открытыми бессрочными задачами.
 */
export function bucketOf(task: Task, now: Date): TaskBucket | null {
  // DONE tasks: completed within 24h → doneToday, older → archive (not shown)
  if (task.status === "DONE") {
    if (task.completedAt) {
      const elapsed = now.getTime() - new Date(task.completedAt).getTime();
      if (elapsed < DONE_VISIBLE_WINDOW_MS) return "doneToday";
    }
    return null;
  }

  if (task.dueDate) {
    const todayStr = toMoscowDateString(now);
    const dueStr = toMoscowDateString(new Date(task.dueDate));
    if (dueStr < todayStr) return "overdue";
    if (dueStr === todayStr) return "today";
    const tomorrowStr = toMoscowDateString(addDays(now, 1));
    if (dueStr === tomorrowStr) return "tomorrow";
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
 * Группирует задачи по вёдрам главного списка.
 * DONE старше 24 часов не попадают ни в одно ведро (см. bucketOf → null).
 * Сортировка внутри ведра: сначала срочные, затем по дате asc, затем по createdAt desc.
 */
export function groupTasks(
  tasks: Task[],
  now: Date = new Date(),
): Record<TaskBucket, Task[]> {
  const groups: Record<TaskBucket, Task[]> = {
    overdue: [],
    today: [],
    tomorrow: [],
    thisWeek: [],
    later: [],
    noDate: [],
    doneToday: [],
  };

  for (const t of tasks) {
    const bucket = bucketOf(t, now);
    if (bucket === null) continue; // архивные DONE — только в /tasks/history
    groups[bucket].push(t);
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
