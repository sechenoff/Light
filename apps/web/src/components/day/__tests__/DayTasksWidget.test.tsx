import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DayTasksWidget } from "../DayTasksWidget";

const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn();
});
afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

function mockTodayResponse(myTasks: Array<{ id: string; title: string; dueDate: string | null; urgent: boolean }>) {
  (global.fetch as any).mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({
      pickups: [],
      returns: [],
      active: [],
      myTasks,
    }),
  });
}

describe("DayTasksWidget", () => {
  it("renders task titles from mocked fetch", async () => {
    mockTodayResponse([
      { id: "t1", title: "Забрать прибор из ремонта", dueDate: null, urgent: false },
      { id: "t2", title: "Купить воду", dueDate: null, urgent: true },
    ]);

    render(<DayTasksWidget />);

    await waitFor(() =>
      expect(screen.getByText("Забрать прибор из ремонта")).toBeInTheDocument(),
    );
    expect(screen.getByText("Купить воду")).toBeInTheDocument();
  });

  it("shows empty state when myTasks is empty", async () => {
    mockTodayResponse([]);

    render(<DayTasksWidget />);

    await waitFor(() =>
      expect(screen.getByText("Задач на сегодня нет")).toBeInTheDocument(),
    );
  });

  it("shows empty state when myTasks is missing from response", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ pickups: [], returns: [], active: [] }),
    });

    render(<DayTasksWidget />);

    await waitFor(() =>
      expect(screen.getByText("Задач на сегодня нет")).toBeInTheDocument(),
    );
  });
});
