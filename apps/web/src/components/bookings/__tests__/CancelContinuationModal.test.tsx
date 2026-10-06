/**
 * «Отменить продолжение»: причина обязательна, запрос с ней, ошибка сервера
 * видна в окне; кнопка на плашке семьи — только когда её передали.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetchMock(...a) }));
vi.mock("../../ToastProvider", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { CancelContinuationModal } from "../CancelContinuationModal";
import { BookingFamilyBanner, type BookingFamily } from "../BookingFamilyBanner";

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe("CancelContinuationModal", () => {
  it("без причины кнопка неактивна; с причиной — запрос и перечитывание карточки", async () => {
    apiFetchMock.mockResolvedValue({ bookingId: "c1", releasedUnits: 1, closedScanSessions: 0 });
    const onDone = vi.fn();
    const onClose = vi.fn();
    render(<CancelContinuationModal bookingId="c1" docNumber="СМ-2026-0231-1" onClose={onClose} onDone={onDone} />);
    const confirm = screen.getByRole("button", { name: "Отменить продолжение" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Всё привезли вместе с основной" } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/bookings/c1/cancel-continuation",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ reason: "Всё привезли вместе с основной" }) }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("сервер отказал — текст в окне, окно не закрылось", async () => {
    apiFetchMock.mockImplementation(async () => {
      throw Object.assign(new Error("По продолжению уже есть оплата"), { status: 409 });
    });
    const onClose = vi.fn();
    render(<CancelContinuationModal bookingId="c1" docNumber={null} onClose={onClose} onDone={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Ошибка оформления" } });
    fireEvent.click(screen.getByRole("button", { name: "Отменить продолжение" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("По продолжению уже есть оплата");
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("плашка продолжения", () => {
  const family: BookingFamily = {
    parent: { id: "root", docNumber: "СМ-2026-0231" },
    root: { id: "root", docNumber: "СМ-2026-0231" },
    continuations: [],
    partiallyReturned: false,
    totals: null,
  };

  it("«Отменить продолжение» — только когда кнопку передали", () => {
    const { rerender } = render(<BookingFamilyBanner family={family} onAcceptRest={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Отменить продолжение" })).toBeNull();
    const onCancel = vi.fn();
    rerender(<BookingFamilyBanner family={family} onAcceptRest={vi.fn()} onCancelContinuation={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Отменить продолжение" }));
    expect(onCancel).toHaveBeenCalled();
  });
});
