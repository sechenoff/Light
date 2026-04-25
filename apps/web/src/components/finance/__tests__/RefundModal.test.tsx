import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RefundModal } from "../RefundModal";

const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn();
});
afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

describe("RefundModal", () => {
  it("renders heading when open", () => {
    render(
      <RefundModal
        open={true}
        onClose={vi.fn()}
        bookingId="b1"
        onSuccess={vi.fn()}
      />
    );
    expect(screen.getByRole("heading", { name: "Оформить возврат" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("0.00")).toBeInTheDocument();
  });

  it("does not render when closed", () => {
    const { container } = render(
      <RefundModal
        open={false}
        onClose={vi.fn()}
        bookingId="b1"
        onSuccess={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("submit button is disabled when amount and reason empty", () => {
    render(
      <RefundModal
        open={true}
        onClose={vi.fn()}
        bookingId="b1"
        onSuccess={vi.fn()}
      />
    );
    // The submit button is distinct from the heading
    const submitBtn = screen.getByRole("button", { name: "Оформить возврат" });
    expect(submitBtn).toBeDisabled();
  });

  it("calls POST /api/refunds on valid submit and calls onSuccess", async () => {
    const onSuccess = vi.fn();
    const onClose = vi.fn();

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ id: "r1" }),
    });

    render(
      <RefundModal
        open={true}
        onClose={onClose}
        bookingId="b1"
        onSuccess={onSuccess}
      />
    );

    const amountInput = screen.getByPlaceholderText("0.00");
    fireEvent.change(amountInput, { target: { value: "5000" } });

    const reasonTextarea = screen.getByPlaceholderText("Например: отмена брони по согласованию");
    fireEvent.change(reasonTextarea, { target: { value: "Клиент отменил съёмку" } });

    const submitBtn = screen.getByRole("button", { name: "Оформить возврат" });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/refunds"),
        expect.objectContaining({ method: "POST" })
      );
      expect(onSuccess).toHaveBeenCalled();
    });
  });
});
