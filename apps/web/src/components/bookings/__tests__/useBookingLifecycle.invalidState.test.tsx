/**
 * Кнопки «Выдать» / «Вернуть» / «Отменить» на карточке брони.
 *
 * Коллега уже выдал бронь, а у сотрудника открыта старая страница: раньше он
 * видел «Недопустимый переход: ISSUED -> issue» и оставался на устаревшей
 * карточке. Теперь — человеческий текст, и карточка перечитывается сама.
 * Предупреждения сервера (не записан пробег, сбой пересчёта финансов) и
 * закрытая попутно сессия киоска тоже доходят до сотрудника.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("../../ToastProvider", () => ({ toast: toastMock }));

import { useBookingLifecycle } from "../useBookingLifecycle";

function setup() {
  const reloadBooking = vi.fn().mockResolvedValue(undefined);
  const onCancelWithDeposit = vi.fn();
  const { result } = renderHook(() =>
    useBookingLifecycle({ bookingId: "b1", booking: { amountPaid: "0" }, reloadBooking, onCancelWithDeposit }),
  );
  return { result, reloadBooking };
}

beforeEach(() => {
  apiFetchMock.mockReset();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
  toastMock.info.mockReset();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("useBookingLifecycle", () => {
  it("INVALID_BOOKING_STATE: понятный текст без «обновите страницу» и перечитанная карточка", async () => {
    apiFetchMock.mockRejectedValue(
      Object.assign(new Error("Бронь уже выдана — обновите страницу"), {
        status: 409,
        code: "INVALID_BOOKING_STATE",
        details: { status: "ISSUED", action: "issue" },
      }),
    );
    const { result, reloadBooking } = setup();
    await act(async () => {
      await result.current.runLifecycleAction("issue");
    });
    expect(reloadBooking).toHaveBeenCalledTimes(1);
    expect(toastMock.error).toHaveBeenCalledWith("Бронь уже выдана. Карточка обновлена");
    expect(result.current.lifecycleBusy).toBe(false);
  });

  it("текст без хвоста «обновите страницу» показывается как есть", async () => {
    apiFetchMock.mockRejectedValue(
      Object.assign(new Error("Выданную бронь нельзя отменить — сначала примите возврат"), {
        status: 409,
        code: "INVALID_BOOKING_STATE",
      }),
    );
    const { result, reloadBooking } = setup();
    await act(async () => {
      await result.current.runLifecycleAction("cancel");
    });
    expect(reloadBooking).toHaveBeenCalledTimes(1);
    expect(toastMock.error).toHaveBeenCalledWith(
      "Выданную бронь нельзя отменить — сначала примите возврат. Карточка обновлена",
    );
  });

  it("предупреждение сервера и закрытая сессия киоска доходят до сотрудника", async () => {
    apiFetchMock.mockResolvedValue({
      booking: { id: "b1", status: "RETURNED" },
      warning: "Пробег машин не записан — внесите его в карточке машины",
      closedScanSessions: 2,
    });
    const { result, reloadBooking } = setup();
    await act(async () => {
      await result.current.runLifecycleAction("return");
    });
    expect(toastMock.success).toHaveBeenCalledWith("Бронь возвращена");
    expect(toastMock.info).toHaveBeenCalledWith(
      "Пробег машин не записан — внесите его в карточке машины",
      expect.objectContaining({ durationMs: expect.any(Number) }),
    );
    expect(toastMock.info).toHaveBeenCalledWith(expect.stringContaining("сессии киоска"));
    expect(reloadBooking).toHaveBeenCalledTimes(1);
  });

  it("без предупреждений — только «Бронь выдана»", async () => {
    apiFetchMock.mockResolvedValue({ booking: { id: "b1", status: "ISSUED" }, warning: null, closedScanSessions: 0 });
    const { result } = setup();
    await act(async () => {
      await result.current.runLifecycleAction("issue");
    });
    expect(toastMock.success).toHaveBeenCalledWith("Бронь выдана");
    expect(toastMock.info).not.toHaveBeenCalled();
  });

  it("ранняя выдача по-прежнему переспрашивает и повторяет с force", async () => {
    apiFetchMock
      .mockRejectedValueOnce(
        Object.assign(new Error("До начала аренды больше суток"), { status: 409, code: "ISSUE_TOO_EARLY" }),
      )
      .mockResolvedValueOnce({ booking: { id: "b1", status: "ISSUED" }, warning: null });
    const { result } = setup();
    await act(async () => {
      await result.current.runLifecycleAction("issue");
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(apiFetchMock.mock.calls[1][1].body))).toEqual({ action: "issue", force: true });
    expect(toastMock.success).toHaveBeenCalledWith("Бронь выдана");
  });
});
