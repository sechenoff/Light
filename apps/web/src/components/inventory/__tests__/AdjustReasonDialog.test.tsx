/**
 * «Ошибка учёта»: набранная причина переживает перечитывание списка
 * расхождений (та же строка приходит новым объектом раз в 20 с), а новое
 * открытие диалога начинается с чистого поля.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AdjustReasonDialog } from "../AdjustReasonDialog";
import type { StockCountLineView } from "../types";
import { shortageLine } from "./fixtures";

function renderDialog(line: StockCountLineView | null) {
  const props = { busy: false, onClose: vi.fn(), onSubmit: vi.fn() };
  const utils = render(<AdjustReasonDialog line={line} {...props} />);
  return {
    ...utils,
    rerenderWith: (next: StockCountLineView | null) => utils.rerender(<AdjustReasonDialog line={next} {...props} />),
  };
}

function field(): HTMLTextAreaElement {
  return screen.getByLabelText(/Причина/) as HTMLTextAreaElement;
}

describe("AdjustReasonDialog — сброс формы", () => {
  it("та же строка новым объектом (список перечитался) — набранная причина остаётся", () => {
    const line = shortageLine();
    const { rerenderWith } = renderDialog(line);

    fireEvent.change(field(), { target: { value: "с импорта было 50" } });
    rerenderWith({ ...line });
    expect(field()).toHaveValue("с импорта было 50");

    // И после второго перечитывания, уже с другими числами той же строки.
    rerenderWith({ ...line, countedQty: 46, diff: -4 });
    expect(field()).toHaveValue("с импорта было 50");
  });

  it("закрыли и открыли ту же строку снова — поле пустое", () => {
    const line = shortageLine();
    const { rerenderWith } = renderDialog(line);

    fireEvent.change(field(), { target: { value: "с импорта было 50" } });
    rerenderWith(null);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    rerenderWith({ ...line });
    expect(field()).toHaveValue("");
  });

  it("другая строка — поле сброшено", () => {
    const { rerenderWith } = renderDialog(shortageLine());

    fireEvent.change(field(), { target: { value: "с импорта было 50" } });
    rerenderWith(shortageLine({ id: "other", name: "Кабель 32/220 (15м)" }));
    expect(field()).toHaveValue("");
  });

  it("строка уже с «Ошибкой учёта» — открывается с записанной причиной", () => {
    renderDialog(shortageLine({ decision: "ADJUST", decisionNote: "в каталоге 50, по факту 47" }));
    expect(field()).toHaveValue("в каталоге 50, по факту 47");
  });
});
