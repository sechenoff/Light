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

  it("renders the three counts (accepted = scanned − repair − problem)", () => {
    render(
      <ReturnResultView
        result={okResult({
          scannedCount: 5,
          createdRepairIds: ["r1"],
          createdProblemItemIds: ["p1", "p2"],
        })}
        projectName="Орбита"
        onDone={() => {}}
      />,
    );

    // 5 − 1 − 2 = 2 accepted; 1 repair card; 2 problem requests.
    expect(valueFor(/^Принято$/)).toHaveTextContent("2");
    // The label states the TRUE distinct concept (cards/requests actually
    // CREATED) and the value is that single meaningful number — never the
    // same number printed twice, no bare/confusing parenthetical.
    expect(
      screen.getByText("На ремонт — создано карточка"),
    ).toBeInTheDocument();
    expect(valueFor(/^На ремонт/)).toHaveTextContent("1");
    expect(
      screen.getByText("В «Потеряшки» — создано заявки"),
    ).toBeInTheDocument();
    expect(valueFor(/^В «Потеряшки»/)).toHaveTextContent("2");
  });

  it("never renders a negative accepted count", () => {
    render(
      <ReturnResultView
        result={okResult({
          scannedCount: 1,
          createdRepairIds: ["r1"],
          createdProblemItemIds: ["p1", "p2"],
        })}
        projectName="P"
        onDone={() => {}}
      />,
    );
    // 1 − 1 − 2 = -2 → clamped to 0.
    expect(valueFor(/^Принято$/)).toHaveTextContent("0");
  });

  it("shows the emerald success header when there are zero failures", () => {
    render(
      <ReturnResultView
        result={okResult({ createdRepairIds: ["r1"] })}
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
        projectName="P"
        onDone={onDone}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Готово/ }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
