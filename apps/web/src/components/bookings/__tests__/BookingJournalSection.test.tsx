import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BookingJournalSection } from "../BookingJournalSection";
const api = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => api(...args),
}));
beforeEach(() => api.mockReset());
describe("журнал на карточке брони", () => {
  it("старые события переводятся, отсутствующий автор указан честно", () => {
    render(
      <BookingJournalSection
        financeEvents={[
          {
            id: "old",
            eventType: "PAYMENT_STATUS_CHANGED",
            statusFrom: "NOT_PAID",
            statusTo: "PAID",
            amountDelta: "0",
            createdAt: new Date().toISOString(),
          },
        ]}
      />,
    );
    expect(screen.getByText("Статус оплаты изменён")).toBeInTheDocument();
    expect(screen.getByText("Не оплачено → Оплачено")).toBeInTheDocument();
    expect(
      screen.getByText("Автор не сохранён в старой записи"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Оплачено: 0/)).toBeInTheDocument();
    expect(api).not.toHaveBeenCalled();
  });
  it("автоматический пересчёт отличает систему от инициировавшего его аккаунта", () => {
    render(
      <BookingJournalSection
        financeEvents={[
          {
            id: "automatic",
            eventType: "PAYMENT_STATUS_CHANGED",
            statusFrom: "NOT_PAID",
            statusTo: "PAID",
            createdAt: new Date().toISOString(),
            payloadJson: JSON.stringify({
              auditSource: "account",
              auditActor: { id: "worker", username: "warehouse_account" },
              automaticCalculation: true,
            }),
          },
        ]}
      />,
    );
    expect(
      screen.getByText("Система · при действии аккаунта warehouse_account"),
    ).toBeInTheDocument();
  });
  it("руководитель получает постраничную историю конкретной брони", async () => {
    api
      .mockResolvedValueOnce({ items: [], nextCursor: "cursor-1" })
      .mockResolvedValueOnce({ items: [], nextCursor: null });
    render(
      <BookingJournalSection
        bookingId="booking-1"
        canViewAudit
        financeEvents={null}
      />,
    );
    await screen.findByRole("button", { name: "Загрузить ещё изменения" });
    expect(api.mock.calls[0][0]).toContain("bookingId=booking-1");
    fireEvent.click(
      screen.getByRole("button", { name: "Загрузить ещё изменения" }),
    );
    await waitFor(() =>
      expect(api.mock.calls[1][0]).toContain("cursor=cursor-1"),
    );
  });
});
