/**
 * «Остаётся у клиента» на приёмке в киоске (этап 15, мокап M3): оставленное
 * уходит из чек-листа в `stays`; сверх оплаченного — превью доплаты; позиция
 * нужна другой брони — «Завершить» ждёт «Оставить под ответственность».
 */
import { render, screen, waitFor, fireEvent, act, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChecklistState, CompleteResult } from "../types";
import { fromWhen, type KioskStaysPreview } from "../kioskStays";
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
const saveDraftSpy = vi.fn(async (..._args: unknown[]) => ({ revision: 1, savedAt: new Date().toISOString() }));
vi.mock("../api", () => ({
  scanApi: {
    complete: (...args: unknown[]) => completeSpy(...args),
    staysPreview: (...args: unknown[]) => previewSpy(...args),
    listSessionVehicles: async () => [],
    listPhotos: async () => ({ photos: [] }),
    saveDraft: (...args: unknown[]) => saveDraftSpy(...args),
    cancel: vi.fn(async () => ({ cancelled: true })),
    getWarehouseToken: () => null,
  },
}));

import { ReturnChecklist } from "../ReturnChecklist";
import { formatStayWhen } from "../PlannedStaysBlock";

const HOUR = 3_600_000;
const NO_PROBLEM = { reason: null, comment: "", expectedBackDate: null };
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
        subtotal: "800",
        discountAmount: "400",
        expectedPaymentDate: null,
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
            equipmentId: "eq-bi-stand",
            until: new Date(Date.now() + SHIFT).toISOString(),
            needed: 1,
            available: 0,
            from: new Date(Date.now() + 10 * HOUR).toISOString(),
            holder: { bookingId: "b-other", projectName: "Клип Север", clientName: "Иванов", from: new Date(Date.now() + 10 * HOUR).toISOString() },
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

  it("карточка держателя — с начала его брони; другой срок — «под ответственность» заново", async () => {
    const neededFrom = new Date(Date.now() + 30 * HOUR).toISOString();
    previewSpy.mockResolvedValue(
      previewWith({
        conflicts: [
          {
            bookingItemId: "bi-stand",
            name: "Стойка C-Stand",
            equipmentId: "eq-bi-stand",
            until: new Date(Date.now() + SHIFT).toISOString(),
            needed: 1,
            available: 0,
            from: new Date(Date.now() + HOUR).toISOString(),
            neededFrom,
            holder: { bookingId: "b-other", projectName: "Клип Север", clientName: null, from: new Date(Date.now() + 10 * HOUR).toISOString() },
          },
        ],
      }),
    );
    mockState = stateWith([countItem("bi-stand", "Стойка C-Stand", 6)], { linePaidThrough: { "bi-stand": paidPast } });
    render(<ReturnChecklist sessionId="s1" projectName="ZZ" onBack={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Остаётся у клиента: Стойка C-Stand" }));
    const holder = await screen.findByRole("group", { name: "Нужен другой брони: Стойка C-Stand" });
    expect(holder).toHaveTextContent(fromWhen(formatStayWhen(neededFrom)));
    fireEvent.click(within(holder).getByRole("button", { name: "Оставить под ответственность" }));
    expect(within(holder).getByRole("button", { name: "✓ Под ответственность" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("radio", { name: "+2 смены" }));
    const again = await screen.findByRole("group", { name: "Нужен другой брони: Стойка C-Stand" });
    expect(within(again).getByRole("button", { name: "Оставить под ответственность" })).toHaveAttribute("aria-pressed", "false");
  });

  it("«Завершить» получил 409 — позицию заняли: превью пересчитано, видна карточка держателя", async () => {
    let conflictNow = false;
    previewSpy.mockImplementation(async () =>
      conflictNow
        ? previewWith({
            conflicts: [
              {
                bookingItemId: "bi-stand",
                name: "Стойка C-Stand",
                equipmentId: "eq-bi-stand",
                until: new Date(Date.now() + SHIFT).toISOString(),
                needed: 1,
                available: 0,
                from: new Date(Date.now() + HOUR).toISOString(),
                holder: { bookingId: "b-other", projectName: "Клип Север", clientName: null, from: new Date(Date.now() + 10 * HOUR).toISOString() },
              },
            ],
          })
        : previewWith(),
    );
    completeSpy.mockImplementation(async () => {
      conflictNow = true;
      throw Object.assign(new Error("Позиция «Стойка C-Stand» нужна брони «Клип Север»"), { code: "CONTINUATION_CONFLICT", status: 409 });
    });
    mockState = stateWith([countItem("bi-stand", "Стойка C-Stand", 6)], { linePaidThrough: { "bi-stand": paidPast } });
    render(<ReturnChecklist sessionId="s1" projectName="ZZ" onBack={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Остаётся у клиента: Стойка C-Stand" }));
    await waitFor(() => expect(previewSpy).toHaveBeenCalledTimes(1));
    await wait(30);
    await finish();
    await waitFor(() => expect(completeSpy).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/нужна брони «Клип Север»/)).toBeInTheDocument();
    expect(await screen.findByRole("group", { name: "Нужен другой брони: Стойка C-Stand" })).toBeInTheDocument();
    expect(previewSpy).toHaveBeenCalledTimes(2);
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

  it("итог: продолжение с дополнительной сметой называет доплату, а не «уже оплачено»", async () => {
    completeSpy.mockResolvedValue({
      ...okResult(),
      continuations: [{ id: "c1", docNumber: "СМ-2026-0231-1", endDate: new Date(Date.now() + SHIFT).toISOString(), quantity: 1, finalAmount: "400.00" }],
    });
    mockState = stateWith([countItem("bi-stand", "Стойка C-Stand", 6)], { linePaidThrough: { "bi-stand": paidPast } });
    render(<ReturnChecklist sessionId="s1" projectName="ZZ" onBack={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Остаётся у клиента: Стойка C-Stand" }));
    await waitFor(() => expect(previewSpy).toHaveBeenCalledTimes(1));
    await wait(30);
    await finish();
    const block = await screen.findByTestId("result-continuations");
    expect(block).toHaveTextContent(/дополнительная смета 400\s₽/);
    expect(block).toHaveTextContent("оплачивают отдельно");
    expect(block).not.toHaveTextContent("Уже оплачено в основной смете");
  });

  it("ремонт в строке не теряется: скрывается принятое, потолок «остаётся» — без ремонта", async () => {
    mockState = stateWith([countItem("bi-stand", "Стойка C-Stand", 3)], {
      linePaidThrough: { "bi-stand": paidFuture },
      draft: {
        v: 1,
        return: {
          units: {},
          grids: {
            "bi-stand": {
              equipmentId: "eq-bi-stand",
              slots: [
                { status: "ACCEPTED", repairComment: "", problem: NO_PROBLEM },
                { status: "ACCEPTED", repairComment: "", problem: NO_PROBLEM },
                { status: "REPAIR", repairComment: "треснул барашек", problem: NO_PROBLEM },
              ],
            },
          },
        },
      },
    });
    render(<ReturnChecklist sessionId="s1" projectName="ZZ" onBack={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Остаётся у клиента: Стойка C-Stand" }));
    fireEvent.click(screen.getByRole("button", { name: "Больше остаётся: Стойка C-Stand" }));
    // Из трёх одна в ремонте — оставить можно не больше двух.
    expect(screen.getByRole("button", { name: "Больше остаётся: Стойка C-Stand" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Меньше остаётся: Стойка C-Stand" }));
    expect(screen.getByRole("button", { name: /юнит #3 — .*Тап циклит статус/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Завершить приёмку/ }));
    await waitFor(() => expect(completeSpy).toHaveBeenCalledTimes(1));
    const [, payload] = completeSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.repairUnits).toEqual([{ bookingItemId: "bi-stand", quantity: 1, comment: "треснул барашек" }]);
    expect(payload.stays).toEqual([{ bookingItemId: "bi-stand", quantity: 1, until: paidFuture }]);
  });

  it("штучная: единицу с отметкой ремонта оставить у клиента нельзя", async () => {
    mockState = stateWith(
      [
        {
          bookingItemId: "bi-lens",
          equipmentId: "eq-lens",
          equipmentName: "Объектив Cooke",
          category: "Оптика",
          quantity: 2,
          checkedQty: 0,
          trackingMode: "UNIT" as const,
          isExtra: false,
          rentalRatePerShift: "0",
          originalQuantity: 2,
          addCap: 0,
          units: [
            { unitId: "u1", barcode: null, checked: false, problemType: null },
            { unitId: "u2", barcode: null, checked: false, problemType: null },
          ],
        },
      ],
      {
        linePaidThrough: { "bi-lens": paidFuture },
        draft: { v: 1, return: { units: { u2: { outcome: "REPAIR", repairComment: "не держит фокус" } }, grids: {} } },
      },
    );
    render(<ReturnChecklist sessionId="s1" projectName="ZZ" onBack={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Остаётся у клиента: Объектив Cooke" }));
    expect(screen.getByRole("button", { name: "прибор 2 из 2" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "прибор 1 из 2" })).toBeEnabled();
  });

  it("всё осталось у клиента — экран не пропадает: «Не остаётся» и «Принять 0 ед.» на месте", async () => {
    mockState = stateWith([countItem("bi-stand", "Стойка C-Stand", 2)], { linePaidThrough: { "bi-stand": paidFuture } });
    render(<ReturnChecklist sessionId="s1" projectName="ZZ" onBack={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Остаётся у клиента: Стойка C-Stand" }));
    fireEvent.click(screen.getByRole("button", { name: "Больше остаётся: Стойка C-Stand" }));
    expect(screen.queryByText(/нет позиций для приёмки/)).toBeNull();
    expect(screen.getByText(/всё остаётся у клиента/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Не остаётся: Стойка C-Stand" })).toBeInTheDocument();
    const summary = screen.getByTestId("return-footer-summary");
    expect(summary).toHaveTextContent("Принимаем на склад0 ед.");
    expect(summary).toHaveTextContent("Остаются у клиента2 ед. · 1 позиция");
    fireEvent.click(screen.getByRole("button", { name: /Принять 0 ед\. — Завершить приёмку/ }));
    await waitFor(() => expect(completeSpy).toHaveBeenCalledTimes(1));
    const [, payload] = completeSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.stays).toEqual([{ bookingItemId: "bi-stand", quantity: 2, until: paidFuture }]);
  });

  it("итог «Принято» — без оставленного у клиента", async () => {
    mockState = stateWith([countItem("bi-stand", "Стойка C-Stand", 3)], { linePaidThrough: { "bi-stand": paidFuture } });
    render(<ReturnChecklist sessionId="s1" projectName="ZZ" onBack={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Принять всё разом/ }));
    await wait(30);
    fireEvent.click(screen.getByRole("button", { name: "Остаётся у клиента: Стойка C-Stand" }));
    fireEvent.click(screen.getByRole("button", { name: /Завершить приёмку/ }));
    const accepted = (await screen.findByText("Принято")).closest("div")!;
    expect(accepted).toHaveTextContent("Принято2");
  });

  it("«остаётся у клиента» уходит в черновик и восстанавливается после перезагрузки", async () => {
    mockState = stateWith([countItem("bi-stand", "Стойка C-Stand", 6)], { linePaidThrough: { "bi-stand": paidFuture }, draftRevision: 0 });
    const { unmount } = render(<ReturnChecklist sessionId="s1" projectName="ZZ" onBack={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Остаётся у клиента: Стойка C-Stand" }));
    await waitFor(() => expect(saveDraftSpy).toHaveBeenCalled(), { timeout: 3000 });
    const draft = saveDraftSpy.mock.calls.at(-1)![2] as { return: { stays: Record<string, unknown> } };
    expect(draft.return.stays["bi-stand"]).toMatchObject({ quantity: 1, until: paidFuture, choice: "paid" });
    unmount();

    mockState = stateWith([countItem("bi-stand", "Стойка C-Stand", 6)], {
      linePaidThrough: { "bi-stand": paidFuture },
      draft: draft as unknown as ChecklistState["draft"],
      draftRevision: 1,
    });
    render(<ReturnChecklist sessionId="s1" projectName="ZZ" onBack={() => {}} />);
    expect(await screen.findByTestId("kiosk-stay")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Принять все 5 шт «Стойка C-Stand» без замечаний" })).toBeInTheDocument();
  });

  it("сняли «остаётся» — старое превью с держателем «Завершить» не держит", async () => {
    previewSpy.mockResolvedValue(
      previewWith({
        conflicts: [
          {
            bookingItemId: "bi-stand",
            name: "Стойка C-Stand",
            equipmentId: "eq-bi-stand",
            until: new Date(Date.now() + SHIFT).toISOString(),
            needed: 1,
            available: 0,
            from: new Date(Date.now() + HOUR).toISOString(),
            holder: null,
          },
        ],
      }),
    );
    mockState = stateWith([countItem("bi-stand", "Стойка C-Stand", 6)], { linePaidThrough: { "bi-stand": paidPast } });
    render(<ReturnChecklist sessionId="s1" projectName="ZZ" onBack={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Остаётся у клиента: Стойка C-Stand" }));
    await screen.findByRole("group", { name: "Нужен другой брони: Стойка C-Stand" });
    fireEvent.click(screen.getByRole("button", { name: "Не остаётся: Стойка C-Stand" }));
    fireEvent.click(screen.getByRole("button", { name: /Принять всё разом/ }));
    await wait(30);
    fireEvent.click(screen.getByRole("button", { name: /Завершить приёмку/ }));
    await waitFor(() => expect(completeSpy).toHaveBeenCalledTimes(1));
  });

  it("409 при «Завершить», а превью не отвечает — карточка держателя из ответа сервера", async () => {
    previewSpy.mockRejectedValue(new Error("сеть"));
    completeSpy.mockRejectedValue(
      Object.assign(new Error("Позиция «Стойка C-Stand» нужна брони «Клип Север»"), {
        code: "CONTINUATION_CONFLICT",
        status: 409,
        details: {
          conflicts: [
            {
              bookingItemId: "bi-stand",
              name: "Стойка C-Stand",
              equipmentId: "eq-bi-stand",
              until: new Date(Date.now() + SHIFT).toISOString(),
              needed: 1,
              available: 0,
              from: new Date(Date.now() + HOUR).toISOString(),
              holder: { bookingId: "b-other", projectName: "Клип Север", clientName: null, from: new Date(Date.now() + 10 * HOUR).toISOString() },
            },
          ],
        },
      }),
    );
    mockState = stateWith([countItem("bi-stand", "Стойка C-Stand", 6)], { linePaidThrough: { "bi-stand": paidPast } });
    render(<ReturnChecklist sessionId="s1" projectName="ZZ" onBack={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Остаётся у клиента: Стойка C-Stand" }));
    await waitFor(() => expect(previewSpy).toHaveBeenCalled());
    await wait(30);
    await finish();
    const holder = await screen.findByRole("group", { name: "Нужен другой брони: Стойка C-Stand" });
    expect(within(holder).getByRole("button", { name: "Оставить под ответственность" })).toBeInTheDocument();
  });

  it("старый сервер без linePaidThrough — ссылки «Остаётся у клиента…» нет", async () => {
    mockState = stateWith([countItem("bi-stand", "Стойка C-Stand", 6)]);
    render(<ReturnChecklist sessionId="s1" projectName="ZZ" onBack={() => {}} />);
    await screen.findByRole("button", { name: /Принять всё разом/ });
    expect(screen.queryByRole("button", { name: /Остаётся у клиента/ })).toBeNull();
  });
});
