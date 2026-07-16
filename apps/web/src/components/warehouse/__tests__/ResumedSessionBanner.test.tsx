import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ResumedSessionBanner } from "../ResumedSessionBanner";

describe("ResumedSessionBanner", () => {
  it("показывает заголовок, московское время начала и пояснение про отметки", () => {
    render(
      <ResumedSessionBanner
        startedAt="2026-07-12T11:05:00.000Z" // 14:05 МСК
        onDismiss={() => {}}
      />,
    );
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Продолжена незавершённая сессия");
    expect(status).toHaveTextContent("начата 12.07, 14:05");
    expect(status).toHaveTextContent("Доборы и принятые позиции сохранены");
  });

  it("без валидного startedAt время опускается, плашка не падает", () => {
    render(<ResumedSessionBanner startedAt={null} onDismiss={() => {}} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Продолжена незавершённая сессия.");
    expect(status).not.toHaveTextContent("начата");
    expect(status.textContent || "").not.toContain("Invalid");
  });

  it("✕ вызывает onDismiss", () => {
    const onDismiss = vi.fn();
    render(
      <ResumedSessionBanner
        startedAt="2026-07-12T11:05:00.000Z"
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Скрыть уведомление о продолженной сессии",
      }),
    );
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
