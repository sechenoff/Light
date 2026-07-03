import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { TaskEditModal } from "../TaskEditModal";
import type { Task } from "../groupTasks";

const BASE_TASK: Task = {
  id: "task-1",
  title: "Проверить генератор",
  status: "OPEN",
  urgent: false,
  // 2026-07-10 полночь по Москве (UTC-3 часа)
  dueDate: "2026-07-09T21:00:00.000Z",
  description: null,
  createdBy: "u1",
  assignedTo: null,
  completedBy: null,
  completedAt: null,
  createdAt: "2026-07-01T10:00:00.000Z",
  updatedAt: "2026-07-01T10:00:00.000Z",
};

describe("TaskEditModal", () => {
  let onSave: Mock;
  let onClose: Mock;

  beforeEach(() => {
    onSave = vi.fn().mockResolvedValue(true);
    onClose = vi.fn();
  });

  it("отправляет dueDate как YYYY-MM-DD (не ISO-datetime)", async () => {
    render(<TaskEditModal task={BASE_TASK} onSave={onSave} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: /сохранить/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    const patch = onSave.mock.calls[0][1];
    // Существующий срок (ISO с сервера) должен уйти как московская дата "YYYY-MM-DD"
    expect(patch.dueDate).toBe("2026-07-10");
  });

  it("изменённая дата из <input type=date> уходит как есть", async () => {
    render(<TaskEditModal task={BASE_TASK} onSave={onSave} onClose={onClose} />);

    const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: "2026-08-01" } });

    fireEvent.click(screen.getByRole("button", { name: /сохранить/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][1].dueDate).toBe("2026-08-01");
  });

  it("пустая дата уходит как null", async () => {
    render(<TaskEditModal task={BASE_TASK} onSave={onSave} onClose={onClose} />);

    const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: "" } });

    fireEvent.click(screen.getByRole("button", { name: /сохранить/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][1].dueDate).toBeNull();
  });

  it("закрывается только ПОСЛЕ успешного onSave", async () => {
    let resolveSave!: (v: boolean) => void;
    onSave.mockImplementation(
      () => new Promise<boolean>((resolve) => { resolveSave = resolve; }),
    );

    render(<TaskEditModal task={BASE_TASK} onSave={onSave} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: /сохранить/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());

    // Пока сохранение в полёте — модалка открыта, кнопка показывает прогресс
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /сохранение/i })).toBeDisabled();

    resolveSave(true);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("НЕ закрывается, если onSave вернул false (ошибка сохранения)", async () => {
    onSave.mockResolvedValue(false);

    render(<TaskEditModal task={BASE_TASK} onSave={onSave} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: /сохранить/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    // Даём микротаскам завершиться
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /сохранить/i })).not.toBeDisabled(),
    );
    expect(onClose).not.toHaveBeenCalled();
    // Модалка всё ещё в DOM
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
