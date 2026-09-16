import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { PaymentFormCard } from "../PaymentFormCard";

describe("PaymentFormCard", () => {
  it("наличные — процент не показывается", () => {
    render(
      <PaymentFormCard
        value="CASH"
        onChange={vi.fn()}
        surchargePercent={null}
        onChangeSurchargePercent={vi.fn()}
        defaultPercent={9}
      />,
    );
    expect(screen.getByRole("radio", { name: "Наличные" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "По счёту (ИП)" })).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByLabelText("Процент надбавки за безналичный расчёт")).toBeNull();
  });

  it("переключение на «По счёту (ИП)» вызывает onChange", () => {
    const onChange = vi.fn();
    render(
      <PaymentFormCard
        value="CASH"
        onChange={onChange}
        surchargePercent={null}
        onChangeSurchargePercent={vi.fn()}
        defaultPercent={9}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "По счёту (ИП)" }));
    expect(onChange).toHaveBeenCalledWith("CASHLESS");
  });

  it("безнал: показывает дефолт из настроек и принимает перебитый процент", () => {
    const onPct = vi.fn();
    render(
      <PaymentFormCard
        value="CASHLESS"
        onChange={vi.fn()}
        surchargePercent={null}
        onChangeSurchargePercent={onPct}
        defaultPercent={9}
      />,
    );
    const input = screen.getByLabelText("Процент надбавки за безналичный расчёт") as HTMLInputElement;
    expect(input.value).toBe("9");
    expect(screen.getByText(/по умолчанию 9 % из настроек/)).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "12,5" } });
    expect(onPct).toHaveBeenCalledWith(12.5);
    fireEvent.change(input, { target: { value: "" } });
    expect(onPct).toHaveBeenCalledWith(null);
  });

  it("перебитый процент: «сбросить» возвращает дефолт", () => {
    const onPct = vi.fn();
    render(
      <PaymentFormCard
        value="CASHLESS"
        onChange={vi.fn()}
        surchargePercent={12}
        onChangeSurchargePercent={onPct}
        defaultPercent={9}
      />,
    );
    expect(screen.getByText(/по умолчанию 9 %/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "сбросить" }));
    expect(onPct).toHaveBeenCalledWith(null);
  });

  it("без права править процент поле заблокировано", () => {
    render(
      <PaymentFormCard
        value="CASHLESS"
        onChange={vi.fn()}
        surchargePercent={null}
        onChangeSurchargePercent={vi.fn()}
        defaultPercent={9}
        canEditPercent={false}
      />,
    );
    expect(screen.getByLabelText("Процент надбавки за безналичный расчёт")).toBeDisabled();
  });
});
