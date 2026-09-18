/**
 * «Смена»: карточка «Идёт инвентаризация № N → Считать» — вход в счёт полки.
 * Своей вкладки у инвентаризации нет, поэтому карточка — единственный вход.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StockCountDetail } from "../../inventory/types";
import type { ShiftSummaryData } from "../api";
import { ShiftHome } from "../ShiftHome";

const SHIFT: ShiftSummaryData = {
  date: "2026-09-18",
  timeline: [],
  overdue: [],
  readyForPickup: [],
  counters: {
    issuesDone: 0,
    issuesPlanned: 0,
    returnsDone: 0,
    returnsPlanned: 0,
    overdue: 0,
    inWork: 0,
  },
  myShift: { workerName: "Иван", sessions: 0, items: 0, firstAt: null, avgMinutes: null },
};

const COUNT: StockCountDetail = {
  id: "sc-1",
  number: 3,
  status: "OPEN",
  categories: null,
  startedAt: "2026-09-18T06:30:00.000Z",
  closedAt: null,
  cancelledAt: null,
  createdByName: "sechenoff",
  closedByName: null,
  counters: ["Иван"],
  totals: {
    lines: 295,
    counted: 23,
    matched: 21,
    shortagePositions: 1,
    shortageQty: 2,
    surplusPositions: 0,
    surplusQty: 0,
    undecided: 1,
    shortageRatePerShift: "200",
  },
  categoryProgress: [
    { category: "Грип", lines: 51, counted: 23, discrepancies: 1, counters: ["Иван"] },
    { category: "Свет", lines: 244, counted: 0, discrepancies: 0, counters: [] },
  ],
  unitModeExcluded: 1,
  isFirst: true,
  decisionsPlan: {
    lostPositions: 0,
    lostQty: 0,
    adjustPositions: 0,
    adjustMinusQty: 0,
    adjustPlusQty: 0,
    foundPositions: 0,
    foundQty: 0,
  },
};

function renderShift(props: Partial<Parameters<typeof ShiftHome>[0]> = {}) {
  const onGoCount = vi.fn();
  render(
    <ShiftHome
      data={SHIFT}
      error={null}
      onRetry={vi.fn()}
      onGoIssue={vi.fn()}
      onGoReturn={vi.fn()}
      onGoOverdue={vi.fn()}
      onOpenEntry={vi.fn()}
      stockCount={COUNT}
      onGoCount={onGoCount}
      {...props}
    />,
  );
  return { onGoCount };
}

describe("ShiftHome — карточка инвентаризации", () => {
  it("пока идёт инвентаризация — номер, прогресс и «ваш участок»", () => {
    renderShift();

    const card = screen.getByRole("region", { name: "Идёт инвентаризация № 3" });
    expect(card).toHaveTextContent("посчитано 23 из 295 позиций");
    expect(card).toHaveTextContent("ваш участок: Грип");
    expect(screen.getByRole("progressbar", { name: "Посчитано 23 из 295" })).toBeInTheDocument();
  });

  it("«Считать →» ведёт в счёт", () => {
    const { onGoCount } = renderShift();
    fireEvent.click(screen.getByRole("button", { name: "Считать →" }));
    expect(onGoCount).toHaveBeenCalledTimes(1);
  });

  it("инвентаризация не идёт — карточки нет", () => {
    renderShift({ stockCount: null });
    expect(screen.queryByRole("region", { name: /Идёт инвентаризация/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Считать →" })).not.toBeInTheDocument();
  });

  it("завершённая инвентаризация карточку не показывает", () => {
    renderShift({ stockCount: { ...COUNT, status: "CLOSED" } });
    expect(screen.queryByRole("button", { name: "Считать →" })).not.toBeInTheDocument();
  });

  it("смена не загрузилась — карточка всё равно есть", () => {
    renderShift({ data: null, error: "Не удалось загрузить смену" });
    expect(screen.getByText("Не удалось загрузить смену")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Считать →" })).toBeInTheDocument();
  });
});
