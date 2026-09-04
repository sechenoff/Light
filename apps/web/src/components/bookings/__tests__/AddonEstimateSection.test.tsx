import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AddonEstimateSection } from "../AddonEstimateSection";

const apiFetchMock = vi.fn();
vi.mock("../../../lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const ADDON = {
  id: "ae1",
  shifts: 2,
  subtotal: "10000",
  discountPercent: "50",
  discountAmount: "5000",
  totalAfterDiscount: "5000",
  lines: [
    { id: "l1", equipmentId: "v", nameSnapshot: "Vmount", categorySnapshot: "Электрика", quantity: 5, unitPrice: "2000", lineSum: "10000" },
  ],
};

describe("AddonEstimateSection", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it("renders nothing if addon is null", () => {
    const { container } = render(
      <AddonEstimateSection booking={{ id: "b1", status: "ISSUED", addonEstimate: null }} userRole="SUPER_ADMIN" />,
    );
    expect(container.querySelector("section")).toBeNull();
  });

  it("renders lines by nameSnapshot, totals and 3 download links", () => {
    render(<AddonEstimateSection booking={{ id: "b1", status: "ISSUED", addonEstimate: ADDON }} userRole="WAREHOUSE" />);
    expect(screen.getByText(/Доб-смета/)).toBeInTheDocument();
    expect(screen.getByText("Vmount")).toBeInTheDocument();
    expect(screen.getByText("×5")).toBeInTheDocument();
    expect(screen.getByText(/PDF доб-сметы/)).toBeInTheDocument();
    expect(screen.getByText(/PDF общая смета/)).toBeInTheDocument();
    expect(screen.getByText(/XLSX доб-сметы/)).toBeInTheDocument();
  });

  it("hides «Влить в основную смету» for technician and archived bookings", () => {
    const { rerender } = render(
      <AddonEstimateSection booking={{ id: "b1", status: "ISSUED", addonEstimate: ADDON }} userRole="TECHNICIAN" />,
    );
    expect(screen.queryByRole("button", { name: /Влить в основную смету/ })).toBeNull();
    rerender(
      <AddonEstimateSection
        booking={{ id: "b1", status: "ISSUED", deletedAt: "2026-09-01T00:00:00.000Z", addonEstimate: ADDON }}
        userRole="SUPER_ADMIN"
      />,
    );
    expect(screen.queryByRole("button", { name: /Влить в основную смету/ })).toBeNull();
  });

  it("merges through POST /addon-estimate/merge after confirmation and reloads", async () => {
    apiFetchMock.mockResolvedValue({ mergedLines: 1 });
    const onMerged = vi.fn();
    render(
      <AddonEstimateSection
        booking={{ id: "b1", status: "ISSUED", addonEstimate: ADDON }}
        userRole="SUPER_ADMIN"
        onMerged={onMerged}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Влить в основную смету/ }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Влить в основную" }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/api/bookings/b1/addon-estimate/merge", { method: "POST" }));
    await waitFor(() => expect(onMerged).toHaveBeenCalledTimes(1));
  });
});
