/**
 * «Прервать выдачу / приёмку» в киоске (P1): брошенную сессию теперь есть
 * чем закрыть. Подтверждение говорит, что сбросится, в каком статусе
 * останется бронь и что доборы этой сессии останутся в брони.
 */
import { render, renderHook, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const cancel = vi.fn();
const saveDraft = vi.fn();
vi.mock("../api", () => ({
  scanApi: {
    cancel: (...a: unknown[]) => cancel(...a),
    saveDraft: (...a: unknown[]) => saveDraft(...a),
  },
}));
const toastSuccess = vi.fn();
vi.mock("../../ToastProvider", () => ({
  toast: { success: (m: string) => toastSuccess(m), error: vi.fn(), info: vi.fn() },
}));

import { AbortSessionButton } from "../AbortSessionButton";
import {
  _resetChecklistDraftsForTests,
  peekUnsavedDraft,
  useChecklistDraft,
} from "../useChecklistDraft";

beforeEach(() => {
  cancel.mockReset();
  saveDraft.mockReset();
  toastSuccess.mockReset();
  _resetChecklistDraftsForTests();
});

describe("AbortSessionButton", () => {
  it("выдача: подтверждение с доборами, KIOSK_ABORT, тост и onAborted", async () => {
    cancel.mockResolvedValue({ id: "s1", cancelled: true });
    // На экране несохранённая правка — после «Прервать» она не должна уйти.
    const draft = renderHook(() => useChecklistDraft({ sessionId: "s1", serverRevision: 0 }));
    act(() =>
      draft.result.current.schedule({
        v: 1,
        issue: { rows: { bi1: { qty: 3, checked: true, equipmentId: null } } },
      }),
    );
    expect(peekUnsavedDraft("s1")).not.toBeNull();
    const onAborted = vi.fn();
    render(
      <AbortSessionButton sessionId="s1" operation="ISSUE" addonsInSession={2} onAborted={onAborted} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Прервать выдачу" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Прервать выдачу?");
    expect(dialog).toHaveTextContent("Количества и отметки сбросятся, бронь останется «Подтверждена».");
    expect(dialog).toHaveTextContent("Доборы этой сессии (2) останутся в брони.");

    fireEvent.click(screen.getAllByRole("button", { name: "Прервать выдачу" })[1]);
    await waitFor(() => expect(onAborted).toHaveBeenCalledTimes(1));
    expect(cancel).toHaveBeenCalledWith("s1", { reason: "KIOSK_ABORT" });
    expect(toastSuccess).toHaveBeenCalledWith("Выдача прервана");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(peekUnsavedDraft("s1")).toBeNull();
    draft.unmount();
    await new Promise((r) => setTimeout(r, 900));
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it("приёмка: свои слова, без строки про доборы", () => {
    render(<AbortSessionButton sessionId="s1" operation="RETURN" addonsInSession={3} onAborted={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Прервать приёмку" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Отметки приёмки сбросятся, бронь останется «Выдана».");
    expect(dialog).not.toHaveTextContent("Доборы");
    expect(screen.getByRole("button", { name: "Продолжить приёмку" })).toBeInTheDocument();
  });

  it("«Продолжить выдачу» закрывает окно без запроса", () => {
    render(<AbortSessionButton sessionId="s1" operation="ISSUE" onAborted={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Прервать выдачу" }));
    fireEvent.click(screen.getByRole("button", { name: "Продолжить выдачу" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("сессию уже закрыли — onSessionClosed вместо ошибки", async () => {
    const closed = {
      status: 409,
      code: "SESSION_ALREADY_COMPLETED",
      message: "Выдача по этой брони уже оформлена",
      details: { sessionId: "s1", operation: "ISSUE", completedAt: null, completedBy: "Пётр" },
    };
    cancel.mockRejectedValue(closed);
    const onSessionClosed = vi.fn();
    const onAborted = vi.fn();
    render(
      <AbortSessionButton
        sessionId="s1"
        operation="ISSUE"
        onAborted={onAborted}
        onSessionClosed={onSessionClosed}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Прервать выдачу" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Прервать выдачу" })[1]);
    await waitFor(() => expect(onSessionClosed).toHaveBeenCalledWith(closed));
    expect(onAborted).not.toHaveBeenCalled();
  });

  it("сбой связи — сообщение в окне, окно остаётся", async () => {
    cancel.mockRejectedValue({
      status: 0,
      code: "NETWORK_ERROR",
      message: "Нет связи с сервером — проверьте подключение",
      details: null,
    });
    const onAborted = vi.fn();
    render(<AbortSessionButton sessionId="s1" operation="ISSUE" onAborted={onAborted} />);
    fireEvent.click(screen.getByRole("button", { name: "Прервать выдачу" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Прервать выдачу" })[1]);
    expect(await screen.findByRole("alert")).toHaveTextContent("Нет связи с сервером — проверьте подключение");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onAborted).not.toHaveBeenCalled();
  });
});
