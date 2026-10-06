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

function mockApi(
  preview: (amount: number, bookingId: string) => unknown,
  opts: { invoices?: unknown[]; payments?: unknown[]; bookings?: unknown[] } = {},
) {
  vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
    const u = String(url);
    if (u.includes("/api/payments/family-preview")) {
      const q = new URL(u, "http://x").searchParams;
      return preview(Number(q.get("amount")), q.get("bookingId") ?? "") as never;
    }
    if (u.startsWith("/api/invoices")) return { items: opts.invoices ?? [] } as never;
    if (u.startsWith("/api/bookings?")) return { bookings: opts.bookings ?? [] } as never;
    return { payment: { id: "p1" }, payments: opts.payments ?? [{ id: "p1" }, { id: "p2" }] } as never;
  });
}

const previewCalls = () => vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).includes("family-preview"));

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
    // Под включённым — «Если выключить …», а не «Выключено …».
    expect(screen.getByText(/^Если выключить — весь платёж ляжет на СМ-2026-0231, и 6 660/)).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(/^Выключено — весь платёж ляжет на СМ-2026-0231/)).toBeInTheDocument();
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
        row({ bookingId: "root", debt: "8340.00", payment: amount.toFixed(2), remaining: "0.00" }),
        row({ bookingId: "child", isContinuation: true, debt: "0.00", payment: "0.00", remaining: "0.00" }),
      ],
    }));
    open();
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "9000" } });
    await waitFor(() => expect(previewCalls().some(([url]) => String(url).includes("amount=9000"))).toBe(true));
    const toggle = await screen.findByRole("switch");
    await new Promise((r) => setTimeout(r, 50));
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("выбран счёт — по умолчанию выключено; включили — предупреждение, счёт не уходит", async () => {
    mockApi(familyPreview, {
      invoices: [{ id: "inv1", number: "С-12", kind: "FULL", total: "8340", paidAmount: "0", dueDate: null, status: "ISSUED" }],
    });
    render(
      <RecordPaymentModal open defaultBookingId="root" bookingContext={ctx} legacyFinance={false} onClose={vi.fn()} onCreated={vi.fn()} />,
    );
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "15000" } });
    const toggle = await screen.findByRole("switch");
    // Первый выпадающий список — счёт, второй — способ оплаты.
    await waitFor(() => expect(screen.getAllByRole("combobox")[0]).toHaveValue("inv1"));
    await new Promise((r) => setTimeout(r, 50));
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    expect(screen.getByText(/Платёж по счёту не разносится/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Записать платёж" }));
    await waitFor(() => expect(postBody()).not.toBeNull());
    expect(postBody()).toMatchObject({ spreadAcrossFamily: true });
    expect(postBody().invoiceId).toBeUndefined();
  });

  it("у продолжения: сумма в пределах своего долга — выключено, больше — включено", async () => {
    const childCtx = { ...ctx, id: "child", amountOutstanding: "11663" };
    mockApi((amount) => familyPreview(amount));
    render(<RecordPaymentModal open defaultBookingId="child" bookingContext={childCtx} onClose={vi.fn()} onCreated={vi.fn()} />);
    const toggle = await screen.findByRole("switch");
    await new Promise((r) => setTimeout(r, 50));
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "20003" } });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
  });

  it("превью упало после удачного — панель уходит, платёж без разнесения", async () => {
    let fail = false;
    vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes("family-preview")) {
        if (fail) throw new Error("сеть");
        return familyPreview(Number(new URL(u, "http://x").searchParams.get("amount"))) as never;
      }
      return { payment: { id: "p1" } } as never;
    });
    open();
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "15000" } });
    await waitFor(() => expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true"));
    fail = true;
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "15500" } });
    await waitFor(() => expect(screen.queryByRole("switch")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Записать платёж" }));
    await waitFor(() => expect(postBody()).not.toBeNull());
    expect(postBody().spreadAcrossFamily).toBeUndefined();
  });

  it("разнесение, где вся сумма легла на одну бронь, — обычный тост", async () => {
    mockApi(familyPreview, { payments: [{ id: "p1" }] });
    open();
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "5000" } });
    await waitFor(() => expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true"));
    fireEvent.click(screen.getByRole("button", { name: "Записать платёж" }));
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith("Платёж зафиксирован"));
  });

  it("сменили бронь в списке — разнесение сбрасывается сразу, не дожидаясь превью", async () => {
    const bookings = [
      { id: "root", projectName: "Реклама кофейни «Зерно»", client: { name: "Продакшн «Сфера»" }, amountOutstanding: "8340" },
      { id: "solo", projectName: "Клип «Ветер»", client: { name: "Студия «Полдень»" }, amountOutstanding: "3000" },
    ];
    mockApi(
      (amount, bookingId) =>
        bookingId === "solo"
          ? { members: 1, parts: [], rows: [row({ bookingId: "solo", debt: "3000.00", payment: amount.toFixed(2), remaining: "0.00" })] }
          : familyPreview(amount),
      { bookings },
    );
    render(<RecordPaymentModal open onClose={vi.fn()} onCreated={vi.fn()} />);
    // Первый выпадающий список — бронь, второй — способ оплаты.
    const select = (await screen.findAllByRole("combobox"))[0];
    await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(2));
    fireEvent.change(select, { target: { value: "root" } });
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "15000" } });
    await waitFor(() => expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true"));
    fireEvent.change(select, { target: { value: "solo" } });
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Записать платёж" }));
    await waitFor(() => expect(postBody()).not.toBeNull());
    expect(postBody()).toMatchObject({ bookingId: "solo" });
    expect(postBody().spreadAcrossFamily).toBeUndefined();
  });
});
