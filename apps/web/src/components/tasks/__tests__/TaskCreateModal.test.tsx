import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { TaskCreateModal } from "../TaskCreateModal";
import { toMoscowDateString, addDays } from "../../../lib/moscowDate";

const ASSIGNEE_OPTIONS = [
  { id: "u1", username: "alice" },
  { id: "u2", username: "bob" },
];

// Helper to get the title textarea (v2 has a different placeholder)
function getTitleTextarea() {
  return screen.getByPlaceholderText(/например.*починить/i) as HTMLTextAreaElement;
}

describe("TaskCreateModal", () => {
  let onSubmit: Mock;
  let onClose: Mock;

  beforeEach(() => {
    onSubmit = vi.fn().mockResolvedValue(undefined);
    onClose = vi.fn();
  });

  it("renders with «Без даты» as the default active pill (dueDate=null on submit)", async () => {
    render(
      <TaskCreateModal
        onSubmit={onSubmit}
        onClose={onClose}
        assigneeOptions={ASSIGNEE_OPTIONS}
      />
    );

    // Default active pill text visible (v2: renamed from «Долгосрочная задача»)
    expect(screen.getByText(/без даты/i)).toBeInTheDocument();

    // Enter a title and submit
    const textarea = getTitleTextarea();
    fireEvent.change(textarea, { target: { value: "Починить машину" } });

    const submitBtn = screen.getByRole("button", { name: /создать задачу/i });
    fireEvent.click(submitBtn);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const arg = onSubmit.mock.calls[0][0];
    expect(arg.dueDate).toBeNull();
    expect(arg.title).toBe("Починить машину");
  });

  it("clicking «Завтра» pill sets dueDate to tomorrow's Moscow date string on submit", async () => {
    render(
      <TaskCreateModal
        onSubmit={onSubmit}
        onClose={onClose}
        assigneeOptions={ASSIGNEE_OPTIONS}
      />
    );

    const textarea = getTitleTextarea();
    fireEvent.change(textarea, { target: { value: "Задача на завтра" } });

    fireEvent.click(screen.getByText(/^завтра$/i));

    const submitBtn = screen.getByRole("button", { name: /создать задачу/i });
    fireEvent.click(submitBtn);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const arg = onSubmit.mock.calls[0][0];
    const expectedDate = toMoscowDateString(addDays(new Date(), 1));
    expect(arg.dueDate).toBe(expectedDate);
  });

  it("clicking «📅 Другая дата» reveals date input and picking a date submits that value", async () => {
    render(
      <TaskCreateModal
        onSubmit={onSubmit}
        onClose={onClose}
        assigneeOptions={ASSIGNEE_OPTIONS}
      />
    );

    const textarea = getTitleTextarea();
    fireEvent.change(textarea, { target: { value: "Задача с датой" } });

    // Click the "📅 Другая дата" pill (v2 uses emoji + "Другая дата")
    fireEvent.click(screen.getByText(/другая дата/i));

    // Date input should appear inside the accent-soft box
    const dateInputEl = document.querySelector('input[type="date"]') as HTMLInputElement;
    expect(dateInputEl).not.toBeNull();

    fireEvent.change(dateInputEl, { target: { value: "2026-06-15" } });

    const submitBtn = screen.getByRole("button", { name: /создать задачу/i });
    fireEvent.click(submitBtn);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const arg = onSubmit.mock.calls[0][0];
    expect(arg.dueDate).toBe("2026-06-15");
  });

  it("pressing Esc fires onClose", () => {
    render(
      <TaskCreateModal
        onSubmit={onSubmit}
        onClose={onClose}
        assigneeOptions={ASSIGNEE_OPTIONS}
      />
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("empty title disables submit button", () => {
    render(
      <TaskCreateModal
        onSubmit={onSubmit}
        onClose={onClose}
        assigneeOptions={ASSIGNEE_OPTIONS}
      />
    );

    const submitBtn = screen.getByRole("button", { name: /создать задачу/i });
    // No text entered — button should be disabled
    expect(submitBtn).toBeDisabled();

    // Enter whitespace-only — still disabled
    const textarea = getTitleTextarea();
    fireEvent.change(textarea, { target: { value: "   " } });
    expect(submitBtn).toBeDisabled();

    // Enter valid text — now enabled
    fireEvent.change(textarea, { target: { value: "Задача" } });
    expect(submitBtn).not.toBeDisabled();
  });
});
