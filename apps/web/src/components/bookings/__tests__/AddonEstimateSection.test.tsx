import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AddonEstimateSection } from "../AddonEstimateSection";
import { scanApi } from "../../warehouse/api";

describe("AddonEstimateSection", () => {
  it("renders nothing if addon is null", async () => {
    vi.spyOn(scanApi, "getAddonEstimate").mockResolvedValue({ addon: null });
    const { container } = render(<AddonEstimateSection bookingId="b1" />);
    await waitFor(() => expect(container.querySelector("section")).toBeNull());
  });

  it("renders lines, totals, and 3 download links when addon exists", async () => {
    vi.spyOn(scanApi, "getAddonEstimate").mockResolvedValue({
      addon: {
        id: "ae1",
        bookingId: "b1",
        shifts: 2,
        subtotal: "10000",
        discountPercent: "50",
        discountAmount: "5000",
        totalAfterDiscount: "5000",
        lines: [
          { equipmentId: "v", name: "Vmount", category: "Электрика", quantity: 5, unitPrice: "1000", lineSum: "10000" },
        ],
      },
    });
    render(<AddonEstimateSection bookingId="b1" />);
    expect(await screen.findByText(/Доб-смета/)).toBeInTheDocument();
    expect(screen.getByText("Vmount")).toBeInTheDocument();
    expect(screen.getByText(/PDF доб-сметы/)).toBeInTheDocument();
    expect(screen.getByText(/PDF общая смета/)).toBeInTheDocument();
    expect(screen.getByText(/XLSX доб-сметы/)).toBeInTheDocument();
  });
});
