import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DayProblemAlert } from "../DayProblemAlert";

const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn();
});
afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

function mockProblemItems(
  items: Array<{ id: string; status: string; expectedBackDate: string | null }>,
) {
  (global.fetch as any).mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ items, nextCursor: null }),
  });
}

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

describe("DayProblemAlert (MD-6)", () => {
  it("показывает амбер-алерт, когда есть EXPECTED с прошедшим expectedBackDate", async () => {
    mockProblemItems([
      { id: "p1", status: "EXPECTED", expectedBackDate: isoDaysFromNow(-3) },
      { id: "p2", status: "EXPECTED", expectedBackDate: isoDaysFromNow(-1) },
      { id: "p3", status: "EXPECTED", expectedBackDate: isoDaysFromNow(+2) }, // не просрочена
    ]);

    render(<DayProblemAlert />);

    await waitFor(() =>
      expect(
        screen.getByText(/Потеряшки: 2 единицы просрочили срок досдачи/),
      ).toBeInTheDocument(),
    );
    const link = screen.getByRole("link", { name: "Реестр →" });
    expect(link).toHaveAttribute("href", "/warehouse/problems");
  });

  it("ничего не рендерит, когда просроченных нет", async () => {
    mockProblemItems([
      { id: "p1", status: "EXPECTED", expectedBackDate: isoDaysFromNow(+5) },
      { id: "p2", status: "EXPECTED", expectedBackDate: null },
    ]);

    const { container } = render(<DayProblemAlert />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it("молча скрывается при ошибке API (не блокирует первый экран)", async () => {
    (global.fetch as any).mockRejectedValueOnce(new Error("network"));

    const { container } = render(<DayProblemAlert />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });
});
