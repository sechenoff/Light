/**
 * «Завершить инвентаризацию»: кнопка заблокирована с текстом «осталось решить
 * N», пока есть расхождения без решения; подтверждение → POST /complete →
 * тост со сводкой; 409 UNDECIDED_LINES — объяснение и перечитывание.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("../../ToastProvider", () => ({
  toast: {
    success: (m: string) => toastSuccess(m),
    error: (m: string) => toastError(m),
    info: vi.fn(),
  },
}));

const apiFetch = vi.fn();
vi.mock("../../../lib/api", () => ({
  apiFetch: (path: string, init?: RequestInit) => apiFetch(path, init),
}));

import { CompletePanel, completeSummary } from "../CompletePanel";
import type { CompleteResult } from "../types";
import { apiError, makeDetail, makeTotals } from "./fixtures";

const RESULT: CompleteResult = {
  matched: 3,
  lostPositions: 1,
  lostQty: 3,
  createdProblemItemIds: ["pi-1"],
  adjustedPositions: 1,
  foundPositions: 0,
  foundQty: 0,
  unexplainedSurplusQty: 0,
  verifiedPositions: 6,
  uncounted: 4,
  unitModeSkipped: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CompletePanel", () => {
  it("пока есть расхождения без решения — кнопка заблокирована и говорит, сколько осталось", () => {
    render(
      <CompletePanel detail={makeDetail({ totals: makeTotals({ undecided: 2 }) })} onCompleted={vi.fn()} onStale={vi.fn()} />,
    );
    const btn = screen.getByRole("button", { name: "Завершить — осталось решить 2" });
    expect(btn).toBeDisabled();
    expect(screen.getByText("пока не завершена — в учёт ничего не записано")).toBeInTheDocument();
    // 3 расхождения, 2 без решения → решено 1 из 3.
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1");
    fireEvent.click(btn);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("план завершения: потеряшки, поправки, «сверено», деньги под вопросом", () => {
    render(<CompletePanel detail={makeDetail()} onCompleted={vi.fn()} onStale={vi.fn()} />);
    expect(screen.getByText("В потеряшки — 1 позиция · 3 шт")).toBeInTheDocument();
    expect(screen.getByText("Поправки учёта — 1 позиция")).toBeInTheDocument();
    expect(screen.getByText(/6 позиций — «сверено/)).toBeInTheDocument();
    expect(screen.getByText(/4 непосчитанные останутся без отметки/)).toBeInTheDocument();
    expect(screen.getByText(/≈ 1 350 ₽ за смену/)).toBeInTheDocument();
    expect(screen.queryByText(/Нашлось —/)).not.toBeInTheDocument();
  });

  it("все решения приняты — подтверждение, POST /complete, тост со сводкой и переход в «завершена»", async () => {
    const closed = makeDetail({ status: "CLOSED", closedAt: "2026-09-18T13:48:00.000Z", closedByName: "sechenoff" });
    apiFetch.mockResolvedValueOnce({ stockCount: closed, result: RESULT });
    const onCompleted = vi.fn();
    render(<CompletePanel detail={makeDetail()} onCompleted={onCompleted} onStale={vi.fn()} />);

    const btn = screen.getByRole("button", { name: "Завершить инвентаризацию" });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);

    const dialog = screen.getByRole("dialog", { name: "Завершить и записать в учёт?" });
    expect(within(dialog).getByText(/4 позиции не посчитаны/)).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Завершить" }));

    await waitFor(() => expect(onCompleted).toHaveBeenCalledWith(closed, RESULT));
    expect(apiFetch).toHaveBeenCalledWith("/api/stock-counts/sc-1/complete", expect.objectContaining({ method: "POST" }));
    expect(toastSuccess).toHaveBeenCalledWith(completeSummary(1, RESULT));
    expect(completeSummary(1, RESULT)).toBe(
      "Инвентаризация № 1 завершена: в потеряшки — 1 позиция · 3 шт, поправлен учёт — 1 позиция, сверено — 6 позиций, не посчитано — 4",
    );
  });

  it("409 UNDECIDED_LINES — тост «осталось решить N», перечитать, ничего не завершено", async () => {
    apiFetch.mockRejectedValueOnce(apiError(409, "UNDECIDED_LINES", "Осталось решить: 2", { count: 2 }));
    const onCompleted = vi.fn();
    const onStale = vi.fn();
    render(<CompletePanel detail={makeDetail()} onCompleted={onCompleted} onStale={onStale} />);

    fireEvent.click(screen.getByRole("button", { name: "Завершить инвентаризацию" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Завершить" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Осталось решить: 2 — завершить пока нельзя"));
    expect(onStale).toHaveBeenCalled();
    expect(onCompleted).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("409 STOCK_COUNT_NOT_OPEN (уже завершили в другой вкладке) — объяснение и перечитать", async () => {
    apiFetch.mockRejectedValueOnce(apiError(409, "STOCK_COUNT_NOT_OPEN", "Инвентаризация уже завершена или отменена"));
    const onStale = vi.fn();
    render(<CompletePanel detail={makeDetail()} onCompleted={vi.fn()} onStale={onStale} />);

    fireEvent.click(screen.getByRole("button", { name: "Завершить инвентаризацию" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Завершить" }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Инвентаризация уже завершена или отменена — изменения не сохранены"),
    );
    expect(onStale).toHaveBeenCalled();
  });
});
