import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { TaskCard } from "../TaskCard";
import type { Task } from "../groupTasks";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Купить воду",
    status: "OPEN",
    urgent: false,
    dueDate: null,
    description: null,
    createdBy: "u1",
    assignedTo: "u2",
    completedBy: null,
    completedAt: null,
    createdAt: "2026-04-17T10:00:00Z",
    updatedAt: "2026-04-17T10:00:00Z",
    assignedToUser: { id: "u2", username: "Иван" },
    createdByUser: { id: "u1", username: "Петр" },
    ...overrides,
  };
}

describe("TaskCard", () => {
  it("renders the task title", () => {
    render(
      <TaskCard
        task={makeTask()}
        onComplete={vi.fn()}
        onReopen={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText("Купить воду")).toBeInTheDocument();
  });

  it("calls onComplete when checkbox is clicked", () => {
    const onComplete = vi.fn();
    render(
      <TaskCard
        task={makeTask()}
        onComplete={onComplete}
        onReopen={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const checkbox = screen.getByRole("checkbox", { name: /выполненным/i });
    fireEvent.click(checkbox);
    expect(onComplete).toHaveBeenCalledWith("t1");
  });

  it("shows assignee initials avatar", () => {
    render(
      <TaskCard
        task={makeTask()}
        onComplete={vi.fn()}
        onReopen={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    // "Иван" → initial "И"
    expect(screen.getByTitle("Иван")).toBeInTheDocument();
  });

  it("applies rose left border when urgent=true", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({ urgent: true })}
        onComplete={vi.fn()}
        onReopen={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    // The root element should have the urgent border class
    const card = container.firstChild as HTMLElement;
    expect(card.className).toMatch(/border-rose/);
  });

  it("toggles urgent flag when flame button clicked", () => {
    const onUpdate = vi.fn();
    render(
      <TaskCard
        task={makeTask({ urgent: false })}
        onComplete={vi.fn()}
        onReopen={vi.fn()}
        onUpdate={onUpdate}
        onDelete={vi.fn()}
      />,
    );
    const flameBtn = screen.getByRole("button", { name: /Пометить срочным/i });
    fireEvent.click(flameBtn);
    expect(onUpdate).toHaveBeenCalledWith("t1", { urgent: true });
  });

  it("toggles urgent flag off when already urgent", () => {
    const onUpdate = vi.fn();
    render(
      <TaskCard
        task={makeTask({ urgent: true })}
        onComplete={vi.fn()}
        onReopen={vi.fn()}
        onUpdate={onUpdate}
        onDelete={vi.fn()}
      />,
    );
    const flameBtn = screen.getByRole("button", { name: /Снять срочность/i });
    fireEvent.click(flameBtn);
    expect(onUpdate).toHaveBeenCalledWith("t1", { urgent: false });
  });
});
