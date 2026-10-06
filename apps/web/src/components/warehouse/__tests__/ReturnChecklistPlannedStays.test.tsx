/**
 * Приёмка в киоске с позициями «по плану у клиента» (этап 11, мокап M3):
 * отдельный блок, «Вернули сейчас», по «Завершить» оставленное уходит в
 * продолжение брони (`stays`), итог называет продолжение.
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


const HOUR = 3_600_000;
const until = new Date(Math.ceil((Date.now() + 26 * HOUR) / HOUR) * HOUR).toISOString();

function plannedState(): ChecklistState {
  return {
    ...stateWith([
      { ...countItem("bi-storm", "Aputure STORM 400x", 2), category: "Свет" },
      countItem("bi-stand", "Стойка C-Stand", 6),
    ]),
    plannedStays: [{ bookingItemId: "bi-storm", until, quantity: 2, unitIds: [] }],
    splitRevision: 3,
  };
}

describe("ReturnChecklist: позиции «по плану у клиента»", () => {
  it("строка «по плану» — в отдельном блоке, а не в чек-листе; «Завершить» отправляет её в продолжение", async () => {
    mockState = plannedState();
    render(<ReturnChecklist sessionId="s1" projectName="Реклама кофейни «Зерно»" onBack={() => {}} />);
    expect(await screen.findByText(/По плану у клиента до/)).toBeInTheDocument();
    expect(screen.getByTestId("planned-stay")).toHaveTextContent("Aputure STORM 400x");
    expect(screen.queryByRole("button", { name: /«Aputure STORM 400x» без замечаний/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Принять всё, кроме оставленного/ }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Завершить приёмку/ }));
    await waitFor(() => expect(completeSpy).toHaveBeenCalledTimes(1));
    const [, payload] = completeSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload).toMatchObject({
      stays: [{ bookingItemId: "bi-storm", quantity: 2, until }],
      expectedSplitRevision: 3,
    });
  });

  it("«Вернули сейчас» — строка в чек-листе, stays пустой", async () => {
    mockState = plannedState();
    render(<ReturnChecklist sessionId="s1" projectName="ZZ" onBack={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "✓ Вернули сейчас" }));
    expect(screen.getByRole("button", { name: "✓ Вернули сейчас" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /«Aputure STORM 400x» без замечаний/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Принять всё, кроме оставленного/ }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Завершить приёмку/ }));
    await waitFor(() => expect(completeSpy).toHaveBeenCalledTimes(1));
    const [, payload] = completeSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.stays).toEqual([]);
  });

  it("всё осталось у клиента — не «нет позиций», а блок «по плану» и «Завершить»", async () => {
    mockState = {
      ...stateWith([countItem("bi-storm", "Aputure STORM 400x", 2)]),
      plannedStays: [{ bookingItemId: "bi-storm", until, quantity: 2, unitIds: [] }],
      splitRevision: 0,
    };
    render(<ReturnChecklist sessionId="s1" projectName="ZZ" onBack={() => {}} />);
    expect(await screen.findByText(/По плану у клиента до/)).toBeInTheDocument();
    expect(screen.queryByText(/нет позиций для приёмки/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Принять всё/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Завершить приёмку/ }));
    await waitFor(() => expect(completeSpy).toHaveBeenCalledTimes(1));
  });

  it("старый сервер без plannedStays — тело без stays, как раньше", async () => {
    mockState = stateWith([countItem("bi-stand", "Стойка C-Stand", 6)]);
    render(<ReturnChecklist sessionId="s1" projectName="ZZ" onBack={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Принять всё разом/ }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Завершить приёмку/ }));
    await waitFor(() => expect(completeSpy).toHaveBeenCalledTimes(1));
    const [, payload] = completeSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload).not.toHaveProperty("stays");
  });

  it("итог называет продолжение", async () => {
    mockState = plannedState();
    completeSpy.mockResolvedValue({
      ...okResult(),
      continuations: [{ id: "c1", docNumber: "СМ-2026-0231-1", endDate: until, quantity: 2 }],
    });
    render(<ReturnChecklist sessionId="s1" projectName="ZZ" onBack={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Принять всё, кроме оставленного/ }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Завершить приёмку/ }));
    const block = await screen.findByTestId("result-continuations");
    expect(block).toHaveTextContent("СМ-2026-0231-1 · 2 ед.");
    expect(block).toHaveTextContent("выдано сразу, без согласования");
  });
});
