import { render, screen, waitFor } from "@testing-library/react";
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

type FetchRoutes = {
  availabilityRows?: Array<{ equipmentId: string; name: string; availableQuantity: number }>;
  /** null → эндпоинт статистики клиента отвечает 404 (панель тихо скрывается) */
  clientStats?: {
    bookingCount: number;
    averageCheck: number;
    outstandingDebt: number;
    hasDebt: boolean;
  } | null;
};

/**
 * ApprovalReviewView теперь монтирует ApprovalContext, который сам ходит в
 * /api/availability и /api/clients/:id/stats — мок маршрутизирует по URL.
 */
function mockFetchRoutes(routes: FetchRoutes = {}) {
  (global.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: unknown) => {
    const u = String(url);
    if (u.includes("/api/audit")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ items: [], nextCursor: null }),
      } as Response);
    }
    if (u.includes("/api/availability")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          rows: routes.availabilityRows ?? [
            { equipmentId: "eq1", name: "ARRI M18", availableQuantity: 5 },
          ],
        }),
      } as Response);
    }
    if (u.includes("/api/clients/")) {
      if (routes.clientStats === null) {
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () =>
          routes.clientStats ?? {
            bookingCount: 3,
            averageCheck: 40000,
            outstandingDebt: 0,
            hasDebt: false,
          },
      } as Response);
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response);
  });
}

function mockAuditEmpty() {
  mockFetchRoutes();
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

  it("falls back to booking.items when estimate is missing (fresh submit path)", () => {
    // Основной путь «создать бронь → отправить на согласование» не создаёт
    // Estimate-снапшот — таблица должна строиться из booking.items,
    // а не показывать «Нет позиций».
    mockAuditEmpty();
    render(
      <ApprovalReviewView
        booking={{ ...BOOKING, estimate: null }}
        onReload={vi.fn()}
        currentUser={CURRENT_USER}
      />
    );
    expect(screen.queryByText("Нет позиций")).not.toBeInTheDocument();
    // Позиция из items: имя, категория, кол-во
    expect(screen.getByText("ARRI M18")).toBeInTheDocument();
    expect(screen.getByText("Свет")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    // Цена/день из equipment.rentalRatePerShift (5000) и сумма (5000 × 2)
    expect(screen.getByText(/^5\s*000,00\s*₽$/)).toBeInTheDocument();
    expect(screen.getByText(/^10\s*000,00\s*₽$/)).toBeInTheDocument();
    // Пометка, что смета ещё не зафиксирована
    expect(
      screen.getByText(/Смета будет зафиксирована при подтверждении/)
    ).toBeInTheDocument();
  });

  it("uses customName/customCategory/customUnitPrice for off-catalog fallback items", () => {
    mockAuditEmpty();
    render(
      <ApprovalReviewView
        booking={{
          ...BOOKING,
          estimate: null,
          items: [
            {
              id: "item2",
              equipmentId: null,
              quantity: 3,
              equipment: null,
              customName: "Дым-машина клиента",
              customCategory: "Спецэффекты",
              customUnitPrice: "1500",
            },
          ],
        }}
        onReload={vi.fn()}
        currentUser={CURRENT_USER}
      />
    );
    expect(screen.queryByText("Нет позиций")).not.toBeInTheDocument();
    expect(screen.getByText("Дым-машина клиента")).toBeInTheDocument();
    expect(screen.getByText("Спецэффекты")).toBeInTheDocument();
    // Цена 1500 и сумма 1500 × 3 = 4500 из custom-полей
    expect(screen.getByText(/^1\s*500,00\s*₽$/)).toBeInTheDocument();
    expect(screen.getByText(/^4\s*500,00\s*₽$/)).toBeInTheDocument();
  });

  it("shows dash for price when fallback item has no equipment and no custom fields", () => {
    mockAuditEmpty();
    render(
      <ApprovalReviewView
        booking={{
          ...BOOKING,
          estimate: null,
          items: [{ id: "item3", equipmentId: null, quantity: 3, equipment: null }],
        }}
        onReload={vi.fn()}
        currentUser={CURRENT_USER}
      />
    );
    expect(screen.queryByText("Нет позиций")).not.toBeInTheDocument();
    expect(screen.getByText("Позиция")).toBeInTheDocument();
    expect(screen.getByText("Прочее")).toBeInTheDocument();
    // Цена и сумма неизвестны → «—» в двух ячейках
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("shows «Нет позиций» only when both estimate and items are empty", () => {
    mockAuditEmpty();
    render(
      <ApprovalReviewView
        booking={{ ...BOOKING, estimate: null, items: [] }}
        onReload={vi.fn()}
        currentUser={CURRENT_USER}
      />
    );
    expect(screen.getByText("Нет позиций")).toBeInTheDocument();
  });

  it("does not show the fallback notice when estimate snapshot exists", () => {
    mockAuditEmpty();
    render(
      <ApprovalReviewView
        booking={BOOKING}
        onReload={vi.fn()}
        currentUser={CURRENT_USER}
      />
    );
    expect(
      screen.queryByText(/Смета будет зафиксирована при подтверждении/)
    ).not.toBeInTheDocument();
  });
});

describe("ApprovalReviewView — транспорт (multi-vehicle)", () => {
  const MULTI_VEHICLE_BOOKING = {
    ...BOOKING,
    finalAmount: "75000",
    // Новые брони: vehicles[] заполнен, legacy vehicleId = null.
    vehicleId: null,
    vehicle: null,
    transportSubtotalRub: "30000",
    vehicles: [
      {
        id: "bv1",
        vehicle: { id: "v1", name: "Газель", slug: "gazel" },
        withGenerator: false,
        shiftHours: "12",
        skipOvertime: false,
        kmOutsideMkad: null,
        ttkEntry: false,
        subtotalRub: "12000",
      },
      {
        id: "bv2",
        vehicle: { id: "v2", name: "Ивеко", slug: "iveco" },
        withGenerator: true,
        shiftHours: "10",
        skipOvertime: false,
        kmOutsideMkad: 40,
        ttkEntry: true,
        subtotalRub: "18000",
      },
    ],
  };

  it("renders every vehicle from vehicles[] instead of «Не выбран»", () => {
    mockAuditEmpty();
    render(
      <ApprovalReviewView
        booking={MULTI_VEHICLE_BOOKING}
        onReload={vi.fn()}
        currentUser={CURRENT_USER}
      />
    );
    expect(screen.queryByText("Не выбран")).not.toBeInTheDocument();
    // Каждая машина видна и в карточке «Транспорт», и в разбивке «Итог»
    expect(screen.getAllByText(/Газель/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/Ивеко/).length).toBeGreaterThanOrEqual(2);
    // Суммы по машинам присутствуют (карточка + разбивка)
    expect(screen.getAllByText(/12\s*000,00\s*₽/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/18\s*000,00\s*₽/).length).toBeGreaterThanOrEqual(2);
    // Атрибуты машины: генератор и км за МКАД
    expect(screen.getByText(/\+ генератор/)).toBeInTheDocument();
    expect(screen.getByText(/40 км за МКАД/)).toBeInTheDocument();
  });

  it("shows «Не выбран» when booking has no vehicles and no legacy vehicleId", () => {
    mockAuditEmpty();
    render(
      <ApprovalReviewView
        booking={{ ...BOOKING, vehicles: [], vehicleId: null, transportSubtotalRub: null }}
        onReload={vi.fn()}
        currentUser={CURRENT_USER}
      />
    );
    expect(screen.getByText("Не выбран")).toBeInTheDocument();
  });
});

describe("ApprovalReviewView — контекст согласования (ApprovalContext)", () => {
  it("shows availability conflict warning on the review screen", async () => {
    // Запрошено 2 × eq1, доступна 1 → amber-предупреждение о конфликте
    mockFetchRoutes({
      availabilityRows: [{ equipmentId: "eq1", name: "ARRI M18", availableQuantity: 1 }],
    });
    render(
      <ApprovalReviewView
        booking={BOOKING}
        onReload={vi.fn()}
        currentUser={CURRENT_USER}
      />
    );
    await waitFor(() =>
      expect(screen.getByText(/Конфликты доступности/i)).toBeInTheDocument()
    );
    expect(screen.getByText(/запрошено 2, доступно 1/)).toBeInTheDocument();
  });

  it("shows client debt on the review screen", async () => {
    mockFetchRoutes({
      clientStats: { bookingCount: 7, averageCheck: 52000, outstandingDebt: 15000, hasDebt: true },
    });
    render(
      <ApprovalReviewView
        booking={BOOKING}
        onReload={vi.fn()}
        currentUser={CURRENT_USER}
      />
    );
    await waitFor(() =>
      expect(screen.getByText(/История клиента/i)).toBeInTheDocument()
    );
    expect(screen.getByText(/долг/i)).toBeInTheDocument();
  });

  it("shows green «no conflicts» line when everything is available", async () => {
    mockFetchRoutes({
      availabilityRows: [{ equipmentId: "eq1", name: "ARRI M18", availableQuantity: 5 }],
    });
    render(
      <ApprovalReviewView
        booking={BOOKING}
        onReload={vi.fn()}
        currentUser={CURRENT_USER}
      />
    );
    await waitFor(() =>
      expect(screen.getByText(/Конфликтов нет/i)).toBeInTheDocument()
    );
  });
});
