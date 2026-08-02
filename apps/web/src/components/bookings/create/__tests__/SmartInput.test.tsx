import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { SmartInput } from "../SmartInput";

describe("SmartInput", () => {
  it("shows placeholder and AI hint badge by default", () => {
    render(<SmartInput value="" onValueChange={vi.fn()} onParse={vi.fn()} parsing={false} />);
    expect(screen.getByPlaceholderText(/поиск.*список от гафера/i)).toBeInTheDocument();
    expect(screen.getByText(/AI/i)).toBeInTheDocument();
  });

  it("calls onValueChange for single-line input", () => {
    const onValueChange = vi.fn();
    render(<SmartInput value="" onValueChange={onValueChange} onParse={vi.fn()} parsing={false} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "arri" } });
    expect(onValueChange).toHaveBeenCalledWith("arri");
  });

  it("does NOT show parse button for short single-line text", () => {
    render(<SmartInput value="arri" onValueChange={vi.fn()} onParse={vi.fn()} parsing={false} />);
    expect(screen.queryByRole("button", { name: /распознать/i })).toBeNull();
  });

  it("shows parse button when text contains newline", () => {
    render(
      <SmartInput value={"2x ARRI SkyPanel\n1x Kino Flo"} onValueChange={vi.fn()} onParse={vi.fn()} parsing={false} />,
    );
    expect(screen.getByRole("button", { name: /распознать/i })).toBeInTheDocument();
  });

  it("shows parse button when text length > 40 chars", () => {
    render(<SmartInput value={"a".repeat(41)} onValueChange={vi.fn()} onParse={vi.fn()} parsing={false} />);
    expect(screen.getByRole("button", { name: /распознать/i })).toBeInTheDocument();
  });

  it("calls onParse when parse button is clicked", () => {
    const onParse = vi.fn();
    render(<SmartInput value={"a".repeat(41)} onValueChange={vi.fn()} onParse={onParse} parsing={false} />);
    fireEvent.click(screen.getByRole("button", { name: /распознать/i }));
    expect(onParse).toHaveBeenCalled();
  });

  it("disables parse button and shows 'Распознаю...' when parsing=true", () => {
    render(<SmartInput value={"a".repeat(41)} onValueChange={vi.fn()} onParse={vi.fn()} parsing={true} />);
    const btn = screen.getByRole("button", { name: /распозна/i });
    expect(btn).toBeDisabled();
    expect(btn.textContent).toMatch(/распознаю/i);
  });

  it("shows 'Очистить' button and disabled textarea after parse (parsed=true)", () => {
    const onClear = vi.fn();
    render(
      <SmartInput
        value="2x ARRI\n1x Kino"
        onValueChange={vi.fn()}
        onParse={vi.fn()}
        onClear={onClear}
        parsing={false}
        parsed={true}
      />,
    );
    expect(screen.getByRole("textbox")).toBeDisabled();
    const clearBtn = screen.getByRole("button", { name: /очистить/i });
    fireEvent.click(clearBtn);
    expect(onClear).toHaveBeenCalled();
  });
});
