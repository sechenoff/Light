import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BookingPaymentsModal } from "../BookingPaymentsModal";

const BOOKING_CONTEXT = {
  projectName: "Тестовый проект",
  clientName: "Тест Клиент",
  amountOutstanding: "50000",
};

// Mock apiFetch
vi.mock("../../../lib/api", () => ({
  apiFetch: vi.fn(),
}));

// Mock toast
vi.mock("../../ToastProvider", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import { apiFetch } from "../../../lib/api";

const mockApiFetch = apiFetch as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BookingPaymentsModal", () => {
  it("renders empty state when no payments exist", async () => {
    mockApiFetch.mockResolvedValueOnce({ items: [], total: 0 });

    render(
      <BookingPaymentsModal
        open={true}
        onClose={vi.fn()}
        bookingId="booking-123"
        bookingContext={BOOKING_CONTEXT}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/На эту бронь платежей не было/)).toBeInTheDocument();
    });
    expect(screen.getByText("Тестовый проект", { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/Тест Клиент/)).toBeInTheDocument();
  });

  it("renders payment rows when payments exist", async () => {
    mockApiFetch.mockResolvedValueOnce({
      items: [
        {
          id: "pay-1",
          amount: "25000",
          method: "CASH",
          note: "Аванс",
          receivedAt: "2026-04-01T12:00:00.000Z",
          paymentDate: null,
          voidedAt: null,
        },
        {
          id: "pay-2",
          amount: "25000",
          method: "CARD",
          note: null,
          receivedAt: "2026-04-15T14:00:00.000Z",
          paymentDate: null,
          voidedAt: null,
        },
      ],
      total: 2,
    });

    render(
      <BookingPaymentsModal
        open={true}
        onClose={vi.fn()}
        bookingId="booking-123"
        bookingContext={BOOKING_CONTEXT}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Наличные")).toBeInTheDocument();
    });
    expect(screen.getByText("Карта")).toBeInTheDocument();
    expect(screen.getByText("Аванс")).toBeInTheDocument();
    // Two void buttons
    const voidBtns = screen.getAllByLabelText("Аннулировать платёж");
    expect(voidBtns).toHaveLength(2);
  });

  it("calls correct endpoint with bookingId filter", async () => {
    mockApiFetch.mockResolvedValueOnce({ items: [], total: 0 });

    render(
      <BookingPaymentsModal
        open={true}
        onClose={vi.fn()}
        bookingId="booking-xyz"
        bookingContext={BOOKING_CONTEXT}
      />
    );

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        expect.stringContaining("bookingId=booking-xyz")
      );
    });
  });
});
