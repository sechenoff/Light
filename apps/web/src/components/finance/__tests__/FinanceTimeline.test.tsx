import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FinanceTimeline } from "../FinanceTimeline";

const ORIGINAL_FETCH = global.fetch;

const MOCK_TIMELINE = [
  {
    type: "INVOICE_ISSUED",
    at: "2026-04-10T10:00:00.000Z",
    invoiceId: "inv-1",
    number: "INV-001",
    total: "50000",
    kind: "FULL",
  },
  {
    type: "PAYMENT_RECEIVED",
    at: "2026-04-15T12:30:00.000Z",
    paymentId: "pay-1",
    amount: "50000",
    method: "CASH",
    invoiceId: "inv-1",
  },
  {
    type: "EXPENSE_LOGGED",
    at: "2026-04-16T09:00:00.000Z",
    expenseId: "exp-1",
    category: "REPAIR",
    amount: "5000",
    description: "Замена лампы",
  },
];

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

describe("FinanceTimeline", () => {
  it("renders collapsed by default with title", () => {
    mockFetch(MOCK_TIMELINE);
    render(<FinanceTimeline bookingId="booking-1" />);
    expect(screen.getByText(/хронология денег/i)).toBeInTheDocument();
  });

  it("loads and shows timeline events after expand", async () => {
    mockFetch(MOCK_TIMELINE);
    render(<FinanceTimeline bookingId="booking-1" />);
    // Click to expand
    fireEvent.click(screen.getByText(/хронология денег/i));
    await waitFor(() => {
      expect(screen.getByText(/INV-001/)).toBeInTheDocument();
    });
  });

  it("shows PAYMENT_RECEIVED event with amount", async () => {
    mockFetch(MOCK_TIMELINE);
    render(<FinanceTimeline bookingId="booking-1" />);
    fireEvent.click(screen.getByText(/хронология денег/i));
    await waitFor(() => {
      expect(screen.getByText(/получен платёж/i)).toBeInTheDocument();
    });
  });

  it("shows EXPENSE_LOGGED event with description", async () => {
    mockFetch(MOCK_TIMELINE);
    render(<FinanceTimeline bookingId="booking-1" />);
    fireEvent.click(screen.getByText(/хронология денег/i));
    await waitFor(() => {
      expect(screen.getByText(/Замена лампы/)).toBeInTheDocument();
    });
  });

  it("shows empty state when no events", async () => {
    mockFetch([]);
    render(<FinanceTimeline bookingId="booking-1" />);
    fireEvent.click(screen.getByText(/хронология денег/i));
    await waitFor(() => {
      expect(screen.getByText(/финансовых событий пока нет/i)).toBeInTheDocument();
    });
  });
});
