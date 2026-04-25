import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CancelWithDepositModal } from "../CancelWithDepositModal";

const ORIGINAL_FETCH = global.fetch;

const DEFAULT_PROPS = {
  open: true,
  onClose: vi.fn(),
  bookingId: "booking-1",
  bookingDisplayName: "Бронь #B-001",
  clientId: "client-1",
  clientName: "Ромашка Продакшн",
  depositTotal: 30000,
  onCancelled: vi.fn(),
};

beforeEach(() => {
  global.fetch = vi.fn();
  vi.clearAllMocks();
});
afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

describe("CancelWithDepositModal", () => {
  it("renders step 1 with deposit amount when open", () => {
    render(<CancelWithDepositModal {...DEFAULT_PROPS} />);
    expect(screen.getAllByText(/30\s*000/)[0]).toBeInTheDocument();
    expect(screen.getByText("Полный возврат клиенту")).toBeInTheDocument();
    expect(screen.getByText("Удержать как кредит на следующую бронь")).toBeInTheDocument();
    expect(screen.getByText("Удержать как штраф")).toBeInTheDocument();
  });

  it("does not render when closed", () => {
    const { container } = render(<CancelWithDepositModal {...DEFAULT_PROPS} open={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("advances to step 2 on 'Далее' and back to step 1", () => {
    render(<CancelWithDepositModal {...DEFAULT_PROPS} />);
    const nextBtn = screen.getByRole("button", { name: "Далее →" });
    fireEvent.click(nextBtn);
    // Step 2 for refund branch
    expect(screen.getByText("Детали возврата")).toBeInTheDocument();
    // Back button
    const backBtn = screen.getByRole("button", { name: "Назад" });
    fireEvent.click(backBtn);
    expect(screen.getByText("Полный возврат клиенту")).toBeInTheDocument();
  });

  it("can select 'credit' branch and advance", () => {
    render(<CancelWithDepositModal {...DEFAULT_PROPS} />);
    // Click credit branch
    fireEvent.click(screen.getByText("Удержать как кредит на следующую бронь"));
    fireEvent.click(screen.getByRole("button", { name: "Далее →" }));
    expect(screen.getByText("Параметры кредит-ноты")).toBeInTheDocument();
  });

  it("can select 'forfeit' branch and advance to confirmation", () => {
    render(<CancelWithDepositModal {...DEFAULT_PROPS} />);
    fireEvent.click(screen.getByText("Удержать как штраф"));
    fireEvent.click(screen.getByRole("button", { name: "Далее →" }));
    // Step 2 forfeit
    expect(screen.getByText(/Депозит/)).toBeInTheDocument();
    // Advance to step 3
    fireEvent.click(screen.getByRole("button", { name: "Далее →" }));
    expect(screen.getByText("Подтверждение")).toBeInTheDocument();
  });

  it("shows confirm button on step 3 and calls cancel API on commit with refund", async () => {
    const onCancelled = vi.fn();

    // Mock POST /api/refunds
    (global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: "r1" }),
      })
      // Mock POST /api/bookings/:id/status
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ booking: { status: "CANCELLED" } }),
      });

    render(<CancelWithDepositModal {...DEFAULT_PROPS} onCancelled={onCancelled} />);

    // Step 1: fill refund reason in step 2
    fireEvent.click(screen.getByRole("button", { name: "Далее →" }));
    // Step 2 refund — fill reason
    fireEvent.change(
      screen.getByPlaceholderText("Отмена съёмки клиентом"),
      { target: { value: "Клиент отказался" } }
    );
    fireEvent.click(screen.getByRole("button", { name: "Далее →" }));
    // Step 3
    const confirmBtn = screen.getByRole("button", { name: "Подтвердить отмену" });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(onCancelled).toHaveBeenCalled();
    });
  });
});
