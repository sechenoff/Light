/**
 * Страница киоска и инвентаризация: идущая инвентаризация читается вместе со
 * сменой и доходит до «Смены»; сбой этого запроса смену не ломает; `?tab=count`
 * открывает экран счёта, а «Считать» переводит на него.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StockCountDetail } from "../../inventory/types";

const h = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  search: "",
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: h.push, replace: h.replace }),
  useSearchParams: () => new URLSearchParams(h.search),
}));

vi.mock("../../../lib/auth", () => ({
  useCurrentUser: () => ({
    user: { role: "WAREHOUSE", username: "ivan" },
    loading: false,
  }),
}));

vi.mock("../../ToastProvider", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const api = vi.hoisted(() => ({
  getShift: vi.fn(),
  getActiveStockCount: vi.fn(),
  listBookings: vi.fn(),
  clearWarehouseToken: vi.fn(),
}));
vi.mock("../api", () => ({ scanApi: api }));

// Содержимое «Смены» и экрана счёта тестируется отдельно — здесь только то,
// что страница им передаёт.
vi.mock("../ShiftHome", () => ({
  ShiftHome: ({
    stockCount,
    onGoCount,
  }: {
    stockCount?: StockCountDetail | null;
    onGoCount?: () => void;
  }) => (
    <div>
      SHIFT-HOME
      {stockCount && (
        <button type="button" onClick={onGoCount}>
          COUNT-CARD № {stockCount.number}
        </button>
      )}
    </div>
  ),
  shiftHeaderTitle: (name: string) => `Смена — ${name}`,
  shiftHeaderEyebrow: () => "Склад · Смена",
}));

vi.mock("../StockCountScreen", () => ({
  StockCountScreen: ({
    initial,
    workerName,
    onExit,
  }: {
    initial?: StockCountDetail | null;
    workerName: string;
    onExit: () => void;
  }) => (
    <div>
      COUNT-SCREEN {workerName} {initial ? `№ ${initial.number}` : "без данных"}
      <button type="button" onClick={onExit}>
        EXIT
      </button>
    </div>
  ),
}));

import WarehouseScanPage from "../../../../app/warehouse/scan/page";

const SHIFT = {
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
  myShift: { workerName: "ivan", sessions: 0, items: 0, firstAt: null, avgMinutes: null },
};

const COUNT = { id: "sc-1", number: 2, status: "OPEN" } as StockCountDetail;

beforeEach(() => {
  vi.clearAllMocks();
  h.search = "";
  api.getShift.mockResolvedValue(SHIFT);
  api.getActiveStockCount.mockResolvedValue(COUNT);
});

describe("WarehouseScanPage — инвентаризация", () => {
  it("идущая инвентаризация доходит до «Смены», «Считать» ведёт на ?tab=count", async () => {
    render(<WarehouseScanPage />);

    fireEvent.click(await screen.findByRole("button", { name: "COUNT-CARD № 2" }));

    expect(h.replace).toHaveBeenCalledWith("/warehouse/scan?tab=count", { scroll: false });
    expect(await screen.findByText("COUNT-SCREEN ivan № 2")).toBeInTheDocument();
  });

  it("сбой запроса инвентаризации смену не ломает", async () => {
    api.getActiveStockCount.mockRejectedValue({ status: 500, code: null, message: "boom", details: null });
    render(<WarehouseScanPage />);

    expect(await screen.findByText("SHIFT-HOME")).toBeInTheDocument();
    await waitFor(() => expect(api.getActiveStockCount).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /COUNT-CARD/ })).not.toBeInTheDocument();
  });

  it("?tab=count — диплинк сразу на экран счёта; выход — на «Смену»", async () => {
    h.search = "tab=count";
    render(<WarehouseScanPage />);

    expect(await screen.findByText(/COUNT-SCREEN ivan/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "EXIT" }));
    expect(await screen.findByText("SHIFT-HOME")).toBeInTheDocument();
    expect(h.replace).toHaveBeenCalledWith("/warehouse/scan?tab=shift", { scroll: false });
  });
});
