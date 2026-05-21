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
    mainOriginalAfterDiscount: "0",
    addonAfterDiscount: "0",
    finalAmount: "0",
    paymentStatus: "NOT_PAID",
    amountPaid: "0",
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
        bookingId="b1"
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
        bookingId="b1"
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
        bookingId="b1"
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
        bookingId="b1"
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
        bookingId="b1"
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
        bookingId="b1"
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
        bookingId="b1"
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

  it("renders Финансы block with main/addon/final breakdown when addonAfterDiscount > 0", () => {
    render(
      <IssueResultView
        result={okResult({
          mainAfterDiscount: "5000",
          addonAfterDiscount: "3000",
          finalAmount: "8000",
        })}
        bookingId="b1"
        issuedCount={3}
        addonsCount={1}
        substitutedCount={0}
        projectName="P"
        onDone={() => {}}
      />,
    );
    expect(screen.getByText(/Согласовано/)).toBeInTheDocument();
    expect(screen.getByText(/5\s?000/)).toBeInTheDocument();
    expect(screen.getByText(/Доб-смета/)).toBeInTheDocument();
    expect(screen.getByText(/3\s?000/)).toBeInTheDocument();
    expect(screen.getByText(/К оплате/)).toBeInTheDocument();
    expect(screen.getByText(/8\s?000/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Скачать смету.*общая.*PDF/ }))
      .toHaveAttribute("href", "/api/bookings/b1/full-estimate/export/pdf");
    expect(screen.getByRole("link", { name: /Скачать доб-смета.*PDF/ }))
      .toHaveAttribute("href", "/api/addon-estimates/b1/export/pdf");
  });

  it("does NOT render Финансы block when addonAfterDiscount === '0'", () => {
    render(
      <IssueResultView
        result={okResult({
          mainAfterDiscount: "5000",
          addonAfterDiscount: "0",
          finalAmount: "5000",
        })}
        bookingId="b1"
        issuedCount={3}
        addonsCount={0}
        substitutedCount={0}
        projectName="P"
        onDone={() => {}}
      />,
    );
    expect(screen.queryByText(/^Согласовано:$/)).not.toBeInTheDocument();
  });

  // ── Task 13: «исходно / снято / фактически» + OVERPAID ──────────────────────

  it("shows «Согласовано (исходно)» and «Снято на выдаче» when mainAfterDiscount < mainOriginalAfterDiscount", () => {
    render(
      <IssueResultView
        result={okResult({
          mainAfterDiscount: "3500",
          mainOriginalAfterDiscount: "5000",
          addonAfterDiscount: "500",
          finalAmount: "4000",
        })}
        bookingId="b1"
        projectName="P"
        issuedCount={3}
        addonsCount={1}
        substitutedCount={0}
        onDone={() => {}}
      />,
    );
    expect(screen.getByText(/Согласовано \(исходно\)/)).toBeInTheDocument();
    expect(screen.getByText(/5\s?000/)).toBeInTheDocument();
    expect(screen.getByText(/Снято на выдаче/)).toBeInTheDocument();
    // «−1 500 ₽» — допускаем дефис либо U+2212 MINUS SIGN
    expect(screen.getByText(/[−-]1\s?500/)).toBeInTheDocument();
    expect(screen.getByText(/Согласовано \(фактически\)/)).toBeInTheDocument();
    expect(screen.getByText(/3\s?500/)).toBeInTheDocument();
  });

  it("hides «исходно» line when no adjustments (mainAfterDiscount === mainOriginalAfterDiscount)", () => {
    render(
      <IssueResultView
        result={okResult({
          mainAfterDiscount: "5000",
          mainOriginalAfterDiscount: "5000",
          addonAfterDiscount: "500",
          finalAmount: "5500",
        })}
        bookingId="b1"
        projectName="P"
        issuedCount={3}
        addonsCount={1}
        substitutedCount={0}
        onDone={() => {}}
      />,
    );
    expect(screen.queryByText(/Согласовано \(исходно\)/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Снято на выдаче/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Согласовано \(фактически\)/)).not.toBeInTheDocument();
  });

  it("renders Финансы block also when ONLY a main-reduction happened (no addons)", () => {
    // Раньше блок «Финансы» рисовался только при addonAfterDiscount > 0.
    // С Task 13 он также должен появиться при main-reduction — иначе оператор
    // не увидит «Снято на выдаче».
    render(
      <IssueResultView
        result={okResult({
          mainAfterDiscount: "3500",
          mainOriginalAfterDiscount: "5000",
          addonAfterDiscount: "0",
          finalAmount: "3500",
        })}
        bookingId="b1"
        projectName="P"
        issuedCount={3}
        addonsCount={0}
        substitutedCount={0}
        onDone={() => {}}
      />,
    );
    expect(screen.getByText(/Согласовано \(исходно\)/)).toBeInTheDocument();
    expect(screen.getByText(/Снято на выдаче/)).toBeInTheDocument();
  });

  it("shows OVERPAID callout «Переплата … К возврату» when paymentStatus === 'OVERPAID'", () => {
    render(
      <IssueResultView
        result={okResult({
          paymentStatus: "OVERPAID",
          finalAmount: "3500",
          amountPaid: "5000",
          mainAfterDiscount: "3500",
          mainOriginalAfterDiscount: "3500",
        })}
        bookingId="b1"
        projectName="P"
        issuedCount={3}
        addonsCount={0}
        substitutedCount={0}
        onDone={() => {}}
      />,
    );
    expect(screen.getByText(/Переплата/)).toBeInTheDocument();
    // 5000 − 3500 = 1500
    expect(screen.getByText(/1\s?500/)).toBeInTheDocument();
    expect(screen.getByText(/К возврату клиенту/)).toBeInTheDocument();
  });

  it("does NOT show OVERPAID callout when paymentStatus !== 'OVERPAID'", () => {
    render(
      <IssueResultView
        result={okResult({ paymentStatus: "PAID" })}
        bookingId="b1"
        projectName="P"
        issuedCount={3}
        addonsCount={0}
        substitutedCount={0}
        onDone={() => {}}
      />,
    );
    expect(screen.queryByText(/Переплата/)).not.toBeInTheDocument();
    expect(screen.queryByText(/К возврату клиенту/)).not.toBeInTheDocument();
  });
});
