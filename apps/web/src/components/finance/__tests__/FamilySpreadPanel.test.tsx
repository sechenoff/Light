/**
 * «Разнести по продолжениям» в окне «Записать платёж» (мокап M5, раздел 6):
 * переключатель включён по умолчанию, когда долг есть у другой брони семьи;
 * таблица «Долг · Платёж · Останется»; флаг уходит в POST /api/payments.
 */
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lib/api", () => ({ apiFetch: vi.fn() }));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("../../ToastProvider", () => ({ toast: toastMock }));

import { apiFetch } from "../../../lib/api";
import { RecordPaymentModal } from "../RecordPaymentModal";

const ctx = {
  id: "root",
  projectName: "Реклама кофейни «Зерно»",
  client: { name: "Продакшн «Сфера»" },
  finalAmount: "28340",
  amountPaid: "20000",
  amountOutstanding: "8340",
};

const row = (over: Record<string, unknown>) => ({
  docNumber: null,
  isContinuation: false,
  expectedPaymentDate: null,
  ...over,
});

/** Семья: основная должна 8 340, продолжение — 11 663; платёж 15 000. */
function familyPreview(amount: number) {
  const rootPay = Math.min(8340, amount);
  const childPay = Math.min(11663, amount - rootPay);
  return {
    members: 2,
    parts: [],
    rows: [
      row({ bookingId: "root", docNumber: "СМ-2026-0231", debt: "8340.00", payment: rootPay.toFixed(2), remaining: (8340 - rootPay).toFixed(2) }),
      row({ bookingId: "child", docNumber: "СМ-2026-0231-1", isContinuation: true, debt: "11663.00", payment: childPay.toFixed(2), remaining: (11663 - childPay).toFixed(2) }),
    ],
  };
}

function mockApi(preview: (amount: number) => unknown) {
  vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
    const u = String(url);
    if (u.includes("/api/payments/family-preview")) {
      const amount = Number(new URL(u, "http://x").searchParams.get("amount"));
      return preview(amount) as never;
    }
    if (u.startsWith("/api/invoices")) return { items: [] } as never;
    return { payment: { id: "p1" }, payments: [{ id: "p1" }, { id: "p2" }] } as never;
  });
}

const postBody = () => {
  const call = vi.mocked(apiFetch).mock.calls.find(([url]) => url === "/api/payments");
  return call ? JSON.parse(String(call[1]!.body)) : null;
};

const open = () =>
  render(<RecordPaymentModal open defaultBookingId="root" bookingContext={ctx} onClose={vi.fn()} onCreated={vi.fn()} />);

beforeEach(() => vi.clearAllMocks());

describe("Разнести по продолжениям", () => {
  it("долг у продолжения — переключатель включён, таблица разбивки, флаг в платеже", async () => {
    mockApi(familyPreview);
    open();
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "15000" } });
    const toggle = await screen.findByRole("switch", { name: "Разнести по продолжениям" });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    const table = within(await screen.findByRole("table"));
    expect(table.getByText("0 · закрыта")).toBeInTheDocument();
    expect(table.getByText(/СМ-2026-0231-1/)).toBeInTheDocument();
    expect(table.getByText("продолжение")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Записать платёж" }));
    await waitFor(() => expect(postBody()).not.toBeNull());
    expect(postBody()).toMatchObject({ bookingId: "root", amount: 15000, spreadAcrossFamily: true });
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith("Платёж разнесён по 2 броням"));
  });

  it("выключили — весь платёж на эту бронь, без флага", async () => {
    mockApi(familyPreview);
    open();
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "15000" } });
    const toggle = await screen.findByRole("switch");
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(/станут переплатой по ней/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Записать платёж" }));
    await waitFor(() => expect(postBody()).not.toBeNull());
    expect(postBody().spreadAcrossFamily).toBeUndefined();
  });

  it("у брони нет продолжений — панели нет, платёж как раньше", async () => {
    mockApi(() => ({ members: 1, parts: [], rows: [row({ bookingId: "root", debt: "8340.00", payment: "8340.00", remaining: "0.00" })] }));
    open();
    await waitFor(() =>
      expect(vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).includes("family-preview"))).toBe(true),
    );
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Записать платёж" }));
    await waitFor(() => expect(postBody()).not.toBeNull());
    expect(postBody().spreadAcrossFamily).toBeUndefined();
  });

  it("долг только у этой брони — переключатель выключен по умолчанию", async () => {
    mockApi((amount) => ({
      members: 2,
      parts: [],
      rows: [
        row({ bookingId: "root", debt: "8340.00", payment: Math.min(8340, amount).toFixed(2), remaining: "0.00" }),
        row({ bookingId: "child", isContinuation: true, debt: "0.00", payment: "0.00", remaining: "0.00" }),
      ],
    }));
    open();
    const toggle = await screen.findByRole("switch");
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });
});
