import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChecklistState, CompleteResult } from "../types";
import type { UseScanSessionResult } from "../useScanSession";

// ── Mock useScanSession ──────────────────────────────────────────────────────
// The real hook makes network calls; here we drive `state` directly and spy on
// the optimistic `check` so we can assert «Принять всё» / ACCEPTED behaviour.

const checkSpy = vi.fn(async () => {});
const uncheckSpy = vi.fn(async () => {});
const openSessionSpy = vi.fn(async () => {});
const refreshSpy = vi.fn(async () => {});

let mockState: ChecklistState | null = null;
let mockLoading = false;
let mockError: UseScanSessionResult["error"] = null;

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

// Mock the API — only `complete` matters for ReturnChecklist; assert the
// EXACT payload (incl. the expectedBackDate ISO conversion it OWNS).
const completeSpy = vi.fn();
vi.mock("../api", () => ({
  scanApi: {
    complete: (...args: unknown[]) => completeSpy(...args),
  },
}));

// Stub RepairPanel — its photo staging is covered by RepairPanel.test.tsx.
// Here we only need a way to drive the controlled `comment` so we can test
// validation (empty repair comment must block the POST).
vi.mock("../RepairPanel", () => ({
  RepairPanel: ({
    unitId,
    comment,
    onCommentChange,
  }: {
    sessionId: string;
    unitId: string;
    comment: string;
    onCommentChange: (s: string) => void;
    disabled?: boolean;
  }) => (
    <div data-testid={`repair-panel-${unitId}`}>
      <span>repair:{unitId}</span>
      <textarea
        aria-label={`repair-comment-${unitId}`}
        value={comment}
        onChange={(e) => onCommentChange(e.target.value)}
      />
    </div>
  ),
}));

// Stub ProblemPanel — its reason chips / date input are covered by
// ProblemPanel.test.tsx. Expose minimal controls to drive the controlled
// reason / comment / expectedBackDate from the test.
vi.mock("../ProblemPanel", () => ({
  ProblemPanel: ({
    unitId,
    reason,
    onReasonChange,
    comment,
    onCommentChange,
    expectedBackDate,
    onExpectedBackDateChange,
  }: {
    unitId?: string;
    reason: string | null;
    onReasonChange: (r: string) => void;
    comment: string;
    onCommentChange: (s: string) => void;
    expectedBackDate: string | null;
    onExpectedBackDateChange: (d: string | null) => void;
    disabled?: boolean;
  }) => (
    <div data-testid="problem-panel">
      <span>problem-reason:{reason ?? "none"}</span>
      <button
        type="button"
        onClick={() => onReasonChange("LEFT_ON_SITE")}
      >
        set-left-on-site
      </button>
      <button type="button" onClick={() => onReasonChange("LOST")}>
        set-lost
      </button>
      <textarea
        aria-label="problem-comment"
        value={comment}
        onChange={(e) => onCommentChange(e.target.value)}
      />
      <input
        aria-label="problem-date"
        value={expectedBackDate ?? ""}
        onChange={(e) =>
          onExpectedBackDateChange(
            e.target.value === "" ? null : e.target.value,
          )
        }
      />
    </div>
  ),
}));

import { ReturnChecklist } from "../ReturnChecklist";

/** UNIT item with 3 units + a COUNT line — mirrors the mockup composition. */
function state(): ChecklistState {
  return {
    sessionId: "s1",
    bookingId: "b1",
    operation: "RETURN",
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
          { unitId: "u1", barcode: "LR-AP600-001", checked: false, problemType: null },
          { unitId: "u2", barcode: "LR-AP600-002", checked: false, problemType: null },
          { unitId: "u3", barcode: "LR-AP600-003", checked: false, problemType: null },
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
    progress: { checkedItems: 0, totalItems: 4 },
  };
}

function okResult(over: Partial<CompleteResult> = {}): CompleteResult {
  return {
    sessionId: "s1",
    operation: "RETURN",
    scannedCount: 3,
    expectedCount: 3,
    missingItems: [],
    substitutedItems: [],
    createdRepairIds: [],
    failedBrokenUnits: [],
    createdProblemItemIds: [],
    failedProblemUnits: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockState = state();
  mockLoading = false;
  mockError = null;
  completeSpy.mockResolvedValue(okResult());
});

describe("ReturnChecklist", () => {
  it("groups by category, renders «прибор N из M», never a barcode", async () => {
    const { container } = render(
      <ReturnChecklist
        sessionId="s1"
        projectName="Реклама «Орбита»"
        onBack={() => {}}
      />,
    );

    expect(await screen.findByText("Свет")).toBeInTheDocument();
    expect(screen.getByText("Стойки")).toBeInTheDocument();
    expect(screen.getByText("прибор 1 из 3")).toBeInTheDocument();
    expect(screen.getByText("прибор 3 из 3")).toBeInTheDocument();
    expect(screen.getByText("×4")).toBeInTheDocument();
    expect(container.textContent || "").not.toMatch(/LR-[A-Z0-9]+-\d+/);
  });

  it("«Принять всё разом» checks every UNIT unit id via the hook", async () => {
    render(
      <ReturnChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    const bulk = await screen.findByRole("button", {
      name: /Принять всё разом/,
    });
    bulk.click();

    await waitFor(() => {
      expect(checkSpy).toHaveBeenCalledWith("u1");
      expect(checkSpy).toHaveBeenCalledWith("u2");
      expect(checkSpy).toHaveBeenCalledWith("u3");
    });
    // Only the 3 UNIT units — COUNT has no server unit ids.
    expect(checkSpy).toHaveBeenCalledTimes(3);
  });

  it("selecting ✓ Принято marks the unit returned via the hook's check", async () => {
    render(
      <ReturnChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    const accept = await screen.findByRole("button", {
      name: /Aputure 600D \(прибор 1 из 3\) — принять без замечаний/,
    });
    accept.click();

    await waitFor(() => expect(checkSpy).toHaveBeenCalledWith("u1"));
  });

  it("selecting 🔧 Ремонт expands the RepairPanel for that unit", async () => {
    render(
      <ReturnChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    expect(screen.queryByTestId("repair-panel-u1")).not.toBeInTheDocument();

    const repair = await screen.findByRole("button", {
      name: /Aputure 600D \(прибор 1 из 3\) — отправить в ремонт/,
    });
    repair.click();

    expect(await screen.findByTestId("repair-panel-u1")).toBeInTheDocument();
  });

  it("selecting ✗ Проблема expands the ProblemPanel for that unit", async () => {
    render(
      <ReturnChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    expect(screen.queryByTestId("problem-panel")).not.toBeInTheDocument();

    const problem = await screen.findByRole("button", {
      name: /Aputure 600D \(прибор 1 из 3\) — зарегистрировать проблему/,
    });
    problem.click();

    expect(await screen.findByTestId("problem-panel")).toBeInTheDocument();
  });

  it("blocks the POST when a REPAIR row has an empty comment + shows a Russian error", async () => {
    render(
      <ReturnChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    // Every unit must have an outcome — accept u2/u3, flag u1 for repair
    // with NO comment.
    fireEvent.click(
      await screen.findByRole("button", {
        name: /прибор 1 из 3\) — отправить в ремонт/,
      }),
    );
    // Panel mounts asynchronously after the state flush.
    await screen.findByTestId("repair-panel-u1");
    fireEvent.click(
      screen.getByRole("button", {
        name: /прибор 2 из 3\) — принять без замечаний/,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: /прибор 3 из 3\) — принять без замечаний/,
      }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Завершить приёмку/ }),
    );

    expect(
      await screen.findByText("Опишите, что сломалось"),
    ).toBeInTheDocument();
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it("blocks the POST when a PROBLEM row is missing reason or comment", async () => {
    render(
      <ReturnChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    // u1 → problem, no reason yet; u2/u3 accepted.
    fireEvent.click(
      await screen.findByRole("button", {
        name: /прибор 1 из 3\) — зарегистрировать проблему/,
      }),
    );
    await screen.findByTestId("problem-panel");
    fireEvent.click(
      screen.getByRole("button", {
        name: /прибор 2 из 3\) — принять без замечаний/,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: /прибор 3 из 3\) — принять без замечаний/,
      }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Завершить приёмку/ }),
    );
    expect(
      await screen.findByText("Выберите причину проблемы"),
    ).toBeInTheDocument();
    expect(completeSpy).not.toHaveBeenCalled();

    // Pick a reason but leave the comment empty → still blocked.
    fireEvent.click(screen.getByRole("button", { name: "set-lost" }));
    fireEvent.click(
      screen.getByRole("button", { name: /Завершить приёмку/ }),
    );
    expect(
      await screen.findByText("Добавьте комментарий к проблеме"),
    ).toBeInTheDocument();
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it("a valid mixed submit posts the EXACT payload incl. ISO date for LEFT_ON_SITE", async () => {
    render(
      <ReturnChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    // u1 → repair w/ comment (await the panel mount before driving inputs).
    fireEvent.click(
      await screen.findByRole("button", {
        name: /прибор 1 из 3\) — отправить в ремонт/,
      }),
    );
    await screen.findByTestId("repair-panel-u1");
    fireEvent.change(screen.getByLabelText("repair-comment-u1"), {
      target: { value: "  Разбит байонет  " },
    });

    // u2 → problem LEFT_ON_SITE + comment + date (must be ISO-converted).
    fireEvent.click(
      screen.getByRole("button", {
        name: /прибор 2 из 3\) — зарегистрировать проблему/,
      }),
    );
    await screen.findByTestId("problem-panel");
    fireEvent.click(
      screen.getByRole("button", { name: "set-left-on-site" }),
    );
    fireEvent.change(screen.getByLabelText("problem-comment"), {
      target: { value: " не вернули со смены " },
    });
    fireEvent.change(screen.getByLabelText("problem-date"), {
      target: { value: "2026-05-22" },
    });

    // u3 → accepted.
    fireEvent.click(
      screen.getByRole("button", {
        name: /прибор 3 из 3\) — принять без замечаний/,
      }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Завершить приёмку/ }),
    );

    await waitFor(() => expect(completeSpy).toHaveBeenCalledTimes(1));
    expect(completeSpy).toHaveBeenCalledWith("s1", {
      repairUnits: [{ equipmentUnitId: "u1", comment: "Разбит байонет" }],
      problemUnits: [
        {
          equipmentUnitId: "u2",
          reason: "LEFT_ON_SITE",
          comment: "не вернули со смены",
          expectedBackDate: "2026-05-22T00:00:00.000Z",
        },
      ],
    });
  });

  it("omits expectedBackDate for a non-LEFT_ON_SITE problem", async () => {
    render(
      <ReturnChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    // u1 → problem LOST + comment; u2/u3 accepted.
    fireEvent.click(
      await screen.findByRole("button", {
        name: /прибор 1 из 3\) — зарегистрировать проблему/,
      }),
    );
    await screen.findByTestId("problem-panel");
    fireEvent.click(screen.getByRole("button", { name: "set-lost" }));
    fireEvent.change(screen.getByLabelText("problem-comment"), {
      target: { value: "потеряли на площадке" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: /прибор 2 из 3\) — принять без замечаний/,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: /прибор 3 из 3\) — принять без замечаний/,
      }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Завершить приёмку/ }),
    );

    await waitFor(() => expect(completeSpy).toHaveBeenCalledTimes(1));
    const [, payload] = completeSpy.mock.calls[0] as [
      string,
      { problemUnits?: Array<Record<string, unknown>> },
    ];
    expect(payload.problemUnits).toEqual([
      {
        equipmentUnitId: "u1",
        reason: "LOST",
        comment: "потеряли на площадке",
      },
    ]);
    expect(payload.problemUnits?.[0]).not.toHaveProperty("expectedBackDate");
  });

  it("renders the RESULT with the REAL failure shapes (problem + broken), never 'undefined', attention header", async () => {
    completeSpy.mockResolvedValue(
      okResult({
        scannedCount: 3,
        createdRepairIds: ["r1"],
        createdProblemItemIds: ["p1"],
        // REAL backend shapes (warehouseScan.ts push sites):
        //  failedBrokenUnits   → { unitId, reason, error }
        //  failedProblemUnits  → { equipmentUnitId, reason } (NO error field)
        failedBrokenUnits: [
          { unitId: "u9", reason: "Разбит байонет", error: "ремонт занят" },
        ],
        failedProblemUnits: [
          { equipmentUnitId: "u3", reason: "единица уже списана" },
        ],
      }),
    );

    const { container } = render(
      <ReturnChecklist sessionId="s1" projectName="Орбита" onBack={() => {}} />,
    );

    // Accept all → valid → submit.
    fireEvent.click(
      await screen.findByRole("button", { name: /Принять всё разом/ }),
    );
    await waitFor(() => expect(checkSpy).toHaveBeenCalled());
    fireEvent.click(
      screen.getByRole("button", { name: /Завершить приёмку/ }),
    );

    // Partial failure → attention header, NOT the clean-success one.
    expect(
      await screen.findByText("Приёмка завершена с замечаниями"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Приёмка завершена")).not.toBeInTheDocument();

    // «Принято» = the FRONTEND outcome truth: «Принять всё разом» marked all
    // 3 UNIT units ACCEPTED + the 1 COUNT line accepted = 4. The OLD buggy
    // formula `scannedCount(3) − repair(1) − problem(1)` = 1 — this assertion
    // pins the true accepted count and would FAIL under that derivation.
    {
      const acceptedDt = screen.getByText(/^Принято$/);
      const acceptedDd = (acceptedDt.parentElement as HTMLElement).querySelector(
        "dd",
      );
      expect(acceptedDd?.textContent).toBe("4");
      expect(acceptedDd?.textContent).not.toBe("1");
    }
    expect(screen.getByText(/^На ремонт/)).toBeInTheDocument();
    expect(screen.getByText(/^В «Потеряшки»/)).toBeInTheDocument();

    // 2 failures total surfaced, nothing silently lost.
    expect(
      screen.getByText(/Не удалось обработать 2 единицы/),
    ).toBeInTheDocument();
    // Broken unit rendered against ITS shape: reason + error.
    expect(
      screen.getByText(/Разбит байонет: ремонт занят/),
    ).toBeInTheDocument();
    // Problem unit rendered against ITS shape: equipmentUnitId + reason
    // (reason already holds the error message — no `error` field exists).
    expect(screen.getByText(/u3: единица уже списана/)).toBeInTheDocument();

    // CRITICAL regression guard: the fabricated-shape bug rendered a literal
    // "undefined" for every failed problem unit. It must NEVER appear.
    expect(container.textContent || "").not.toContain("undefined");

    // No barcode anywhere in the result view.
    expect(container.textContent || "").not.toMatch(/LR-[A-Z0-9]+-\d+/);

    // «Готово» is present and navigable.
    expect(
      screen.getByRole("button", { name: /Готово/ }),
    ).toBeInTheDocument();
  });

  it("mixed completion (1 ✓ + 1 🔧 + 1 ✗): «Принято: 1», NOT scanned − repair − problem", async () => {
    // The exact display-accuracy regression. Backend `scannedCount` counts
    // ScanRecords, which exist ONLY for ACCEPTED units (REPAIR/PROBLEM are
    // never check()'d). If the backend (correctly) reports scannedCount: 1
    // here, the OLD formula `scannedCount − repair − problem` = 1 − 1 − 1 =
    // -1 → clamped 0 — under-reporting the 1 accepted unit. The fix derives
    // «Принято» from the frontend outcome map instead → 1.
    completeSpy.mockResolvedValue(
      okResult({
        scannedCount: 1, // only the 1 ACCEPTED unit was scanned/check()'d
        createdRepairIds: ["r1"],
        createdProblemItemIds: ["p1"],
      }),
    );

    render(
      <ReturnChecklist sessionId="s1" projectName="Орбита" onBack={() => {}} />,
    );

    // u1 → accepted
    fireEvent.click(
      await screen.findByRole("button", {
        name: /прибор 1 из 3\) — принять без замечаний/,
      }),
    );
    // u2 → repair w/ comment
    fireEvent.click(
      screen.getByRole("button", {
        name: /прибор 2 из 3\) — отправить в ремонт/,
      }),
    );
    await screen.findByTestId("repair-panel-u2");
    fireEvent.change(screen.getByLabelText("repair-comment-u2"), {
      target: { value: "Разбит байонет" },
    });
    // u3 → problem LOST w/ comment
    fireEvent.click(
      screen.getByRole("button", {
        name: /прибор 3 из 3\) — зарегистрировать проблему/,
      }),
    );
    await screen.findByTestId("problem-panel");
    fireEvent.click(screen.getByRole("button", { name: "set-lost" }));
    fireEvent.change(screen.getByLabelText("problem-comment"), {
      target: { value: "потеряли на площадке" },
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Завершить приёмку/ }),
    );

    await waitFor(() => expect(completeSpy).toHaveBeenCalledTimes(1));

    // «Принято» MUST be 1 (the one ACCEPTED unit) — NOT scanned − repair −
    // problem (= 1 − 1 − 1 → clamped 0 under the old formula).
    const acceptedDt = await screen.findByText(/^Принято$/);
    const acceptedDd = (acceptedDt.parentElement as HTMLElement).querySelector(
      "dd",
    );
    expect(acceptedDd?.textContent).toBe("1");
    expect(acceptedDd?.textContent).not.toBe("0");

    // Repair line = createdRepairIds.length; problem line =
    // createdProblemItemIds.length (what the backend actually created).
    const repairDt = screen.getByText(/^На ремонт/);
    expect(
      (repairDt.parentElement as HTMLElement).querySelector("dd")?.textContent,
    ).toBe("1");
    const problemDt = screen.getByText(/^В «Потеряшки»/);
    expect(
      (problemDt.parentElement as HTMLElement).querySelector("dd")?.textContent,
    ).toBe("1");

    // Zero failures here → clean emerald header preserved.
    expect(screen.getByText("Приёмка завершена")).toBeInTheDocument();
    expect(
      screen.queryByText("Приёмка завершена с замечаниями"),
    ).not.toBeInTheDocument();
  });

  it("keeps the emerald success header when there are zero failures", async () => {
    completeSpy.mockResolvedValue(
      okResult({
        scannedCount: 3,
        createdRepairIds: ["r1"],
        createdProblemItemIds: [],
      }),
    );

    render(
      <ReturnChecklist sessionId="s1" projectName="Орбита" onBack={() => {}} />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /Принять всё разом/ }),
    );
    await waitFor(() => expect(checkSpy).toHaveBeenCalled());
    fireEvent.click(
      screen.getByRole("button", { name: /Завершить приёмку/ }),
    );

    expect(await screen.findByText("Приёмка завершена")).toBeInTheDocument();
    expect(
      screen.queryByText("Приёмка завершена с замечаниями"),
    ).not.toBeInTheDocument();
  });

  it("focuses the first invalid row on a failed «Завершить приёмку» submit", async () => {
    const scrollSpy = vi.fn();
    // jsdom has no scrollIntoView — install a spy so we can assert M3 a11y.
    window.HTMLElement.prototype.scrollIntoView = scrollSpy;

    render(
      <ReturnChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    // u1 → repair WITHOUT a comment (invalid); u2/u3 accepted.
    fireEvent.click(
      await screen.findByRole("button", {
        name: /прибор 1 из 3\) — отправить в ремонт/,
      }),
    );
    await screen.findByTestId("repair-panel-u1");
    fireEvent.click(
      screen.getByRole("button", {
        name: /прибор 2 из 3\) — принять без замечаний/,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: /прибор 3 из 3\) — принять без замечаний/,
      }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Завершить приёмку/ }),
    );

    // POST blocked.
    expect(
      await screen.findByText("Опишите, что сломалось"),
    ).toBeInTheDocument();
    expect(completeSpy).not.toHaveBeenCalled();

    // The offending row is marked invalid + describes its error, and the
    // first errored row is scrolled into view (kiosk a11y).
    const errorP = screen.getByText("Опишите, что сломалось");
    const offendingRow = errorP.closest('[aria-invalid="true"]');
    expect(offendingRow).not.toBeNull();
    expect(offendingRow?.getAttribute("aria-describedby")).toBe(errorP.id);
    expect(errorP.id).toBeTruthy();
    await waitFor(() => expect(scrollSpy).toHaveBeenCalled());
  });

  it("shows the loading skeleton while state is null and loading", async () => {
    mockState = null;
    mockLoading = true;
    const { container } = render(
      <ReturnChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );
    expect(
      container.querySelectorAll(".animate-pulse").length,
    ).toBeGreaterThan(0);
  });

  it("shows an empty state when the booking has no items", async () => {
    mockState = { ...state(), items: [] };
    render(
      <ReturnChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );
    expect(
      await screen.findByText(/нет позиций для приёмки/),
    ).toBeInTheDocument();
  });
});
