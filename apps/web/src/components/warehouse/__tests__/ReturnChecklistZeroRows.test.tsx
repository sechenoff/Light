/**
 * Приёмка в киоске и строки «×0» (P5, UI).
 *
 * На выдаче позицию можно снять степпером до 0 — строка брони остаётся с
 * `quantity: 0`. Сервер v2 такие строки в чек-лист приёмки не отдаёт, но
 * старый API и старые данные — отдают. Чек-лист обязан их пропускать:
 * не рисовать, не требовать «Помечьте все 0 шт» и не мешать «Завершить».
 * На проде так «застряла» приёмка брони, которую потом закрыли кнопкой.
 */
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChecklistState, CompleteResult } from "../types";
import type { UseScanSessionResult } from "../useScanSession";

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });

let mockState: ChecklistState | null = null;
vi.mock("../useScanSession", () => ({
  useScanSession: (): Partial<UseScanSessionResult> => ({
    state: mockState,
    loading: false,
    error: null,
    openSession: vi.fn(async () => {}),
    check: vi.fn(async () => {}),
    uncheck: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
  }),
}));

const completeSpy = vi.fn();
vi.mock("../api", () => ({
  scanApi: {
    complete: (...args: unknown[]) => completeSpy(...args),
    listSessionVehicles: async () => [],
    saveDraft: vi.fn(async () => ({ revision: 1, savedAt: new Date().toISOString() })),
    cancel: vi.fn(async () => ({ cancelled: true })),
    getWarehouseToken: () => null,
  },
}));

import { ReturnChecklist } from "../ReturnChecklist";

function countItem(id: string, name: string, quantity: number) {
  return {
    bookingItemId: id,
    equipmentId: `eq-${id}`,
    equipmentName: name,
    category: "Коммутация",
    quantity,
    checkedQty: 0,
    trackingMode: "COUNT" as const,
    isExtra: false,
    rentalRatePerShift: "0",
    originalQuantity: quantity === 0 ? 5 : quantity,
    addCap: 0,
  };
}

function stateWith(items: ChecklistState["items"]): ChecklistState {
  return {
    sessionId: "s1",
    bookingId: "b1",
    operation: "RETURN",
    items,
    progress: { checkedItems: 0, totalItems: items.length },
    shifts: 1,
    discountPercent: "0",
    mainOriginalAfterDiscount: "0",
  };
}

function okResult(): CompleteResult {
  return {
    sessionId: "s1",
    operation: "RETURN",
    scannedCount: 0,
    expectedCount: 0,
    missingItems: [],
    substitutedItems: [],
    reservedButUnavailable: [],
    createdRepairIds: [],
    failedBrokenUnits: [],
    createdProblemItemIds: [],
    failedProblemUnits: [],
    mainAfterDiscount: "0",
    mainOriginalAfterDiscount: "0",
    addonAfterDiscount: "0",
    finalAmount: "0",
    paymentStatus: "NOT_PAID",
    amountPaid: "0",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  completeSpy.mockResolvedValue(okResult());
});

describe("ReturnChecklist: строки ×0 (сняли на выдаче)", () => {
  it("без обнулённой строки «Принять всё разом» → «Завершить приёмку» проходит", async () => {
    mockState = stateWith([countItem("bi-a", "Штатив A100", 2)]);
    render(<ReturnChecklist sessionId="s1" projectName="ZZ" onBack={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Принять всё разом/ }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Завершить приёмку/ }));
    await waitFor(() => expect(completeSpy).toHaveBeenCalledTimes(1));
  });

  it("с обнулённой строкой «Принять всё разом» → «Завершить приёмку» тоже проходит", async () => {
    mockState = stateWith([
      countItem("bi-a", "Штатив A100", 2),
      countItem("bi-z", "Удлинитель", 0),
    ]);
    render(<ReturnChecklist sessionId="s1" projectName="ZZ" onBack={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Принять всё разом/ }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Завершить приёмку/ }));
    await settle();

    expect(screen.queryAllByText(/Помечьте все 0 шт/)).toHaveLength(0);
    expect(completeSpy).toHaveBeenCalledTimes(1);
    // В тело завершения строка ×0 не попадает ни ремонтом, ни потеряшкой.
    const [, payload] = completeSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(JSON.stringify(payload)).not.toContain("bi-z");
  });

  it("строка ×0 не рисуется в чек-листе, поштучная приёмка остальных завершается", async () => {
    mockState = stateWith([
      countItem("bi-a", "Штатив A100", 2),
      countItem("bi-z", "Удлинитель", 0),
    ]);
    render(<ReturnChecklist sessionId="s1" projectName="ZZ" onBack={() => {}} />);
    expect(await screen.findByText("Штатив A100")).toBeInTheDocument();
    expect(screen.queryByText("Удлинитель")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: /Принять все 2 шт «Штатив A100» без замечаний/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Завершить приёмку/ }));
    await waitFor(() => expect(completeSpy).toHaveBeenCalledTimes(1));
  });

  it("все строки ×0 — пустое состояние, а не чек-лист, который нельзя завершить", async () => {
    mockState = stateWith([countItem("bi-z", "Удлинитель", 0)]);
    render(<ReturnChecklist sessionId="s1" projectName="ZZ" onBack={() => {}} />);
    expect(await screen.findByText(/нет позиций для приёмки/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Завершить приёмку/ })).toBeNull();
    // Подсказка, как всё-таки закрыть бронь, — иначе кладовщик в тупике.
    expect(screen.getByText(/кнопкой «Вернуть» на карточке брони/)).toBeInTheDocument();
  });
});
