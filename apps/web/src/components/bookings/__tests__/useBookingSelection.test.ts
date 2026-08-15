import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useBookingSelection } from "../useBookingSelection";

type Row = { id: string };
const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }));

describe("useBookingSelection", () => {
  it("переключает выбор строки", () => {
    const { result } = renderHook(() => useBookingSelection(rows("a", "b")));
    act(() => result.current.toggle("a"));
    expect([...result.current.selected]).toEqual(["a"]);
    act(() => result.current.toggle("a"));
    expect(result.current.selected.size).toBe(0);
  });

  it("«выбрать все» выделяет загруженные строки, повторный клик снимает", () => {
    const { result } = renderHook(() => useBookingSelection(rows("a", "b", "c")));
    act(() => result.current.toggleAll());
    expect(result.current.selected.size).toBe(3);
    expect(result.current.allSelected).toBe(true);
    act(() => result.current.toggleAll());
    expect(result.current.selected.size).toBe(0);
  });

  it("частичный выбор помечается someSelected", () => {
    const { result } = renderHook(() => useBookingSelection(rows("a", "b")));
    act(() => result.current.toggle("a"));
    expect(result.current.someSelected).toBe(true);
    expect(result.current.allSelected).toBe(false);
  });

  it("смена фильтра выбрасывает из выбора пропавшие строки", () => {
    const { result, rerender } = renderHook(({ r }) => useBookingSelection(r), {
      initialProps: { r: rows("a", "b", "c") },
    });
    act(() => result.current.toggleAll());
    expect(result.current.selected.size).toBe(3);

    // Сервер вернул другую выдачу — «b» в ней больше нет.
    rerender({ r: rows("a", "c") });
    expect([...result.current.selected].sort()).toEqual(["a", "c"]);
  });

  it("дозагрузка «Загрузить ещё» выбор сохраняет", () => {
    const { result, rerender } = renderHook(({ r }) => useBookingSelection(r), {
      initialProps: { r: rows("a", "b") },
    });
    act(() => result.current.toggle("a"));
    rerender({ r: rows("a", "b", "c", "d") });
    expect([...result.current.selected]).toEqual(["a"]);
  });

  it("deselect снимает только указанные (для успешных после группового действия)", () => {
    const { result } = renderHook(() => useBookingSelection(rows("a", "b", "c")));
    act(() => result.current.toggleAll());
    act(() => result.current.deselect(["a", "c"]));
    expect([...result.current.selected]).toEqual(["b"]);
  });

  it("clear сбрасывает выбор целиком", () => {
    const { result } = renderHook(() => useBookingSelection(rows("a", "b")));
    act(() => result.current.toggleAll());
    act(() => result.current.clear());
    expect(result.current.selected.size).toBe(0);
  });

  it("selectedRows отдаёт сами строки в порядке списка", () => {
    const { result } = renderHook(() => useBookingSelection(rows("a", "b", "c")));
    act(() => result.current.toggle("c"));
    act(() => result.current.toggle("a"));
    expect(result.current.selectedRows.map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("на пустом списке «выбрано всё» не срабатывает", () => {
    const { result } = renderHook(() => useBookingSelection(rows()));
    expect(result.current.allSelected).toBe(false);
  });

  it("«выбрать все» ограничено потолком: список подгружается сам, и строк набирается больше, чем сервер примет пачкой", () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ id: `r${i}` }));
    const { result } = renderHook(() => useBookingSelection(many, 100));

    expect(result.current.selectionCapped).toBe(true);
    expect(result.current.selectableCount).toBe(100);

    act(() => result.current.toggleAll());
    expect(result.current.selected.size).toBe(100);
    // Берём строки сверху вниз — те, что пользователь видел первыми.
    expect(result.current.selected.has("r0")).toBe(true);
    expect(result.current.selected.has("r119")).toBe(false);
    // При выборе «до потолка» чекбокс шапки показывает полное выделение.
    expect(result.current.allSelected).toBe(true);

    act(() => result.current.toggleAll());
    expect(result.current.selected.size).toBe(0);
  });

  it("без потолка «выбрать все» берёт весь загруженный список", () => {
    const { result } = renderHook(() => useBookingSelection(rows("a", "b", "c")));
    expect(result.current.selectionCapped).toBe(false);
    act(() => result.current.toggleAll());
    expect(result.current.selected.size).toBe(3);
  });
});
