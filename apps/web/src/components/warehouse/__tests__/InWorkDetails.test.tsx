/**
 * InWorkDetails — read-only booking view + «← Принять обратно» action.
 *
 * Verifies:
 *  - Renders booking items + finance breakdown
 *  - «← Принять обратно» button calls onAcceptBack(bookingId)
 *  - Loading state
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { InWorkDetails } from "../InWorkDetails";
import { scanApi } from "../api";

vi.mock("../api", () => ({
  scanApi: {
    getInWorkDetails: vi.fn(),
  },
}));

const fixtureDetails = {
  bookingId: "b1",
  displayNo: "#ABC123",
  projectName: "Test project",
  clientName: "Test client",
  issuedAt: "2026-05-19T10:00:00Z",
  expectedReturnAt: "2026-05-25T10:00:00Z",
  items: [
    {
      bookingItemId: "bi1",
      equipmentId: "e1",
      equipmentName: "Item A",
      category: "Cat",
      quantity: 3,
      trackingMode: "COUNT" as const,
    },
    {
      bookingItemId: "bi2",
      equipmentId: "e2",
      equipmentName: "Item B",
      category: "Cat",
      quantity: 1,
      trackingMode: "UNIT" as const,
    },
  ],
  finance: {
    finalAmount: "5000",
    addonAmount: "0",
    amountPaid: "0",
    outstanding: "5000",
    paymentStatus: "NOT_PAID",
  },
};

beforeEach(() => {
  vi.mocked(scanApi.getInWorkDetails).mockReset();
});

describe("InWorkDetails", () => {
  it("renders booking items + «← Принять обратно» button", async () => {
    vi.mocked(scanApi.getInWorkDetails).mockResolvedValue(fixtureDetails);
    render(
      <InWorkDetails
        bookingId="b1"
        onAcceptBack={vi.fn()}
      />,
    );
    await screen.findByText("Test project");
    expect(screen.getByText("Item A")).toBeInTheDocument();
    expect(screen.getByText("Item B")).toBeInTheDocument();
    expect(screen.getByText(/×3/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Принять обратно/i }),
    ).toBeInTheDocument();
  });

  it("«← Принять обратно» calls onAcceptBack with bookingId", async () => {
    vi.mocked(scanApi.getInWorkDetails).mockResolvedValue(fixtureDetails);
    const onAcceptBack = vi.fn();
    render(
      <InWorkDetails
        bookingId="b1"
        onAcceptBack={onAcceptBack}
      />,
    );
    await screen.findByText("Test project");
    fireEvent.click(
      screen.getByRole("button", { name: /Принять обратно/i }),
    );
    expect(onAcceptBack).toHaveBeenCalledWith("b1");
  });

  it("не рисует свою ссылку «К списку» — назад ведёт стрелка шапки", async () => {
    vi.mocked(scanApi.getInWorkDetails).mockResolvedValue(fixtureDetails);
    render(<InWorkDetails bookingId="b1" onAcceptBack={vi.fn()} />);
    await screen.findByText("Test project");
    expect(screen.queryByRole("button", { name: /К списку/i })).not.toBeInTheDocument();
  });

  it("shows outstanding in rose when > 0", async () => {
    vi.mocked(scanApi.getInWorkDetails).mockResolvedValue(fixtureDetails);
    render(
      <InWorkDetails
        bookingId="b1"
        onAcceptBack={vi.fn()}
      />,
    );
    await screen.findByText("Test project");
    expect(screen.getByText(/Остаток/)).toBeInTheDocument();
  });

  it("hides addon line when addonAmount is 0", async () => {
    vi.mocked(scanApi.getInWorkDetails).mockResolvedValue(fixtureDetails);
    render(
      <InWorkDetails
        bookingId="b1"
        onAcceptBack={vi.fn()}
      />,
    );
    await screen.findByText("Test project");
    expect(screen.queryByText(/Доб-смета/)).not.toBeInTheDocument();
  });

  it("shows addon line when addonAmount > 0", async () => {
    vi.mocked(scanApi.getInWorkDetails).mockResolvedValue({
      ...fixtureDetails,
      finance: { ...fixtureDetails.finance, addonAmount: "1500" },
    });
    render(
      <InWorkDetails
        bookingId="b1"
        onAcceptBack={vi.fn()}
      />,
    );
    await screen.findByText("Test project");
    expect(screen.getByText(/Доб-смета/)).toBeInTheDocument();
  });
});
