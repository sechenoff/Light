/**
 * «Остаётся у клиента» на приёмке в киоске (этап 15, мокап M3): оставленное
 * уходит из чек-листа в `stays`; сверх оплаченного — превью доплаты; позиция
 * нужна другой брони — «Завершить» ждёт «Оставить под ответственность».
 */
import { render, screen, waitFor, fireEvent, act, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChecklistState, CompleteResult } from "../types";
import type { KioskStaysPreview } from "../kioskStays";
import type { UseScanSessionResult } from "../useScanSession";

const wait = (ms: number) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

let mockState: ChecklistState | null = null;
const uncheckSpy = vi.fn(async () => {});
vi.mock("../useScanSession", () => ({
  useScanSession: (): Partial<UseScanSessionResult> => ({
    state: mockState,
    loading: false,
    error: null,
    openSession: vi.fn(async () => {}),
    check: vi.fn(async () => {}),
    uncheck: uncheckSpy,
    refresh: vi.fn(async () => {}),
  }),
}));

const completeSpy = vi.fn();
const previewSpy = vi.fn();
vi.mock("../api", () => ({
  scanApi: {
    complete: (...args: unknown[]) => completeSpy(...args),
    staysPreview: (...args: unknown[]) => previewSpy(...args),
    listSessionVehicles: async () => [],
    saveDraft: vi.fn(async () => ({ revision: 1, savedAt: new Date().toISOString() })),
    cancel: vi.fn(async () => ({ cancelled: true })),
    getWarehouseToken: () => null,
  },
}));

import { ReturnChecklist } from "../ReturnChecklist";

const HOUR = 3_600_000;
const SHIFT = 24 * HOUR;
const paidFuture = new Date(Math.ceil((Date.now() + 26 * HOUR) / HOUR) * HOUR).toISOString();
const paidPast = new Date(Math.floor((Date.now() - 2 * HOUR) / HOUR) * HOUR).toISOString();

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
    rentalRatePerShift: "800",
    originalQuantity: quantity,
    addCap: 0,
  };
}

function stateWith(items: ChecklistState["items"], extra: Partial<ChecklistState> = {}): ChecklistState {
  return {
    sessionId: "s1",
    bookingId: "b1",
    operation: "RETURN",
    items,
    progress: { checkedItems: 0, totalItems: items.length },
    shifts: 1,
    discountPercent: "50",
    mainOriginalAfterDiscount: "0",
    plannedStays: [],
    splitRevision: 2,
    ...extra,
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

function previewWith(extra: Partial<KioskStaysPreview> = {}): KioskStaysPreview {
  return {
    continuations: [
      {
        until: new Date(Date.now() + SHIFT).toISOString(),
        docNumber: null,
        lines: [
          { bookingItemId: "bi-stand", name: "Стойка C-Stand", quantity: 1, billedShifts: 1, lineSum: "800", afterDiscount: "400", negotiated: false },
        ],
        discountPercent: "50",
        surchargeAmount: "0",
        total: "400",
      },
    ],
    conflicts: [],
    parentNegotiatedTotal: null,
    ...extra,
  };
}

async function finish() {
  fireEvent.click(screen.getByRole("button", { name: /Принять всё, кроме оставленного/ }));
  await wait(30);
  fireEvent.click(screen.getByRole("button", { name: /Завершить приёмку/ }));
}

beforeEach(() => {
  vi.clearAllMocks();
  completeSpy.mockResolvedValue(okResult());
  previewSpy.mockResolvedValue(previewWith());
});

describe("ReturnChecklist: «Остаётся у клиента» у обычной строки", () => {
  it("до конца оплаченного — строка короче, без доплаты, без превью; stays в «Завершить»", async () => {
    mockState = stateWith([countItem("bi-stand", "Стойка C-Stand", 6)], { linePaidThrough: { "bi-stand": paidFuture } });
    render(<ReturnChecklist sessionId="s1" projectName="ZZ" onBack={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Остаётся у клиента: Стойка C-Stand" }));
    const editor = screen.getByTestId("kiosk-stay");
    expect(editor).toHaveTextContent("без доплаты");
    expect(screen.getByRole("button", { name: "Принять все 5 шт «Стойка C-Stand» без замечаний" })).toBeInTheDocument();
    await wait(500);
    expect(previewSpy).not.toHaveBeenCalled();
    await finish();
    await waitFor(() => expect(completeSpy).toHaveBeenCalledTimes(1));
    const [, payload] = completeSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload).toMatchObject({
      stays: [{ bookingItemId: "bi-stand", quantity: 1, until: paidFuture }],
      expectedSplitRevision: 2,
    });
  });

  it("«Не остаётся» возвращает строку целиком", async () => {
    mockState = stateWith([countItem("bi-stand", "Стойка C-Stand", 6)], { linePaidThrough: { "bi-stand": paidFuture } });
    render(<ReturnChecklist sessionId="s1" projectName="ZZ" onBack={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Остаётся у клиента: Стойка C-Stand" }));
    fireEvent.click(screen.getByRole("button", { name: "Не остаётся: Стойка C-Stand" }));
    expect(screen.getByRole("button", { name: "Принять все 6 шт «Стойка C-Stand» без замечаний" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Принять всё разом/ }));
    await wait(30);
    fireEvent.click(screen.getByRole("button", { name: /Завершить приёмку/ }));
    await waitFor(() => expect(completeSpy).toHaveBeenCalledTimes(1));
    const [, payload] = completeSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.stays).toEqual([]);
  });

  it("оплата прошла — «+1 смена» по умолчанию и доплата из превью", async () => {
    mockState = stateWith([countItem("bi-stand", "Стойка C-Stand", 6)], { linePaidThrough: { "bi-stand": paidPast } });
    render(<ReturnChecklist sessionId="s1" projectName="ZZ" onBack={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Остаётся у клиента: Стойка C-Stand" }));
    expect(screen.getByRole("radio", { name: "+1 смена" })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("radio", { name: "до конца оплаченного" })).toBeNull();
    await waitFor(() => expect(previewSpy).toHaveBeenCalledTimes(1));
    expect(previewSpy).toHaveBeenCalledWith("s1", [
      expect.objectContaining({ bookingItemId: "bi-stand", quantity: 1 }),
    ]);
    const editor = screen.getByTestId("kiosk-stay");
    await waitFor(() => expect(editor).toHaveTextContent(/1 шт × 1 смена → 400\s₽ со скидкой/));
  });

  it("позиция нужна другой брони — «Завершить» ждёт «Оставить под ответственность»", async () => {
    previewSpy.mockResolvedValue(
      previewWith({
        conflicts: [
          {
            bookingItemId: "bi-stand",
            name: "Стойка C-Stand",
            needed: 1,
            available: 0,
            from: new Date(Date.now() + 10 * HOUR).toISOString(),
            holder: { projectName: "Клип Север", clientName: "Иванов" },
          },
        ],
      }),
    );
    mockState = stateWith([countItem("bi-stand", "Стойка C-Stand", 6)], { linePaidThrough: { "bi-stand": paidPast } });
    render(<ReturnChecklist sessionId="s1" projectName="ZZ" onBack={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Остаётся у клиента: Стойка C-Stand" }));
    const holder = await screen.findByRole("group", { name: "Нужен другой брони: Стойка C-Stand" });
    expect(holder).toHaveTextContent("Нужен брони «Клип Север»");
    await finish();
    await wait(30);
    expect(completeSpy).not.toHaveBeenCalled();
    expect(screen.getByText(/оставьте под ответственность или сократите срок/)).toBeInTheDocument();

    fireEvent.click(within(holder).getByRole("button", { name: "Оставить под ответственность" }));
    await waitFor(() => expect(previewSpy).toHaveBeenCalledTimes(2));
    await wait(30);
    fireEvent.click(screen.getByRole("button", { name: /Завершить приёмку/ }));
    await waitFor(() => expect(completeSpy).toHaveBeenCalledTimes(1));
    const [, payload] = completeSpy.mock.calls[0] as [string, { stays: Array<Record<string, unknown>> }];
    expect(payload.stays[0]).toMatchObject({ bookingItemId: "bi-stand", quantity: 1, acknowledgedConflict: true });
  });

  it("штучная позиция: оставленная единица снимается с «принято» и уходит в stays", async () => {
    mockState = stateWith(
      [
        {
          bookingItemId: "bi-lens",
          equipmentId: "eq-lens",
          equipmentName: "Объектив Cooke",
          category: "Оптика",
          quantity: 2,
          checkedQty: 1,
          trackingMode: "UNIT" as const,
          isExtra: false,
          rentalRatePerShift: "0",
          originalQuantity: 2,
          addCap: 0,
          units: [
            { unitId: "u1", barcode: null, checked: true, problemType: null },
            { unitId: "u2", barcode: null, checked: false, problemType: null },
          ],
        },
      ],
      { linePaidThrough: { "bi-lens": paidFuture } },
    );
    render(<ReturnChecklist sessionId="s1" projectName="ZZ" onBack={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Остаётся у клиента: Объектив Cooke" }));
    expect(screen.getByText("Отметьте, какие приборы остаются у клиента")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "прибор 1 из 2" }));
    await waitFor(() => expect(uncheckSpy).toHaveBeenCalledWith("u1"));
    await finish();
    await waitFor(() => expect(completeSpy).toHaveBeenCalledTimes(1));
    const [, payload] = completeSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.stays).toEqual([{ bookingItemId: "bi-lens", quantity: 1, until: paidFuture, equipmentUnitIds: ["u1"] }]);
  });

  it("строку «по плану» можно продлить: «+1 смена» — от конца оплаченного, с превью", async () => {
    previewSpy.mockResolvedValue(
      previewWith({
        continuations: [
          {
            ...previewWith().continuations[0],
            lines: [
              { bookingItemId: "bi-storm", name: "Aputure STORM 400x", quantity: 2, billedShifts: 1, lineSum: "8000", afterDiscount: "4000", negotiated: false },
            ],
          },
        ],
      }),
    );
    mockState = stateWith(
      [{ ...countItem("bi-storm", "Aputure STORM 400x", 2), category: "Свет" }, countItem("bi-stand", "Стойка C-Stand", 6)],
      {
        plannedStays: [{ bookingItemId: "bi-storm", until: paidFuture, quantity: 2, unitIds: [] }],
        linePaidThrough: { "bi-storm": paidFuture, "bi-stand": paidFuture },
      },
    );
    render(<ReturnChecklist sessionId="s1" projectName="ZZ" onBack={() => {}} />);
    const block = await screen.findByTestId("planned-stay");
    expect(within(block).getByText(/без доплаты/)).toBeInTheDocument();
    fireEvent.click(within(block).getByRole("radio", { name: "+1 смена" }));
    await waitFor(() => expect(previewSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(block).toHaveTextContent(/2 шт × 1 смена → 4\s000\s₽/));
    // У строки «по плану» своего «Остаётся у клиента…» нет — она уже остаётся.
    expect(screen.queryByRole("button", { name: "Остаётся у клиента: Aputure STORM 400x" })).toBeNull();
    await finish();
    await waitFor(() => expect(completeSpy).toHaveBeenCalledTimes(1));
    const [, payload] = completeSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.stays).toEqual([
      { bookingItemId: "bi-storm", quantity: 2, until: new Date(Date.parse(paidFuture) + SHIFT).toISOString() },
    ]);
  });

  it("старый сервер без linePaidThrough — ссылки «Остаётся у клиента…» нет", async () => {
    mockState = stateWith([countItem("bi-stand", "Стойка C-Stand", 6)]);
    render(<ReturnChecklist sessionId="s1" projectName="ZZ" onBack={() => {}} />);
    await screen.findByRole("button", { name: /Принять всё разом/ });
    expect(screen.queryByRole("button", { name: /Остаётся у клиента/ })).toBeNull();
  });
});
