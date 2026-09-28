/**
 * Плашка «Продолжена выдача / приёмка» (P6). Раньше она безусловно писала
 * «Доборы и принятые позиции сохранены», хотя количества на степпере и
 * отметки жили только в памяти экрана. Теперь — правда: кто и когда начал,
 * восстановлен ли черновик и когда его сохранили.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ResumedSessionBanner } from "../ResumedSessionBanner";

describe("ResumedSessionBanner", () => {
  it("выдача с восстановленным черновиком: кто начал, когда сохранено и кем", () => {
    render(
      <ResumedSessionBanner
        operation="ISSUE"
        startedAt="2026-07-12T11:05:00.000Z" // 14:05 МСК
        startedBy="Иван Кладовщик"
        restored
        draftSavedAt="2026-07-12T11:20:00.000Z" // 14:20 МСК
        draftSavedBy="Пётр"
        onDismiss={() => {}}
      />,
    );
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Продолжена выдача, начатая 12.07, 14:05 (Иван Кладовщик).");
    expect(status).toHaveTextContent("Количества и отметки восстановлены — сохранено в 14:20, Пётр.");
    expect(status).not.toHaveTextContent("Доборы и принятые позиции сохранены");
  });

  it("сохранённых отметок нет — прямо просит проверить количества", () => {
    render(
      <ResumedSessionBanner
        operation="ISSUE"
        startedAt="2026-07-12T11:05:00.000Z"
        startedBy="Иван"
        restored={false}
        onDismiss={() => {}}
      />,
    );
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Сохранённых отметок нет — проверьте количества.");
    expect(status).not.toHaveTextContent("восстановлены");
  });

  it("приёмка: свои формулировки", () => {
    const { rerender } = render(
      <ResumedSessionBanner
        operation="RETURN"
        startedAt="2026-07-12T11:05:00.000Z"
        restored
        draftSavedAt="2026-07-12T11:20:00.000Z"
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Продолжена приёмка, начатая 12.07, 14:05. Отметки приёмки восстановлены — сохранено в 14:20.",
    );

    rerender(
      <ResumedSessionBanner operation="RETURN" startedAt={null} restored={false} onDismiss={() => {}} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Продолжена приёмка. Сохранённых отметок нет — отметьте приёмку заново.",
    );
  });

  it("часть черновика не подошла к составу брони — просит проверить строки", () => {
    render(
      <ResumedSessionBanner
        operation="ISSUE"
        startedAt={null}
        restored
        partial
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Часть позиций брони с тех пор изменилась — проверьте отмеченные строки.",
    );
  });

  it("без операции и времени — общий заголовок, ничего не обещает, не падает", () => {
    render(<ResumedSessionBanner startedAt={null} onDismiss={() => {}} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Продолжена незавершённая сессия.");
    expect(status).not.toHaveTextContent("начата");
    expect(status).not.toHaveTextContent("сохранены");
    expect(status.textContent || "").not.toContain("Invalid");
  });

  it("✕ вызывает onDismiss", () => {
    const onDismiss = vi.fn();
    render(
      <ResumedSessionBanner
        operation="ISSUE"
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
