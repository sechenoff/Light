import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lib/api", () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from "../../../lib/api";
import { fetchMainTaskLists } from "../useTasksQuery";
import type { Task } from "../groupTasks";

const apiFetchMock = vi.mocked(apiFetch);

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: `Задача ${overrides.id}`,
    status: "OPEN",
    urgent: false,
    dueDate: null,
    description: null,
    createdBy: "u1",
    assignedTo: null,
    completedBy: null,
    completedAt: null,
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("fetchMainTaskLists", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it("делает два запроса: OPEN (status=OPEN) + свежие DONE (sort=completedAt-desc), а не status=ALL", async () => {
    apiFetchMock.mockResolvedValue({ items: [], nextCursor: null });

    await fetchMainTaskLists("all");

    expect(apiFetchMock).toHaveBeenCalledTimes(2);
    const urls = apiFetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toContain("status=OPEN");
    expect(urls[0]).toContain("filter=all");
    expect(urls[0]).not.toContain("status=ALL");
    expect(urls[1]).toContain("status=DONE");
    expect(urls[1]).toContain("sort=completedAt-desc");
  });

  it("объединяет открытые задачи и DONE за последние 24 часа; старые DONE отфильтровываются", async () => {
    const open = makeTask({ id: "open-1" });
    const doneRecent = makeTask({
      id: "done-recent",
      status: "DONE",
      completedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 часа назад
    });
    const doneOld = makeTask({
      id: "done-old",
      status: "DONE",
      completedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), // 2 дня назад
    });

    apiFetchMock
      .mockResolvedValueOnce({ items: [open], nextCursor: null })
      .mockResolvedValueOnce({ items: [doneRecent, doneOld], nextCursor: null });

    const items = await fetchMainTaskLists("my");

    expect(items.map((t) => t.id)).toEqual(["open-1", "done-recent"]);
  });
});
