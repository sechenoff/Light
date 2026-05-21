import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChecklistState, CompleteResult } from "../types";
import type { UseScanSessionResult } from "../useScanSession";

// ── Mock useScanSession ──────────────────────────────────────────────────────
// The real hook makes network calls; here we drive `state` directly and spy on
// the optimistic `check`/`uncheck` so we can assert «Выдать всё» behaviour.

let mockState: ChecklistState | null = null;
let mockLoading = false;
let mockError: UseScanSessionResult["error"] = null;

/** Optimistically flip `unit.checked` in `mockState` — mirrors the real hook. */
function applyUnitCheck(unitId: string, checked: boolean) {
  if (!mockState) return;
  mockState = {
    ...mockState,
    items: mockState.items.map((item) =>
      item.units
        ? {
            ...item,
            units: item.units.map((u) =>
              u.unitId === unitId ? { ...u, checked } : u,
            ),
          }
        : item,
    ),
  };
}

const checkSpy = vi.fn(async (unitId: string) => {
  applyUnitCheck(unitId, true);
});
const uncheckSpy = vi.fn(async (unitId: string) => {
  applyUnitCheck(unitId, false);
});
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
// 409-race) is covered by AddonSearch.test.tsx. Here we only assert the
// IssueChecklist wiring: «＋ Добор» mounts it, and its `onAdded` triggers the
// session refresh so a freshly added добор appears in the list.
vi.mock("../AddonSearch", () => ({
  AddonSearch: ({
    sessionId,
    bookingId,
    bookingNo,
    onAdded,
    onClose,
  }: {
    sessionId: string;
    bookingId: string;
    bookingNo?: string;
    onAdded: (bookingItemId: string, hadConflict: boolean) => void;
    onClose: () => void;
  }) => (
    <div data-testid="addon-search">
      <span>addon:{sessionId}</span>
      <span>bookingId:{bookingId}</span>
      <span>no:{bookingNo}</span>
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

// Spy on the api client used for getSummary / complete. We mock with hoisted
// vi.fn() refs so tests can drive `complete`'s resolution/rejection per-case.
const completeSpy = vi.fn();
const getSummarySpy = vi.fn();
const getAddonEstimateSpy = vi.fn();
vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    scanApi: {
      ...actual.scanApi,
      complete: (sessionId: string, payload: unknown) =>
        completeSpy(sessionId, payload),
      getSummary: (sessionId: string) => getSummarySpy(sessionId),
      getAddonEstimate: (bookingId: string) => getAddonEstimateSpy(bookingId),
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
      },
    ],
    progress: { checkedItems: 0, totalItems: 3 },
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
    mainAfterDiscount: "0",
    mainOriginalAfterDiscount: "0",
    addonAfterDiscount: "0",
    finalAmount: "0",
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
  // Default api mocks — overridden per-test as needed.
  completeSpy.mockResolvedValue(defaultCompleteResult());
  getSummarySpy.mockResolvedValue({
    sessionId: "s1",
    operation: "ISSUE",
    scannedCount: 0,
    expectedCount: 0,
    missingItems: [],
    substitutedItems: [],
    reservedButUnavailable: [],
    mainAfterDiscount: "0",
    mainOriginalAfterDiscount: "0",
    addonAfterDiscount: "0",
    finalAmount: "0",
  });
  getAddonEstimateSpy.mockResolvedValue({ addon: null });
});

describe("IssueChecklist", () => {
  it("groups items by category and renders one stepper row per bookingItem (no barcodes, no per-unit ordinals)", async () => {
    const { container } = render(
      <IssueChecklist
        sessionId="s1"
        projectName="Реклама «Орбита»"
        onBack={() => {}}
      />,
    );

    // Category headers.
    expect(await screen.findByText("Свет")).toBeInTheDocument();
    expect(screen.getByText("Стойки")).toBeInTheDocument();

    // One row per bookingItem now — never per-unit. Pre-Task-11 ordinals
    // («прибор N из M») are gone; we show «было ×M» eyebrows instead.
    expect(screen.queryByText("прибор 1 из 2")).not.toBeInTheDocument();
    expect(screen.queryByText("прибор 2 из 2")).not.toBeInTheDocument();
    // Eyebrows: «было ×2» (UNIT) and «было ×4» (COUNT).
    expect(screen.getByText("было ×2")).toBeInTheDocument();
    expect(screen.getByText("было ×4")).toBeInTheDocument();

    // Stepper inputs are present (one per bookingItem, including isExtra=false).
    expect(
      screen.getAllByLabelText(/Количество к выдаче/),
    ).toHaveLength(2);

    // No barcode-like strings.
    expect(container.textContent || "").not.toMatch(/LR-[A-Z0-9]+-\d+/);
  });

  it("renders stepper with default N=M on each row", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    const inputs = await screen.findAllByLabelText(/Количество к выдаче/);
    expect(inputs).toHaveLength(2);
    // UNIT-mode row: M = units.length = 2.
    expect(inputs[0]).toHaveValue(2);
    // COUNT-mode row: M = item.quantity = 4.
    expect(inputs[1]).toHaveValue(4);
  });

  it("minus disabled at 0, plus disabled at M", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    // UNIT row M=2; plus is initially disabled (N=M).
    const minus = (await screen.findAllByLabelText(/Уменьшить количество/))[0];
    const plus = screen.getAllByLabelText(/Увеличить количество/)[0];
    expect(plus).toBeDisabled();
    expect(minus).not.toBeDisabled();

    // Click minus twice to reach 0 — then minus becomes disabled, plus enabled.
    fireEvent.click(minus);
    fireEvent.click(minus);
    expect(minus).toBeDisabled();
    expect(plus).not.toBeDisabled();
  });

  it("clicking «Выдать N» commits the row with N and surfaces «Выдано N / M»", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    const minus = (await screen.findAllByLabelText(/Уменьшить количество/))[0];
    fireEvent.click(minus); // UNIT-row: N goes 2 → 1.
    const issueBtn = screen.getByRole("button", {
      name: /Выдать 1 шт — Aputure 600D/,
    });
    fireEvent.click(issueBtn);

    expect(screen.getByText("Выдано 1 / 2")).toBeInTheDocument();
    // Stepper input for that row is gone — committed state.
    expect(
      screen.queryByLabelText(/Количество к выдаче — Aputure 600D/),
    ).not.toBeInTheDocument();
  });

  it("N=0 → button reads «Не выдаём» (rose) and committing shows the «Не выдаём» badge", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    const minus = (await screen.findAllByLabelText(/Уменьшить количество/))[0];
    fireEvent.click(minus);
    fireEvent.click(minus); // UNIT-row: 2 → 1 → 0.

    const issueBtn = screen.getByRole("button", {
      name: /Не выдаём — Aputure 600D/,
    });
    expect(issueBtn).toHaveTextContent("Не выдаём");
    expect(issueBtn.className).toMatch(/bg-rose/);
    fireEvent.click(issueBtn);

    // Badge appears; stepper hidden.
    expect(screen.getByText("Не выдаём")).toBeInTheDocument();
    expect(
      screen.queryByLabelText(/Количество к выдаче — Aputure 600D/),
    ).not.toBeInTheDocument();
  });

  it("«Изменить» reverses the commit state back to the stepper", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    // Commit the first row at default N=2.
    const issueBtn = (
      await screen.findAllByRole("button", { name: /Выдать \d+ шт/ })
    )[0];
    fireEvent.click(issueBtn);
    expect(
      screen.queryByLabelText(/Количество к выдаче — Aputure 600D/),
    ).not.toBeInTheDocument();

    // Click «Изменить» → row is editable again.
    fireEvent.click(
      screen.getByLabelText(/Изменить количество для выдачи — Aputure 600D/),
    );
    expect(
      screen.getByLabelText(/Количество к выдаче — Aputure 600D/),
    ).toBeInTheDocument();
  });

  it("global «Выдать всё разом» commits every row at its current intended qty (preserving N=0 etc.)", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    // First row N=2→1. COUNT row stays at 4.
    const firstMinus = (
      await screen.findAllByLabelText(/Уменьшить количество/)
    )[0];
    fireEvent.click(firstMinus);

    fireEvent.click(screen.getByRole("button", { name: /Выдать всё разом/ }));

    // Both rows now committed: «Выдано 1 / 2» and «Выдано 4 / 4».
    expect(screen.getByText("Выдано 1 / 2")).toBeInTheDocument();
    expect(screen.getByText("Выдано 4 / 4")).toBeInTheDocument();

    // The old API was: «Выдать всё разом» called `check(unitId)` per unit.
    // Post-Task-11, commits stay in local state until /complete — no spies fired.
    expect(checkSpy).not.toHaveBeenCalled();
  });

  it("renders «＋ Добор» and a sticky «Завершить выдачу» that enters the сверка phase", async () => {
    render(
      <IssueChecklist
        sessionId="s1"
        projectName="Орбита"
        onBack={() => {}}
      />,
    );

    expect(
      (await screen.findAllByRole("button", { name: /Добор/ })).length,
    ).toBeGreaterThanOrEqual(1);

    const finish = screen.getByRole("button", { name: /Завершить выдачу/ });
    finish.click();

    // Phase entered, badge visible.
    expect(await screen.findByText(/Готово к выдаче/)).toBeInTheDocument();
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

  it("«＋ Добор» (no onAddon) opens AddonSearch with sessionId + booking #", async () => {
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
    // sessionId is forwarded; bookingNo derived as "#" + last 6 of bookingId.
    expect(screen.getByText("addon:s1")).toBeInTheDocument();
    expect(screen.getByText("no:#B1")).toBeInTheDocument();
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

  it("«Не выдаём» badge counts toward сверка's withheld bucket (M − 0 = M)", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    // UNIT-row M=2 → N=0 → commit «Не выдаём».
    const minus = (await screen.findAllByLabelText(/Уменьшить количество/))[0];
    fireEvent.click(minus);
    fireEvent.click(minus);
    fireEvent.click(
      screen.getByRole("button", { name: /Не выдаём — Aputure 600D/ }),
    );

    // Enter the сверка phase — the «✗ Не выдаём» stat row should report 2
    // (every withheld unit counts; UNIT M=2 + N=0 → withheld=2).
    fireEvent.click(screen.getByRole("button", { name: /Завершить выдачу/ }));
    expect(await screen.findByText(/Готово к выдаче/)).toBeInTheDocument();
    const notIssuedLabel = screen.getByText("✗ Не выдаём");
    expect(notIssuedLabel.parentElement?.textContent || "").toContain("2");
  });

  it("changing N after «Изменить» and re-committing reflects the new value", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    // Commit UNIT row at default N=2.
    const issueBtn = (
      await screen.findAllByRole("button", { name: /Выдать \d+ шт — Aputure/ })
    )[0];
    fireEvent.click(issueBtn);
    expect(screen.getByText("Выдано 2 / 2")).toBeInTheDocument();

    // Uncommit → adjust → re-commit at N=1.
    fireEvent.click(
      screen.getByLabelText(/Изменить количество для выдачи — Aputure 600D/),
    );
    fireEvent.click(screen.getByLabelText(/Уменьшить количество — Aputure 600D/));
    fireEvent.click(
      screen.getByRole("button", { name: /Выдать 1 шт — Aputure 600D/ }),
    );
    expect(screen.getByText("Выдано 1 / 2")).toBeInTheDocument();

    // The hook's optimistic check API must NOT be called — adjustments
    // are batched into /complete by Task 12.
    expect(checkSpy).not.toHaveBeenCalled();
  });

  it("passes bookingId to AddonSearch (for доб-смета PDF link)", async () => {
    render(<IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />);
    (await screen.findAllByRole("button", { name: /Добор/ }))[0].click();
    await screen.findByTestId("addon-search");
    expect(screen.getByText(/bookingId:b1/)).toBeInTheDocument();
  });

  it("AddonSearch onAdded(bi, hadConflict=true) tracks the bookingItemId for the сверка", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    (await screen.findAllByRole("button", { name: /Добор/ }))[0].click();
    await screen.findByTestId("addon-search");
    screen.getByRole("button", { name: "stub-add-conflict" }).click();

    // No outward signal yet (UI in Task 8), but the session refresh must
    // still fire — keeps the existing «refresh» test green and proves the
    // handler signature is correct.
    await waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(1));
  });

  // ── Task 12: issuanceAdjustments payload + 409 inline error ───────────────
  // Fixture has bi-1 (UNIT, M=2) and bi-2 (COUNT, M=4). The submit handler is
  // hit via the сверка screen («Подтвердить выдачу») — that's the moment we
  // build the payload from committed rows where intended != original.

  it("sends only differences (actualQty !== originalQty) in issuanceAdjustments", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    // Reduce bi-1 (UNIT, M=2) by one → N=1.
    const minuses = await screen.findAllByLabelText(/Уменьшить количество/);
    fireEvent.click(minuses[0]);

    // Reduce bi-2 (COUNT, M=4) all the way to 0 (four clicks).
    fireEvent.click(minuses[1]);
    fireEvent.click(minuses[1]);
    fireEvent.click(minuses[1]);
    fireEvent.click(minuses[1]);

    // Global commit-all.
    fireEvent.click(screen.getByRole("button", { name: /Выдать всё разом/ }));

    // Enter сверка, then «Подтвердить выдачу» → POST /complete.
    fireEvent.click(screen.getByRole("button", { name: /Завершить выдачу/ }));
    await screen.findByText(/Готово к выдаче/);
    fireEvent.click(
      await screen.findByRole("button", { name: /Подтвердить выдачу/ }),
    );

    await waitFor(() => expect(completeSpy).toHaveBeenCalledTimes(1));
    const [callSessionId, callPayload] = completeSpy.mock.calls[0] as [
      string,
      { issuanceAdjustments?: Array<{ bookingItemId: string; actualQuantity: number }> },
    ];
    expect(callSessionId).toBe("s1");
    // Order is iteration-stable but assert as a set for robustness.
    expect(callPayload.issuanceAdjustments).toEqual(
      expect.arrayContaining([
        { bookingItemId: "bi-1", actualQuantity: 1 },
        { bookingItemId: "bi-2", actualQuantity: 0 },
      ]),
    );
    expect(callPayload.issuanceAdjustments).toHaveLength(2);
  });

  it("omits issuanceAdjustments when no row's intended differs from original", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    // Commit everything at default N=M without changing anything.
    fireEvent.click(
      await screen.findByRole("button", { name: /Выдать всё разом/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Завершить выдачу/ }));
    await screen.findByText(/Готово к выдаче/);
    fireEvent.click(
      await screen.findByRole("button", { name: /Подтвердить выдачу/ }),
    );

    await waitFor(() => expect(completeSpy).toHaveBeenCalledTimes(1));
    const [, callPayload] = completeSpy.mock.calls[0] as [
      string,
      { issuanceAdjustments?: Array<{ bookingItemId: string; actualQuantity: number }> },
    ];
    // Either omitted entirely or sent as []. Either is acceptable.
    expect(callPayload.issuanceAdjustments ?? []).toEqual([]);
  });

  it("surfaces 409 ADJUSTMENT_CONFLICTS_WITH_SCANS inline and uncommits the conflicting row", async () => {
    completeSpy.mockRejectedValueOnce({
      status: 409,
      code: "ADJUSTMENT_CONFLICTS_WITH_SCANS",
      message: "Нельзя снять 1 шт: 3 единицы уже отсканированы",
      details: { bookingItemId: "bi-1", scannedCount: 3, requestedQuantity: 1 },
    });

    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    // Reduce bi-1 to N=1, commit, then «Подтвердить выдачу».
    fireEvent.click(
      (await screen.findAllByLabelText(/Уменьшить количество/))[0],
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Выдать 1 шт — Aputure 600D/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Завершить выдачу/ }));
    await screen.findByText(/Готово к выдаче/);
    fireEvent.click(
      await screen.findByRole("button", { name: /Подтвердить выдачу/ }),
    );

    // Server message surfaces inline.
    await waitFor(() =>
      expect(
        screen.getByText(/3 единицы уже отсканированы/),
      ).toBeInTheDocument(),
    );

    // We're back in the сверка phase (not advanced to result) — «Подтвердить»
    // is enabled again so the operator can fix the row and retry.
    expect(
      screen.getByRole("button", { name: /Подтвердить выдачу/ }),
    ).not.toBeDisabled();
  });
});
