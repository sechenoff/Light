import { render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lib/api", () => ({
  apiFetch: vi.fn(),
}));
vi.mock("../../ToastProvider", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import { apiFetch } from "../../../lib/api";
import { toast } from "../../ToastProvider";
import { TaskArchivePage } from "../TaskArchivePage";
import type { Task } from "../groupTasks";

const mockFetch = vi.mocked(apiFetch);
const toastError = vi.mocked(toast.error);
const toastSuccess = vi.mocked(toast.success);

function makeDone(id: string, title: string, completedAgoMs: number): Task {
  const completedAt = new Date(Date.now() - completedAgoMs).toISOString();
  return {
    id,
    title,
    status: "DONE",
    urgent: false,
    dueDate: null,
    description: null,
    createdBy: "u1",
    assignedTo: null,
    completedBy: "u1",
    completedAt,
    createdAt: "2026-06-01T10:00:00.000Z",
    updatedAt: completedAt,
    createdByUser: { id: "u1", username: "Иван" },
    assignedToUser: null,
    completedByUser: { id: "u1", username: "Иван" },
  } as Task;
}

beforeEach(() => {
  mockFetch.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
});

describe("TaskArchivePage", () => {
  it("запрашивает архив с sort=completedAt-desc (свежевыполненные первыми)", async () => {
    mockFetch.mockResolvedValueOnce({ items: [], nextCursor: null });

    render(<TaskArchivePage />);

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const url = String(mockFetch.mock.calls[0][0]);
    expect(url).toContain("status=DONE");
    expect(url).toContain("sort=completedAt-desc");
    expect(url).not.toContain("cursor=");
  });

  it("«Загрузить ещё» передаёт compound-курсор с прошлой страницы", async () => {
    const cursor = "2026-06-30T10:00:00.000Z|task-old";
    mockFetch.mockResolvedValueOnce({
      items: [makeDone("t1", "Задача А", 60 * 60 * 1000)],
      nextCursor: cursor,
    });

    render(<TaskArchivePage />);
    await screen.findByText("Задача А");

    mockFetch.mockResolvedValueOnce({ items: [], nextCursor: null });
    fireEvent.click(screen.getByRole("button", { name: "Загрузить ещё" }));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(String(mockFetch.mock.calls[1][0])).toContain(
      `cursor=${encodeURIComponent(cursor)}`,
    );
  });

  it("подпись «Выполнено всего»: честная «по загруженным записям» пока есть nextCursor", async () => {
    mockFetch.mockResolvedValueOnce({
      items: [makeDone("t1", "Задача А", 60 * 60 * 1000)],
      nextCursor: "2026-06-30T10:00:00.000Z|t1",
    });

    render(<TaskArchivePage />);
    await screen.findByText("Задача А");

    expect(screen.getByText("по загруженным записям")).toBeTruthy();
    expect(screen.queryByText("за всё время")).toBeNull();
  });

  it("подпись «за всё время» когда история догружена полностью (nextCursor=null)", async () => {
    mockFetch.mockResolvedValueOnce({
      items: [makeDone("t1", "Задача А", 60 * 60 * 1000)],
      nextCursor: null,
    });

    render(<TaskArchivePage />);
    await screen.findByText("Задача А");

    expect(screen.getByText("за всё время")).toBeTruthy();
  });

  it("«Вернуть» при ошибке сервера откатывает список — строка возвращается + toast.error", async () => {
    mockFetch.mockResolvedValueOnce({
      items: [makeDone("t1", "Задача А", 2 * 60 * 60 * 1000)],
      nextCursor: null,
    });

    render(<TaskArchivePage />);
    await screen.findByText("Задача А");

    mockFetch.mockRejectedValueOnce(new Error("Сервер недоступен"));
    fireEvent.click(screen.getByRole("button", { name: /Вернуть задачу/ }));

    // Оптимистично строка исчезает…
    expect(screen.queryByText("Задача А")).toBeNull();

    // …а после ошибки сервера возвращается (rollback), с тостом об ошибке
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Сервер недоступен"));
    expect(screen.getByText("Задача А")).toBeTruthy();
  });

  it("«Вернуть» при успехе убирает строку из архива и показывает toast.success", async () => {
    mockFetch.mockResolvedValueOnce({
      items: [makeDone("t1", "Задача А", 2 * 60 * 60 * 1000)],
      nextCursor: null,
    });

    render(<TaskArchivePage />);
    await screen.findByText("Задача А");

    mockFetch.mockResolvedValueOnce({ task: { id: "t1" } });
    fireEvent.click(screen.getByRole("button", { name: /Вернуть задачу/ }));

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Задача возвращена в работу"),
    );
    expect(screen.queryByText("Задача А")).toBeNull();
  });
});
