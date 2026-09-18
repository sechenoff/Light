/**
 * Страница инвентаризации: какой экран открывается по умолчанию, подменю со
 * значком «№ N · идёт», переключатель «Счёт · Итог» в URL, «Пересчитать» из
 * итога возвращает строку к счёту, завершённая — только чтение.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../hooks/useRequireRole", () => ({
  useRequireRole: () => ({ user: { role: "WAREHOUSE" }, loading: false, authorized: true }),
}));

let search = new URLSearchParams();
const routerReplace = vi.fn((url: string) => {
  search = new URLSearchParams(url.split("?")[1] ?? "");
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: routerReplace }),
  usePathname: () => "/warehouse/inventory/sc-1",
  useSearchParams: () => search,
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("../../ToastProvider", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const apiFetch = vi.fn();
vi.mock("../../../lib/api", () => ({
  apiFetch: (path: string, init?: RequestInit) => apiFetch(path, init),
}));

import { InventoryPage } from "../InventoryPage";
import type { StockCountDetail, StockCountLineView } from "../types";
import { makeCategory, makeDetail, makeLine, makeTotals, makeTrail, shortageLine } from "./fixtures";

function routeApi(detail: StockCountDetail, lines: StockCountLineView[], discrepancies: StockCountLineView[]) {
  apiFetch.mockImplementation((path: string, init?: RequestInit) => {
    if (path === `/api/stock-counts/${detail.id}`) return Promise.resolve({ stockCount: detail });
    if (path.includes("/lines?filter=discrepancy")) return Promise.resolve({ lines: discrepancies });
    // Строка расхождения без решения сама подгружает «Как пропало».
    if (path.endsWith("/trail")) return Promise.resolve({ trail: makeTrail() });
    if (path.includes("/lines?")) return Promise.resolve({ lines });
    if (path.endsWith("/reset") && init?.method === "POST") {
      return Promise.resolve({ line: makeLine({ id: discrepancies[0]!.id }) });
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  search = new URLSearchParams();
});

describe("InventoryPage", () => {
  it("идёт и есть непосчитанное — открывается «Счёт»: рейл категорий, строки, подменю «№ N · идёт»", async () => {
    const detail = makeDetail();
    routeApi(detail, [makeLine()], []);
    render(<InventoryPage id="sc-1" />);

    expect(await screen.findByRole("heading", { name: "Инвентаризация № 1", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Счёт/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("link", { name: /Инвентаризация\s?№ 1 · идёт/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Акт № 1 (PDF)" })).toHaveAttribute("href", "/api/stock-counts/sc-1/act.pdf");
    expect(screen.getByRole("link", { name: "XLSX" })).toHaveAttribute("href", "/api/stock-counts/sc-1/act.xlsx");
    expect(screen.getByText(/1 позиция со штучным учётом сверяется в карточке единиц/)).toBeInTheDocument();
    expect(await screen.findByText("Удлинитель PCE (15м)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Отменить/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Итог/ }));
    expect(routerReplace).toHaveBeenCalledWith("/warehouse/inventory/sc-1?view=review", { scroll: false });
  });

  it("всё посчитано — «Итог»: баннер первой инвентаризации, недостача без решения, «Завершить» заблокирована", async () => {
    const detail = makeDetail({
      totals: makeTotals({ lines: 4, counted: 4, matched: 3, shortagePositions: 1, shortageQty: 3, surplusPositions: 0, surplusQty: 0, undecided: 1 }),
      categoryProgress: [makeCategory({ lines: 4, counted: 4, discrepancies: 1 })],
    });
    routeApi(detail, [], [shortageLine()]);
    render(<InventoryPage id="sc-1" />);

    expect(await screen.findByText("Это первая инвентаризация.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Итог/ })).toHaveAttribute("aria-pressed", "true");
    const group = await screen.findByRole("group", { name: "Фильтр: недостача" });
    expect(within(group).getByRole("button", { name: "без решения · 1" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Завершить — осталось решить 1" })).toBeDisabled();
  });

  it("«Пересчитать» в итоге сбрасывает строку и возвращает к счёту её категории", async () => {
    const detail = makeDetail({
      totals: makeTotals({ lines: 4, counted: 4, undecided: 1 }),
      categoryProgress: [makeCategory({ lines: 4, counted: 4 })],
    });
    routeApi(detail, [], [shortageLine()]);
    render(<InventoryPage id="sc-1" />);

    const row = await screen.findByTestId("discrepancy-line-1");
    fireEvent.click(within(row).getByRole("button", { name: "Пересчитать" }));

    await waitFor(() =>
      expect(routerReplace).toHaveBeenCalledWith(
        `/warehouse/inventory/sc-1?view=count&category=${encodeURIComponent("Электрика / Коммутация").replace(/%20/g, "+")}`,
        { scroll: false },
      ),
    );
    expect(apiFetch).toHaveBeenCalledWith("/api/stock-counts/sc-1/lines/line-1/reset", expect.objectContaining({ method: "POST" }));
  });

  it("завершённая — только «Итог» на чтение: без переключателя, без «Отменить», с итогом вместо «Завершить»", async () => {
    const detail = makeDetail({
      status: "CLOSED",
      closedAt: "2026-09-18T13:48:00.000Z",
      closedByName: "sechenoff",
      totals: makeTotals({ undecided: 0 }),
    });
    routeApi(detail, [], [shortageLine({ decision: "LOST", decidedBy: "sechenoff", allowedDecisions: [] })]);
    render(<InventoryPage id="sc-1" />);

    expect(await screen.findByRole("heading", { name: "Инвентаризация завершена" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Экран инвентаризации" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Отменить/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Это первая инвентаризация.")).not.toBeInTheDocument();
    const lost = await screen.findByRole("button", { name: "Пропало → потеряшки" });
    expect(lost).toHaveAttribute("aria-pressed", "true");
    expect(lost).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("link", { name: "История инвентаризаций" })).toHaveAttribute("aria-current", "page");
  });
});
