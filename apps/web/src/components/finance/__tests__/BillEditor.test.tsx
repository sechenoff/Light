/**
 * Редактор счёта на оплату: заготовка по брони, выставление с печатью,
 * карточка выставленного счёта со статусами.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { BillEditor } from "../BillEditor";

const apiFetchMock = vi.fn();
vi.mock("../../../lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiFetchRaw: vi.fn(),
}));

const printMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("../../../lib/estimateExport", () => ({
  printEstimate: (...args: unknown[]) => printMock(...args),
  downloadEstimate: vi.fn(async () => undefined),
}));

const replaceMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
}));

const PAYER = {
  name: "Эпикпро",
  legalName: "ООО «Эпикпро»",
  inn: "7701234567",
  kpp: "770101001",
  ogrn: null,
  legalAddress: "г. Москва, ул. Киношная, 1",
  postalAddress: null,
  bankName: null,
  bankBik: null,
  rschet: null,
  kschet: null,
  phone: null,
  email: null,
};

const BILL = {
  id: "bill-1",
  year: 2026,
  number: 12,
  date: "2026-09-16T09:00:00.000Z",
  status: "ISSUED",
  clientId: "c-1",
  clientName: "Эпикпро",
  bookingId: null,
  basis: "Договор № 12",
  taxNote: "Без НДС (УСН)",
  dueDate: "2026-09-30T09:00:00.000Z",
  total: "52102",
  payer: PAYER,
  seller: { name: "ИП Светов", rschet: "40802810400001234567", bankName: "Банк" },
  notes: null,
  paidAt: null,
  cancelledAt: null,
  lines: [{ id: "l1", position: 1, name: "Аренда света", unit: "усл. ед.", quantity: "1", price: "52102", sum: "52102" }],
};

beforeEach(() => {
  apiFetchMock.mockReset();
  printMock.mockClear();
  replaceMock.mockClear();
});

describe("BillEditor — создание", () => {
  it("заготовка по брони: клиент, реквизиты и строки подставлены, итог сходится", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/bills/next-number") return { year: 2026, number: 13 };
      if (path.startsWith("/api/bills/prefill")) {
        return {
          bookingId: "b-1",
          clientId: "c-1",
          client: { id: "c-1", ...PAYER },
          basis: "Смета № СМ-2026-0042 от 12.09.2026",
          dueDate: null,
          lines: [
            { name: "Аренда светового оборудования", unit: "усл. ед.", quantity: "1", price: "10000" },
            { name: "Безналичный расчёт, +9 %", unit: "усл. ед.", quantity: "1", price: "900" },
          ],
          expectedTotal: "10900",
          paymentForm: "CASHLESS",
          taxNote: null,
        };
      }
      if (path.startsWith("/api/clients")) return { clients: [] };
      throw new Error(`unexpected ${path}`);
    });

    render(<BillEditor mode="create" bookingId="b-1" />);

    await waitFor(() => expect(screen.getByDisplayValue("Аренда светового оборудования")).toBeInTheDocument());
    expect(screen.getByDisplayValue("Безналичный расчёт, +9 %")).toBeInTheDocument();
    expect(screen.getByDisplayValue("ООО «Эпикпро»")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Смета № СМ-2026-0042 от 12.09.2026")).toBeInTheDocument();
    // Итог 10 900 — расхождения с бронью нет
    expect(screen.getByText("10 900").closest("aside")).not.toBeNull();
    expect(screen.queryByText(/По брони к оплате/)).toBeNull();
    expect(screen.getByPlaceholderText("авто: 13")).toBeInTheDocument();
  });

  it("«Выставить и распечатать» шлёт POST с контрагентом и строками и печатает PDF", async () => {
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/bills/next-number") return { year: 2026, number: 1 };
      if (path.startsWith("/api/clients")) return { clients: [] };
      if (path === "/api/bills" && init?.method === "POST") return { ...BILL, id: "bill-new", number: 1 };
      throw new Error(`unexpected ${path}`);
    });

    render(<BillEditor mode="create" />);
    await waitFor(() => expect(screen.getByPlaceholderText("авто: 1")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Контрагент"), { target: { value: "Новый ООО" } });
    fireEvent.change(screen.getByLabelText("Наименование позиции 1"), { target: { value: "Монтаж ролика" } });
    fireEvent.change(screen.getByLabelText("Цена"), { target: { value: "15 000,50" } });

    const submit = screen.getByRole("button", { name: /Выставить и распечатать/ });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);

    await waitFor(() => expect(printMock).toHaveBeenCalledWith("/api/bills/bill-new/pdf", "Счёт не найден"));
    const post = apiFetchMock.mock.calls.find(([p, i]) => p === "/api/bills" && (i as RequestInit)?.method === "POST");
    expect(post).toBeTruthy();
    const body = JSON.parse(String((post![1] as RequestInit).body));
    expect(body.client.name).toBe("Новый ООО");
    expect(body.lines).toEqual([{ name: "Монтаж ролика", unit: "усл. ед.", quantity: "1", price: "15000.5" }]);
    expect(replaceMock).toHaveBeenCalledWith("/finance/bills/bill-new");
  });

  it("без названия позиции и цены кнопка выставления заблокирована", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/bills/next-number") return { year: 2026, number: 1 };
      if (path.startsWith("/api/clients")) return { clients: [] };
      throw new Error(`unexpected ${path}`);
    });
    render(<BillEditor mode="create" />);
    await waitFor(() => expect(screen.getByPlaceholderText("авто: 1")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Контрагент"), { target: { value: "Кто-то" } });
    expect(screen.getByRole("button", { name: /Выставить и распечатать/ })).toBeDisabled();
    expect(screen.getByText(/Заполните/)).toBeInTheDocument();
  });
});

describe("BillEditor — карточка", () => {
  it("показывает статус, печатает и отмечает оплаченным", async () => {
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/bills/bill-1") return BILL;
      if (path === "/api/bills/bill-1/status" && init?.method === "POST") {
        return { ...BILL, status: JSON.parse(String(init.body)).status, paidAt: "2026-09-17T00:00:00.000Z" };
      }
      throw new Error(`unexpected ${path}`);
    });

    render(<BillEditor mode="edit" billId="bill-1" />);
    await waitFor(() => expect(screen.getByText("Выставлен")).toBeInTheDocument());
    expect(screen.getByText(/Счёт № 12 от/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Печать" }));
    expect(printMock).toHaveBeenCalledWith("/api/bills/bill-1/pdf", "Счёт не найден");

    fireEvent.click(screen.getByRole("button", { name: "Оплачен" }));
    await waitFor(() => expect(screen.getByText("Оплачен", { selector: "span" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Оплачен" })).toBeNull();
  });

  it("отменённый счёт — правки закрыты", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/bills/bill-1") return { ...BILL, status: "CANCELLED", cancelledAt: "2026-09-17T00:00:00.000Z" };
      throw new Error(`unexpected ${path}`);
    });
    render(<BillEditor mode="edit" billId="bill-1" />);
    await waitFor(() => expect(screen.getByText(/правки закрыты/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Сохранить/ })).toBeNull();
    expect(screen.getByLabelText("Наименование позиции 1")).toBeDisabled();
  });
});
