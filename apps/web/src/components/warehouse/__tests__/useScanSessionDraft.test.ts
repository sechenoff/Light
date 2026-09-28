/**
 * useScanSession и черновик чек-листа (P6):
 *  - чтение /state ждёт досылку черновика — вернувшийся экран видит последнюю
 *    правку, а не ту, что была до ухода;
 *  - несохранённая правка (нет связи) подкладывается в `state.draft`, пока
 *    сервер не получил ничего новее;
 *  - refresh() возвращает свежий ChecklistState (перезасев после
 *    CHECKLIST_OUTDATED);
 *  - закрытая сессия (`SESSION_*`) попадает в `closedError`.
 */
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChecklistDraftV1, ChecklistState } from "../types";

const calls: string[] = [];
const getState = vi.fn();
const saveDraft = vi.fn();
vi.mock("../api", () => ({
  scanApi: {
    getState: (...a: unknown[]) => getState(...a),
    saveDraft: (...a: unknown[]) => saveDraft(...a),
    cancel: vi.fn(),
  },
}));

import { useScanSession, withUnsavedDraft } from "../useScanSession";
import { _resetChecklistDraftsForTests, useChecklistDraft } from "../useChecklistDraft";

function draftQty(qty: number): ChecklistDraftV1 {
  return { v: 1, issue: { rows: { bi1: { qty, checked: false, equipmentId: null } } } };
}

function stateWith(draft: ChecklistDraftV1 | null, draftRevision: number): ChecklistState {
  return {
    sessionId: "s1",
    bookingId: "b1",
    operation: "ISSUE",
    items: [],
    progress: { checkedItems: 0, totalItems: 0 },
    shifts: 1,
    discountPercent: "0",
    mainOriginalAfterDiscount: "0",
    draft,
    draftRevision,
    itemsVersion: "v1",
  };
}

beforeEach(() => {
  calls.length = 0;
  getState.mockReset();
  saveDraft.mockReset();
  _resetChecklistDraftsForTests();
});

describe("useScanSession + черновик", () => {
  it("refresh() возвращает свежий ChecklistState", async () => {
    getState.mockResolvedValueOnce(stateWith(null, 0)).mockResolvedValueOnce(stateWith(draftQty(4), 2));
    const { result } = renderHook(() => useScanSession());
    await act(async () => {
      await result.current.openSession("s1", "ISSUE");
    });
    let fresh: ChecklistState | null | void = null;
    await act(async () => {
      fresh = await result.current.refresh();
    });
    expect(fresh).toEqual(stateWith(draftQty(4), 2));
    expect(result.current.state?.draftRevision).toBe(2);
  });

  it("чтение /state ждёт, пока досылка черновика дойдёт до сервера", async () => {
    let resolveSave: ((v: { revision: number; savedAt: string }) => void) | null = null;
    saveDraft.mockImplementation(() => {
      calls.push("save");
      return new Promise((r) => {
        resolveSave = r;
      });
    });
    getState.mockImplementation(async () => {
      calls.push("state");
      return stateWith(draftQty(5), 1);
    });

    // Экран ушёл с правкой: при размонтировании она отправлена, ответа ещё нет.
    const screenA = renderHook(() => useChecklistDraft({ sessionId: "s1", serverRevision: 0 }));
    act(() => screenA.result.current.schedule(draftQty(5)));
    screenA.unmount();
    expect(calls).toEqual(["save"]);

    const { result } = renderHook(() => useScanSession());
    let opening: Promise<void> | null = null;
    act(() => {
      opening = result.current.openSession("s1", "ISSUE");
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls).toEqual(["save"]); // /state ещё не читали

    await act(async () => {
      resolveSave!({ revision: 1, savedAt: "2026-09-28T11:05:00.000Z" });
      await opening;
    });
    expect(calls).toEqual(["save", "state"]);
    expect(result.current.state?.draft).toEqual(draftQty(5));
  });

  it("правка без связи подкладывается в state.draft, пока сервер не получил новее", async () => {
    saveDraft.mockRejectedValue({ status: 0, code: "NETWORK_ERROR", message: "Нет связи", details: null });
    const screenA = renderHook(() => useChecklistDraft({ sessionId: "s1", serverRevision: 3 }));
    act(() => screenA.result.current.schedule(draftQty(8)));
    await act(async () => {
      await screenA.result.current.flush();
    });
    screenA.unmount();
    await act(async () => {
      await Promise.resolve();
    });

    // Сервер на той же ревизии — на экран идёт наша несохранённая правка.
    expect(withUnsavedDraft(stateWith(draftQty(1), 3)).draft).toEqual(draftQty(8));
    // Другое устройство успело сохранить новее — верим серверу.
    expect(withUnsavedDraft(stateWith(draftQty(1), 4)).draft).toEqual(draftQty(1));
  });

  it("закрытая сессия: closedError заполнен, новая сессия его сбрасывает", async () => {
    const stale = {
      status: 409,
      code: "SESSION_STALE",
      message: "Бронь уже выдана на карточке — чек-лист закрыт, изменения из него не применены",
      details: { sessionId: "s1", operation: "ISSUE", bookingStatus: "ISSUED" },
    };
    getState.mockRejectedValueOnce(stale).mockResolvedValueOnce(stateWith(null, 0));
    const { result } = renderHook(() => useScanSession());
    await act(async () => {
      await result.current.openSession("s1", "ISSUE");
    });
    expect(result.current.closedError).toEqual(stale);
    expect(result.current.error).toEqual(stale);

    await act(async () => {
      await result.current.openSession("s2", "ISSUE");
    });
    expect(result.current.closedError).toBeNull();
  });

  it("обычная ошибка загрузки — не «сессия закрыта»", async () => {
    getState.mockRejectedValueOnce({ status: 0, code: "NETWORK_ERROR", message: "Нет связи", details: null });
    const { result } = renderHook(() => useScanSession());
    await act(async () => {
      await result.current.openSession("s1", "ISSUE");
    });
    expect(result.current.error?.code).toBe("NETWORK_ERROR");
    expect(result.current.closedError).toBeNull();
  });
});
