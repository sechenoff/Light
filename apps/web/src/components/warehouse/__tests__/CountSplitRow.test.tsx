import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CountSplitRow } from "../CountSplitRow";

const baseProps = {
  name: "Штатив Avenger A100",
  totalQty: 3,
  split: { accepted: 0, repair: 0, problem: 0 },
  repairComment: "",
  problem: { reason: null, comment: "", expectedBackDate: null },
  disabled: false,
  onIncrement: vi.fn(),
  onDecrement: vi.fn(),
  onAcceptAll: vi.fn(),
  onRepairCommentChange: vi.fn(),
  onProblemPatch: vi.fn(),
};

describe("CountSplitRow", () => {
  it("renders three action buttons + «осталось пометить» counter", () => {
    render(<CountSplitRow {...baseProps} />);
    expect(
      screen.getByRole("button", { name: /Принять.*Штатив/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Ремонт.*Штатив/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Проблема.*Штатив/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/осталось пометить.*3.*из.*3/i),
    ).toBeInTheDocument();
  });

  it("disables action buttons when pending=0", () => {
    render(
      <CountSplitRow
        {...baseProps}
        split={{ accepted: 3, repair: 0, problem: 0 }}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Принять.*Штатив/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Ремонт.*Штатив/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Проблема.*Штатив/i }),
    ).toBeDisabled();
  });

  it("pill click triggers onDecrement when bucket >= 1", () => {
    const onDecrement = vi.fn();
    render(
      <CountSplitRow
        {...baseProps}
        split={{ accepted: 2, repair: 1, problem: 0 }}
        onDecrement={onDecrement}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Снять отметку «Принято»/i }),
    );
    expect(onDecrement).toHaveBeenCalledWith("accepted");
  });

  it("shortcut: pending=totalQty + click «Принять 1» → calls onAcceptAll, not onIncrement", () => {
    const onIncrement = vi.fn();
    const onAcceptAll = vi.fn();
    render(
      <CountSplitRow
        {...baseProps}
        onIncrement={onIncrement}
        onAcceptAll={onAcceptAll}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Принять.*Штатив/i }));
    expect(onAcceptAll).toHaveBeenCalled();
    expect(onIncrement).not.toHaveBeenCalled();
  });

  it("regular click (pending < totalQty) on «Принять 1» calls onIncrement('accepted')", () => {
    const onIncrement = vi.fn();
    render(
      <CountSplitRow
        {...baseProps}
        split={{ accepted: 1, repair: 0, problem: 0 }}
        onIncrement={onIncrement}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Принять.*Штатив/i }));
    expect(onIncrement).toHaveBeenCalledWith("accepted");
  });

  it("renders repair panel when split.repair >= 1", () => {
    render(
      <CountSplitRow
        {...baseProps}
        split={{ accepted: 0, repair: 1, problem: 0 }}
      />,
    );
    expect(screen.getByLabelText(/Комментарий ремонта/i)).toBeInTheDocument();
  });

  it("renders problem panel when split.problem >= 1", () => {
    render(
      <CountSplitRow
        {...baseProps}
        split={{ accepted: 0, repair: 0, problem: 1 }}
      />,
    );
    expect(screen.getByLabelText(/Причина проблемы/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Комментарий проблемы/i)).toBeInTheDocument();
  });

  it("problem reason <select> exposes the 4 valid ProblemReason options", () => {
    render(
      <CountSplitRow
        {...baseProps}
        split={{ accepted: 0, repair: 0, problem: 1 }}
      />,
    );
    const select = screen.getByLabelText(/Причина проблемы/i) as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toContain("LOST");
    expect(values).toContain("DESTROYED");
    expect(values).toContain("STOLEN");
    expect(values).toContain("LEFT_ON_SITE");
    expect(values).not.toContain("BROKEN");
  });

  it("calls onRepairCommentChange when typing in repair panel", () => {
    const onRepairCommentChange = vi.fn();
    render(
      <CountSplitRow
        {...baseProps}
        split={{ accepted: 0, repair: 2, problem: 0 }}
        onRepairCommentChange={onRepairCommentChange}
      />,
    );
    const ta = screen.getByLabelText(/Комментарий ремонта/i);
    fireEvent.change(ta, { target: { value: "Сломана ножка" } });
    expect(onRepairCommentChange).toHaveBeenCalledWith("Сломана ножка");
  });
});
