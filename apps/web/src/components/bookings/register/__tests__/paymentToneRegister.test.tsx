/**
 * Заливка строк и карточек реестра по оплате — на странице целиком: тон ставит
 * BookingRegister, а выбор галочкой не должен его стирать.
 */
import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: () => null, toString: () => "" }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/bookings",
}));
vi.mock("../../../../hooks/useRequireRole", () => ({
  useRequireRole: () => ({ user: { role: "SUPER_ADMIN" }, loading: false, authorized: true }),
}));
vi.mock("../../../../hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: { role: "SUPER_ADMIN", name: "Тест" }, loading: false }),
}));
vi.mock("../../../ToastProvider", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import BookingsPage from "../../../../../app/bookings/page";

const ORIGINAL_FETCH = global.fetch;

function booking(id: string, patch: Record<string, unknown>) {
  return {
    id,
    projectName: `Проект ${id}`,
    status: "CONFIRMED",
    paymentStatus: "NOT_PAID",
    startDate: "2026-10-08T06:00:00.000Z",
    endDate: "2026-10-09T06:00:00.000Z",
    finalAmount: "10000",
    amountPaid: "0",
    amountOutstanding: "10000",
    client: { id: `c-${id}`, name: `Клиент ${id}` },
    items: [], mode: "STANDARD", financeState: "UNPAID", overdueAmount: "0", overdueDays: 0, creditAmount: "0",
    completed: false, onHand: 0, actions: [], projectSummary: null, writeOffAmount: "0",
    ...patch,
  };
}

const BOOKINGS = [
  booking("paid", { status: "RETURNED", financeState: "PAID", amountPaid: "10000", amountOutstanding: "0", completed: true }),
  booking("settled", { status: "RETURNED", financeState: "SETTLED", amountPaid: "9500", amountOutstanding: "0", writeOffAmount: "500" }),
  booking("partial", { status: "ISSUED", financeState: "PARTIAL", amountPaid: "4000", amountOutstanding: "6000" }),
  booking("future", { status: "CONFIRMED", financeState: "UNPAID" }),
  booking("draft", { status: "DRAFT", financeState: "UNPAID" }),
  booking("cancelled", { status: "CANCELLED", financeState: "UNPAID" }),
  booking("zero", { status: "RETURNED", financeState: "ZERO", finalAmount: "0", amountOutstanding: "0" }),
];

function mockApi() {
  const body = {
    bookings: BOOKINGS, nextCursor: null, totalCount: BOOKINGS.length, scopeCounts: {},
    summary: { active: 1, issued: 1, outstanding: "16000", overdue: "0", unpaid: 2, overdueCount: 0, total: "59500", paid: "23500" },
    options: { clients: [], projects: [] },
    totals: { count: BOOKINGS.length, outstanding: "16000", overdue: "0", total: "59500", paid: "23500" },
    day: { events: [], bookings: [] }, asOf: "2026-10-04T12:00:00Z",
  };
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = url.includes("/api/bookings/register?") ? body : {};
    return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) } as Response;
  }) as unknown as typeof fetch;
}

const rowTone = (id: string) =>
  document.querySelector(`tr[data-booking-row="${id}"]`)?.getAttribute("data-payment-tone") ?? null;
const cardTone = (id: string) =>
  document.querySelector(`[data-booking-card="${id}"]`)?.getAttribute("data-payment-tone") ?? null;

describe("/bookings — заливка по оплате", () => {
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
  });

  it("красит строку и карточку: оплаченные — зелёным, с остатком — красным, остальные не трогает", async () => {
    mockApi();
    render(<BookingsPage />);
    await screen.findAllByText("Проект paid");

    const expected: Record<string, string | null> = {
      paid: "paid",
      settled: "paid",
      partial: "unpaid",
      future: "unpaid",
      draft: null,
      cancelled: null,
      zero: null,
    };
    for (const [id, tone] of Object.entries(expected)) {
      expect(rowTone(id), `строка ${id}`).toBe(tone);
      expect(cardTone(id), `карточка ${id}`).toBe(tone);
    }
    expect(document.querySelector('tr[data-booking-row="paid"]')!.className).toContain("bg-emerald-soft/60");
    expect(document.querySelector('tr[data-booking-row="future"]')!.className).toContain("bg-rose-soft/70");
    expect(document.querySelector('tr[data-booking-row="draft"]')!.className).not.toMatch(/emerald-soft|rose-soft/);
  });

  it("показывает легенду цветов рядом со счётчиком списка", async () => {
    mockApi();
    render(<BookingsPage />);
    await screen.findAllByText("Проект paid");
    const legend = screen.getByTitle(/Цвет — по оплате/);
    expect(within(legend).getByText("Оплачено")).toBeInTheDocument();
    expect(within(legend).getByText("Есть остаток")).toBeInTheDocument();
  });

  it("выбор галочкой сохраняет цвет строки и отмечает её полосой слева", async () => {
    mockApi();
    render(<BookingsPage />);
    await screen.findAllByText("Проект paid");
    const row = document.querySelector<HTMLTableRowElement>('tr[data-booking-row="partial"]')!;
    fireEvent.click(within(row).getByRole("checkbox", { name: "Выбрать Проект partial" }));

    expect(within(row).getByRole("checkbox", { name: "Выбрать Проект partial" })).toBeChecked();
    expect(row.getAttribute("data-payment-tone")).toBe("unpaid");
    expect(row.className).toContain("bg-rose-soft/70");
    expect(row.className).not.toContain("bg-accent-soft");
    expect(row.cells[0].className).toContain("shadow-accent");
    const other = document.querySelector<HTMLTableRowElement>('tr[data-booking-row="paid"]')!;
    expect(other.cells[0].className).not.toContain("shadow-accent");
  });
});
