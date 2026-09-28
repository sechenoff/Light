/**
 * SessionClosedNotice — вместо «Внутренней ошибки сервера» и живого на вид
 * чек-листа кладовщик видит, что сессию уже закрыли, кто и когда, и один
 * выход: «К списку броней».
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { SessionClosedNotice, describeClosedSession } from "../SessionClosedNotice";
import type { ScanApiError } from "../types";

function err(code: string, message: string, details: unknown = null, status = 409): ScanApiError {
  return { status, code, message, details };
}

describe("SessionClosedNotice", () => {
  it("выдачу уже оформили: заголовок по операции, текст сервера, кто и когда", () => {
    const onBack = vi.fn();
    render(
      <SessionClosedNotice
        error={err("SESSION_ALREADY_COMPLETED", "Выдача по этой брони уже оформлена", {
          sessionId: "s1",
          operation: "ISSUE",
          completedAt: "2026-09-28T11:05:00.000Z", // 14:05 МСК
          completedBy: "Иван Кладовщик",
        })}
        onBack={onBack}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Выдача уже оформлена");
    expect(alert).toHaveTextContent("Выдача по этой брони уже оформлена");
    expect(alert).toHaveTextContent("Завершено 28.09, 14:05 · Иван Кладовщик");

    fireEvent.click(screen.getByRole("button", { name: "← К списку броней" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("приёмку уже завершили — операция из details важнее пропа", () => {
    const view = describeClosedSession(
      err("SESSION_ALREADY_COMPLETED", "Приёмка по этой брони уже завершена", {
        sessionId: "s1",
        operation: "RETURN",
        completedAt: null,
        completedBy: null,
      }),
      "ISSUE",
    );
    expect(view.title).toBe("Приёмка уже завершена");
    expect(view.tone).toBe("done");
    expect(view.meta).toBeNull();
  });

  it("сессию прервали: причина по-человечески, кто и когда", () => {
    render(
      <SessionClosedNotice
        error={err("SESSION_CANCELLED", "Сессию склада прервали — откройте бронь заново", {
          sessionId: "s1",
          operation: "ISSUE",
          cancelReason: "BOOKING_ISSUED_MANUALLY",
          cancelledAt: "2026-09-28T11:05:00.000Z",
          cancelledBy: "sechenoff",
        })}
        onBack={() => {}}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Сессию прервали");
    expect(alert).toHaveTextContent("Сессию склада прервали — откройте бронь заново");
    expect(alert).toHaveTextContent("Причина: бронь выдали кнопкой на карточке · 28.09, 14:05, sechenoff");
    expect(alert.textContent).not.toContain("BOOKING_ISSUED_MANUALLY");
  });

  it("устаревшая сессия: текст сервера про статус брони", () => {
    render(
      <SessionClosedNotice
        error={err(
          "SESSION_STALE",
          "Бронь уже принята на карточке — чек-лист закрыт, изменения из него не применены",
          { sessionId: "s1", operation: "RETURN", bookingStatus: "RETURNED" },
        )}
        onBack={() => {}}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Чек-лист закрыт");
    expect(alert).toHaveTextContent("Бронь уже принята на карточке — чек-лист закрыт, изменения из него не применены");
  });

  it("сессии нет (404) и пустое сообщение — запасные формулировки", () => {
    const view = describeClosedSession(err("SESSION_NOT_FOUND", "", null, 404));
    expect(view.title).toBe("Сессия не найдена");
    expect(view.message).toBe("Сессия склада не найдена — откройте бронь заново.");
  });
});
