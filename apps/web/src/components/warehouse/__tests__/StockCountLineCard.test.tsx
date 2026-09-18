/**
 * Карточка строки инвентаризации в киоске: две большие кнопки для позиции в
 * одном экземпляре, степпер + «Всё на месте» для остальных, тексты итога.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StockCountLineView } from "../../inventory/types";
import { StockCountLineCard } from "../StockCountLineCard";

function line(over: Partial<StockCountLineView> = {}): StockCountLineView {
  return {
    id: "ln-1",
    equipmentId: "eq-1",
    name: "страховка цепь",
    category: "Грип",
    ratePerShift: "100",
    position: 1,
    expected: { total: 41, issued: 0, calendar: 0, repair: 0, lost: 0, expected: 41 },
    expectedIsSnapshot: false,
    calendarBookings: [],
    countedQty: null,
    countedBy: null,
    countedAt: null,
    diff: null,
    decision: null,
    decisionNote: null,
    decidedBy: null,
    decidedAt: null,
    sourceBookingId: null,
    sourceBooking: null,
    openProblemQty: 0,
    allowedDecisions: [],
    ...over,
  };
}

function renderCard(l: StockCountLineView, over: { compact?: boolean; current?: boolean } = {}) {
  const onCount = vi.fn();
  const onReset = vi.fn();
  render(
    <StockCountLineCard
      line={l}
      current={over.current ?? true}
      compact={over.compact ?? false}
      saving={false}
      error={null}
      onCount={onCount}
      onReset={onReset}
    />,
  );
  return { onCount, onReset };
}

const SINGLE = { total: 1, issued: 0, calendar: 0, repair: 0, lost: 0, expected: 1 };

describe("StockCountLineCard — позиция в одном экземпляре", () => {
  it("«✓ На месте» сохраняет 1 сразу, «Нет на полке» — 0", () => {
    const { onCount } = renderCard(line({ name: "Magic Flex ARM", expected: SINGLE }));

    expect(screen.getByText("по учёту 1 шт")).toBeInTheDocument();
    // Степпера у штучной позиции нет — только две большие кнопки.
    expect(screen.queryByLabelText(/Больше/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "✓ На месте" }));
    expect(onCount).toHaveBeenLastCalledWith(1, "now");

    fireEvent.click(screen.getByRole("button", { name: "Нет на полке" }));
    expect(onCount).toHaveBeenLastCalledWith(0, "now");
  });

  it("после счёта: «✓ на месте · 1 из 1» и «Пересчитать» вместо кнопок", () => {
    const { onReset } = renderCard(
      line({ expected: SINGLE, countedQty: 1, diff: 0 }),
      { compact: true, current: false },
    );

    expect(screen.getByText("✓ на месте · 1 из 1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "✓ На месте" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Пересчитать" }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("нет на полке → недостача, решает руководитель", () => {
    renderCard(line({ expected: SINGLE, countedQty: 0, diff: -1 }), { compact: true });
    expect(screen.getByText("−1 · решит руководитель после счёта")).toBeInTheDocument();
  });
});

describe("StockCountLineCard — степпер", () => {
  const BY_CALENDAR = line({
    expected: { total: 41, issued: 0, calendar: 6, repair: 0, lost: 0, expected: 35 },
    calendarBookings: [
      { bookingId: "b1", projectName: "Лето", clientName: "Клиент", quantity: 6, endDate: "2026-09-20T18:00:00.000Z" },
    ],
  });

  it("крупно «должно быть N» и пояснение по календарю (amber)", () => {
    renderCard(BY_CALENDAR);
    expect(screen.getByText("35")).toBeInTheDocument();
    const calendar = screen.getByText("6 у «Лето» по календарю");
    expect(calendar).toHaveClass("text-amber");
    expect(screen.getByText("всего 41")).toBeInTheDocument();
  });

  it("«Всё на месте · N» сохраняет «должно быть» сразу", () => {
    const { onCount } = renderCard(BY_CALENDAR);
    fireEvent.click(screen.getByRole("button", { name: "Всё на месте · 35" }));
    expect(onCount).toHaveBeenCalledWith(35, "now");
  });

  it("с пустого степпер шагает от «должно быть», с задержкой сохранения", () => {
    const { onCount } = renderCard(BY_CALENDAR);
    fireEvent.click(screen.getByRole("button", { name: "Меньше — страховка цепь" }));
    expect(onCount).toHaveBeenLastCalledWith(34, "debounced");
    fireEvent.click(screen.getByRole("button", { name: "Больше — страховка цепь" }));
    expect(onCount).toHaveBeenLastCalledWith(36, "debounced");
  });

  it("ручной ввод числа — тоже с задержкой", () => {
    const { onCount } = renderCard(BY_CALENDAR);
    fireEvent.change(screen.getByLabelText("Посчитано — страховка цепь"), {
      target: { value: "33" },
    });
    expect(onCount).toHaveBeenLastCalledWith(33, "debounced");
  });

  it("цели степпера не меньше 44 px", () => {
    renderCard(BY_CALENDAR);
    expect(screen.getByRole("button", { name: "Больше — страховка цепь" })).toHaveClass("h-11", "w-11");
  });

  it.each([
    [{ countedQty: 33, diff: -2 }, "−2 · решит руководитель после счёта", "text-rose"],
    [{ countedQty: 35, diff: 0 }, "✓ сошлось · 35", "text-emerald"],
    [{ countedQty: 36, diff: 1 }, "+1 · излишек — решит руководитель", "text-emerald"],
  ])("итог строки %o → «%s»", (counted, text, tone) => {
    renderCard({ ...BY_CALENDAR, ...counted });
    expect(screen.getByText(text)).toHaveClass(tone);
    // Посчитанная строка больше не предлагает «Всё на месте».
    expect(screen.queryByRole("button", { name: /Всё на месте/ })).not.toBeInTheDocument();
  });
});

describe("StockCountLineCard — «Пересчитать»", () => {
  const DECIDED = line({
    countedQty: 39,
    diff: -2,
    countedBy: "Иван",
    decision: "ADJUST",
    decisionNote: "пересорт",
    decidedBy: "sechenoff",
  });

  it("цель не меньше 44 px", () => {
    renderCard(line({ countedQty: 41, diff: 0 }), { compact: true, current: false });
    expect(screen.getByRole("button", { name: "Пересчитать" })).toHaveClass(
      "min-h-[44px]",
      "min-w-[44px]",
    );
  });

  it("строка без решения сбрасывается одним касанием", () => {
    const { onReset } = renderCard(line({ countedQty: 39, diff: -2 }), { compact: true, current: false });
    fireEvent.click(screen.getByRole("button", { name: "Пересчитать" }));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/пересчёт снимет решение/)).not.toBeInTheDocument();
  });

  it("решённая руководителем строка помечена и спрашивает ещё раз", () => {
    const { onReset } = renderCard(DECIDED, { compact: true, current: false });
    expect(screen.getByText("решено руководителем")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Пересчитать" }));
    expect(onReset).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Руководитель уже решил по этой строке — пересчёт снимет решение",
    );
    // Фокус — на безопасном варианте; обе цели не меньше 44 px.
    const cancel = screen.getByRole("button", { name: "Отмена" });
    expect(cancel).toHaveFocus();
    expect(cancel).toHaveClass("min-h-[44px]");
    expect(screen.getByRole("button", { name: "Пересчитать всё равно" })).toHaveClass("min-h-[44px]");

    fireEvent.click(cancel);
    expect(screen.queryByText(/пересчёт снимет решение/)).not.toBeInTheDocument();
    expect(onReset).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Пересчитать" }));
    fireEvent.click(screen.getByRole("button", { name: "Пересчитать всё равно" }));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/пересчёт снимет решение/)).not.toBeInTheDocument();
  });
});
