/**
 * UnitGridRow — per-unit chips with cycle-on-tap status + inline cards
 * for REPAIR/PROBLEM. Replaces CountSplitRow for COUNT-mode RETURN positions.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { UnitGridRow, type UnitSlot } from "../UnitGridRow";

function makeUnits(n: number): UnitSlot[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    status: "PENDING" as const,
    repairComment: "",
    problem: { reason: null, comment: "", expectedBackDate: null },
  }));
}

const baseProps = {
  name: "Штатив Avenger A100",
  totalQty: 4,
  disabled: false,
  onCycle: vi.fn(),
  onAcceptAll: vi.fn(),
  onRepairCommentChange: vi.fn(),
  onProblemPatch: vi.fn(),
};

describe("UnitGridRow", () => {
  it("renders one chip per unit + bulk «✓ Все» button when all pending", () => {
    render(<UnitGridRow {...baseProps} units={makeUnits(4)} />);
    for (let i = 1; i <= 4; i++) {
      expect(
        screen.getByRole("button", {
          name: new RegExp(`юнит #${i}.*ожидает`, "i"),
        }),
      ).toBeInTheDocument();
    }
    expect(
      screen.getByRole("button", { name: /Принять все/i }),
    ).toBeInTheDocument();
  });

  it("shows «осталось пометить» counter when there's pending", () => {
    render(<UnitGridRow {...baseProps} units={makeUnits(4)} />);
    expect(screen.getByText(/осталось пометить 4/)).toBeInTheDocument();
  });

  it("clicking a chip calls onCycle with the unit's index", () => {
    const onCycle = vi.fn();
    render(<UnitGridRow {...baseProps} units={makeUnits(4)} onCycle={onCycle} />);
    fireEvent.click(
      screen.getByRole("button", { name: /юнит #2.*ожидает/i }),
    );
    expect(onCycle).toHaveBeenCalledWith(2);
  });

  it("ACCEPTED chip has emerald style + aria says «принят»", () => {
    const units = makeUnits(2);
    units[0].status = "ACCEPTED";
    render(<UnitGridRow {...baseProps} units={units} />);
    const chip = screen.getByRole("button", { name: /юнит #1.*принят/i });
    expect(chip).toBeInTheDocument();
    expect(chip.className).toContain("bg-emerald");
  });

  it("REPAIR chip renders inline repair card with textarea", () => {
    const units = makeUnits(2);
    units[0].status = "REPAIR";
    render(<UnitGridRow {...baseProps} units={units} />);
    expect(
      screen.getByLabelText(/Комментарий ремонта — юнит #1/i),
    ).toBeInTheDocument();
  });

  it("PROBLEM chip renders reason select + comment textarea", () => {
    const units = makeUnits(2);
    units[0].status = "PROBLEM";
    render(<UnitGridRow {...baseProps} units={units} />);
    expect(
      screen.getByLabelText(/Причина проблемы — юнит #1/i),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(/Комментарий проблемы — юнит #1/i),
    ).toBeInTheDocument();
  });

  it("LEFT_ON_SITE problem shows date input", () => {
    const units = makeUnits(2);
    units[0].status = "PROBLEM";
    units[0].problem.reason = "LEFT_ON_SITE";
    render(<UnitGridRow {...baseProps} units={units} />);
    expect(
      screen.getByLabelText(/Дата ожидаемого возврата — юнит #1/i),
    ).toBeInTheDocument();
  });

  it("non-LEFT_ON_SITE problem hides date input", () => {
    const units = makeUnits(2);
    units[0].status = "PROBLEM";
    units[0].problem.reason = "LOST";
    render(<UnitGridRow {...baseProps} units={units} />);
    expect(
      screen.queryByLabelText(/Дата ожидаемого возврата/i),
    ).not.toBeInTheDocument();
  });

  it("typing in repair comment fires onRepairCommentChange with unit index", () => {
    const units = makeUnits(2);
    units[0].status = "REPAIR";
    const onRepairCommentChange = vi.fn();
    render(
      <UnitGridRow
        {...baseProps}
        units={units}
        onRepairCommentChange={onRepairCommentChange}
      />,
    );
    fireEvent.change(screen.getByLabelText(/Комментарий ремонта — юнит #1/i), {
      target: { value: "Сломан замок" },
    });
    expect(onRepairCommentChange).toHaveBeenCalledWith(1, "Сломан замок");
  });

  it("«✓ Все» calls onAcceptAll", () => {
    const onAcceptAll = vi.fn();
    render(
      <UnitGridRow
        {...baseProps}
        units={makeUnits(4)}
        onAcceptAll={onAcceptAll}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Принять все/i }));
    expect(onAcceptAll).toHaveBeenCalled();
  });

  it("«✓ Все» button hidden when there's already a non-accepted issue", () => {
    const units = makeUnits(4);
    units[0].status = "REPAIR";
    render(<UnitGridRow {...baseProps} units={units} />);
    expect(
      screen.queryByRole("button", { name: /Принять все/i }),
    ).not.toBeInTheDocument();
  });

  it("«✓ Все» button hidden when all already accepted", () => {
    const units = makeUnits(4);
    units.forEach((u) => (u.status = "ACCEPTED"));
    render(<UnitGridRow {...baseProps} units={units} />);
    expect(
      screen.queryByRole("button", { name: /Принять все/i }),
    ).not.toBeInTheDocument();
  });

  it("renders bucket pills (✓ N, 🔧 N, ✗ N) for non-zero buckets only", () => {
    const units = makeUnits(4);
    units[0].status = "ACCEPTED";
    units[1].status = "ACCEPTED";
    units[2].status = "REPAIR";
    render(<UnitGridRow {...baseProps} units={units} />);
    expect(screen.getByLabelText(/Принято 2/)).toBeInTheDocument();
    expect(screen.getByLabelText(/В ремонт 1/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Проблема/)).not.toBeInTheDocument();
  });

  it("renders rowError as alert when provided", () => {
    render(
      <UnitGridRow
        {...baseProps}
        units={makeUnits(4)}
        rowError="Заполните комментарий ремонта на юните #2"
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      /Заполните комментарий/,
    );
  });
});
