import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { SummaryPanel } from "../SummaryPanel";
import type { QuoteResponse, ValidationCheck } from "../types";

const noopSubmit = vi.fn();
const noopDraft = vi.fn();

const defaultProps = {
  quote: null,
  localSubtotal: 10000,
  localDiscount: 1000,
  localTotal: 9000,
  discountPercent: 10,
  itemCount: 3,
  shifts: 2,
  isLoadingQuote: false,
  checks: [] as ValidationCheck[],
  onSubmitForApproval: noopSubmit,
  onSaveDraft: noopDraft,
  canSubmit: true,
};

describe("SummaryPanel", () => {
  it("renders 'Расчёт' eyebrow", () => {
    render(<SummaryPanel {...defaultProps} />);
    expect(screen.getByText("Расчёт")).toBeInTheDocument();
  });

  it("shows 'считаю...' when loading", () => {
    render(<SummaryPanel {...defaultProps} isLoadingQuote={true} />);
    expect(screen.getByText(/считаю/i)).toBeInTheDocument();
  });

  it("shows 'обновлено сейчас' timestamp when not loading", () => {
    render(<SummaryPanel {...defaultProps} isLoadingQuote={false} />);
    expect(screen.getByText(/обновлено/i)).toBeInTheDocument();
  });

  it("displays big total from local values when no quote", () => {
    const { container } = render(<SummaryPanel {...defaultProps} localTotal={9000} />);
    // big total uses font-mono text-[32px] span — integer only, no decimals
    const bigTotal = container.querySelector(".font-mono");
    expect(bigTotal).toBeTruthy();
    expect(bigTotal!.textContent).toMatch(/9\s*000/);
  });

  it("displays big total from quote when available", () => {
    const quote: QuoteResponse = {
      shifts: 3,
      subtotal: "15000",
      discountPercent: "5",
      discountAmount: "750",
      totalAfterDiscount: "14250",
      lines: [],
    };
    const { container } = render(<SummaryPanel {...defaultProps} quote={quote} />);
    const bigTotal = container.querySelector(".font-mono");
    expect(bigTotal).toBeTruthy();
    expect(bigTotal!.textContent).toMatch(/14\s*250/);
  });

  it("shows '₽' currency suffix", () => {
    render(<SummaryPanel {...defaultProps} />);
    expect(screen.getByText("₽")).toBeInTheDocument();
  });

  it("shows correct day plural for 1 shift (день)", () => {
    render(<SummaryPanel {...defaultProps} shifts={1} />);
    expect(screen.getByText(/1\s*день/)).toBeInTheDocument();
  });

  it("shows correct day plural for 3 shifts (дня)", () => {
    render(<SummaryPanel {...defaultProps} shifts={3} />);
    expect(screen.getByText(/3\s*дня/)).toBeInTheDocument();
  });

  it("shows correct day plural for 5 shifts (дней)", () => {
    render(<SummaryPanel {...defaultProps} shifts={5} />);
    expect(screen.getByText(/5\s*дней/)).toBeInTheDocument();
  });

  it("shows item count in subtitle", () => {
    render(<SummaryPanel {...defaultProps} itemCount={7} />);
    expect(screen.getByText(/7\s*(позиций|позиция|позиции)/)).toBeInTheDocument();
  });

  it("renders breakdown lines: subtotal, discount, total", () => {
    render(<SummaryPanel {...defaultProps} localSubtotal={10000} localDiscount={1000} localTotal={9000} discountPercent={10} />);
    // subtotal label (renamed from «Аренда» to «Оборудование»)
    expect(screen.getAllByText(/Оборудование/i).length).toBeGreaterThanOrEqual(1);
    // discount label
    expect(screen.getByText(/Скидка/i)).toBeInTheDocument();
    // total label — "Итого" appears in "Оборудование итого" and standalone "Итого"
    expect(screen.getAllByText(/Итого/i).length).toBeGreaterThanOrEqual(1);
  });

  it("shows discount as negative red value", () => {
    const { container } = render(<SummaryPanel {...defaultProps} localDiscount={1000} />);
    // discount should have text-rose class and show minus sign
    const discountEl = container.querySelector(".text-rose");
    expect(discountEl).toBeTruthy();
    expect(discountEl!.textContent).toMatch(/−|-/);
  });

  it("renders primary submit button", () => {
    render(<SummaryPanel {...defaultProps} />);
    expect(screen.getByRole("button", { name: /согласован/i })).toBeInTheDocument();
  });

  it("renders secondary draft save button", () => {
    render(<SummaryPanel {...defaultProps} />);
    expect(screen.getByRole("button", { name: /черновик/i })).toBeInTheDocument();
  });

  it("submit button is disabled when canSubmit is false", () => {
    render(<SummaryPanel {...defaultProps} canSubmit={false} />);
    const btn = screen.getByRole("button", { name: /согласован/i });
    expect(btn).toBeDisabled();
  });

  it("calls onSubmitForApproval when submit button clicked", () => {
    const onSubmit = vi.fn();
    render(<SummaryPanel {...defaultProps} onSubmitForApproval={onSubmit} canSubmit={true} />);
    fireEvent.click(screen.getByRole("button", { name: /согласован/i }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("calls onSaveDraft when draft button clicked", () => {
    const onDraft = vi.fn();
    render(<SummaryPanel {...defaultProps} onSaveDraft={onDraft} />);
    fireEvent.click(screen.getByRole("button", { name: /черновик/i }));
    expect(onDraft).toHaveBeenCalledOnce();
  });

  it("renders ok check with emerald badge", () => {
    const checks: ValidationCheck[] = [
      { type: "ok", label: "Доступность подтверждена", detail: "Все позиции доступны" },
    ];
    const { container } = render(<SummaryPanel {...defaultProps} checks={checks} />);
    expect(screen.getByText("Доступность подтверждена")).toBeInTheDocument();
    expect(screen.getByText("Все позиции доступны")).toBeInTheDocument();
    // emerald badge
    expect(container.querySelector(".text-emerald")).toBeTruthy();
  });

  it("renders warn check with amber badge", () => {
    const checks: ValidationCheck[] = [
      { type: "warn", label: "Нет клиента", detail: "Укажите клиента" },
    ];
    const { container } = render(<SummaryPanel {...defaultProps} checks={checks} />);
    expect(container.querySelector(".text-amber")).toBeTruthy();
  });

  it("renders tip check with accent badge", () => {
    const checks: ValidationCheck[] = [
      { type: "tip", label: "Совет", detail: "Добавьте описание" },
    ];
    const { container } = render(<SummaryPanel {...defaultProps} checks={checks} />);
    expect(container.querySelector(".text-accent")).toBeTruthy();
  });

  it("has sticky positioning class", () => {
    const { container } = render(<SummaryPanel {...defaultProps} />);
    const root = container.firstChild as HTMLElement;
    expect(root.className).toMatch(/sticky/);
  });
});
