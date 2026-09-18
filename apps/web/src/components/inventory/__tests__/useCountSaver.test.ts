/**
 * Сохранение счёта строки: по строке в полёте не больше одного запроса.
 * Новое значение ждёт окончания запроса в пути и уходит последним — иначе
 * сервер сохранил бы то, что закоммитил позже, а не то, что ввели позже.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const count = vi.fn();
vi.mock("../api", () => ({
  inventoryApi: { count: (...args: unknown[]) => count(...args) },
}));

import { COUNT_DEBOUNCE_MS, useCountSaver } from "../useCountSaver";
import type { StockCountLineView } from "../types";
import { apiError, makeLine } from "./fixtures";

const LINE = "line-1";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function saved(qty: number): { line: StockCountLineView } {
  return { line: makeLine({ id: LINE, countedQty: qty, diff: qty - 50 }) };
}

/** Каждый вызов count получает свой отложенный ответ — по порядку. */
function queueResponses() {
  const calls: Deferred<{ line: StockCountLineView }>[] = [];
  count.mockImplementation(() => {
    const d = deferred<{ line: StockCountLineView }>();
    calls.push(d);
    return d.promise;
  });
  return calls;
}

function sentQtys(): number[] {
  return count.mock.calls.map((c) => c[2] as number);
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

function setup() {
  const onSaved = vi.fn();
  const onError = vi.fn();
  const hook = renderHook(() => useCountSaver({ stockCountId: "sc-1", onSaved, onError }));
  return { ...hook, onSaved, onError };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useCountSaver — один запрос на строку", () => {
  it("значение, введённое во время запроса, уходит только после его ответа; pending и saving гаснут после второго", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const calls = queueResponses();
    const { result, onSaved } = setup();

    act(() => result.current.setCount(LINE, 1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COUNT_DEBOUNCE_MS);
    });
    expect(count).toHaveBeenCalledTimes(1);
    expect(count).toHaveBeenLastCalledWith("sc-1", LINE, 1);

    act(() => result.current.setCount(LINE, 12));
    act(() => result.current.flush(LINE));
    // Первый ещё в пути — второй ждёт, на сервер ничего нового не ушло.
    expect(count).toHaveBeenCalledTimes(1);
    expect(result.current.pending[LINE]).toBe(12);
    expect(result.current.saving[LINE]).toBe(true);

    await act(async () => {
      calls[0]!.resolve(saved(1));
    });
    await settle();
    expect(sentQtys()).toEqual([1, 12]);
    // Ответ на «1» не применяется: следом уже идёт «12».
    expect(onSaved).not.toHaveBeenCalled();
    expect(result.current.pending[LINE]).toBe(12);
    expect(result.current.saving[LINE]).toBe(true);

    await act(async () => {
      calls[1]!.resolve(saved(12));
    });
    await settle();
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith(saved(12).line);
    expect(result.current.pending[LINE]).toBeUndefined();
    expect(result.current.saving[LINE]).toBeUndefined();
  });

  it("несколько значений, пока запрос в пути, — уходит только последнее", async () => {
    const calls = queueResponses();
    const { result } = setup();

    act(() => result.current.setCount(LINE, 1, { immediate: true }));
    act(() => result.current.setCount(LINE, 2, { immediate: true }));
    act(() => result.current.setCount(LINE, 3, { immediate: true }));
    act(() => result.current.setCount(LINE, 4, { immediate: true }));
    expect(sentQtys()).toEqual([1]);

    await act(async () => {
      calls[0]!.resolve(saved(1));
    });
    await settle();
    expect(sentQtys()).toEqual([1, 4]);

    await act(async () => {
      calls[1]!.resolve(saved(4));
    });
    await settle();
    expect(sentQtys()).toEqual([1, 4]);
    expect(result.current.pending[LINE]).toBeUndefined();
  });

  it("первый запрос упал, а следом ждёт новое значение — без отката и без ошибки, новое всё равно уходит", async () => {
    const calls = queueResponses();
    const { result, onError, onSaved } = setup();

    act(() => result.current.setCount(LINE, 1, { immediate: true }));
    act(() => result.current.setCount(LINE, 2, { immediate: true }));

    await act(async () => {
      calls[0]!.reject(apiError(500, "INTERNAL", "Request failed 500"));
    });
    await settle();
    expect(onError).not.toHaveBeenCalled();
    expect(result.current.pending[LINE]).toBe(2);
    expect(sentQtys()).toEqual([1, 2]);

    await act(async () => {
      calls[1]!.resolve(saved(2));
    });
    await settle();
    expect(onError).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledWith(saved(2).line);
    expect(result.current.pending[LINE]).toBeUndefined();
    expect(result.current.saving[LINE]).toBeUndefined();
  });

  it("размонтирование при запросе в пути: значение из таймера уходит после его ответа, а не параллельно", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const calls = queueResponses();
    const { result, unmount } = setup();

    act(() => result.current.setCount(LINE, 1, { immediate: true }));
    act(() => result.current.setCount(LINE, 5));
    expect(sentQtys()).toEqual([1]);

    unmount();
    expect(sentQtys()).toEqual([1]);

    await act(async () => {
      calls[0]!.resolve(saved(1));
    });
    await settle();
    expect(sentQtys()).toEqual([1, 5]);

    // Таймер снят при размонтировании: второй раз «5» не уйдёт.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COUNT_DEBOUNCE_MS * 2);
    });
    expect(sentQtys()).toEqual([1, 5]);
  });

  it("discard при запросе в пути: «сохраняю» гаснет, ждущее значение выбрасывается", async () => {
    const calls = queueResponses();
    const { result, onSaved, onError } = setup();

    act(() => result.current.setCount(LINE, 1, { immediate: true }));
    act(() => result.current.setCount(LINE, 2, { immediate: true }));
    expect(result.current.saving[LINE]).toBe(true);

    act(() => result.current.discard(LINE));
    expect(result.current.saving[LINE]).toBeUndefined();
    expect(result.current.pending[LINE]).toBeUndefined();

    await act(async () => {
      calls[0]!.resolve(saved(1));
    });
    await settle();
    expect(sentQtys()).toEqual([1]);
    expect(onSaved).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(result.current.saving[LINE]).toBeUndefined();
  });
});
