/**
 * Ретро-правка состава: что уходит на сервер.
 *
 * Произвольная позиция шла с equipmentId: null, и сервер отвечал 400 на всю
 * правку. Договорную цену форма не шлёт вовсе: сервер сохраняет её сам
 * (поле не передано — не трогать).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock("../../ToastProvider", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { useRetroEdit, type RetroBooking } from "../useRetroEdit";

const booking: RetroBooking = {
  id: "b1",
  projectName: "Съёмка",
  comment: null,
  discountPercent: null,
  manualFinalAmount: null,
  items: [
    { id: "i1", equipmentId: "e1", quantity: 2, equipment: { id: "e1", name: "Прибор", category: "Свет" } },
    { id: "i2", equipmentId: null, customName: "Расходники", customUnitPrice: "1500", quantity: 1, equipment: null },
  ],
  vehicles: [],
};

beforeEach(() => apiFetchMock.mockReset());

describe("useRetroEdit — состав брони", () => {
  it("произвольная позиция уходит без equipmentId, каталожная — без договорной цены", async () => {
    apiFetchMock.mockResolvedValue({ booking: { id: "b1" }, warning: null });
    const { result } = renderHook(() => useRetroEdit({ booking, reloadBooking: vi.fn().mockResolvedValue(undefined) }));
    act(() => result.current.enterRetroEdit());
    act(() => result.current.updateRetroItemQty("i1", 3));
    await act(async () => {
      await result.current.saveRetroEdit();
    });
    const body = JSON.parse(String(apiFetchMock.mock.calls[0][1].body));
    expect(body.items).toEqual([
      { equipmentId: "e1", quantity: 3 },
      { quantity: 1, customName: "Расходники", customUnitPrice: 1500 },
    ]);
    expect(body.items.some((i: Record<string, unknown>) => "negotiatedRatePerShift" in i)).toBe(false);
  });
});
