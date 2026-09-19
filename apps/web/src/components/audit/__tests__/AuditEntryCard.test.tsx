import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { AuditEntryCard } from "../AuditEntryCard";

describe("карточка журнала", () => {
  it("показывает аккаунт, время, статус словами и ссылку на его действия", () => {
    render(
      <AuditEntryCard
        entry={{
          id: "entry",
          userId: "worker",
          user: { username: "ivan" },
          action: "BOOKING_UPDATE",
          entityType: "Booking",
          entityId: "booking",
          entityLabel: "Съёмка",
          createdAt: new Date().toISOString(),
          before: '{"status":"CONFIRMED"}',
          after: '{"status":"ISSUED"}',
        }}
      />,
    );
    expect(screen.getByText("Бронь изменена")).toBeInTheDocument();
    expect(
      screen.getByText("Подтверждена", { exact: false }),
    ).toBeInTheDocument();
    expect(screen.getByText("Выдана", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ivan" })).toHaveAttribute(
      "href",
      "/admin/audit?userId=worker",
    );
    expect(screen.getByText(/МСК/)).toBeInTheDocument();
    expect(screen.queryByText("CONFIRMED")).toBeNull();
  });
});
