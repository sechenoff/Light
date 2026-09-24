/**
 * ЛК, карточка заказа: позиции сметы идут группами категорий (полоса над
 * группой, порядок — серверный), без отдельной колонки/подписи категории.
 * В режиме проекта в categorySnapshot лежит период — там групп нет.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import LkBookingDetailPage from "../../../../app/lk/bookings/[id]/page";

const mocks = vi.hoisted(() => ({ booking: vi.fn() }));

vi.mock("next/navigation", () => ({ useParams: () => ({ id: "bk1" }) }));
vi.mock("../../../lib/lkApi", () => ({ lkApi: { booking: mocks.booking } }));

const BASE = {
  id: "bk1",
  bookingNo: "#ABC123",
  projectName: "Съёмка",
  startDate: "2026-09-24T10:00:00.000Z",
  endDate: "2026-09-25T10:00:00.000Z",
  status: "CONFIRMED",
  shifts: 1,
  subtotal: "30000",
  discountAmount: "0",
  totalAfterDiscount: "30000",
  finalAmount: "30000",
  amountPaid: "0",
  amountOutstanding: "30000",
  comment: null,
  optionalNote: null,
  hasConfirmedEstimate: true,
  hasAct: false,
  transportSubtotal: "0",
  hasInvoice: false,
  invoiceNumber: null,
};

const line = (categorySnapshot: string, nameSnapshot: string) => ({
  categorySnapshot,
  nameSnapshot,
  quantity: 1,
  unitPrice: "10000",
  lineSum: "10000",
});

function tableGroups() {
  return within(screen.getByRole("table"))
    .getAllByRole("rowgroup")
    .filter((g) => g.tagName === "TBODY")
    .map((g) => within(g).getAllByRole("row").map((r) => r.textContent ?? ""));
}

describe("ЛК · карточка заказа — группы категорий", () => {
  beforeEach(() => mocks.booking.mockReset());

  it("puts lines under category bands in arrival order, without a «Категория» column", async () => {
    mocks.booking.mockResolvedValue({
      ...BASE,
      items: [line("Грип", "C-Stand"), line("Свет", "Aputure 600d"), line("Свет", "SkyPanel S60")],
    });
    render(<LkBookingDetailPage />);
    await screen.findByText("Съёмка");

    const groups = tableGroups();
    expect(groups.map((g) => g[0])).toEqual(["Грип", "Свет"]);
    const svetRows = within(within(screen.getByRole("table")).getAllByRole("rowgroup")[2]).getAllByRole("row").slice(1);
    expect(svetRows.map((r) => within(r).getAllByRole("cell")[0].textContent)).toEqual(["Aputure 600d", "SkyPanel S60"]);
    const table = within(screen.getByRole("table"));
    expect(table.queryByRole("columnheader", { name: /Категория|Период/ })).toBeNull();

    // Мобильный список: своя группа под каждой полосой, подписи категории у строк нет.
    const lists = screen.getAllByRole("list");
    expect(lists.map((l) => l.previousElementSibling?.textContent)).toEqual(["Грип", "Свет"]);
    expect(within(lists[1]).queryByText("Свет")).toBeNull();
  });

  it("project mode keeps the period column and draws no category bands", async () => {
    mocks.booking.mockResolvedValue({
      ...BASE,
      mode: "PROJECT",
      restDays: 0,
      restPercent: 50,
      forecastTotal: "20000",
      periods: [],
      items: [line("2026-09-24 — 2026-09-30", "C-Stand"), line("2026-09-24 — 2026-09-27", "Aputure 600d")],
    });
    render(<LkBookingDetailPage />);
    await screen.findByText("Съёмка");

    expect(tableGroups()).toHaveLength(1);
    expect(tableGroups()[0]).toHaveLength(2);
    expect(within(screen.getByRole("table")).getByRole("columnheader", { name: "Период" })).toBeInTheDocument();
    expect(screen.getAllByRole("list")).toHaveLength(1);
  });
});
