/**
 * Правка закрытой брони задним числом.
 *
 * Сервер может пересчитать сумму к оплате по текущим ценам каталога даже при
 * «бумажной» правке (комментарий, название). Раньше это происходило молча —
 * теперь предупреждение сервера показывается сотруднику.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("../../ToastProvider", () => ({ toast: toastMock }));

import { useRetroEdit, type RetroBooking } from "../useRetroEdit";

const booking: RetroBooking = {
  id: "b1",
  projectName: "Съёмка",
  comment: "старый",
  discountPercent: null,
  manualFinalAmount: null,
  items: [{ id: "i1", equipmentId: "e1", quantity: 1, equipment: { id: "e1", name: "Прибор", category: "Свет" } }],
  vehicles: [],
};

async function editComment(reloadBooking: () => Promise<void>) {
  const { result } = renderHook(() => useRetroEdit({ booking, reloadBooking }));
  act(() => result.current.enterRetroEdit());
  act(() => result.current.setRetroEdits((s) => ({ ...s, comment: "новый" })));
  await act(async () => {
    await result.current.saveRetroEdit();
  });
  return result;
}

beforeEach(() => {
  apiFetchMock.mockReset();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
  toastMock.info.mockReset();
});

describe("useRetroEdit — предупреждение сервера", () => {
  it("сумма пересчитана — сотрудник видит «было / стало»", async () => {
    const warning = "Сумма к оплате пересчитана по текущим ценам каталога: было 2 000 ₽, стало 3 000 ₽";
    apiFetchMock.mockResolvedValue({ booking: { id: "b1" }, warning });
    const reloadBooking = vi.fn().mockResolvedValue(undefined);
    const result = await editComment(reloadBooking);
    expect(JSON.parse(String(apiFetchMock.mock.calls[0][1].body))).toEqual({ retroactive: true, comment: "новый" });
    expect(toastMock.success).toHaveBeenCalled();
    expect(toastMock.info).toHaveBeenCalledWith(warning, expect.objectContaining({ durationMs: expect.any(Number) }));
    expect(reloadBooking).toHaveBeenCalledTimes(1);
    expect(result.current.retroEditMode).toBe(false);
  });

  it("без предупреждения — только подтверждение сохранения", async () => {
    apiFetchMock.mockResolvedValue({ booking: { id: "b1" }, warning: null });
    await editComment(vi.fn().mockResolvedValue(undefined));
    expect(toastMock.success).toHaveBeenCalled();
    expect(toastMock.info).not.toHaveBeenCalled();
  });
});
