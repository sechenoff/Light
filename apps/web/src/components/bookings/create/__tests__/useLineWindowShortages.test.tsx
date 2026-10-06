/**
 * «На ср свободно 1 из 2»: доступность длинной позиции спрашивается на окне
 * «выдача → срок строки», ответы кэшируются по окну, сбой не ломает форму.
 */
import { renderHook, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetchMock(...a) }));

import { useLineWindowShortages } from "../useLineWindowShortages";
import type { CatalogSelectedItem } from "../types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = Math.ceil((Date.now() + 7 * DAY) / HOUR) * HOUR;
const pickupISO = new Date(START).toISOString();
const returnISO = new Date(START + DAY).toISOString();

const item = (over: Partial<CatalogSelectedItem> = {}): CatalogSelectedItem => ({
  equipmentId: "storm",
  name: "Aputure STORM 1200x",
  category: "Свет",
  quantity: 2,
  dailyPrice: "9000",
  availableQuantity: 4,
  ...over,
});
const cart = (...items: CatalogSelectedItem[]) => new Map(items.map((i) => [i.equipmentId, i]));
const availability = (available: number) => ({ rows: [{ equipmentId: "storm", availableQuantity: available }] });

beforeEach(() => {
  apiFetchMock.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("useLineWindowShortages", () => {
  it("нет длинных строк — ничего не спрашивает", async () => {
    const { result } = renderHook(() =>
      useLineWindowShortages({ selected: cart(item()), bookingShifts: 1, pickupISO, returnISO, invalid: false }),
    );
    await new Promise((r) => setTimeout(r, 500));
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(result.current.size).toBe(0);
  });

  it("длинная строка — окно до её срока, правка брони исключает саму бронь, нехватка видна", async () => {
    apiFetchMock.mockResolvedValue(availability(1));
    const { result } = renderHook(() =>
      useLineWindowShortages({
        selected: cart(item({ shifts: 2 })),
        bookingShifts: 1,
        pickupISO,
        returnISO,
        invalid: false,
        excludeBookingId: "b1",
      }),
    );
    await waitFor(() => expect(result.current.get("storm")).toMatchObject({ available: 1 }));
    const url = String(apiFetchMock.mock.calls[0][0]);
    const params = new URL(url, "http://x").searchParams;
    expect(params.get("start")).toBe(pickupISO);
    expect(params.get("end")).toBe(new Date(START + 2 * DAY).toISOString());
    expect(params.get("excludeBookingId")).toBe("b1");
  });

  it("хватает — подсказки нет; некорректные даты — не спрашивает", async () => {
    apiFetchMock.mockResolvedValue(availability(5));
    const { result, rerender } = renderHook((props: { invalid: boolean }) =>
      useLineWindowShortages({ selected: cart(item({ shifts: 2 })), bookingShifts: 1, pickupISO, returnISO, invalid: props.invalid }),
      { initialProps: { invalid: true } },
    );
    await new Promise((r) => setTimeout(r, 500));
    expect(apiFetchMock).not.toHaveBeenCalled();
    rerender({ invalid: false });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.size).toBe(0);
  });

  it("сбой — без подсказки; окно забыто, и к нему вернутся при следующей правке срока", async () => {
    apiFetchMock.mockRejectedValueOnce(new Error("сеть")).mockResolvedValue(availability(0));
    const { result, rerender } = renderHook((props: { shifts: number }) =>
      useLineWindowShortages({ selected: cart(item({ shifts: props.shifts })), bookingShifts: 1, pickupISO, returnISO, invalid: false }),
      { initialProps: { shifts: 2 } },
    );
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
    expect(result.current.size).toBe(0);
    rerender({ shifts: 3 });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.get("storm")).toMatchObject({ available: 0 }));
    // Назад к окну, которое упало: его спрашивают заново, а не считают известным.
    rerender({ shifts: 2 });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(3));
    const end = new URL(String(apiFetchMock.mock.calls[2][0]), "http://x").searchParams.get("end");
    expect(end).toBe(new Date(START + 2 * DAY).toISOString());
  });

  it("частые правки — один запрос на окно после паузы", async () => {
    vi.useFakeTimers();
    apiFetchMock.mockResolvedValue(availability(3));
    const { rerender } = renderHook((props: { shifts: number }) =>
      useLineWindowShortages({ selected: cart(item({ shifts: props.shifts })), bookingShifts: 1, pickupISO, returnISO, invalid: false }),
      { initialProps: { shifts: 2 } },
    );
    rerender({ shifts: 3 });
    rerender({ shifts: 4 });
    await act(async () => {
      vi.advanceTimersByTime(450);
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    const end = new URL(String(apiFetchMock.mock.calls[0][0]), "http://x").searchParams.get("end");
    expect(end).toBe(new Date(START + 4 * DAY).toISOString());
  });
});
