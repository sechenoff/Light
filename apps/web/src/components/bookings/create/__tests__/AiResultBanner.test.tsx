import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { AiResultBanner } from "../AiResultBanner";

describe("AiResultBanner", () => {
  it("renders success banner with counts", () => {
    render(<AiResultBanner resolved={4} total={5} unmatched={[]} onDismissSuccess={vi.fn()} onAddOffCatalog={vi.fn()} onIgnoreUnmatched={vi.fn()} />);
    expect(screen.getByText(/распознано 4 из 5/i)).toBeInTheDocument();
  });

  it("calls onDismissSuccess when close button clicked", () => {
    const onDismiss = vi.fn();
    render(<AiResultBanner resolved={3} total={3} unmatched={[]} onDismissSuccess={onDismiss} onAddOffCatalog={vi.fn()} onIgnoreUnmatched={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /закрыть/i }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it("renders unmatched list with 'Добавить вручную' action per item", () => {
    const onAddOffCatalog = vi.fn();
    render(
      <AiResultBanner
        resolved={2}
        total={3}
        unmatched={["Генератор 6кВт"]}
        onDismissSuccess={vi.fn()}
        onAddOffCatalog={onAddOffCatalog}
        onIgnoreUnmatched={vi.fn()}
      />,
    );
    expect(screen.getByText(/генератор 6квт/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /добавить вручную/i }));
    expect(onAddOffCatalog).toHaveBeenCalledWith("Генератор 6кВт");
  });

  it("renders nothing when resolved=0 and unmatched=[]", () => {
    const { container } = render(
      <AiResultBanner resolved={0} total={0} unmatched={[]} onDismissSuccess={vi.fn()} onAddOffCatalog={vi.fn()} onIgnoreUnmatched={vi.fn()} />,
    );
    expect(container.textContent).toBe("");
  });

  it("can hide success banner independently (successDismissed=true)", () => {
    render(
      <AiResultBanner
        resolved={3}
        total={4}
        unmatched={["xxx"]}
        successDismissed={true}
        onDismissSuccess={vi.fn()}
        onAddOffCatalog={vi.fn()}
        onIgnoreUnmatched={vi.fn()}
      />,
    );
    expect(screen.queryByText(/распознано/i)).toBeNull();
    expect(screen.getByText(/xxx/i)).toBeInTheDocument();
  });
});
