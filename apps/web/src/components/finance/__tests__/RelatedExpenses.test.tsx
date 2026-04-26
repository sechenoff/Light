import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RelatedExpenses } from "../RelatedExpenses";

const ORIGINAL_FETCH = global.fetch;

const MOCK_EXPENSES = {
  items: [
    {
      id: "exp-1",
      category: "REPAIR",
      amount: "5000",
      description: "Замена лампы",
      source: "DIRECT",
      createdAt: "2026-04-15T10:00:00.000Z",
      documentUrl: null,
      approved: true,
    },
    {
      id: "exp-2",
      category: "TRANSPORT",
      amount: "3000",
      description: null,
      source: "REPAIR_LINKED",
      createdAt: "2026-04-16T11:00:00.000Z",
      documentUrl: null,
      approved: false,
      linkedRepairId: "repair-123",
    },
  ],
  total: "8000",
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

describe("RelatedExpenses", () => {
  it("renders collapsed with title", () => {
    mockFetch(MOCK_EXPENSES);
    render(<RelatedExpenses bookingId="booking-1" />);
    expect(screen.getByText(/связанные расходы/i)).toBeInTheDocument();
  });

  it("loads and shows expenses after expand", async () => {
    mockFetch(MOCK_EXPENSES);
    render(<RelatedExpenses bookingId="booking-1" />);
    fireEvent.click(screen.getByText(/связанные расходы/i));
    await waitFor(() => {
      expect(screen.getAllByText(/Замена лампы/).length).toBeGreaterThan(0);
    });
  });

  it("shows DIRECT and REPAIR_LINKED source chips", async () => {
    mockFetch(MOCK_EXPENSES);
    render(<RelatedExpenses bookingId="booking-1" />);
    fireEvent.click(screen.getByText(/связанные расходы/i));
    await waitFor(() => {
      expect(screen.getAllByText(/прямой/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/через ремонт/i).length).toBeGreaterThan(0);
    });
  });

  it("shows total at the bottom", async () => {
    mockFetch(MOCK_EXPENSES);
    render(<RelatedExpenses bookingId="booking-1" />);
    fireEvent.click(screen.getByText(/связанные расходы/i));
    await waitFor(() => {
      // total should be visible (8000)
      expect(screen.getByText(/итого/i)).toBeInTheDocument();
    });
  });

  it("shows empty state when no expenses", async () => {
    mockFetch({ items: [], total: "0" });
    render(<RelatedExpenses bookingId="booking-1" />);
    fireEvent.click(screen.getByText(/связанные расходы/i));
    await waitFor(() => {
      expect(screen.getByText(/связанных расходов нет/i)).toBeInTheDocument();
    });
  });
});
