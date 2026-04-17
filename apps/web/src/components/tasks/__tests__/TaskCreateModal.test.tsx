import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TaskCreateModal } from "../TaskCreateModal";
import { toMoscowDateString, addDays } from "../../../lib/moscowDate";

const ASSIGNEE_OPTIONS = [
  { id: "u1", username: "alice" },
  { id: "u2", username: "bob" },
];

describe("TaskCreateModal", () => {
  let onSubmit: ReturnType<typeof vi.fn>;
  let onClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onSubmit = vi.fn().mockResolvedValue(undefined);
    onClose = vi.fn();
  });

  it("renders with «Долгосрочная задача» as the default active pill (dueDate=null on submit)", async () => {
    render(
      <TaskCreateModal
        onSubmit={onSubmit}
        onClose={onClose}
        assigneeOptions={ASSIGNEE_OPTIONS}
      />
    );

    // Default active pill text visible
    expect(screen.getByText(/долгосрочная задача/i)).toBeInTheDocument();

    // Enter a title and submit
    const textarea = screen.getByPlaceholderText(/что сделать/i);
    fireEvent.change(textarea, { target: { value: "Починить машину" } });

    const submitBtn = screen.getByRole("button", { name: /создать/i });
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

    const textarea = screen.getByPlaceholderText(/что сделать/i);
    fireEvent.change(textarea, { target: { value: "Задача на завтра" } });

    fireEvent.click(screen.getByText(/^завтра$/i));

    const submitBtn = screen.getByRole("button", { name: /создать/i });
    fireEvent.click(submitBtn);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const arg = onSubmit.mock.calls[0][0];
    const expectedDate = toMoscowDateString(addDays(new Date(), 1));
    expect(arg.dueDate).toBe(expectedDate);
  });

  it("clicking «Выбрать дату…» reveals date input and picking a date submits that value", async () => {
    render(
      <TaskCreateModal
        onSubmit={onSubmit}
        onClose={onClose}
        assigneeOptions={ASSIGNEE_OPTIONS}
      />
    );

    const textarea = screen.getByPlaceholderText(/что сделать/i);
    fireEvent.change(textarea, { target: { value: "Задача с датой" } });

    // Click the "Выбрать дату" pill
    fireEvent.click(screen.getByText(/выбрать дату/i));

    // Date input should appear
    const dateInput = screen.getByRole("textbox", { hidden: true }) as HTMLInputElement
      || document.querySelector('input[type="date"]') as HTMLInputElement;
    // Try querying the input directly since type="date" won't be role="textbox"
    const dateInputEl = document.querySelector('input[type="date"]') as HTMLInputElement;
    expect(dateInputEl).not.toBeNull();

    fireEvent.change(dateInputEl, { target: { value: "2026-06-15" } });

    const submitBtn = screen.getByRole("button", { name: /создать/i });
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

    const submitBtn = screen.getByRole("button", { name: /создать/i });
    // No text entered — button should be disabled
    expect(submitBtn).toBeDisabled();

    // Enter whitespace-only — still disabled
    const textarea = screen.getByPlaceholderText(/что сделать/i);
    fireEvent.change(textarea, { target: { value: "   " } });
    expect(submitBtn).toBeDisabled();

    // Enter valid text — now enabled
    fireEvent.change(textarea, { target: { value: "Задача" } });
    expect(submitBtn).not.toBeDisabled();
  });
});
