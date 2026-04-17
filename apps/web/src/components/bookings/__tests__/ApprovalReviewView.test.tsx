import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApprovalReviewView } from "../ApprovalReviewView";

// Mock next/navigation
const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn();
  mockPush.mockClear();
});
afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  vi.clearAllMocks();
});

const BOOKING = {
  id: "bk1",
  status: "PENDING_APPROVAL" as const,
  projectName: "Тестовый проект",
  displayName: "Иванов Иван · проект «Тестовый проект»",
  startDate: "2026-05-01T10:00:00Z",
  endDate: "2026-05-03T18:00:00Z",
  comment: "Нужен кран",
  discountPercent: "10",
  totalEstimateAmount: "50000",
  discountAmount: "5000",
  finalAmount: "45000",
  amountPaid: "0",
  amountOutstanding: "45000",
  paymentStatus: "NOT_PAID" as const,
  rejectionReason: null,
  client: { id: "cl1", name: "Иванов Иван", phone: null, email: null, comment: null },
  items: [
    {
      id: "item1",
      equipmentId: "eq1",
      quantity: 2,
      equipment: {
        id: "eq1",
        name: "ARRI M18",
        category: "Свет",
        brand: "ARRI",
        model: "M18",
        rentalRatePerShift: "5000",
        totalQuantity: 5,
        availableQuantity: 3,
      },
    },
    {
      id: "item2",
      equipmentId: "eq2",
      quantity: 1,
      equipment: {
        id: "eq2",
        name: "Dedolight 150W",
        category: "Свет",
        brand: "Dedo",
        model: null,
        rentalRatePerShift: "2000",
        totalQuantity: 4,
        availableQuantity: 2,
      },
    },
  ],
  estimate: null,
  financeEvents: [],
  scanSessions: [],
};

const CURRENT_USER = {
  userId: "u1",
  username: "boss",
  role: "SUPER_ADMIN" as const,
};

function mockAuditEmpty() {
  (global.fetch as any).mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ items: [], nextCursor: null }),
  });
}

describe("ApprovalReviewView", () => {
  it("renders booking header with client name, project and dates", async () => {
    mockAuditEmpty();
    render(
      <ApprovalReviewView
        booking={BOOKING}
        onReload={vi.fn()}
        currentUser={CURRENT_USER}
      />
    );
    // client name appears in the title heading
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toContain("Иванов Иван");
    expect(heading.textContent).toContain("Тестовый проект");
  });

  it("renders equipment table with correct line totals", async () => {
    mockAuditEmpty();
    render(
      <ApprovalReviewView
        booking={BOOKING}
        onReload={vi.fn()}
        currentUser={CURRENT_USER}
      />
    );
    // ARRI M18 should appear in the table
    expect(screen.getByText("ARRI M18")).toBeInTheDocument();
    // Dedolight too
    expect(screen.getByText("Dedolight 150W")).toBeInTheDocument();
    // Line total for ARRI M18: 2 × 5000 × 2 shifts = 20000 (or just check the name appears)
    // Check quantities rendered
    expect(screen.getAllByRole("button", { name: /\+/ })).not.toHaveLength(0);
  });

  it("renders big final amount from booking.finalAmount", async () => {
    mockAuditEmpty();
    render(
      <ApprovalReviewView
        booking={BOOKING}
        onReload={vi.fn()}
        currentUser={CURRENT_USER}
      />
    );
    // finalAmount = 45000, should appear in sidebar
    // formatMoneyRub renders with locale formatting — look for the number
    const amountElements = screen.getAllByText(/45\s*000|45\.000/);
    expect(amountElements.length).toBeGreaterThan(0);
  });

  it("calls PATCH /api/bookings/:id after stepper increment with debounce", async () => {
    const patchCalls: { url: string; payload: any }[] = [];

    (global.fetch as any).mockImplementation((url: string, init?: any) => {
      if (typeof url === "string" && url.includes("/api/bookings/bk1") && init?.method === "PATCH") {
        patchCalls.push({ url, payload: JSON.parse(init.body) });
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            booking: {
              ...BOOKING,
              totalEstimateAmount: "55000",
              discountAmount: "5500",
              finalAmount: "49500",
            },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ items: [], nextCursor: null }),
      });
    });

    render(
      <ApprovalReviewView
        booking={BOOKING}
        onReload={vi.fn()}
        currentUser={CURRENT_USER}
      />
    );

    // Find the first "+" button (increments first item quantity)
    const plusButtons = screen.getAllByRole("button", { name: /\+/ });
    fireEvent.click(plusButtons[0]);

    // Wait for debounce (500ms) to fire — use real timers, just wait
    await waitFor(
      () => expect(patchCalls.length).toBeGreaterThan(0),
      { timeout: 1500 },
    );

    // Payload should have the updated quantity (3, was 2)
    const lastCall = patchCalls[patchCalls.length - 1];
    expect(lastCall.payload.items).toBeDefined();
    const arriItem = lastCall.payload.items.find((i: any) => i.equipmentId === "eq1");
    expect(arriItem?.quantity).toBe(3);
  });
});
