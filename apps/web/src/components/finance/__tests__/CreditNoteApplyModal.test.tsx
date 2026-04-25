import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CreditNoteApplyModal } from "../CreditNoteApplyModal";

const ORIGINAL_FETCH = global.fetch;

const DEFAULT_PROPS = {
  open: true,
  onClose: vi.fn(),
  bookingId: "booking-1",
  clientId: "client-1",
  onApplied: vi.fn(),
};

beforeEach(() => {
  global.fetch = vi.fn();
  vi.clearAllMocks();
});
afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

describe("CreditNoteApplyModal", () => {
  it("does not render when closed", () => {
    const { container } = render(
      <CreditNoteApplyModal {...DEFAULT_PROPS} open={false} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows empty state when no credit notes are available", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ items: [] }),
    });

    render(<CreditNoteApplyModal {...DEFAULT_PROPS} />);

    await waitFor(() => {
      expect(
        screen.getByText("Нет доступных кредит-нот у этого клиента")
      ).toBeInTheDocument();
    });
  });

  it("renders available credit note and calls apply on click", async () => {
    const onApplied = vi.fn();
    const onClose = vi.fn();

    // GET /api/credit-notes
    (global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            {
              id: "cn-1",
              amount: "15000",
              remainingAmount: "15000",
              reason: "Отмена декабрьской брони",
              expiresAt: null,
              appliedToBookingId: null,
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        }),
      })
      // POST /api/credit-notes/cn-1/apply
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
      });

    render(
      <CreditNoteApplyModal
        {...DEFAULT_PROPS}
        onApplied={onApplied}
        onClose={onClose}
      />
    );

    // Wait for list to load
    await waitFor(() => {
      expect(screen.getByText("Отмена декабрьской брони")).toBeInTheDocument();
    });

    // Click apply
    fireEvent.click(screen.getByRole("button", { name: "Применить" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(onApplied).toHaveBeenCalled();
    });
  });
});
