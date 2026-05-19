import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { UnitRow } from "../UnitRow";

describe("UnitRow", () => {
  it("ISSUE mode renders exactly 2 segment buttons with Russian aria-labels", () => {
    render(
      <UnitRow
        name="Aputure 600D"
        ordinalLabel="прибор 1 из 3"
        mode="ISSUE"
        value={null}
        onChange={() => {}}
      />,
    );

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);

    expect(
      screen.getByRole("button", {
        name: /Aputure 600D \(прибор 1 из 3\) — отметить выданным/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /Aputure 600D \(прибор 1 из 3\) — отметить «не выдаём»/,
      }),
    ).toBeInTheDocument();
  });

  it("ISSUE mode toggles via onChange (select, then deselect back to null)", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <UnitRow
        name="SkyPanel S60"
        mode="ISSUE"
        value={null}
        onChange={onChange}
      />,
    );

    screen
      .getByRole("button", { name: /отметить выданным/ })
      .click();
    expect(onChange).toHaveBeenCalledWith("ISSUED");

    // Re-render as active; clicking the active segment clears it back to null.
    rerender(
      <UnitRow
        name="SkyPanel S60"
        mode="ISSUE"
        value="ISSUED"
        onChange={onChange}
      />,
    );
    const issuedBtn = screen.getByRole("button", {
      name: /отметить выданным/,
    });
    expect(issuedBtn).toHaveAttribute("aria-pressed", "true");
    issuedBtn.click();
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("renders NO barcode — only the name and ordinal label", () => {
    const { container } = render(
      <UnitRow
        name="Aputure 600D"
        ordinalLabel="прибор 2 из 3"
        mode="ISSUE"
        value={null}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText("прибор 2 из 3")).toBeInTheDocument();
    // No barcode-looking text (LR-XXX-NNN) anywhere.
    expect(container.textContent || "").not.toMatch(/LR-[A-Z0-9]+-\d+/);
  });

  it("RETURN mode renders 3 segment buttons (Принято / Ремонт / Проблема)", () => {
    const onChange = vi.fn();
    render(
      <UnitRow
        name="Manfrotto 1004"
        ordinalLabel="стойка 1 из 4"
        mode="RETURN"
        value={null}
        onChange={onChange}
      />,
    );

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(3);

    expect(
      screen.getByRole("button", { name: /принять без замечаний/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /отправить в ремонт/ }),
    ).toBeInTheDocument();
    const problem = screen.getByRole("button", {
      name: /зарегистрировать проблему/,
    });
    expect(problem).toBeInTheDocument();

    problem.click();
    expect(onChange).toHaveBeenCalledWith("PROBLEM");
  });

  it("disables all segments when disabled", () => {
    render(
      <UnitRow name="X" mode="ISSUE" value={null} onChange={() => {}} disabled />,
    );
    for (const b of screen.getAllByRole("button")) {
      expect(b).toBeDisabled();
    }
  });
});
