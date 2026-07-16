import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ForecastWidget } from "../ForecastWidget";

const ORIGINAL_FETCH = global.fetch;

const MOCK_FORECAST = {
  months: [
    { month: "2026-04", confirmed: "100000", potential: "50000", bookingsPipeline: "20000" },
    { month: "2026-05", confirmed: "0", potential: "0", bookingsPipeline: "0" },
  ],
  totals: { confirmed: "100000", potential: "50000", bookingsPipeline: "20000" },
  horizon: { from: "2026-04-01", to: "2026-09-30" },
};

beforeEach(() => {
  global.fetch = vi.fn();
  vi.clearAllMocks();
});
afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

function mockFetch(data: unknown, status = 200) {
  (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: status < 400,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
    headers: { get: () => "application/json" },
  });
}

describe("ForecastWidget", () => {
  it("shows loading skeleton initially", () => {
    mockFetch(MOCK_FORECAST);
    render(<ForecastWidget />);
    // Should show loading state (skeleton) before data arrives
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("renders month bars after fetch", async () => {
    mockFetch(MOCK_FORECAST);
    render(<ForecastWidget />);
    await waitFor(() => {
      expect(screen.getByText(/апр 2026/i)).toBeInTheDocument();
    });
  });

  it("renders nothing when all values are zero (пустой прогноз не занимает место)", async () => {
    mockFetch({
      months: [{ month: "2026-04", confirmed: "0", potential: "0", bookingsPipeline: "0" }],
      totals: { confirmed: "0", potential: "0", bookingsPipeline: "0" },
      horizon: { from: "2026-04-01", to: "2026-04-30" },
    });
    const { container } = render(<ForecastWidget />);
    await waitFor(() => {
      // Редизайн 2026-07: при пустых данных виджет возвращает null,
      // а не мёртвую панель «Нет прогноза по счетам».
      expect(container.querySelector("h3")).toBeNull();
    });
  });

  it("renders legend with three colors", async () => {
    mockFetch(MOCK_FORECAST);
    render(<ForecastWidget />);
    await waitFor(() => {
      expect(screen.getAllByText(/подтверждённый/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/возможный/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/по броням/i).length).toBeGreaterThan(0);
    });
  });

  it("renders totals row", async () => {
    mockFetch(MOCK_FORECAST);
    render(<ForecastWidget />);
    await waitFor(() => {
      // totals row should appear
      expect(screen.getByText(/pipeline/i)).toBeInTheDocument();
    });
  });
});
