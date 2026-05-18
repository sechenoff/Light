import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTaskDetail } from "../useTaskDetail";

vi.mock("../../../lib/api", () => ({
  apiFetch: vi.fn(),
}));
vi.mock("../../ToastProvider", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import { apiFetch } from "../../../lib/api";
const mockFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

const baseTask = {
  id: "t1", title: "T", status: "OPEN", urgent: false, dueDate: null,
  description: null, createdBy: "u1", assignedTo: null, completedBy: null,
  completedAt: null, createdAt: "2026-05-18T00:00:00Z", updatedAt: "2026-05-18T00:00:00Z",
  comments: [], checklist: [],
};

beforeEach(() => {
  mockFetch.mockReset();
});

describe("useTaskDetail", () => {
  it("fetches the task on open", async () => {
    mockFetch.mockResolvedValueOnce({ task: baseTask });
    const { result } = renderHook(() => useTaskDetail("t1"));
    await waitFor(() => expect(result.current.task?.id).toBe("t1"));
    expect(mockFetch).toHaveBeenCalledWith("/api/tasks/t1");
  });

  it("optimistically appends a comment, reconciles from server", async () => {
    mockFetch.mockResolvedValueOnce({ task: baseTask }); // initial
    const { result } = renderHook(() => useTaskDetail("t1"));
    await waitFor(() => expect(result.current.task?.id).toBe("t1"));

    mockFetch.mockResolvedValueOnce({
      comment: { id: "c1", taskId: "t1", authorId: "u1", body: "hi", createdAt: "2026-05-18T01:00:00Z", authorUser: { id: "u1", username: "Иван" } },
    });
    await act(async () => {
      await result.current.addComment("hi");
    });
    expect(result.current.task?.comments.some((c) => c.body === "hi")).toBe(true);
    expect(result.current.task?.comments.every((c) => !c.id.startsWith("temp-"))).toBe(true);
  });

  it("rolls back the optimistic comment on failure", async () => {
    mockFetch.mockResolvedValueOnce({ task: baseTask });
    const { result } = renderHook(() => useTaskDetail("t1"));
    await waitFor(() => expect(result.current.task?.id).toBe("t1"));

    mockFetch.mockRejectedValueOnce(new Error("boom"));
    await act(async () => {
      await result.current.addComment("bad");
    });
    expect(result.current.task?.comments.some((c) => c.body === "bad")).toBe(false);
  });

  it("a poll landing mid-add does not drop the optimistic comment", async () => {
    mockFetch.mockResolvedValueOnce({ task: baseTask }); // initial load
    const { result } = renderHook(() => useTaskDetail("t1"));
    await waitFor(() => expect(result.current.task?.id).toBe("t1"));

    // POST is pending; resolve it manually after we simulate a poll
    let resolvePost: (v: any) => void;
    const postPromise = new Promise((res) => { resolvePost = res; });
    mockFetch.mockReturnValueOnce(postPromise as any);

    let addPromise: Promise<void>;
    await act(async () => {
      addPromise = result.current.addComment("racy");
      // optimistic item should be present now
    });
    expect(result.current.task?.comments.some((c) => c.body === "racy")).toBe(true);

    // Simulate the 8s poll firing mid-add: returns server snapshot WITHOUT the temp item
    mockFetch.mockResolvedValueOnce({ task: baseTask });
    await act(async () => {
      await result.current.refetch();
    });
    // poll must NOT have clobbered the in-flight optimistic comment
    expect(result.current.task?.comments.some((c) => c.body === "racy")).toBe(true);

    // now resolve the POST and let reconcile run
    await act(async () => {
      resolvePost!({ comment: { id: "c9", taskId: "t1", authorId: "u1", body: "racy", createdAt: "2026-05-18T02:00:00Z", authorUser: { id: "u1", username: "U" } } });
      await addPromise!;
    });
    expect(result.current.task?.comments.some((c) => c.body === "racy")).toBe(true);
    expect(result.current.task?.comments.every((c) => !c.id.startsWith("temp-"))).toBe(true);
  });
});
