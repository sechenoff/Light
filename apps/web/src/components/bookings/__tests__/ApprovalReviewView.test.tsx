import { render, screen } from "@testing-library/react";
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
  ],
  estimate: {
    id: "est1",
    shifts: 2,
    subtotal: "50000",
    discountPercent: "10",
    discountAmount: "5000",
    totalAfterDiscount: "45000",
    lines: [
      {
        id: "ln1",
        equipmentId: "eq1",
        categorySnapshot: "Свет",
        nameSnapshot: "ARRI M18",
        brandSnapshot: "ARRI",
        modelSnapshot: "M18",
        quantity: 2,
        unitPrice: "5000",
        lineSum: "20000",
      },
      {
        id: "ln2",
        equipmentId: "eq2",
        categorySnapshot: "Свет",
        nameSnapshot: "Dedolight 150W",
        brandSnapshot: "Dedo",
        modelSnapshot: null,
        quantity: 1,
        unitPrice: "2000",
        lineSum: "2000",
      },
    ],
  },
};

const CURRENT_USER = {
  userId: "u1",
  username: "boss",
  role: "SUPER_ADMIN" as const,
};

function mockAuditEmpty() {
  (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ items: [], nextCursor: null }),
  } as Response);
}

describe("ApprovalReviewView (read-only)", () => {
  it("renders booking header with client name, project and dates", () => {
    mockAuditEmpty();
    render(
      <ApprovalReviewView
        booking={BOOKING}
        onReload={vi.fn()}
        currentUser={CURRENT_USER}
      />
    );
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toContain("Иванов Иван");
    expect(heading.textContent).toContain("Тестовый проект");
  });

  it("renders equipment lines from estimate snapshot (read-only)", () => {
    mockAuditEmpty();
    render(
      <ApprovalReviewView
        booking={BOOKING}
        onReload={vi.fn()}
        currentUser={CURRENT_USER}
      />
    );
    // Estimate lines appear
    expect(screen.getByText("ARRI M18")).toBeInTheDocument();
    expect(screen.getByText("Dedolight 150W")).toBeInTheDocument();
    // NO quantity +/- buttons — this view is read-only
    const plusButtons = screen.queryAllByRole("button", { name: /\+/ });
    expect(plusButtons).toHaveLength(0);
  });

  it("renders big final amount from booking.finalAmount", () => {
    mockAuditEmpty();
    render(
      <ApprovalReviewView
        booking={BOOKING}
        onReload={vi.fn()}
        currentUser={CURRENT_USER}
      />
    );
    // finalAmount = 45000
    const amountElements = screen.getAllByText(/45\s*000/);
    expect(amountElements.length).toBeGreaterThan(0);
  });

  it("renders Edit link pointing to /bookings/:id/edit", () => {
    mockAuditEmpty();
    render(
      <ApprovalReviewView
        booking={BOOKING}
        onReload={vi.fn()}
        currentUser={CURRENT_USER}
      />
    );
    // At least one Edit link should point to the edit page
    const editLinks = screen.getAllByRole("link", { name: /Редактировать/ });
    expect(editLinks.length).toBeGreaterThan(0);
    expect(editLinks[0].getAttribute("href")).toBe("/bookings/bk1/edit");
  });
});
