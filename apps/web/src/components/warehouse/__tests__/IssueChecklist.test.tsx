import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChecklistState } from "../types";
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
    bookingNo,
    onAdded,
    onClose,
  }: {
    sessionId: string;
    bookingNo?: string;
    onAdded: (bookingItemId: string, hadConflict: boolean) => void;
    onClose: () => void;
  }) => (
    <div data-testid="addon-search">
      <span>addon:{sessionId}</span>
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

beforeEach(() => {
  vi.clearAllMocks();
  mockState = state();
  mockLoading = false;
  mockError = null;
});

describe("IssueChecklist", () => {
  it("groups items by category and renders «прибор N из M», never barcodes", async () => {
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

    // UNIT ordinals «прибор N из M», COUNT «×N» — no barcode strings.
    expect(screen.getByText("прибор 1 из 2")).toBeInTheDocument();
    expect(screen.getByText("прибор 2 из 2")).toBeInTheDocument();
    expect(screen.getByText("×4")).toBeInTheDocument();
    expect(container.textContent || "").not.toMatch(/LR-[A-Z0-9]+-\d+/);
  });

  it("«Выдать всё разом» checks every not-yet-checked UNIT unit", async () => {
    render(
      <IssueChecklist
        sessionId="s1"
        projectName="P"
        onBack={() => {}}
      />,
    );

    const bulk = await screen.findByRole("button", {
      name: /Выдать всё разом/,
    });
    bulk.click();

    await waitFor(() => {
      expect(checkSpy).toHaveBeenCalledWith("u1");
      expect(checkSpy).toHaveBeenCalledWith("u2");
    });
    // Only the 2 UNIT units — COUNT has no unit ids server-side.
    expect(checkSpy).toHaveBeenCalledTimes(2);
  });

  it("disables all unit rows while «Выдать всё разом» is fanning out", async () => {
    // Hold `check` open so the `bulkBusy` window is observable.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    checkSpy.mockImplementationOnce(async () => {
      await gate;
    });

    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    const bulk = await screen.findByRole("button", {
      name: /Выдать всё разом/,
    });
    bulk.click();

    // While the fan-out is pending, every per-row segment is disabled
    // (consistent with the already-disabled bulk bar / footer).
    await waitFor(() => {
      const issued = screen.getByRole("button", {
        name: /Aputure 600D \(прибор 1 из 2\) — отметить выданным/,
      });
      expect(issued).toBeDisabled();
    });

    release();
    await waitFor(() => {
      const issued = screen.getByRole("button", {
        name: /Aputure 600D \(прибор 1 из 2\) — отметить выданным/,
      });
      expect(issued).not.toBeDisabled();
    });
  });

  it("toggling a UNIT row ✓ calls the hook's optimistic check", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    const issued = await screen.findByRole("button", {
      name: /Aputure 600D \(прибор 1 из 2\) — отметить выданным/,
    });
    issued.click();

    await waitFor(() => expect(checkSpy).toHaveBeenCalledWith("u1"));
  });

  it("renders «＋ Добор» and a sticky «Завершить выдачу» that calls onComplete", async () => {
    const onComplete = vi.fn();
    render(
      <IssueChecklist
        sessionId="s1"
        projectName="Орбита"
        onBack={() => {}}
        onComplete={onComplete}
      />,
    );

    // At least one Добор control (mobile dashed bar; desktop chip is hidden by CSS).
    expect(
      (await screen.findAllByRole("button", { name: /Добор/ })).length,
    ).toBeGreaterThanOrEqual(1);

    const finish = screen.getByRole("button", {
      name: /Завершить выдачу/,
    });
    finish.click();
    expect(onComplete).toHaveBeenCalledTimes(1);
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

  it("tapping ✗ on a UNIT row tracks the unit as WITHHELD (visible later in сверка)", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    const withhold = await screen.findByRole("button", {
      name: /Aputure 600D \(прибор 1 из 2\) — отметить «не выдаём»/,
    });
    withhold.click();

    // No outward signal yet (UI for the сверка lands in Task 8), but the
    // segment becomes aria-pressed and remains so on re-render.
    await waitFor(() => expect(withhold).toHaveAttribute("aria-pressed", "true"));
  });

  it("tapping ✗ then ✓ on the same UNIT row clears the WITHHELD and issues it", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    const withhold = await screen.findByRole("button", {
      name: /Aputure 600D \(прибор 1 из 2\) — отметить «не выдаём»/,
    });
    const issued = await screen.findByRole("button", {
      name: /Aputure 600D \(прибор 1 из 2\) — отметить выданным/,
    });
    withhold.click();
    await waitFor(() =>
      expect(withhold).toHaveAttribute("aria-pressed", "true"),
    );
    issued.click();
    await waitFor(() => {
      expect(issued).toHaveAttribute("aria-pressed", "true");
      expect(withhold).toHaveAttribute("aria-pressed", "false");
    });
    expect(checkSpy).toHaveBeenCalledWith("u1");
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
});
