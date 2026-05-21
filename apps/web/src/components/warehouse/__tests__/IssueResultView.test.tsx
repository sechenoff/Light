import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import type { CompleteResult } from "../types";
import { IssueResultView } from "../IssueResultView";

function okResult(over: Partial<CompleteResult> = {}): CompleteResult {
  return {
    sessionId: "s1",
    operation: "ISSUE",
    scannedCount: 24,
    expectedCount: 26,
    missingItems: [],
    substitutedItems: [],
    reservedButUnavailable: [],
    createdRepairIds: [],
    failedBrokenUnits: [],
    createdProblemItemIds: [],
    failedProblemUnits: [],
    mainAfterDiscount: "0",
    addonAfterDiscount: "0",
    finalAmount: "0",
    ...over,
  };
}

describe("IssueResultView", () => {
  function valueFor(labelRe: RegExp): HTMLElement {
    const dt = screen.getByText(labelRe);
    const row = dt.parentElement as HTMLElement;
    const dd = row.querySelector("dd");
    if (!dd) throw new Error(`no <dd> for ${labelRe}`);
    return dd as HTMLElement;
  }

  it("renders the emerald header «Выдача оформлена» on zero failures", () => {
    render(
      <IssueResultView
        result={okResult()}
        projectName="Орбита"
        issuedCount={24}
        addonsCount={2}
        substitutedCount={1}
        onDone={() => {}}
      />,
    );
    expect(screen.getByText("Выдача оформлена")).toBeInTheDocument();
    expect(
      screen.queryByText("Выдача оформлена с замечаниями"),
    ).not.toBeInTheDocument();
  });

  it("renders «Выдано» / «Добавлено доборов» / «Замены» from props, not from scannedCount", () => {
    render(
      <IssueResultView
        result={okResult({ scannedCount: 999 })}
        projectName="P"
        issuedCount={24}
        addonsCount={2}
        substitutedCount={1}
        onDone={() => {}}
      />,
    );
    expect(valueFor(/^Выдано$/)).toHaveTextContent("24");
    expect(valueFor(/Добавлено доборов/)).toHaveTextContent("2");
    expect(valueFor(/Замены/)).toHaveTextContent("1");
    expect(valueFor(/^Выдано$/)).not.toHaveTextContent("999");
  });

  it("clamps issuedCount ≥ 0 (defensive)", () => {
    render(
      <IssueResultView
        result={okResult()}
        projectName="P"
        issuedCount={-3}
        addonsCount={0}
        substitutedCount={0}
        onDone={() => {}}
      />,
    );
    expect(valueFor(/^Выдано$/)).toHaveTextContent("0");
  });

  it("shows the info-block «Бронь переведена в «Выдана»»", () => {
    render(
      <IssueResultView
        result={okResult()}
        projectName="P"
        issuedCount={1}
        addonsCount={0}
        substitutedCount={0}
        onDone={() => {}}
      />,
    );
    expect(
      screen.getByText(/Бронь переведена в «Выдана»/),
    ).toBeInTheDocument();
  });

  it("demotes to amber header on any failedBrokenUnits / failedProblemUnits (edge-case)", () => {
    render(
      <IssueResultView
        result={okResult({
          failedProblemUnits: [
            { equipmentUnitId: "u9", reason: "race-condition" },
          ],
        })}
        projectName="P"
        issuedCount={22}
        addonsCount={2}
        substitutedCount={0}
        onDone={() => {}}
      />,
    );
    expect(
      screen.getByText("Выдача оформлена с замечаниями"),
    ).toBeInTheDocument();
  });

  it("never renders a barcode", () => {
    const { container } = render(
      <IssueResultView
        result={okResult()}
        projectName="P"
        issuedCount={1}
        addonsCount={0}
        substitutedCount={0}
        onDone={() => {}}
      />,
    );
    expect(container.textContent || "").not.toMatch(/LR-[A-Z0-9]+-\d+/);
  });

  it("invokes onDone when «Готово» is pressed", () => {
    const onDone = vi.fn();
    render(
      <IssueResultView
        result={okResult()}
        projectName="P"
        issuedCount={3}
        addonsCount={0}
        substitutedCount={0}
        onDone={onDone}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Готово/ }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
