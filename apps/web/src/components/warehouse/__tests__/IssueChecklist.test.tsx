import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChecklistState, CompleteResult } from "../types";
import type { UseScanSessionResult } from "../useScanSession";

// ── Mock useScanSession ──────────────────────────────────────────────────────
// The real hook makes network calls; here we drive `state` directly. The
// post-Task-14 UX doesn't issue per-row check/uncheck during stepping — every
// intent is held in local state and batched into /complete — so the spies
// stay defined for backward-compat assertions but should never fire from this
// component.

let mockState: ChecklistState | null = null;
let mockLoading = false;
let mockError: UseScanSessionResult["error"] = null;

const checkSpy = vi.fn(async () => {});
const uncheckSpy = vi.fn(async () => {});
const openSessionSpy = vi.fn(async () => {});
const refreshSpy = vi.fn(async () => {});

vi.mock("../useScanSession", () => ({
  useScanSession: (): Partial<UseScanSessionResult> => ({
    state: mockState,
    loading: mockLoading,
    error: mockError,
    openSession: openSessionSpy,
    check: checkSpy,
    uncheck: uncheckSpy,
    refresh: refreshSpy,
  }),
}));

// Stub AddonSearch — its full behaviour (debounced search, soft-warning,
// 409-race, existingEquipmentIds filter) is covered by AddonSearch.test.tsx.
// Here we only assert the IssueChecklist wiring: «+ Добор» mounts it with the
// expected props, and its `onAdded` triggers the session refresh.
vi.mock("../AddonSearch", () => ({
  AddonSearch: ({
    sessionId,
    bookingId,
    bookingNo,
    existingEquipmentIds,
    onAdded,
    onClose,
  }: {
    sessionId: string;
    bookingId: string;
    bookingNo?: string;
    existingEquipmentIds?: ReadonlySet<string>;
    onAdded: (bookingItemId: string, hadConflict: boolean) => void;
    onClose: () => void;
  }) => (
    <div data-testid="addon-search">
      <span>addon:{sessionId}</span>
      <span>bookingId:{bookingId}</span>
      <span>no:{bookingNo}</span>
      <span>
        existingIds:
        {existingEquipmentIds ? Array.from(existingEquipmentIds).sort().join(",") : ""}
      </span>
      <button type="button" onClick={() => onAdded("bi-added", false)}>
        stub-add
      </button>
      <button type="button" onClick={() => onAdded("bi-conflict", true)}>
        stub-add-conflict
      </button>
      <button type="button" onClick={onClose}>
        stub-close
      </button>
    </div>
  ),
}));

// Spy on the api client used for complete. We mock with hoisted vi.fn() refs
// so tests can drive `complete`'s resolution/rejection per-case.
const completeSpy = vi.fn();
vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    scanApi: {
      ...actual.scanApi,
      complete: (sessionId: string, payload: unknown) =>
        completeSpy(sessionId, payload),
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
        quantity: 2,
        checkedQty: 0,
        trackingMode: "UNIT",
        isExtra: false,
        rentalRatePerShift: "1000",
        originalQuantity: 2,
        addCap: 2,
        units: [
          { unitId: "u1", barcode: "LR-AP600-001", checked: false, problemType: null },
          { unitId: "u2", barcode: "LR-AP600-002", checked: false, problemType: null },
        ],
      },
      {
        bookingItemId: "bi-2",
        equipmentId: "eq2",
        equipmentName: "Manfrotto 1004",
        category: "Стойки",
        quantity: 4,
        checkedQty: 0,
        trackingMode: "COUNT",
        isExtra: false,
        rentalRatePerShift: "500",
        originalQuantity: 4,
        addCap: 1,
      },
    ],
    progress: { checkedItems: 0, totalItems: 3 },
    shifts: 2,
    discountPercent: "0",
    mainOriginalAfterDiscount: "8000",
  };
}

function defaultCompleteResult(): CompleteResult {
  return {
    sessionId: "s1",
    operation: "ISSUE",
    scannedCount: 0,
    expectedCount: 0,
    missingItems: [],
    substitutedItems: [],
    reservedButUnavailable: [],
    mainAfterDiscount: "8000",
    mainOriginalAfterDiscount: "8000",
    addonAfterDiscount: "0",
    finalAmount: "8000",
    paymentStatus: "NOT_PAID",
    amountPaid: "0",
    createdRepairIds: [],
    failedBrokenUnits: [],
    createdProblemItemIds: [],
    failedProblemUnits: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockState = state();
  mockLoading = false;
  mockError = null;
  completeSpy.mockResolvedValue(defaultCompleteResult());
});

describe("IssueChecklist (Task 14 unbounded stepper + live finance)", () => {
  it("groups items by category and renders one stepper row per bookingItem (no barcodes, no per-unit ordinals)", async () => {
    const { container } = render(
      <IssueChecklist
        sessionId="s1"
        projectName="Реклама «Орбита»"
        onBack={() => {}}
      />,
    );

    expect(await screen.findByText("Свет")).toBeInTheDocument();
    expect(screen.getByText("Стойки")).toBeInTheDocument();

    // Eyebrows now read «было ×<originalQuantity>» — one per row.
    expect(screen.getAllByText(/было ×2/)).toHaveLength(1);
    expect(screen.getAllByText(/было ×4/)).toHaveLength(1);

    expect(
      screen.getAllByLabelText(/Количество к выдаче/),
    ).toHaveLength(2);

    // Never a barcode.
    expect(container.textContent || "").not.toMatch(/LR-[A-Z0-9]+-\d+/);
  });

  it("renders stepper with default N=bi.quantity on each row", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    const inputs = await screen.findAllByLabelText(/Количество к выдаче/);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toHaveValue(2);
    expect(inputs[1]).toHaveValue(4);
  });

  it("stepper does NOT render «/ M» visually — it shows just the number", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );
    const inputs = await screen.findAllByLabelText(/Количество к выдаче/);
    // No «/ 2» or «/ 4» literal next to the stepper (committed-state badges are gone).
    // The page-level progress chip (e.g. «0 / 2 выдано») is intentional and scoped
    // out of this assertion — we only care about the stepper row itself.
    for (const input of inputs) {
      const stepperBox = input.parentElement;
      expect(stepperBox?.textContent || "").not.toMatch(/\/\s*\d+/);
    }
  });

  it("plus enabled past originalQuantity (up to bi.quantity + addCap)", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    // bi-1: bi.quantity=2, addCap=2 → max = 4. Click + twice should reach 4.
    const plus = (await screen.findAllByLabelText(/Увеличить количество/))[0];
    expect(plus).not.toBeDisabled();
    fireEvent.click(plus);
    fireEvent.click(plus);
    const input = screen.getAllByLabelText(/Количество к выдаче/)[0];
    expect(input).toHaveValue(4);
    // At max, plus disabled.
    expect(plus).toBeDisabled();
    // One more click does nothing.
    fireEvent.click(plus);
    expect(input).toHaveValue(4);
  });

  it("plus disabled at bi.quantity + addCap (cannot exceed)", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    // bi-2: bi.quantity=4, addCap=1 → max = 5. Default value is 4.
    const inputs = await screen.findAllByLabelText(/Количество к выдаче/);
    const plus = screen.getAllByLabelText(/Увеличить количество/)[1];
    fireEvent.click(plus);
    expect(inputs[1]).toHaveValue(5);
    expect(plus).toBeDisabled();
  });

  it("minus disabled at 0", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    const minus = (await screen.findAllByLabelText(/Уменьшить количество/))[0];
    fireEvent.click(minus); // 2 → 1
    fireEvent.click(minus); // 1 → 0
    expect(minus).toBeDisabled();
    // The check/uncheck hook API is NOT touched while stepping.
    expect(checkSpy).not.toHaveBeenCalled();
    expect(uncheckSpy).not.toHaveBeenCalled();
  });

  it("shows «+X» emerald pill when N > originalQuantity (inline-добор)", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    const plus = (await screen.findAllByLabelText(/Увеличить количество/))[0];
    fireEvent.click(plus); // 2 → 3
    const pill = screen.getByLabelText(/Добавлено сверх 2: 1/);
    expect(pill).toBeInTheDocument();
    expect(pill.className).toMatch(/text-emerald/);
    expect(pill).toHaveTextContent("+1");
  });

  it("shows «−X» amber pill when N < originalQuantity (снято на выдаче)", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    const minus = (await screen.findAllByLabelText(/Уменьшить количество/))[0];
    fireEvent.click(minus); // 2 → 1
    const pill = screen.getByLabelText(/Снято от 2: 1/);
    expect(pill).toBeInTheDocument();
    expect(pill.className).toMatch(/text-amber/);
    expect(pill).toHaveTextContent("−1");
  });

  it("dims and strikes through the row when N = 0", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    const minus = (await screen.findAllByLabelText(/Уменьшить количество/))[0];
    fireEvent.click(minus); // 2 → 1
    fireEvent.click(minus); // 1 → 0
    // The row container gets opacity-60; the equipment name gets line-through.
    const name = screen.getByText("Aputure 600D");
    expect(name.parentElement?.className || "").toMatch(/line-through/);
  });

  it("renders the sticky live finance block with «Согласовано» from mainOriginalAfterDiscount", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    expect(await screen.findByText(/Согласовано/)).toBeInTheDocument();
    // 8000 ₽
    expect(screen.getAllByText(/8\s?000/).length).toBeGreaterThan(0);
  });

  it("live finance shows «Дополнительно» line when intended > originalQuantity (rate*shifts*delta)", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    // Bump bi-1 by 1 → rate=1000, shifts=2 → addonActual=2000.
    const plus = (await screen.findAllByLabelText(/Увеличить количество/))[0];
    fireEvent.click(plus);

    expect(screen.getByText(/Дополнительно/)).toBeInTheDocument();
    expect(screen.getByText(/\+\s?2\s?000/)).toBeInTheDocument();
    // Итого = 8000 + 2000 = 10 000.
    expect(screen.getByText(/10\s?000/)).toBeInTheDocument();
  });

  it("live finance shows «Снято на выдаче» when intended < originalQuantity (rate*shifts*delta)", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    // Reduce bi-1 by 1 → rate=1000, shifts=2 → removalAmount=2000.
    const minus = (await screen.findAllByLabelText(/Уменьшить количество/))[0];
    fireEvent.click(minus);

    expect(screen.getByText(/Снято на выдаче/)).toBeInTheDocument();
    expect(screen.getByText(/−\s?2\s?000/)).toBeInTheDocument();
    // Итого = 8000 − 2000 = 6 000.
    expect(screen.getByText(/6\s?000/)).toBeInTheDocument();
  });

  it("renders «+ Добор» chip and «Готово, выдать» button", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="Орбита" onBack={() => {}} />,
    );

    expect(
      (await screen.findAllByRole("button", { name: /Добор/ })).length,
    ).toBeGreaterThanOrEqual(1);
    // Finalize button exists in either state: «Завершить (...)» when not all
    // marked, «✓ Готово, выдать →» when all marked.
    expect(
      screen.getByRole("button", { name: /Готово, выдать|Завершить выдачу/ }),
    ).toBeInTheDocument();
  });

  it("«Готово, выдать» submits ONLY differences as issuanceAdjustments", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    // bi-1: 2 → 1 (reduction). bi-2 left at 4 (unchanged).
    const minuses = await screen.findAllByLabelText(/Уменьшить количество/);
    fireEvent.click(minuses[0]);

    // Bump bi-2 + 1 → 5 (inline-добор).
    const plus = screen.getAllByLabelText(/Увеличить количество/)[1];
    fireEvent.click(plus);

    // Mark all rows «Выдано» so the finalize button switches to its
    // all-checked emerald state («✓ Готово, выдать →»).
    fireEvent.click(
      screen.getAllByRole("button", { name: /Отметить все позиции/ })[0],
    );

    fireEvent.click(screen.getByRole("button", { name: /Готово, выдать/ }));

    await waitFor(() => expect(completeSpy).toHaveBeenCalledTimes(1));
    const [callSessionId, callPayload] = completeSpy.mock.calls[0] as [
      string,
      { issuanceAdjustments?: Array<{ bookingItemId: string; actualQuantity: number }> },
    ];
    expect(callSessionId).toBe("s1");
    expect(callPayload.issuanceAdjustments).toEqual(
      expect.arrayContaining([
        { bookingItemId: "bi-1", actualQuantity: 1 },
        { bookingItemId: "bi-2", actualQuantity: 5 },
      ]),
    );
    expect(callPayload.issuanceAdjustments).toHaveLength(2);
  });

  it("omits issuanceAdjustments when no row's intended differs from bi.quantity", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    // Need all rows marked «Выдано» so the finalize button switches to its
    // all-checked emerald «✓ Готово, выдать →» state.
    fireEvent.click(
      (await screen.findAllByRole("button", { name: /Отметить все позиции/ }))[0],
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Готово, выдать/ }),
    );

    await waitFor(() => expect(completeSpy).toHaveBeenCalledTimes(1));
    const [, callPayload] = completeSpy.mock.calls[0] as [
      string,
      { issuanceAdjustments?: Array<{ bookingItemId: string; actualQuantity: number }> },
    ];
    expect(callPayload.issuanceAdjustments ?? []).toEqual([]);
  });

  it("sends actualQuantity > bi.quantity for inline-добор (positive delta)", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    // bi-1: 2 → 3 → 4 (inline-добор of 2 above bi.quantity).
    const plus = (await screen.findAllByLabelText(/Увеличить количество/))[0];
    fireEvent.click(plus);
    fireEvent.click(plus);

    // Mark all rows «Выдано» so the finalize button is in the all-checked state.
    fireEvent.click(
      screen.getAllByRole("button", { name: /Отметить все позиции/ })[0],
    );

    fireEvent.click(screen.getByRole("button", { name: /Готово, выдать/ }));

    await waitFor(() => expect(completeSpy).toHaveBeenCalledTimes(1));
    const [, callPayload] = completeSpy.mock.calls[0] as [
      string,
      { issuanceAdjustments?: Array<{ bookingItemId: string; actualQuantity: number }> },
    ];
    expect(callPayload.issuanceAdjustments).toEqual([
      { bookingItemId: "bi-1", actualQuantity: 4 },
    ]);
  });

  it("on /complete success advances to result phase rendering IssueResultView", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );
    // Mark all «Выдано» first so we can match the all-checked finalize button.
    fireEvent.click(
      (await screen.findAllByRole("button", { name: /Отметить все позиции/ }))[0],
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Готово, выдать/ }),
    );
    expect(await screen.findByText("Выдача оформлена")).toBeInTheDocument();
  });

  it("surfaces 409 ADJUSTMENT_CONFLICTS_WITH_SCANS inline and resets conflicting row", async () => {
    completeSpy.mockRejectedValueOnce({
      status: 409,
      code: "ADJUSTMENT_CONFLICTS_WITH_SCANS",
      message: "Нельзя снять 1 шт: 3 единицы уже отсканированы",
      details: { bookingItemId: "bi-1", scannedCount: 3, requestedQuantity: 1 },
    });

    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    // Reduce bi-1 → 1, then mark all + submit.
    fireEvent.click(
      (await screen.findAllByLabelText(/Уменьшить количество/))[0],
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: /Отметить все позиции/ })[0],
    );
    fireEvent.click(screen.getByRole("button", { name: /Готово, выдать/ }));

    await waitFor(() =>
      expect(
        screen.getByText(/3 единицы уже отсканированы/),
      ).toBeInTheDocument(),
    );

    // The conflicting row's intended quantity is reset to bi.quantity (2).
    expect(screen.getAllByLabelText(/Количество к выдаче/)[0]).toHaveValue(2);
    // Still on checklist — finalize button (now in all-checked state) re-enabled.
    expect(
      screen.getByRole("button", { name: /Готово, выдать/ }),
    ).not.toBeDisabled();
  });

  it("surfaces 409 ADDON_OVER_STOCK inline and resets row that hit stock cap", async () => {
    completeSpy.mockRejectedValueOnce({
      status: 409,
      code: "ADDON_OVER_STOCK",
      message: "Не хватает на складе",
      details: { bookingItemId: "bi-1", addCap: 0, requested: 4 },
    });

    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    fireEvent.click(
      (await screen.findAllByLabelText(/Увеличить количество/))[0],
    );
    fireEvent.click(
      screen.getAllByLabelText(/Увеличить количество/)[0],
    );
    // Mark all rows «Выдано» so finalize button enters all-checked state.
    fireEvent.click(
      screen.getAllByRole("button", { name: /Отметить все позиции/ })[0],
    );
    fireEvent.click(screen.getByRole("button", { name: /Готово, выдать/ }));

    await waitFor(() =>
      expect(screen.getByText(/Не хватает на складе/)).toBeInTheDocument(),
    );
    expect(screen.getAllByLabelText(/Количество к выдаче/)[0]).toHaveValue(2);
  });

  it("network failure on submit keeps the checklist visible with a rose alert + retry", async () => {
    completeSpy.mockRejectedValueOnce({
      status: 500,
      message: "boom",
      code: null,
      details: null,
    });

    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    // Mark all rows «Выдано» so the finalize button switches to its
    // all-checked emerald «✓ Готово, выдать →» state.
    fireEvent.click(
      (await screen.findAllByRole("button", { name: /Отметить все позиции/ }))[0],
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Готово, выдать/ }),
    );

    expect(
      await screen.findByText(/Не получилось завершить выдачу: boom/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Готово, выдать/ }),
    ).not.toBeDisabled();
  });

  it("shows the loading skeleton while state is null and loading", async () => {
    mockState = null;
    mockLoading = true;
    const { container } = render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(
      0,
    );
  });

  it("shows an empty state when the booking has no items", async () => {
    mockState = { ...state(), items: [] };
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );
    expect(
      await screen.findByText(/нет позиций для выдачи/),
    ).toBeInTheDocument();
  });

  it("«+ Добор» opens AddonSearch with sessionId, bookingId, existingEquipmentIds", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    expect(screen.queryByTestId("addon-search")).not.toBeInTheDocument();

    const dobor = (
      await screen.findAllByRole("button", { name: /Добор/ })
    )[0];
    dobor.click();

    const panel = await screen.findByTestId("addon-search");
    expect(panel).toBeInTheDocument();
    expect(screen.getByText("addon:s1")).toBeInTheDocument();
    expect(screen.getByText("bookingId:b1")).toBeInTheDocument();
    expect(screen.getByText("no:#B1")).toBeInTheDocument();
    // Both equipment ids in the fixture flow to AddonSearch for filtering.
    expect(screen.getByText("existingIds:eq1,eq2")).toBeInTheDocument();
  });

  it("AddonSearch onAdded triggers the session refresh; onClose hides it", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    (await screen.findAllByRole("button", { name: /Добор/ }))[0].click();
    await screen.findByTestId("addon-search");

    screen.getByRole("button", { name: "stub-add" }).click();
    await waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(1));

    screen.getByRole("button", { name: "stub-close" }).click();
    await waitFor(() =>
      expect(screen.queryByTestId("addon-search")).not.toBeInTheDocument(),
    );
  });

  it("AddonSearch onAdded(_, true) surfaces an audit hint for conflict доборы", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    (await screen.findAllByRole("button", { name: /Добор/ }))[0].click();
    await screen.findByTestId("addon-search");
    screen.getByRole("button", { name: "stub-add-conflict" }).click();

    await waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText(/добавлен с конфликтом/),
    ).toBeInTheDocument();
  });

  it("live finance applies discount: discountPercent=50 halves both main and addon contributions", async () => {
    // Use a custom state with discount=50.
    mockState = {
      ...state(),
      discountPercent: "50",
      mainOriginalAfterDiscount: "4000", // 8000 * 0.5
    };
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    // bi-1 + 1 → addon rate=1000, shifts=2, discount=50% → +1000.
    const plus = (await screen.findAllByLabelText(/Увеличить количество/))[0];
    fireEvent.click(plus);

    expect(screen.getByText(/Дополнительно/)).toBeInTheDocument();
    expect(screen.getByText(/\+\s?1\s?000/)).toBeInTheDocument();
  });

  it("originalQuantity=0 (prior-session добор): any positive intent counts as addon", async () => {
    mockState = {
      ...state(),
      items: [
        {
          bookingItemId: "bi-x",
          equipmentId: "eq-x",
          equipmentName: "Prior Добор",
          category: "Свет",
          quantity: 1,
          checkedQty: 0,
          trackingMode: "COUNT",
          isExtra: false,
          rentalRatePerShift: "500",
          originalQuantity: 0,
          addCap: 5,
        },
      ],
      mainOriginalAfterDiscount: "0",
    };
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    // intended starts at bi.quantity=1; refQty=bi.quantity → diff=0, no pill.
    expect(screen.queryByLabelText(/Добавлено сверх/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Снято от/)).not.toBeInTheDocument();

    // Bump + 1 → intended=2 > originalQuantity=0 → addon portion is intended-0=2.
    fireEvent.click(screen.getByLabelText(/Увеличить количество/));
    expect(screen.getByText(/Дополнительно/)).toBeInTheDocument();
    // 500 * 2 * 2 = 2000
    expect(screen.getByText(/\+\s?2\s?000/)).toBeInTheDocument();
  });

  // ── Post-Task-14.1 per-row «Выдать» check-toggle UX ─────────────────────────

  it("each row has a «Выдать» check-toggle button", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    // Two rows in the fixture (Aputure 600D, Manfrotto 1004) → two toggles.
    const toggles = await screen.findAllByRole("button", {
      name: /Отметить «Выдано»/,
    });
    expect(toggles).toHaveLength(2);
    for (const toggle of toggles) {
      expect(toggle).toHaveAttribute("aria-pressed", "false");
      expect(toggle).toHaveTextContent(/^Выдать$/);
    }
  });

  it("clicking a row's «Выдать» turns it into «✓ Выдано» (aria-pressed=true) and tints the row", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    const aputureToggle = await screen.findByRole("button", {
      name: /Отметить «Выдано» — Aputure 600D/,
    });
    expect(aputureToggle).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(aputureToggle);

    // After the click, the same button switches to its checked label.
    const checkedToggle = screen.getByRole("button", {
      name: /Снять отметку «Выдано» — Aputure 600D/,
    });
    expect(checkedToggle).toHaveAttribute("aria-pressed", "true");
    expect(checkedToggle).toHaveTextContent(/Выдано/);

    // The row container (toggle's grandparent — wraps stepper + toggle) picks
    // up the emerald border + soft tint when checked.
    const rowContainer = checkedToggle.closest("div.flex.flex-wrap");
    expect(rowContainer?.className || "").toMatch(/emerald/);

    // The other row stays untouched.
    const manfrottoToggle = screen.getByRole("button", {
      name: /Отметить «Выдано» — Manfrotto 1004/,
    });
    expect(manfrottoToggle).toHaveAttribute("aria-pressed", "false");
  });

  it("bulk «✓ Все выдано» button marks every row at once", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    // Initially none are marked.
    const initialToggles = await screen.findAllByRole("button", {
      name: /Отметить «Выдано»/,
    });
    expect(initialToggles).toHaveLength(2);

    // Click the bulk «✓ Все выдано» button (desktop variant is the first).
    fireEvent.click(
      screen.getAllByRole("button", {
        name: "Отметить все позиции как «Выдано»",
      })[0],
    );

    // Both per-row toggles now show their checked label.
    const checkedToggles = screen.getAllByRole("button", {
      name: /Снять отметку «Выдано»/,
    });
    expect(checkedToggles).toHaveLength(2);
    for (const toggle of checkedToggles) {
      expect(toggle).toHaveAttribute("aria-pressed", "true");
    }

    // The bulk button flipped into «Снять все отметки» mode.
    expect(
      screen.getByRole("button", { name: "Снять все отметки «Выдано»" }),
    ).toBeInTheDocument();
  });

  it("finalize button label is «Завершить (отмечено N из M)» when not all rows marked; «✓ Готово, выдать» when all marked", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    // ── Phase A: nothing checked → amber «Завершить» state. ────────────────
    const initialFinalize = await screen.findByRole("button", {
      name: /Завершить выдачу/,
    });
    expect(initialFinalize).toHaveTextContent(/Завершить \(отмечено 0 из 2\)/);
    expect(initialFinalize.className).toMatch(/bg-amber/);

    // ── Phase B: one row checked → still amber, label updates to «1 из 2». ──
    fireEvent.click(
      screen.getByRole("button", {
        name: /Отметить «Выдано» — Aputure 600D/,
      }),
    );
    const partialFinalize = screen.getByRole("button", {
      name: /Завершить выдачу/,
    });
    expect(partialFinalize).toHaveTextContent(/Завершить \(отмечено 1 из 2\)/);
    expect(partialFinalize.className).toMatch(/bg-amber/);

    // ── Phase C: all rows checked → emerald «✓ Готово, выдать →». ──────────
    fireEvent.click(
      screen.getByRole("button", {
        name: /Отметить «Выдано» — Manfrotto 1004/,
      }),
    );
    const finalFinalize = screen.getByRole("button", {
      name: /Готово, выдать/,
    });
    expect(finalFinalize).toHaveTextContent(/✓ Готово, выдать/);
    expect(finalFinalize.className).toMatch(/bg-emerald/);
    expect(finalFinalize.className).not.toMatch(/bg-amber/);
  });
});
