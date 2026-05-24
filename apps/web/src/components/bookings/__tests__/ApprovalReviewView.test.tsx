import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApprovalReviewView } from "../ApprovalReviewView";

// Mock next/navigation
const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

// Мокаем apiFetch — он используется для всех PATCH/approve вызовов.
// global.fetch остаётся для audit-fetch'а (вызывается напрямую).
vi.mock("../../../lib/api", () => ({
  apiFetch: vi.fn(),
}));

// Мокаем toast, чтобы проверять вызовы и не зависеть от провайдера.
// vi.mock hoist'ится наверх — используем vi.fn() прямо в factory и достаём через import.
vi.mock("../../ToastProvider", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}));

import { apiFetch } from "../../../lib/api";
import { toast } from "../../ToastProvider";

const mockApiFetch = apiFetch as ReturnType<typeof vi.fn>;
const mockToastError = toast.error as ReturnType<typeof vi.fn>;
const mockToastSuccess = toast.success as ReturnType<typeof vi.fn>;

const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn();
  mockPush.mockClear();
  mockApiFetch.mockReset();
  mockToastError.mockReset();
  mockToastSuccess.mockReset();
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
        totalQuantity: 5,
        availableQuantity: 5,
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

describe("ApprovalReviewView (inline edit)", () => {
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

  it("renders equipment lines from booking.items with editable +/- buttons", () => {
    mockAuditEmpty();
    render(
      <ApprovalReviewView
        booking={BOOKING}
        onReload={vi.fn()}
        currentUser={CURRENT_USER}
      />
    );
    // Equipment names from booking.items
    expect(screen.getByText("ARRI M18")).toBeInTheDocument();
    expect(screen.getByText("Dedolight 150W")).toBeInTheDocument();
    // Inline qty editor: каждая позиция получает кнопки +/−
    const plusButtons = screen.getAllByRole("button", { name: "+" });
    expect(plusButtons.length).toBeGreaterThanOrEqual(2);
    const minusButtons = screen.getAllByRole("button", { name: "-" });
    expect(minusButtons.length).toBeGreaterThanOrEqual(2);
  });

  it("renders editable discount input with current value", () => {
    mockAuditEmpty();
    render(
      <ApprovalReviewView
        booking={BOOKING}
        onReload={vi.fn()}
        currentUser={CURRENT_USER}
      />
    );
    const discountInput = screen.getByLabelText("Процент скидки") as HTMLInputElement;
    expect(discountInput).toBeInTheDocument();
    expect(Number(discountInput.value)).toBe(10);
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

  it("does NOT render Edit link to /bookings/:id/edit (replaced by inline edit)", () => {
    mockAuditEmpty();
    render(
      <ApprovalReviewView
        booking={BOOKING}
        onReload={vi.fn()}
        currentUser={CURRENT_USER}
      />
    );
    const editLinks = screen.queryAllByRole("link", { name: /Редактировать/ });
    expect(editLinks).toHaveLength(0);
  });

  it("renders Reject and Approve buttons in both hero and sidebar", () => {
    mockAuditEmpty();
    render(
      <ApprovalReviewView
        booking={BOOKING}
        onReload={vi.fn()}
        currentUser={CURRENT_USER}
      />
    );
    const rejectButtons = screen.getAllByRole("button", { name: /Отклонить/ });
    expect(rejectButtons.length).toBeGreaterThanOrEqual(2);
    const approveButtons = screen.getAllByRole("button", { name: /Подтвердить/ });
    expect(approveButtons.length).toBeGreaterThanOrEqual(2);
  });

  it("PATCH error rollback — реверты qty к серверному значению и вызывает toast.error", async () => {
    vi.useFakeTimers();
    mockAuditEmpty();
    // apiFetch для PATCH будет падать.
    mockApiFetch.mockRejectedValueOnce(new Error("server boom"));

    const onReload = vi.fn();
    render(
      <ApprovalReviewView
        booking={BOOKING}
        onReload={onReload}
        currentUser={CURRENT_USER}
      />
    );

    // На ARRI M18 qty=2 (см. BOOKING.items[0]). Жмём «+» рядом с ним.
    // qty-input отрисовывается у каждой позиции — берём первую +.
    const plusButtons = screen.getAllByRole("button", { name: "+" });
    fireEvent.click(plusButtons[0]);

    // Оптимистично 3.
    expect(screen.getByText("3")).toBeInTheDocument();

    // Гоняем debounce (500ms) → PATCH летит → отказ → rollback.
    await act(async () => {
      vi.advanceTimersByTime(600);
      // Дать промисам распуститься.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // PATCH должен быть вызван единожды.
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    expect(mockApiFetch).toHaveBeenCalledWith(
      `/api/bookings/${BOOKING.id}`,
      expect.objectContaining({ method: "PATCH" }),
    );
    // Roll back: qty снова 2 (серверная истина).
    expect(screen.getByText("2")).toBeInTheDocument();
    // Toast об ошибке.
    expect(mockToastError).toHaveBeenCalled();
    const firstArg = mockToastError.mock.calls[0]?.[0];
    expect(String(firstArg)).toContain("server boom");

    vi.useRealTimers();
  });

  it("Approve mid-debounce flush — PATCH летит ПЕРЕД /approve, кнопки заблокированы всё время", async () => {
    vi.useFakeTimers();
    mockAuditEmpty();

    const callOrder: string[] = [];
    // Первый apiFetch — это PATCH из debounce. Резолвится после явного флипа.
    let resolvePatch: ((v: unknown) => void) | null = null;
    const patchPromise = new Promise((res) => {
      resolvePatch = res;
    });
    mockApiFetch.mockImplementationOnce(async (path: string, init: RequestInit) => {
      callOrder.push(`${init.method} ${path}`);
      await patchPromise;
      return { booking: BOOKING };
    });
    // Второй apiFetch — POST /approve.
    mockApiFetch.mockImplementationOnce(async (path: string, init: RequestInit) => {
      callOrder.push(`${init.method} ${path}`);
      return { booking: { ...BOOKING, status: "CONFIRMED" } };
    });

    render(
      <ApprovalReviewView
        booking={BOOKING}
        onReload={vi.fn()}
        currentUser={CURRENT_USER}
      />
    );

    // Жмём «+» — qty 2 → 3, scheduleSave запускает debounce 500ms.
    const plusButtons = screen.getAllByRole("button", { name: "+" });
    fireEvent.click(plusButtons[0]);

    // НЕ даём debounce-у уйти — сразу жмём Approve (в hero — первый).
    const approveButtons = screen.getAllByRole("button", { name: /Подтвердить/ });
    expect(approveButtons.length).toBeGreaterThanOrEqual(2);

    // Запускаем click — handleApprove первым делом setApproving(true), затем
    // flush debounce → performSave (PATCH). PATCH висит на patchPromise.
    let approveClickPromise: Promise<void> | undefined;
    act(() => {
      approveClickPromise = (async () => {
        fireEvent.click(approveButtons[0]);
      })();
    });

    // Дать React микротаску прокрутить state-update.
    await act(async () => {
      await Promise.resolve();
    });

    // MED #6 — обе approve-кнопки должны быть disabled пока PATCH в полёте.
    for (const btn of approveButtons) {
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    }

    // На этой точке должен быть отправлен ТОЛЬКО PATCH, не /approve.
    expect(callOrder).toEqual([`PATCH /api/bookings/${BOOKING.id}`]);

    // Резолвим PATCH → handleApprove должен пойти дальше и отправить /approve.
    await act(async () => {
      resolvePatch?.({ booking: BOOKING });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Approve уже улетел после PATCH.
    expect(callOrder).toEqual([
      `PATCH /api/bookings/${BOOKING.id}`,
      `POST /api/bookings/${BOOKING.id}/approve`,
    ]);

    // Body PATCH'a содержит обновлённый qty (3 для eq1).
    const patchCall = mockApiFetch.mock.calls[0];
    const patchBody = JSON.parse(String((patchCall[1] as RequestInit).body));
    const eq1Item = (patchBody.items as Array<{ equipmentId: string; quantity: number }>).find(
      (i) => i.equipmentId === "eq1",
    );
    expect(eq1Item?.quantity).toBe(3);

    // Подождать handleApprove завершиться.
    await act(async () => {
      await approveClickPromise;
    });

    vi.useRealTimers();
  });

  it("Custom-line preservation — PATCH-body содержит И catalog-, И custom-позицию", async () => {
    vi.useFakeTimers();
    mockAuditEmpty();
    mockApiFetch.mockResolvedValueOnce({ booking: BOOKING });

    // Бронь с 1 catalog + 1 custom item.
    const bookingWithCustom = {
      ...BOOKING,
      items: [
        BOOKING.items[0], // catalog: eq1, qty 2
        {
          id: "custom1",
          equipmentId: null,
          quantity: 1,
          customName: "тележка",
          customCategory: "Спец",
          customUnitPrice: "5000",
          equipment: null,
        },
      ],
    };

    render(
      <ApprovalReviewView
        booking={bookingWithCustom}
        onReload={vi.fn()}
        currentUser={CURRENT_USER}
      />
    );

    // Меняем qty catalog-позиции: жмём «+» (там она одна — единственная catalog).
    const plusButtons = screen.getAllByRole("button", { name: "+" });
    fireEvent.click(plusButtons[0]);

    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockApiFetch.mock.calls[0];
    const body = JSON.parse(String((init as RequestInit).body));
    const items = body.items as Array<Record<string, unknown>>;

    // Catalog-позиция с новым qty=3.
    const catalogLine = items.find((i) => i.equipmentId === "eq1");
    expect(catalogLine).toBeDefined();
    expect(catalogLine?.quantity).toBe(3);

    // Custom-позиция «тележка» сохраняется без изменений.
    const customLine = items.find((i) => i.customName === "тележка");
    expect(customLine).toBeDefined();
    expect(customLine?.customUnitPrice).toBe(5000);
    expect(customLine?.quantity).toBe(1);

    vi.useRealTimers();
  });
});
