import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApprovalContext } from "../ApprovalContext";

const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn();
});
afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  vi.clearAllMocks();
});

const ITEMS = [
  { equipmentId: "eq1", quantity: 2, equipment: { name: "ARRI M18" } },
  { equipmentId: "eq2", quantity: 1, equipment: { name: "Dedolight 150W" } },
];

function mockAvailability(rows: Array<{ equipmentId: string; name: string; availableQuantity: number }>) {
  (global.fetch as any).mockImplementation((url: string) => {
    if (url.includes("/api/availability")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ rows }),
      });
    }
    if (url.includes("/api/clients/")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          bookingCount: 14,
          averageCheck: 58000,
          outstandingDebt: 0,
          hasDebt: false,
        }),
      });
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  });
}

function mockAvailabilityAndDebt(outstandingDebt: number, hasDebt: boolean) {
  (global.fetch as any).mockImplementation((url: string) => {
    if (url.includes("/api/availability")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          rows: [
            { equipmentId: "eq1", name: "ARRI M18", availableQuantity: 5 },
            { equipmentId: "eq2", name: "Dedolight 150W", availableQuantity: 5 },
          ],
        }),
      });
    }
    if (url.includes("/api/clients/")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          bookingCount: 5,
          averageCheck: 30000,
          outstandingDebt,
          hasDebt,
        }),
      });
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  });
}

const BASE_PROPS = {
  bookingId: "bk1",
  clientId: "cl1",
  startDate: "2026-04-20T10:00:00Z",
  endDate: "2026-04-22T18:00:00Z",
  itemCount: 2,
  comment: null,
  items: ITEMS,
};

describe("ApprovalContext", () => {
  it("shows no conflicts when all items are available", async () => {
    mockAvailability([
      { equipmentId: "eq1", name: "ARRI M18", availableQuantity: 5 },
      { equipmentId: "eq2", name: "Dedolight 150W", availableQuantity: 5 },
    ]);
    render(<ApprovalContext {...BASE_PROPS} />);
    await waitFor(() => expect(screen.getByText(/конфликтов нет/i)).toBeInTheDocument());
  });

  it("shows conflict warning when item quantity exceeds availability", async () => {
    mockAvailability([
      { equipmentId: "eq1", name: "ARRI M18", availableQuantity: 1 }, // requested 2, only 1 available
      { equipmentId: "eq2", name: "Dedolight 150W", availableQuantity: 5 },
    ]);
    render(<ApprovalContext {...BASE_PROPS} />);
    await waitFor(() => expect(screen.getByText(/конфликты доступности/i)).toBeInTheDocument());
    expect(screen.getByText(/ARRI M18/)).toBeInTheDocument();
  });

  it("shows client history with booking count and average check", async () => {
    mockAvailability([
      { equipmentId: "eq1", name: "ARRI M18", availableQuantity: 5 },
      { equipmentId: "eq2", name: "Dedolight 150W", availableQuantity: 5 },
    ]);
    render(<ApprovalContext {...BASE_PROPS} />);
    await waitFor(() => expect(screen.getByText(/история клиента/i)).toBeInTheDocument());
    expect(screen.getByText(/14/)).toBeInTheDocument();
    expect(screen.getByText(/долгов нет/i)).toBeInTheDocument();
  });

  it("shows debt warning in client history when client has debt", async () => {
    mockAvailabilityAndDebt(15000, true);
    render(<ApprovalContext {...BASE_PROPS} />);
    await waitFor(() => expect(screen.getByText(/история клиента/i)).toBeInTheDocument());
    expect(screen.getByText(/долг/i)).toBeInTheDocument();
  });

  it("renders warehouse comment when provided", async () => {
    mockAvailability([
      { equipmentId: "eq1", name: "ARRI M18", availableQuantity: 5 },
      { equipmentId: "eq2", name: "Dedolight 150W", availableQuantity: 5 },
    ]);
    render(<ApprovalContext {...BASE_PROPS} comment="Нужно согласовать с кладом" />);
    await waitFor(() => expect(screen.getByText(/комментарий кладовщика/i)).toBeInTheDocument());
    expect(screen.getByText(/Нужно согласовать с кладом/)).toBeInTheDocument();
  });

  it("does not render warehouse comment section when comment is null", async () => {
    mockAvailability([
      { equipmentId: "eq1", name: "ARRI M18", availableQuantity: 5 },
      { equipmentId: "eq2", name: "Dedolight 150W", availableQuantity: 5 },
    ]);
    render(<ApprovalContext {...BASE_PROPS} comment={null} />);
    await waitFor(() => expect(screen.getByText(/конфликтов нет/i)).toBeInTheDocument());
    expect(screen.queryByText(/комментарий кладовщика/i)).toBeNull();
  });

  it("silently hides client stats panel when /api/clients/:id/stats returns 404", async () => {
    (global.fetch as any).mockImplementation((url: string) => {
      if (url.includes("/api/availability")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            rows: [
              { equipmentId: "eq1", name: "ARRI M18", availableQuantity: 5 },
              { equipmentId: "eq2", name: "Dedolight 150W", availableQuantity: 5 },
            ],
          }),
        });
      }
      // stats endpoint not yet built — returns 404
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    });
    render(<ApprovalContext {...BASE_PROPS} />);
    await waitFor(() => expect(screen.getByText(/конфликтов нет/i)).toBeInTheDocument());
    expect(screen.queryByText(/история клиента/i)).toBeNull();
  });
});
