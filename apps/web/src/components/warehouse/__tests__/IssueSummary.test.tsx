import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChecklistState, SummaryResult } from "../types";
import type { UseScanSessionResult } from "../useScanSession";

const checkSpy = vi.fn(async () => {});
const uncheckSpy = vi.fn(async () => {});
const openSessionSpy = vi.fn(async () => {});
const refreshSpy = vi.fn(async () => {});

let mockState: ChecklistState | null = null;

vi.mock("../useScanSession", () => ({
  useScanSession: (): Partial<UseScanSessionResult> => ({
    state: mockState,
    loading: false,
    error: null,
    openSession: openSessionSpy,
    check: checkSpy,
    uncheck: uncheckSpy,
    refresh: refreshSpy,
  }),
}));

// Stub AddonSearch — not exercised in these tests.
vi.mock("../AddonSearch", () => ({
  AddonSearch: () => null,
}));

// Spy on the api client used for getSummary.
const summarySpy = vi.fn<(sessionId: string) => Promise<SummaryResult>>();
vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    scanApi: {
      ...actual.scanApi,
      getSummary: (sessionId: string) => summarySpy(sessionId),
    },
  };
});

import { IssueChecklist } from "../IssueChecklist";

function state(): ChecklistState {
  return {
    sessionId: "s1",
    bookingId: "b1",
    operation: "ISSUE",
    items: [
      {
        bookingItemId: "bi-1",
        equipmentId: "eq1",
        equipmentName: "Aputure 600D",
        category: "Свет",
        quantity: 3,
        checkedQty: 0,
        trackingMode: "UNIT",
        isExtra: false,
        units: [
          { unitId: "u1", barcode: null, checked: true, problemType: null },
          { unitId: "u2", barcode: null, checked: true, problemType: null },
          { unitId: "u3", barcode: null, checked: false, problemType: null },
        ],
      },
      {
        bookingItemId: "bi-2",
        equipmentId: "eq2",
        equipmentName: "Manfrotto 1004",
        category: "Стойки",
        quantity: 4,
        checkedQty: 0,
        trackingMode: "UNIT",
        isExtra: false,
        units: [
          { unitId: "u4", barcode: null, checked: true, problemType: null },
          { unitId: "u5", barcode: null, checked: true, problemType: null },
          { unitId: "u6", barcode: null, checked: false, problemType: null },
          { unitId: "u7", barcode: null, checked: false, problemType: null },
        ],
      },
      {
        bookingItemId: "bi-3",
        equipmentId: "eq3",
        equipmentName: "Astera Titan Tube",
        category: "Свет",
        quantity: 1,
        checkedQty: 0,
        trackingMode: "UNIT",
        isExtra: true, // ← добор
        units: [
          { unitId: "u8", barcode: null, checked: true, problemType: null },
        ],
      },
    ],
    progress: { checkedItems: 5, totalItems: 8 },
  };
}

function defaultSummary(over: Partial<SummaryResult> = {}): SummaryResult {
  return {
    sessionId: "s1",
    operation: "ISSUE",
    scannedCount: 5,
    expectedCount: 7,
    missingItems: [],
    substitutedItems: [],
    reservedButUnavailable: [
      {
        equipmentUnitId: "u9",
        equipmentName: "SkyPanel S60",
        ordinalLabel: "прибор 2 из 2",
        status: "MAINTENANCE",
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockState = state();
  summarySpy.mockResolvedValue(defaultSummary());
});

describe("IssueChecklist · Сверка phase", () => {
  it("opens the сверка screen when «Завершить выдачу» is pressed, fetching getSummary", async () => {
    render(<IssueChecklist sessionId="s1" projectName="Орбита" onBack={() => {}} />);

    const finish = await screen.findByRole("button", { name: /Завершить выдачу/ });
    finish.click();

    // The сверка header / badge becomes visible; checklist disappears.
    expect(
      await screen.findByText(/Готово к выдаче/),
    ).toBeInTheDocument();
    expect(summarySpy).toHaveBeenCalledWith("s1");
  });

  it("computes the emerald «Готово к выдаче» count from issued units + count lines", async () => {
    render(<IssueChecklist sessionId="s1" projectName="Орбита" onBack={() => {}} />);
    (await screen.findByRole("button", { name: /Завершить выдачу/ })).click();

    // 5 issued units (u1,u2,u4,u5,u8) + 0 count lines = 5.
    const badge = await screen.findByText(/Готово к выдаче/);
    const badgeBlock = badge.parentElement as HTMLElement;
    expect(badgeBlock.textContent || "").toMatch(/\b5\b/);
  });

  it("'из M в брони' uses unit count, not BookingItem count (no «4 из 3» misread)", async () => {
    // Fixture state: two NON-extra UNIT items with 3+4 units = 7 reservable
    // unit-rows; plus one extra UNIT добор of 1 unit (not counted into M).
    // Old formula `state.items.filter(!isExtra).length` would give M=2 (just
    // the two non-extra BookingItem objects), which reads as «… из 2 в брони»
    // — semantically wrong against the mock «из 26 в брони» which counts
    // every reservable row.
    render(<IssueChecklist sessionId="s1" projectName="Орбита" onBack={() => {}} />);
    (await screen.findByRole("button", { name: /Завершить выдачу/ })).click();

    const badge = await screen.findByText(/Готово к выдаче/);
    const badgeBlock = badge.parentElement as HTMLElement;
    expect(badgeBlock.textContent || "").toMatch(/из\s+7\s+в брони/);
  });

  it("expands the «⚠ Без отметки» row with the first matching units", async () => {
    render(<IssueChecklist sessionId="s1" projectName="Орбита" onBack={() => {}} />);
    (await screen.findByRole("button", { name: /Завершить выдачу/ })).click();

    // u3 (Aputure 600D · прибор 3 из 3), u6 (Manfrotto · прибор 3 из 4),
    // u7 (Manfrotto · прибор 4 из 4) — 3 untouched.
    await screen.findByText(/Без отметки/);
    expect(
      screen.getByText(/Aputure 600D · прибор 3 из 3/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Manfrotto 1004 · прибор 3 из 4/),
    ).toBeInTheDocument();
  });

  it("expands «⛔ Резерв недоступен» with the SkyPanel S60 line and a status suffix", async () => {
    render(<IssueChecklist sessionId="s1" projectName="Орбита" onBack={() => {}} />);
    (await screen.findByRole("button", { name: /Завершить выдачу/ })).click();

    await screen.findByText(/Резерв недоступен/);
    expect(
      screen.getByText(/SkyPanel S60 · прибор 2 из 2/),
    ).toBeInTheDocument();
    // MAINTENANCE → human suffix «в ремонте».
    expect(screen.getByText(/в ремонте/)).toBeInTheDocument();
  });

  it("«← К чек-листу» returns to the checklist phase with state preserved", async () => {
    render(<IssueChecklist sessionId="s1" projectName="Орбита" onBack={() => {}} />);
    (await screen.findByRole("button", { name: /Завершить выдачу/ })).click();
    await screen.findByText(/Готово к выдаче/);

    const back = screen.getByRole("button", { name: /К чек-листу/ });
    back.click();

    // Сверка hidden, checklist visible again — and the u1 segment is still ✓
    // (state preserved across the round-trip).
    await waitFor(() =>
      expect(screen.queryByText(/Готово к выдаче/)).not.toBeInTheDocument(),
    );
    const issued = screen.getByRole("button", {
      name: /Aputure 600D \(прибор 1 из 3\) — отметить выданным/,
    });
    expect(issued).toHaveAttribute("aria-pressed", "true");
  });

  it("soft-warn: «Без отметки»/«Резерв недоступен» do NOT disable «Подтвердить выдачу»", async () => {
    render(<IssueChecklist sessionId="s1" projectName="Орбита" onBack={() => {}} />);
    (await screen.findByRole("button", { name: /Завершить выдачу/ })).click();
    await screen.findByText(/Готово к выдаче/);

    const confirm = screen.getByRole("button", {
      name: /Подтвердить выдачу/,
    });
    expect(confirm).not.toBeDisabled();
  });

  it("«Подтвердить выдачу» POSTs /complete and renders the emerald result on success", async () => {
    const completeSpy = vi.fn().mockResolvedValue({
      sessionId: "s1",
      operation: "ISSUE",
      scannedCount: 5,
      expectedCount: 7,
      missingItems: [],
      substitutedItems: [{ id: "u8", name: "Astera Titan Tube", barcode: "X" }],
      reservedButUnavailable: [],
      createdRepairIds: [],
      failedBrokenUnits: [],
      createdProblemItemIds: [],
      failedProblemUnits: [],
    });
    const apiMod = await import("../api");
    // @ts-expect-error — override the read-only `as const` object for the test.
    apiMod.scanApi.complete = completeSpy;

    render(<IssueChecklist sessionId="s1" projectName="Орбита" onBack={() => {}} />);
    (await screen.findByRole("button", { name: /Завершить выдачу/ })).click();
    await screen.findByText(/Готово к выдаче/);
    (
      await screen.findByRole("button", { name: /Подтвердить выдачу/ })
    ).click();

    // POST happened with empty body.
    await waitFor(() => expect(completeSpy).toHaveBeenCalledWith("s1", {}));
    // Emerald result header.
    expect(await screen.findByText("Выдача оформлена")).toBeInTheDocument();
    // info-block visible.
    expect(
      screen.getByText(/Бронь переведена в «Выдана»/),
    ).toBeInTheDocument();
  });

  it("network failure on submit keeps the сверка visible with a rose alert + retry", async () => {
    const apiMod = await import("../api");
    // @ts-expect-error — see above
    apiMod.scanApi.complete = vi.fn().mockRejectedValue({
      status: 500,
      message: "boom",
      code: null,
      details: null,
    });

    render(<IssueChecklist sessionId="s1" projectName="Орбита" onBack={() => {}} />);
    (await screen.findByRole("button", { name: /Завершить выдачу/ })).click();
    await screen.findByText(/Готово к выдаче/);
    (
      await screen.findByRole("button", { name: /Подтвердить выдачу/ })
    ).click();

    expect(
      await screen.findByText(/Не получилось завершить выдачу: boom/),
    ).toBeInTheDocument();
    // Сверка is still visible and «Подтвердить» is re-enabled.
    expect(screen.getByText(/Готово к выдаче/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Подтвердить выдачу/ }),
    ).not.toBeDisabled();
  });
});
