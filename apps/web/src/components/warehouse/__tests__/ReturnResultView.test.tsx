import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import type { CompleteResult } from "../types";
import { ReturnResultView } from "../ReturnResultView";

/** A clean (zero-failure) complete response. */
function okResult(over: Partial<CompleteResult> = {}): CompleteResult {
  return {
    sessionId: "s1",
    operation: "RETURN",
    scannedCount: 3,
    expectedCount: 3,
    missingItems: [],
    substitutedItems: [],
    reservedButUnavailable: [],
    createdRepairIds: [],
    failedBrokenUnits: [],
    createdProblemItemIds: [],
    failedProblemUnits: [],
    ...over,
  };
}

describe("ReturnResultView", () => {
  /** The <dd> value cell whose row <dt> label matches the substring. */
  function valueFor(labelRe: RegExp): HTMLElement {
    const dt = screen.getByText(labelRe);
    const row = dt.parentElement as HTMLElement;
    const dd = row.querySelector("dd");
    if (!dd) throw new Error(`no <dd> for ${labelRe}`);
    return dd as HTMLElement;
  }

  it("renders «Принято» from the acceptedCount prop, NOT scanned − repair − problem", () => {
    // The OLD buggy formula was `scannedCount − repair − problem`. With this
    // input that would be 5 − 1 − 2 = 2 — but the view is now a pure
    // presentational component that takes the authoritative accepted count
    // (computed by ReturnChecklist from its outcome map) as a prop. Pin it to
    // a value (4) that ONLY matches the prop and would FAIL under the old
    // derivation.
    render(
      <ReturnResultView
        result={okResult({
          scannedCount: 5,
          createdRepairIds: ["r1"],
          createdProblemItemIds: ["p1", "p2"],
        })}
        acceptedCount={4}
        projectName="Орбита"
        onDone={() => {}}
      />,
    );

    // 4 accepted (the prop) — NOT 5 − 1 − 2 = 2 (the old formula).
    expect(valueFor(/^Принято$/)).toHaveTextContent("4");
    expect(valueFor(/^Принято$/)).not.toHaveTextContent("2");
    // «На ремонт» / «В Потеряшки» stay the cards/requests the backend
    // actually CREATED (createdRepairIds / createdProblemItemIds).
    expect(
      screen.getByText("На ремонт — создано карточка"),
    ).toBeInTheDocument();
    expect(valueFor(/^На ремонт/)).toHaveTextContent("1");
    expect(
      screen.getByText("В «Потеряшки» — создано заявки"),
    ).toBeInTheDocument();
    expect(valueFor(/^В «Потеряшки»/)).toHaveTextContent("2");
  });

  it("never renders a negative or non-finite accepted count (clamped ≥0)", () => {
    const { rerender } = render(
      <ReturnResultView
        result={okResult()}
        acceptedCount={-2}
        projectName="P"
        onDone={() => {}}
      />,
    );
    // -2 → clamped to 0.
    expect(valueFor(/^Принято$/)).toHaveTextContent("0");

    rerender(
      <ReturnResultView
        result={okResult()}
        acceptedCount={Number.NaN}
        projectName="P"
        onDone={() => {}}
      />,
    );
    // NaN → 0 (Number.isFinite guard).
    expect(valueFor(/^Принято$/)).toHaveTextContent("0");
  });

  it("shows the emerald success header when there are zero failures", () => {
    render(
      <ReturnResultView
        result={okResult({ createdRepairIds: ["r1"] })}
        acceptedCount={2}
        projectName="Орбита"
        onDone={() => {}}
      />,
    );
    expect(screen.getByText("Приёмка завершена")).toBeInTheDocument();
    expect(
      screen.queryByText("Приёмка завершена с замечаниями"),
    ).not.toBeInTheDocument();
  });

  it("demotes to the amber attention header when any failure exists", () => {
    render(
      <ReturnResultView
        result={okResult({
          failedProblemUnits: [
            { equipmentUnitId: "u3", reason: "единица уже списана" },
          ],
        })}
        acceptedCount={2}
        projectName="Орбита"
        onDone={() => {}}
      />,
    );
    expect(
      screen.getByText("Приёмка завершена с замечаниями"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Приёмка завершена")).not.toBeInTheDocument();
  });

  it("renders the broken-unit failure against its REAL shape (reason: error)", () => {
    const { container } = render(
      <ReturnResultView
        result={okResult({
          failedBrokenUnits: [
            { unitId: "u9", reason: "Разбит байонет", error: "ремонт занят" },
          ],
        })}
        acceptedCount={2}
        projectName="P"
        onDone={() => {}}
      />,
    );
    expect(
      screen.getByText("Не удалось создать ремонт:"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Разбит байонет: ремонт занят/),
    ).toBeInTheDocument();
    // No `undefined` from a wrong field access.
    expect(container.textContent || "").not.toContain("undefined");
  });

  it("renders the problem-unit failure against its REAL shape (equipmentUnitId + reason), no 'undefined'", () => {
    const { container } = render(
      <ReturnResultView
        result={okResult({
          failedProblemUnits: [
            { equipmentUnitId: "u3", reason: "единица уже списана" },
          ],
        })}
        acceptedCount={2}
        projectName="P"
        onDone={() => {}}
      />,
    );
    expect(
      screen.getByText("Не удалось завести в «Потеряшки»:"),
    ).toBeInTheDocument();
    // reason ALREADY holds the error message; the unit id is equipmentUnitId.
    expect(screen.getByText(/u3: единица уже списана/)).toBeInTheDocument();
    // The exact regression: a fabricated `{unitId,reason,error}` model
    // rendered "undefined" for every failed problem unit. Never again.
    expect(container.textContent || "").not.toContain("undefined");
  });

  it("renders BOTH failure lists together in one rose alert", () => {
    render(
      <ReturnResultView
        result={okResult({
          failedBrokenUnits: [
            { unitId: "u9", reason: "Разбит байонет", error: "ремонт занят" },
          ],
          failedProblemUnits: [
            { equipmentUnitId: "u3", reason: "единица уже списана" },
          ],
        })}
        acceptedCount={2}
        projectName="P"
        onDone={() => {}}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/Не удалось обработать 2 единицы/);
    expect(alert).toHaveTextContent(/Разбит байонет: ремонт занят/);
    expect(alert).toHaveTextContent(/u3: единица уже списана/);
  });

  it("never renders a barcode", () => {
    const { container } = render(
      <ReturnResultView
        result={okResult({
          failedBrokenUnits: [
            { unitId: "u9", reason: "Разбит байонет", error: "ремонт занят" },
          ],
        })}
        acceptedCount={2}
        projectName="P"
        onDone={() => {}}
      />,
    );
    expect(container.textContent || "").not.toMatch(/LR-[A-Z0-9]+-\d+/);
  });

  it("invokes onDone when «Готово» is pressed", () => {
    const onDone = vi.fn();
    render(
      <ReturnResultView
        result={okResult()}
        acceptedCount={3}
        projectName="P"
        onDone={onDone}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Готово/ }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
