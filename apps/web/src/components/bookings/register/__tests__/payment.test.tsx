import {
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import type { BookingRegisterRow } from "@light-rental/shared";
import { PaymentState } from "../RegisterCells";

const now = new Date().toISOString();
const row: BookingRegisterRow = {
  id: "paid",
  docNumber: "Б-1",
  mode: "STANDARD",
  status: "RETURNED",
  projectName: "Тестовый проект",
  client: { id: "client", name: "Тестовый клиент" },
  startDate: now,
  endDate: now,
  createdAt: now,
  updatedAt: now,
  expectedPaymentDate: null,
  confirmedAt: now,
  issuedAt: now,
  finalAmount: "150000",
  amountPaid: "150000",
  amountOutstanding: "0",
  writeOffAmount: "0",
  paymentStatus: "PAID",
  paymentForm: "CASH",
  legacyFinance: false,
  hasScanSessions: false,
  lastScanOperation: null,
  lastScanStatus: null,
  financeState: "PAID",
  overdueAmount: "0",
  overdueDays: 0,
  creditAmount: "0",
  completed: true,
  returnOverdue: false,
  openProblems: 0,
  needsReview: false,
  actions: [],
  onHand: 0,
  projectSummary: null,
};
const trigger = () =>
  screen.getByRole("button", { name: "Сумма и оплата: Тестовый проект" });
const money = (amount: number) =>
  new RegExp(`${amount.toLocaleString("ru-RU").replace(/\s/g, "\\s")}.*₽`);

describe("Booking payment summary", () => {
  it("shows an unpaid project and keeps details read-only when payment is not allowed", async () => {
    render(
      <PaymentState
        row={{
          ...row,
          financeState: "UNPAID",
          amountPaid: "0",
          amountOutstanding: "150000",
        }}
      />,
    );
    expect(within(trigger()).getByText("Не оплачено")).toBeVisible();
    expect(within(trigger()).getByText(/Получено/)).toHaveTextContent(
      "Получено 0 ₽",
    );
    fireEvent.click(trigger());
    expect(
      within(await screen.findByRole("dialog")).queryByRole("button", {
        name: "Записать платёж",
      }),
    ).not.toBeInTheDocument();
  });
  it("leads a paid booking with its project value and received money, without a zero debt headline", () => {
    render(<PaymentState row={row} />);
    expect(within(trigger()).getByText("Сумма проекта")).toBeVisible();
    expect(within(trigger()).getByText("Оплачено")).toBeVisible();
    expect(within(trigger()).getAllByText(money(150000))).toHaveLength(2);
    expect(within(trigger()).queryByText(/Осталось/)).not.toBeInTheDocument();
  });
  it("separates an agreed 150000 from 135000 received and 15000 remaining; details do not record a payment", async () => {
    const pay = vi.fn();
    render(
      <PaymentState
        row={{
          ...row,
          financeState: "PARTIAL",
          amountPaid: "135000",
          amountOutstanding: "15000",
        }}
        pay={pay}
      />,
    );
    expect(within(trigger()).getByText("Частично оплачено")).toBeVisible();
    for (const amount of [150000, 135000, 15000])
      expect(within(trigger()).getByText(money(amount))).toBeVisible();
    fireEvent.click(trigger());
    const details = await screen.findByRole("dialog", {
      name: "Расчёты: Тестовый проект",
    });
    expect(within(details).getByText("Осталось получить")).toBeVisible();
    expect(pay).not.toHaveBeenCalled();
    fireEvent.click(
      within(details).getByRole("button", { name: "Записать платёж" }),
    );
    expect(pay).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
  it("keeps forgiven money separate from actual receipts", async () => {
    render(
      <PaymentState
        row={{
          ...row,
          financeState: "SETTLED",
          amountPaid: "135000",
          writeOffAmount: "15000",
        }}
      />,
    );
    expect(within(trigger()).getByText("Расчёт со списанием")).toBeVisible();
    fireEvent.click(trigger());
    const details = await screen.findByRole("dialog");
    expect(
      within(details).getByText("Списано по договорённости"),
    ).toBeVisible();
    expect(within(details).getByText(money(135000))).toBeVisible();
    expect(within(details).getByText(money(15000))).toBeVisible();
  });
  it.each(["UNPRICED", "NO_CHARGES"] as const)(
    "does not present %s as a free or paid project",
    (financeState) => {
      render(
        <PaymentState
          row={{ ...row, financeState, finalAmount: "0", amountPaid: "0" }}
        />,
      );
      expect(within(trigger()).getByText("—")).toBeVisible();
      expect(within(trigger()).queryByText("Оплачено")).not.toBeInTheDocument();
    },
  );
  it("shows a real zero price explicitly", () => {
    render(
      <PaymentState
        row={{
          ...row,
          financeState: "ZERO",
          finalAmount: "0",
          amountPaid: "0",
        }}
      />,
    );
    expect(within(trigger()).getByText("К оплате 0 ₽")).toBeVisible();
    expect(within(trigger()).queryByText("—")).not.toBeInTheDocument();
  });
  it("retains project total as the headline when a payment includes credit", async () => {
    render(
      <PaymentState
        row={{
          ...row,
          financeState: "CREDIT",
          amountPaid: "160000",
          creditAmount: "10000",
        }}
      />,
    );
    expect(within(trigger()).getByText(money(150000))).toBeVisible();
    fireEvent.click(trigger());
    expect(
      within(await screen.findByRole("dialog")).getByText(money(10000)),
    ).toBeVisible();
  });
  it("limits the paid label for a project with unclosed periods to the amounts already charged", async () => {
    render(
      <PaymentState
        row={{
          ...row,
          mode: "PROJECT",
          projectSummary: {
            periodCount: 1,
            closedThrough: now,
            nextCloseDate: now,
            unclosedBilling: true,
            plannedQuantity: 0,
            totalQuantity: 1,
          },
        }}
      />,
    );
    expect(within(trigger()).getByText("Начислено по периодам")).toBeVisible();
    expect(within(trigger()).getByText("Начисленное оплачено")).toBeVisible();
    fireEvent.click(trigger());
    expect(
      within(await screen.findByRole("dialog")).getByText(
        /Итог проекта ещё изменится/,
      ),
    ).toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
});
