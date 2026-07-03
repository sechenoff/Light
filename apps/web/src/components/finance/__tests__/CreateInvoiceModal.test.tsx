/**
 * Tests for CreateInvoiceModal — поиск-селектор брони вместо сырого CUID.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../ToastProvider", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { CreateInvoiceModal } from "../CreateInvoiceModal";

const ORIGINAL_FETCH = global.fetch;

const BOOKING_HIT = {
  id: "booking-abc",
  projectName: "Съёмки клипа",
  startDate: "2026-07-10T00:00:00Z",
  endDate: "2026-07-12T00:00:00Z",
  finalAmount: "50000",
  amountOutstanding: "30000",
  client: { id: "client-1", name: "Ромашка Продакшн" },
};

beforeEach(() => {
  global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).includes("/api/bookings")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ bookings: [BOOKING_HIT] }),
        text: async () => "",
      };
    }
    if (String(url).includes("/api/invoices") && init?.method === "POST") {
      return { ok: true, status: 201, json: async () => ({ id: "inv-new" }), text: async () => "" };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  });
  vi.clearAllMocks();
});
afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

describe("CreateInvoiceModal", () => {
  it("рендерит поиск брони, а не поле для сырого ID", () => {
    render(<CreateInvoiceModal open onClose={() => {}} onCreated={() => {}} />);

    expect(screen.getByPlaceholderText(/клиент или проект/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/введите id/i)).toBeNull();
  });

  it("ищет брони с дебаунсом и показывает «клиент · проект · даты · сумма»", async () => {
    render(<CreateInvoiceModal open onClose={() => {}} onCreated={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText(/клиент или проект/i), {
      target: { value: "ромашка" },
    });

    // После дебаунса приходит подсказка с полной сводкой брони
    const hit = await screen.findByText(/Ромашка Продакшн · Съёмки клипа ·/);
    expect(hit.textContent).toMatch(/50\s*000/); // сумма брони в подсказке

    const calledUrls = (global.fetch as any).mock.calls.map((c: any[]) => String(c[0]));
    expect(calledUrls.some((u: string) => u.includes("/api/bookings?q="))).toBe(true);
  });

  it("выбор брони автозаполняет сумму (FULL → finalAmount) и сабмит шлёт bookingId", async () => {
    render(<CreateInvoiceModal open onClose={() => {}} onCreated={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText(/клиент или проект/i), {
      target: { value: "ромашка" },
    });
    const hit = await screen.findByText(/Ромашка Продакшн · Съёмки клипа ·/);
    fireEvent.click(hit);

    // Выбранная бронь показана карточкой, сумма подставлена из finalAmount
    expect(screen.getByText("Ромашка Продакшн")).toBeInTheDocument();
    const totalInput = screen.getByPlaceholderText("0.00") as HTMLInputElement;
    expect(totalInput.value).toBe("50000");

    fireEvent.click(screen.getByRole("button", { name: "Создать" }));

    await waitFor(() => {
      const postCall = (global.fetch as any).mock.calls.find(
        (c: any[]) => String(c[0]).includes("/api/invoices") && c[1]?.method === "POST"
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall[1].body);
      expect(body.bookingId).toBe("booking-abc");
      expect(body.total).toBe(50000);
    });
  });

  it("для DEPOSIT сумма обязательна, для FULL можно оставить пустой", async () => {
    render(<CreateInvoiceModal open onClose={() => {}} onCreated={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText(/клиент или проект/i), {
      target: { value: "ромашка" },
    });
    const hit = await screen.findByText(/Ромашка Продакшн · Съёмки клипа ·/);
    fireEvent.click(hit);

    // FULL + пустая сумма → кнопка активна (сервер посчитает из брони)
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Создать" })).not.toBeDisabled();

    // DEPOSIT + пустая сумма → кнопка заблокирована
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "DEPOSIT" } });
    expect(screen.getByRole("button", { name: "Создать" })).toBeDisabled();
  });
});
