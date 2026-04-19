import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { MemberNumberField } from "../MemberNumberField";

/**
 * Regression coverage for the "0 stays after clear" bug on the Gaffer project
 * wizard (/gaffer/projects/new and /gaffer/projects/[id]).
 *
 * Bug before fix:
 *   <input value={m.hours} onChange={(e) => setHours(Math.max(0, Number(e.target.value)))} />
 *   When the user emptied the field, Number("") === 0 → state became 0 →
 *   the controlled input re-rendered with value={0} and showed "0" stuck inside.
 *
 * Fix under test:
 *   value={value === 0 ? "" : value}
 *   onChange: raw === "" ? 0 : Math.max(0, Number(raw))
 *
 * Parent filters (m.shifts === 0 || m.hours === 0) on submit, so 0 is a
 * "not entered" marker — displaying it as "" aligns with the intended UX.
 */

function Harness({ initial }: { initial: number }) {
  const [value, setValue] = useState(initial);
  return (
    <div>
      <MemberNumberField
        label="Часов"
        value={value}
        onChange={setValue}
        ariaLabel="hours"
      />
      <span data-testid="state">{value}</span>
    </div>
  );
}

describe("MemberNumberField", () => {
  it("renders the initial numeric value", () => {
    render(<Harness initial={12} />);
    const input = screen.getByLabelText("hours") as HTMLInputElement;
    expect(input.value).toBe("12");
  });

  it("renders EMPTY when initial value is 0 (not '0')", () => {
    render(<Harness initial={0} />);
    const input = screen.getByLabelText("hours") as HTMLInputElement;
    expect(input.value).toBe("");
  });

  it("updates state when a numeric value is typed", () => {
    render(<Harness initial={0} />);
    const input = screen.getByLabelText("hours") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "8" } });
    expect(input.value).toBe("8");
    expect(screen.getByTestId("state")).toHaveTextContent("8");
  });

  it("shows EMPTY (not '0') after the user clears the field", () => {
    render(<Harness initial={12} />);
    const input = screen.getByLabelText("hours") as HTMLInputElement;
    expect(input.value).toBe("12");

    // user clears the field
    fireEvent.change(input, { target: { value: "" } });

    // regression guard: must NOT show "0"
    expect(input.value).toBe("");
    expect(input.value).not.toBe("0");
  });

  it("lets the user type a new number right after clearing", () => {
    render(<Harness initial={12} />);
    const input = screen.getByLabelText("hours") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");

    fireEvent.change(input, { target: { value: "6" } });
    expect(input.value).toBe("6");
    expect(screen.getByTestId("state")).toHaveTextContent("6");
  });

  it("clamps negative values to 0 (which renders as EMPTY)", () => {
    render(<Harness initial={5} />);
    const input = screen.getByLabelText("hours") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "-3" } });
    // clamped to 0, then rendered as empty
    expect(input.value).toBe("");
    expect(screen.getByTestId("state")).toHaveTextContent("0");
  });

  it("fires onChange with the parsed number when typing", () => {
    const onChange = vi.fn();
    render(
      <MemberNumberField
        label="Часов"
        value={0}
        onChange={onChange}
        ariaLabel="hours"
      />,
    );
    const input = screen.getByLabelText("hours") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "7" } });
    expect(onChange).toHaveBeenLastCalledWith(7);
  });

  it("fires onChange with 0 when the user clears a non-zero field", () => {
    const onChange = vi.fn();
    render(
      <MemberNumberField
        label="Часов"
        value={12}
        onChange={onChange}
        ariaLabel="hours"
      />,
    );
    const input = screen.getByLabelText("hours") as HTMLInputElement;
    expect(input.value).toBe("12");

    fireEvent.change(input, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(0);
  });

  it("floors decimal input to an integer (shifts/hours are whole numbers)", () => {
    const onChange = vi.fn();
    render(
      <MemberNumberField
        label="Часов"
        value={0}
        onChange={onChange}
        ariaLabel="hours"
      />,
    );
    const input = screen.getByLabelText("hours") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "3.7" } });
    expect(onChange).toHaveBeenLastCalledWith(3);
  });

  it("guards against NaN when the raw value is garbage (Firefox partial typing)", () => {
    const onChange = vi.fn();
    render(
      <MemberNumberField
        label="Часов"
        value={5}
        onChange={onChange}
        ariaLabel="hours"
      />,
    );
    const input = screen.getByLabelText("hours") as HTMLInputElement;
    // Some browsers pass partial strings like "1e" during typing, yielding NaN.
    fireEvent.change(input, { target: { value: "abc" } });
    // Must not propagate NaN — we fall back to 0 (the "not entered" marker).
    expect(onChange).toHaveBeenLastCalledWith(0);
  });
});
