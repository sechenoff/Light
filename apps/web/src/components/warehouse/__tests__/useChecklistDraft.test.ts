/**
 * useChecklistDraft — черновик чек-листа киоска на сервере (P6, P25).
 *
 * Проверяем то, из-за чего на проде терялась работа кладовщика: правки
 * копятся 800 мс и уходят одним запросом, досылаются при уходе со страницы и
 * при размонтировании, конфликт двух планшетов разрешается по ревизии, а
 * «открыл и посмотрел» прерывает пустую сессию, не трогая чужую работу.
 */
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MutableRefObject } from "react";
import type { ChecklistDraftV1, ScanApiError } from "../types";

const saveDraft = vi.fn();
const cancel = vi.fn();
vi.mock("../api", () => ({
  scanApi: {
    saveDraft: (...a: unknown[]) => saveDraft(...a),
    cancel: (...a: unknown[]) => cancel(...a),
  },
}));

import {
  DRAFT_RETRY_DELAY_MS,
  DRAFT_SAVE_DELAY_MS,
  _resetChecklistDraftsForTests,
  awaitDraftSettled,
  leaveChecklistSession,
  matchDraftEntries,
  peekUnsavedDraft,
  useChecklistDraft,
  type ChecklistLeaveFn,
  type UseChecklistDraftOptions,
} from "../useChecklistDraft";

function issueDraft(qty: number, checked = false): ChecklistDraftV1 {
  return { v: 1, issue: { rows: { bi1: { qty, checked, equipmentId: "eq1" } } } };
}

function apiError(status: number, code: string | null, message: string, details: unknown = null): ScanApiError {
  return { status, code, message, details };
}

/** Дать промисам (ответам «сервера») разрешиться при фейковых таймерах. */
async function flushMicrotasks() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

function mount(opts: Partial<UseChecklistDraftOptions> = {}) {
  return renderHook((props: UseChecklistDraftOptions) => useChecklistDraft(props), {
    initialProps: { sessionId: "s1", serverRevision: 0, ...opts } as UseChecklistDraftOptions,
  });
}

// Сервер наращивает ревизию на 1 и отвечает временем сохранения.
const SAVED_AT = "2026-09-28T11:05:00.000Z"; // 14:05 МСК

beforeEach(() => {
  vi.useFakeTimers();
  _resetChecklistDraftsForTests();
  saveDraft.mockReset();
  cancel.mockReset();
  saveDraft.mockImplementation(async (_sid: string, revision: number) => ({
    revision: revision + 1,
    savedAt: SAVED_AT,
  }));
  cancel.mockResolvedValue({ id: "s1", cancelled: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useChecklistDraft — задержка и сохранение", () => {
  it("копит правки 800 мс и отправляет одну последнюю, от ревизии с сервера", async () => {
    const { result } = mount({ serverRevision: 3 });

    act(() => {
      result.current.schedule(issueDraft(4));
      result.current.schedule(issueDraft(5));
      result.current.schedule(issueDraft(6, true));
    });
    expect(result.current.statusLabel).toBe("Сохраняем…");
    expect(result.current.dirty).toBe(true);

    act(() => {
      vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS - 1);
    });
    expect(saveDraft).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    await flushMicrotasks();

    expect(saveDraft).toHaveBeenCalledTimes(1);
    expect(saveDraft).toHaveBeenCalledWith("s1", 3, issueDraft(6, true), { keepalive: false });
    expect(result.current.revision).toBe(4);
    expect(result.current.statusLabel).toBe("Сохранено 14:05");
    expect(result.current.dirty).toBe(false);
  });

  it("следующее сохранение идёт от ревизии, которую вернул сервер", async () => {
    const { result } = mount({ serverRevision: 0 });
    act(() => result.current.schedule(issueDraft(1)));
    act(() => vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS));
    await flushMicrotasks();
    act(() => result.current.schedule(issueDraft(2)));
    act(() => vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS));
    await flushMicrotasks();

    expect(saveDraft.mock.calls.map((c) => c[1])).toEqual([0, 1]);
  });

  it("пока /state не загружен, правка ждёт и уходит, когда ревизия стала известна", async () => {
    const { result, rerender } = mount({ serverRevision: undefined });
    act(() => result.current.schedule(issueDraft(2)));
    act(() => vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS * 2));
    await flushMicrotasks();
    expect(saveDraft).not.toHaveBeenCalled();

    rerender({ sessionId: "s1", serverRevision: 7 });
    await flushMicrotasks();
    expect(saveDraft).toHaveBeenCalledWith("s1", 7, issueDraft(2), { keepalive: false });
  });

  it("засев экрана не считается правкой: тот же черновик, что на сервере или в setBaseline, не сохраняется", async () => {
    const serverDraft = issueDraft(5, true);
    const { result } = mount({ serverRevision: 2, serverDraft });
    // Порядок ключей другой — это всё ещё тот же черновик.
    act(() =>
      result.current.schedule({ issue: { rows: { bi1: { equipmentId: "eq1", checked: true, qty: 5 } } }, v: 1 }),
    );
    act(() => vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS));
    await flushMicrotasks();
    expect(saveDraft).not.toHaveBeenCalled();

    const fresh = mount({ sessionId: "s2", serverRevision: 0 });
    act(() => fresh.result.current.setBaseline(issueDraft(3)));
    act(() => fresh.result.current.schedule(issueDraft(3)));
    act(() => vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS));
    await flushMicrotasks();
    expect(saveDraft).not.toHaveBeenCalled();

    act(() => fresh.result.current.schedule(issueDraft(2)));
    act(() => vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS));
    await flushMicrotasks();
    expect(saveDraft).toHaveBeenCalledWith("s2", 0, issueDraft(2), { keepalive: false });
  });
});

describe("useChecklistDraft — досылка при уходе", () => {
  it("pagehide отправляет накопленное сразу и с keepalive", async () => {
    const { result } = mount({ serverRevision: 1 });
    act(() => result.current.schedule(issueDraft(9)));
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(saveDraft).toHaveBeenCalledWith("s1", 1, issueDraft(9), { keepalive: true });
    // Сессия с правкой — не пустая: прерывать её нельзя.
    expect(cancel).not.toHaveBeenCalled();
  });

  it("уход вкладки в фон (visibilitychange → hidden) досылает с keepalive", () => {
    const { result } = mount({ serverRevision: 1 });
    act(() => result.current.schedule(issueDraft(8)));
    const spy = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    spy.mockRestore();
    expect(saveDraft).toHaveBeenCalledWith("s1", 1, issueDraft(8), { keepalive: true });
  });

  it("размонтирование (смена раздела) досылает правку, не дожидаясь задержки", async () => {
    const { result, unmount } = mount({ serverRevision: 4 });
    act(() => result.current.schedule(issueDraft(1)));
    unmount();
    expect(saveDraft).toHaveBeenCalledWith("s1", 4, issueDraft(1), { keepalive: false });
  });

  it("чтение /state после ухода ждёт, пока досылка дойдёт", async () => {
    let resolveSave: ((v: { revision: number; savedAt: string }) => void) | null = null;
    saveDraft.mockImplementation(
      () => new Promise((r) => {
        resolveSave = r;
      }),
    );
    const { result, unmount } = mount({ serverRevision: 0 });
    act(() => result.current.schedule(issueDraft(3)));
    unmount();

    let settled = false;
    const wait = awaitDraftSettled("s1").then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);

    resolveSave!({ revision: 1, savedAt: SAVED_AT });
    await flushMicrotasks();
    await wait;
    expect(settled).toBe(true);
  });

  it("несохранённая правка (нет связи) переживает размонтирование и видна следующему экрану", async () => {
    saveDraft.mockRejectedValue(apiError(0, "NETWORK_ERROR", "Нет связи с сервером — проверьте подключение"));
    const { result, unmount } = mount({ serverRevision: 2 });
    act(() => result.current.schedule(issueDraft(7)));
    act(() => vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS));
    await flushMicrotasks();
    expect(result.current.statusLabel).toBe("Нет связи — не сохранено");
    unmount();

    expect(peekUnsavedDraft("s1")).toEqual({ draft: issueDraft(7), baseRevision: 2 });
  });
});

describe("useChecklistDraft — конфликты и закрытая сессия", () => {
  it("DRAFT_OUTDATED: берёт ревизию и черновик другого устройства и перезасевает экран", async () => {
    const otherDraft = issueDraft(10, true);
    saveDraft.mockRejectedValueOnce(
      apiError(409, "DRAFT_OUTDATED", "Чек-лист изменили на другом устройстве — загружена свежая версия", {
        revision: 6,
        draft: otherDraft,
        savedAt: SAVED_AT,
        savedBy: "Пётр",
      }),
    );
    const onOutdated = vi.fn();
    const { result } = mount({ serverRevision: 3, onOutdated });

    act(() => result.current.schedule(issueDraft(1)));
    act(() => vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS));
    await flushMicrotasks();

    expect(onOutdated).toHaveBeenCalledWith({
      revision: 6,
      draft: otherDraft,
      savedAt: SAVED_AT,
      savedBy: "Пётр",
    });
    expect(result.current.revision).toBe(6);
    expect(result.current.status).toBe("outdated");
    expect(result.current.savedBy).toBe("Пётр");

    // Экран перезасеян чужим черновиком — повторять его не нужно…
    act(() => result.current.schedule(otherDraft));
    act(() => vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS));
    await flushMicrotasks();
    expect(saveDraft).toHaveBeenCalledTimes(1);

    // …а новая правка идёт уже от свежей ревизии.
    act(() => result.current.schedule(issueDraft(11, true)));
    act(() => vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS));
    await flushMicrotasks();
    expect(saveDraft).toHaveBeenLastCalledWith("s1", 6, issueDraft(11, true), { keepalive: false });
  });

  it("сессию закрыли — onSessionClosed, дальше ничего не отправляется", async () => {
    const closed = apiError(409, "SESSION_STALE", "Бронь уже выдана на карточке — чек-лист закрыт, изменения из него не применены", {
      sessionId: "s1",
      operation: "ISSUE",
      bookingStatus: "ISSUED",
    });
    saveDraft.mockRejectedValueOnce(closed);
    const onSessionClosed = vi.fn();
    const { result } = mount({ serverRevision: 0, onSessionClosed });

    act(() => result.current.schedule(issueDraft(1)));
    act(() => vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS));
    await flushMicrotasks();
    expect(onSessionClosed).toHaveBeenCalledWith(closed);
    expect(result.current.status).toBe("closed");

    act(() => result.current.schedule(issueDraft(2)));
    act(() => vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS));
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    await flushMicrotasks();
    expect(saveDraft).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("нет связи — подпись честная, правка уходит повтором", async () => {
    saveDraft.mockRejectedValueOnce(apiError(0, "NETWORK_ERROR", "Нет связи с сервером — проверьте подключение"));
    const { result } = mount({ serverRevision: 0 });
    act(() => result.current.schedule(issueDraft(4)));
    act(() => vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS));
    await flushMicrotasks();
    expect(result.current.statusLabel).toBe("Нет связи — не сохранено");
    expect(result.current.dirty).toBe(true);

    act(() => vi.advanceTimersByTime(DRAFT_RETRY_DELAY_MS));
    await flushMicrotasks();
    expect(saveDraft).toHaveBeenCalledTimes(2);
    expect(saveDraft).toHaveBeenLastCalledWith("s1", 0, issueDraft(4), { keepalive: false });
    expect(result.current.statusLabel).toBe("Сохранено 14:05");
  });

  it("слишком большой черновик — «не сохранён», без повторов", async () => {
    saveDraft.mockRejectedValueOnce(apiError(413, "DRAFT_TOO_LARGE", "Черновик слишком большой"));
    const { result } = mount({ serverRevision: 0 });
    act(() => result.current.schedule(issueDraft(4)));
    act(() => vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS + DRAFT_RETRY_DELAY_MS * 2));
    await flushMicrotasks();
    expect(saveDraft).toHaveBeenCalledTimes(1);
    expect(result.current.statusLabel).toBe("Черновик слишком большой — не сохранён");
  });
});

describe("useChecklistDraft — перед «Готово»", () => {
  it("досылает правку и возвращает ревизию для complete", async () => {
    const { result } = mount({ serverRevision: 2 });
    act(() => result.current.schedule(issueDraft(3)));
    let pre: { draftRevision: number | undefined } | null = null;
    await act(async () => {
      pre = await result.current.flushBeforeSubmit();
    });
    expect(saveDraft).toHaveBeenCalledTimes(1);
    expect(pre).toEqual({ draftRevision: 3 });
  });

  it("без правок — ревизия с сервера", async () => {
    const { result } = mount({ serverRevision: 5 });
    let pre: { draftRevision: number | undefined } | null = null;
    await act(async () => {
      pre = await result.current.flushBeforeSubmit();
    });
    expect(saveDraft).not.toHaveBeenCalled();
    expect(pre).toEqual({ draftRevision: 5 });
  });

  it("другое устройство успело раньше — null (завершать нельзя, экран перезасеян)", async () => {
    saveDraft.mockRejectedValueOnce(
      apiError(409, "DRAFT_OUTDATED", "Чек-лист изменили на другом устройстве — загружена свежая версия", {
        revision: 9,
        draft: issueDraft(1),
        savedAt: SAVED_AT,
        savedBy: "Пётр",
      }),
    );
    const onOutdated = vi.fn();
    const { result } = mount({ serverRevision: 2, onOutdated });
    act(() => result.current.schedule(issueDraft(3)));
    let pre: { draftRevision: number | undefined } | null = { draftRevision: -1 };
    await act(async () => {
      pre = await result.current.flushBeforeSubmit();
    });
    expect(pre).toBeNull();
    expect(onOutdated).toHaveBeenCalledTimes(1);

    // Экран перезасеян, кладовщик посмотрел и снова жмёт «Готово» — можно.
    await act(async () => {
      pre = await result.current.flushBeforeSubmit();
    });
    expect(pre).toEqual({ draftRevision: 9 });
  });

  it("discard: отложенная правка не уходит в уже оформленную сессию", async () => {
    const { result, unmount } = mount({ serverRevision: 0 });
    act(() => result.current.schedule(issueDraft(3)));
    act(() => result.current.discard());
    unmount();
    act(() => vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS * 2));
    await flushMicrotasks();
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it("adoptOutdated (409 из complete): следующая правка идёт от свежей ревизии", async () => {
    const { result } = mount({ serverRevision: 1 });
    act(() =>
      result.current.adoptOutdated({ revision: 4, draft: issueDraft(2), savedAt: SAVED_AT, savedBy: "Пётр" }),
    );
    act(() => result.current.schedule(issueDraft(2)));
    act(() => vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS));
    await flushMicrotasks();
    expect(saveDraft).not.toHaveBeenCalled();
    act(() => result.current.schedule(issueDraft(3)));
    act(() => vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS));
    await flushMicrotasks();
    expect(saveDraft).toHaveBeenCalledWith("s1", 4, issueDraft(3), { keepalive: false });
  });
});

describe("useChecklistDraft — «ухожу» (P25)", () => {
  it("«открыл и посмотрел»: пустая сессия прерывается с onlyIfEmpty и EMPTY_LEAVE", async () => {
    const leaveRef: MutableRefObject<ChecklistLeaveFn | null> = { current: null };
    mount({ serverRevision: 0, leaveRef });
    expect(leaveRef.current).toBeTypeOf("function");

    act(() => leaveRef.current!());
    expect(cancel).toHaveBeenCalledWith("s1", {
      onlyIfEmpty: true,
      reason: "EMPTY_LEAVE",
      keepalive: true,
    });
    // Повторный уход не шлёт второй запрос.
    act(() => leaveRef.current?.());
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("была правка — сессию не трогаем, досылаем черновик", async () => {
    const { result } = mount({ serverRevision: 0 });
    act(() => result.current.schedule(issueDraft(2)));
    act(() => result.current.leave());
    expect(cancel).not.toHaveBeenCalled();
    expect(saveDraft).toHaveBeenCalledWith("s1", 0, issueDraft(2), { keepalive: false });

    // И после сохранения уход сессию не прерывает: работа в ней есть.
    await flushMicrotasks();
    act(() => result.current.leave());
    expect(cancel).not.toHaveBeenCalled();
  });

  it("черновик был на сервере при открытии — не прерываем", () => {
    const { result } = mount({ serverRevision: 3 });
    act(() => result.current.leave());
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("закрытие вкладки без работы тоже прерывает пустую сессию", () => {
    mount({ serverRevision: 0 });
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(saveDraft).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith("s1", {
      onlyIfEmpty: true,
      reason: "EMPTY_LEAVE",
      keepalive: true,
    });
  });

  it("leaveChecklistSession без открытого экрана: несохранённое досылается, пустое — прерывается", async () => {
    const { result, unmount } = mount({ serverRevision: 0 });
    saveDraft.mockRejectedValue(apiError(0, "NETWORK_ERROR", "Нет связи с сервером — проверьте подключение"));
    act(() => result.current.schedule(issueDraft(2)));
    act(() => vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS));
    await flushMicrotasks();
    unmount();
    await flushMicrotasks();
    const before = saveDraft.mock.calls.length;
    expect(peekUnsavedDraft("s1")).toEqual({ draft: issueDraft(2), baseRevision: 0 });

    // Связь вернулась, кладовщик ушёл с брони — правка досылается, сессия цела.
    saveDraft.mockImplementation(async (_sid: string, revision: number) => ({
      revision: revision + 1,
      savedAt: SAVED_AT,
    }));
    leaveChecklistSession("s1");
    await flushMicrotasks();
    expect(saveDraft.mock.calls.length).toBe(before + 1);
    expect(saveDraft).toHaveBeenLastCalledWith("s1", 0, issueDraft(2), { keepalive: false });
    expect(peekUnsavedDraft("s1")).toBeNull();
    expect(cancel).not.toHaveBeenCalled();

    // Сессия, экран которой так и не загрузился: решает сервер (onlyIfEmpty).
    leaveChecklistSession("never-opened");
    expect(cancel).toHaveBeenCalledWith("never-opened", {
      onlyIfEmpty: true,
      reason: "EMPTY_LEAVE",
      keepalive: true,
    });
  });
});

describe("useChecklistDraft — ревью: два устройства и гонки при уходе", () => {
  it("вернулся на экран, а другое устройство за это время сохранило позже: правка идёт от его ревизии, без ложного конфликта", async () => {
    const onOutdated = vi.fn();
    const first = mount({ serverRevision: 2, onOutdated });
    act(() => first.result.current.schedule(issueDraft(3)));
    act(() => vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS));
    await flushMicrotasks();
    expect(saveDraft).toHaveBeenLastCalledWith("s1", 2, issueDraft(3), { keepalive: false });
    first.unmount(); // смена раздела; второй планшет сохранил ревизии 4 и 5

    // Новый экземпляр чек-листа засеян из свежего /state (ревизия 5). Экран
    // выдачи не передаёт serverDraft — прежняя «последняя правка» (3) уже не
    // то, что лежит на сервере, и повтор её обязан уйти.
    const second = mount({ serverRevision: 5, onOutdated });
    act(() => second.result.current.schedule(issueDraft(3)));
    act(() => vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS));
    await flushMicrotasks();

    expect(saveDraft).toHaveBeenLastCalledWith("s1", 5, issueDraft(3), { keepalive: false });
    expect(onOutdated).not.toHaveBeenCalled();
    expect(second.result.current.revision).toBe(6);
  });

  it("несохранённая правка (нет связи) при возврате не подменяется молча: сервер ушёл вперёд — честный DRAFT_OUTDATED", async () => {
    saveDraft.mockRejectedValue(apiError(0, "NETWORK_ERROR", "Нет связи с сервером — проверьте подключение"));
    const first = mount({ serverRevision: 2 });
    act(() => first.result.current.schedule(issueDraft(3)));
    act(() => vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS));
    await flushMicrotasks();
    first.unmount();

    saveDraft.mockReset();
    saveDraft.mockImplementation(async (_sid: string, revision: number) => ({
      revision: revision + 1,
      savedAt: SAVED_AT,
    }));
    mount({ serverRevision: 5 });
    await flushMicrotasks();
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await flushMicrotasks();
    // Правка построена на ревизии 2 — сервер сам решит, что она проиграла.
    expect(saveDraft).toHaveBeenLastCalledWith("s1", 2, issueDraft(3), { keepalive: false });
  });

  it("отмена пустой сессии долетела, когда экран той же сессии уже открыли снова — «Сессию прервали», а не молчащий чек-лист", async () => {
    let resolveCancel: ((v: unknown) => void) | null = null;
    cancel.mockImplementation(
      () => new Promise((r) => {
        resolveCancel = r;
      }),
    );
    const leaveRef: MutableRefObject<ChecklistLeaveFn | null> = { current: null };
    const firstClosed = vi.fn();
    const first = mount({ serverRevision: 0, leaveRef, onSessionClosed: firstClosed });
    act(() => leaveRef.current!());
    expect(cancel).toHaveBeenCalledTimes(1);
    first.unmount();

    // Кладовщик тут же снова открыл ту же бронь: сервер продолжил сессию.
    const onSessionClosed = vi.fn();
    const second = mount({ serverRevision: 0, onSessionClosed });

    resolveCancel!({
      id: "s1",
      bookingId: "b1",
      operation: "ISSUE",
      status: "CANCELLED",
      cancelled: true,
      cancelReason: "EMPTY_LEAVE",
      cancelledAt: SAVED_AT,
      cancelledBy: "Иван",
    });
    await flushMicrotasks();

    expect(firstClosed).not.toHaveBeenCalled();
    expect(onSessionClosed).toHaveBeenCalledTimes(1);
    const err = onSessionClosed.mock.calls[0][0] as ScanApiError;
    expect(err.code).toBe("SESSION_CANCELLED");
    expect(err.message).toBe("Сессию склада прервали — откройте бронь заново");
    expect(err.details).toMatchObject({
      sessionId: "s1",
      operation: "ISSUE",
      cancelReason: "EMPTY_LEAVE",
      cancelledAt: SAVED_AT,
      cancelledBy: "Иван",
    });
    expect(second.result.current.status).toBe("closed");
  });

  it("отмена пустой сессии без открытого экрана — тихо забывает черновик", async () => {
    const leaveRef: MutableRefObject<ChecklistLeaveFn | null> = { current: null };
    const onSessionClosed = vi.fn();
    const { unmount } = mount({ serverRevision: 0, leaveRef, onSessionClosed });
    act(() => leaveRef.current!());
    unmount();
    await flushMicrotasks();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(onSessionClosed).not.toHaveBeenCalled();
    expect(peekUnsavedDraft("s1")).toBeNull();
  });

  it("экран ушёл в фон, пока летело сохранение: досылка обогнала его на сервере — это не другое устройство, правка уходит повтором", async () => {
    let resolveFirst: ((v: { revision: number; savedAt: string }) => void) | null = null;
    saveDraft
      .mockImplementationOnce(
        () => new Promise((r) => {
          resolveFirst = r;
        }),
      )
      // Досылка с keepalive пришла на сервер раньше первого запроса.
      .mockRejectedValueOnce(
        apiError(409, "DRAFT_OUTDATED", "Чек-лист изменили на другом устройстве — загружена свежая версия", {
          revision: 1,
          draft: issueDraft(1),
          savedAt: SAVED_AT,
          savedBy: "Иван",
        }),
      );
    const onOutdated = vi.fn();
    const { result } = mount({ serverRevision: 1, onOutdated });

    act(() => result.current.schedule(issueDraft(2)));
    act(() => vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS));
    expect(saveDraft).toHaveBeenLastCalledWith("s1", 1, issueDraft(2), { keepalive: false });

    act(() => result.current.schedule(issueDraft(3)));
    const spy = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    spy.mockRestore();
    expect(saveDraft).toHaveBeenLastCalledWith("s1", 2, issueDraft(3), { keepalive: true });
    await flushMicrotasks();

    resolveFirst!({ revision: 2, savedAt: SAVED_AT });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(onOutdated).not.toHaveBeenCalled();
    expect(saveDraft).toHaveBeenCalledTimes(3);
    expect(saveDraft).toHaveBeenLastCalledWith("s1", 2, issueDraft(3), { keepalive: false });
    expect(result.current.revision).toBe(3);
    expect(result.current.status).toBe("saved");
  });

  /** Первое сохранение висит, досылка при уходе в фон получает `outdated`. */
  async function overtakeScenario(outdated: { revision: number; draft: ChecklistDraftV1; savedBy: string }) {
    let resolveFirst: ((v: { revision: number; savedAt: string }) => void) | null = null;
    let rejectFirst: ((e: unknown) => void) | null = null;
    saveDraft
      .mockImplementationOnce(
        () => new Promise((res, rej) => {
          resolveFirst = res;
          rejectFirst = rej;
        }),
      )
      .mockRejectedValueOnce(
        apiError(409, "DRAFT_OUTDATED", "Чек-лист изменили на другом устройстве — загружена свежая версия", {
          ...outdated,
          savedAt: SAVED_AT,
        }),
      );
    const onOutdated = vi.fn();
    const hook = mount({ serverRevision: 1, onOutdated });
    act(() => hook.result.current.schedule(issueDraft(2)));
    act(() => vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS));
    act(() => hook.result.current.schedule(issueDraft(3)));
    const spy = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    spy.mockRestore();
    await flushMicrotasks();
    return { hook, onOutdated, resolveFirst: resolveFirst!, rejectFirst: rejectFirst! };
  }

  it("сервер применил обогнанный запрос между проверкой и ответом (в ответе ровно наша ревизия) — тоже не конфликт", async () => {
    const { hook, onOutdated, resolveFirst } = await overtakeScenario({
      revision: 2,
      draft: issueDraft(2),
      savedBy: "Иван",
    });
    resolveFirst({ revision: 2, savedAt: SAVED_AT });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(onOutdated).not.toHaveBeenCalled();
    expect(saveDraft).toHaveBeenLastCalledWith("s1", 2, issueDraft(3), { keepalive: false });
    expect(hook.result.current.revision).toBe(3);
  });

  it("а если ревизию поднял другой планшет — честный DRAFT_OUTDATED, его черновик не затирается", async () => {
    const other = issueDraft(9, true);
    const { hook, onOutdated, rejectFirst } = await overtakeScenario({
      revision: 2,
      draft: other,
      savedBy: "Пётр",
    });
    // Обогнанный запрос тоже проиграл другому планшету.
    rejectFirst(
      apiError(409, "DRAFT_OUTDATED", "Чек-лист изменили на другом устройстве — загружена свежая версия", {
        revision: 2,
        draft: other,
        savedAt: SAVED_AT,
        savedBy: "Пётр",
      }),
    );
    await flushMicrotasks();
    await flushMicrotasks();

    expect(onOutdated).toHaveBeenCalled();
    expect(onOutdated).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 2, draft: other }));
    // Своих повторов поверх чужой версии нет: всего два запроса.
    expect(saveDraft).toHaveBeenCalledTimes(2);
    expect(hook.result.current.status).toBe("outdated");
    expect(hook.result.current.revision).toBe(2);
  });
});

describe("matchDraftEntries — восстановление строк", () => {
  const row = (qty: number, equipmentId: string | null) => ({ qty, checked: true, equipmentId });

  it("по bookingItemId; лишние записи черновика считаются несопоставленными", () => {
    const { matched, unmatchedCount } = matchDraftEntries(
      { bi1: row(2, "eq1"), bi2: row(0, "eq2"), gone: row(1, null) },
      [
        { bookingItemId: "bi1", equipmentId: "eq1" },
        { bookingItemId: "bi2", equipmentId: "eq2" },
      ],
    );
    expect(matched.get("bi1")).toEqual(row(2, "eq1"));
    expect(matched.get("bi2")).toEqual(row(0, "eq2"));
    expect(unmatchedCount).toBe(1);
  });

  it("позицию брони пересоздали — запись переходит к строке с тем же equipmentId", () => {
    const { matched, unmatchedCount } = matchDraftEntries(
      { old1: row(3, "eq1") },
      [{ bookingItemId: "new1", equipmentId: "eq1" }],
    );
    expect(matched.get("new1")).toEqual(row(3, "eq1"));
    expect(unmatchedCount).toBe(0);
  });

  it("неоднозначно (две строки с тем же прибором) — не угадываем", () => {
    const { matched, unmatchedCount } = matchDraftEntries(
      { old1: row(3, "eq1") },
      [
        { bookingItemId: "new1", equipmentId: "eq1" },
        { bookingItemId: "new2", equipmentId: "eq1" },
      ],
    );
    expect(matched.size).toBe(0);
    expect(unmatchedCount).toBe(1);
  });

  it("нет черновика — пусто", () => {
    expect(matchDraftEntries(null, [{ bookingItemId: "bi1", equipmentId: "eq1" }])).toEqual({
      matched: new Map(),
      unmatchedCount: 0,
    });
  });
});
