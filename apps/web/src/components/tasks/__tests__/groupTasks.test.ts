import { describe, it, expect } from "vitest";
import { bucketOf, groupTasks } from "../groupTasks";

// Minimal Task shape needed by the pure function
type MinTask = {
  id: string;
  title: string;
  status: "OPEN" | "DONE";
  urgent: boolean;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  assignedTo: string | null;
  completedBy: string | null;
  completedAt: string | null;
  description: string | null;
};

function makeTask(overrides: Partial<MinTask> = {}): MinTask {
  return {
    id: "t1",
    title: "Test task",
    status: "OPEN",
    urgent: false,
    dueDate: null,
    createdAt: "2026-04-17T12:00:00Z",
    updatedAt: "2026-04-17T12:00:00Z",
    createdBy: "u1",
    assignedTo: null,
    completedBy: null,
    completedAt: null,
    description: null,
    ...overrides,
  };
}

// We use a fixed "now" to make tests deterministic.
// "now" = 2026-04-17T10:00:00Z which is 2026-04-17T13:00:00 MSK → Moscow date = "2026-04-17"
const MSK_NOW = new Date("2026-04-17T10:00:00Z");

describe("bucketOf", () => {
  it("returns 'overdue' for a past dueDate", () => {
    const task = makeTask({ dueDate: "2026-04-16T21:00:00.000Z" }); // April 16 MSK midnight = April 15 UTC+21
    // We pass a dueDate that is clearly yesterday in Moscow
    const yesterday = makeTask({ dueDate: "2026-04-15T21:00:00.000Z" }); // April 16 MSK midnight
    expect(bucketOf(yesterday, MSK_NOW)).toBe("overdue");
  });

  it("returns 'today' for dueDate = today in MSK", () => {
    // "2026-04-17" MSK midnight = "2026-04-16T21:00:00Z"
    const task = makeTask({ dueDate: "2026-04-16T21:00:00.000Z" });
    expect(bucketOf(task, MSK_NOW)).toBe("today");
  });

  it("returns 'thisWeek' for dueDate within next 7 days", () => {
    // +3 days from 2026-04-17: April 20 MSK = 2026-04-19T21:00:00Z
    const task = makeTask({ dueDate: "2026-04-19T21:00:00.000Z" });
    expect(bucketOf(task, MSK_NOW)).toBe("thisWeek");
  });

  it("returns 'later' for dueDate 8+ days away", () => {
    // +10 days from 2026-04-17: April 27 MSK = 2026-04-26T21:00:00Z
    const task = makeTask({ dueDate: "2026-04-26T21:00:00.000Z" });
    expect(bucketOf(task, MSK_NOW)).toBe("later");
  });

  it("returns 'today' for urgent task with no dueDate (urgent-undated promotes)", () => {
    const task = makeTask({ urgent: true, dueDate: null });
    expect(bucketOf(task, MSK_NOW)).toBe("today");
  });

  it("returns 'noDate' for non-urgent task with no dueDate", () => {
    const task = makeTask({ urgent: false, dueDate: null });
    expect(bucketOf(task, MSK_NOW)).toBe("noDate");
  });
});

describe("groupTasks", () => {
  it("returns all empty buckets for empty array", () => {
    const groups = groupTasks([], MSK_NOW);
    expect(groups.overdue).toHaveLength(0);
    expect(groups.today).toHaveLength(0);
    expect(groups.thisWeek).toHaveLength(0);
    expect(groups.later).toHaveLength(0);
    expect(groups.noDate).toHaveLength(0);
  });

  it("sorts within bucket: urgent first, then dueDate ascending", () => {
    const t1 = makeTask({
      id: "t1",
      urgent: false,
      dueDate: "2026-04-19T21:00:00.000Z", // April 20 MSK
      createdAt: "2026-04-17T10:00:00Z",
    });
    const t2 = makeTask({
      id: "t2",
      urgent: true,
      dueDate: "2026-04-20T21:00:00.000Z", // April 21 MSK
      createdAt: "2026-04-17T10:00:00Z",
    });
    const t3 = makeTask({
      id: "t3",
      urgent: false,
      dueDate: "2026-04-18T21:00:00.000Z", // April 19 MSK
      createdAt: "2026-04-17T10:00:00Z",
    });
    const groups = groupTasks([t1, t2, t3], MSK_NOW);
    // t2 is urgent → first; then t3 (earlier date), then t1
    expect(groups.thisWeek[0].id).toBe("t2");
    expect(groups.thisWeek[1].id).toBe("t3");
    expect(groups.thisWeek[2].id).toBe("t1");
  });

  it("sorts noDate bucket by createdAt desc when no dueDate", () => {
    const older = makeTask({ id: "older", createdAt: "2026-04-16T10:00:00Z" });
    const newer = makeTask({ id: "newer", createdAt: "2026-04-17T10:00:00Z" });
    const groups = groupTasks([older, newer], MSK_NOW);
    expect(groups.noDate[0].id).toBe("newer");
    expect(groups.noDate[1].id).toBe("older");
  });

  it("routes each task to the correct bucket", () => {
    const overdue = makeTask({ id: "overdue", dueDate: "2026-04-15T21:00:00.000Z" }); // April 16 MSK
    const today = makeTask({ id: "today", dueDate: "2026-04-16T21:00:00.000Z" });    // April 17 MSK
    const thisWeek = makeTask({ id: "week", dueDate: "2026-04-19T21:00:00.000Z" });  // April 20 MSK
    const later = makeTask({ id: "later", dueDate: "2026-04-26T21:00:00.000Z" });    // April 27 MSK
    const noDate = makeTask({ id: "nodate" });

    const groups = groupTasks([overdue, today, thisWeek, later, noDate], MSK_NOW);
    expect(groups.overdue.map((t) => t.id)).toContain("overdue");
    expect(groups.today.map((t) => t.id)).toContain("today");
    expect(groups.thisWeek.map((t) => t.id)).toContain("week");
    expect(groups.later.map((t) => t.id)).toContain("later");
    expect(groups.noDate.map((t) => t.id)).toContain("nodate");
  });
});
