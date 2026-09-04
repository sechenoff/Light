import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { BookingFinancePanel } from "../BookingFinancePanel";

const HANDLERS = {
  isArchived: false,
  invoices: [],
  invoicesError: false,
  dispatch: vi.fn(),
  onDownload: vi.fn(),
  onReloadInvoices: vi.fn(),
  onDownloadInvoicePdf: vi.fn(),
};

// Основная смета 20 700 после скидки + добор 27 000 = 47 700 (транспорта нет).
const BOOKING = {
  id: "b1",
  status: "ISSUED",
  paymentStatus: "NOT_PAID",
  finalAmount: "47700",
  amountPaid: "0",
  amountOutstanding: "47700",
  legacyFinance: false,
  estimate: { subtotal: "23400", discountAmount: "2700", discountPercent: "50", totalAfterDiscount: "20700" },
  addonEstimate: { totalAfterDiscount: "27000" },
};

describe("BookingFinancePanel — разбивка суммы с добором", () => {
  it("shows the addon line and no drift warning when the addon explains the difference", () => {
    render(<BookingFinancePanel booking={BOOKING} userRole="SUPER_ADMIN" {...HANDLERS} />);
    expect(screen.getByText("Добор (доп-смета)")).toBeInTheDocument();
    expect(screen.getByText("+27 000,00")).toBeInTheDocument();
    expect(screen.queryByText(/актуальнее суммы в снапшоте/)).toBeNull();
  });

  it("hides the addon line without an addon estimate and flags a real drift", () => {
    render(
      <BookingFinancePanel
        booking={{ ...BOOKING, addonEstimate: null }}
        userRole="SUPER_ADMIN"
        {...HANDLERS}
      />,
    );
    expect(screen.queryByText("Добор (доп-смета)")).toBeNull();
    // 20 700 в снапшоте против 47 700 в итоге — расхождение без объяснения.
    expect(screen.getByText(/актуальнее суммы в снапшоте/)).toBeInTheDocument();
  });
});
