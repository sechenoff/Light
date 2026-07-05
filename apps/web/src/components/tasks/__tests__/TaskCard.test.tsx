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

  it("toggles urgent flag via ⋯ menu when not urgent", () => {
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
    // Open the ⋯ menu first
    const menuBtn = screen.getByRole("button", { name: /Действия с задачей/i });
    fireEvent.click(menuBtn);
    // Now click the urgent menu item
    const urgentBtn = screen.getByRole("button", { name: /Пометить срочным/i });
    fireEvent.click(urgentBtn);
    expect(onUpdate).toHaveBeenCalledWith("t1", { urgent: true });
  });

  it("toggles urgent flag off via ⋯ menu when already urgent", () => {
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
    // Open the ⋯ menu first
    const menuBtn = screen.getByRole("button", { name: /Действия с задачей/i });
    fireEvent.click(menuBtn);
    // Now click the urgent menu item
    const urgentBtn = screen.getByRole("button", { name: /Снять срочность/i });
    fireEvent.click(urgentBtn);
    expect(onUpdate).toHaveBeenCalledWith("t1", { urgent: false });
  });

  it("renders comment + checklist chips when present", () => {
    const onOpen = vi.fn();
    render(
      <TaskCard
        task={makeTask({ commentCount: 3, checklistSummary: { done: 1, total: 4 } })}
        onComplete={() => {}}
        onReopen={() => {}}
        onUpdate={() => {}}
        onDelete={() => {}}
        onOpenDetail={onOpen}
      />,
    );
    expect(screen.getByText("💬 3")).toBeInTheDocument();
    expect(screen.getByText("☑ 1/4")).toBeInTheDocument();
  });

  it("calls onOpenDetail when the card body is clicked", () => {
    const onOpen = vi.fn();
    render(
      <TaskCard
        task={makeTask({ id: "tX" })}
        onComplete={() => {}}
        onReopen={() => {}}
        onUpdate={() => {}}
        onDelete={() => {}}
        onOpenDetail={onOpen}
      />,
    );
    fireEvent.click(screen.getByTestId("task-card-body-tX"));
    expect(onOpen).toHaveBeenCalledWith("tX");
  });

  it("clicking the title enters inline-edit and does NOT open the detail panel", () => {
    const onOpen = vi.fn();
    render(
      <TaskCard
        task={makeTask({ id: "tEdit", title: "Изначальное" })}
        onComplete={() => {}}
        onReopen={() => {}}
        onUpdate={() => {}}
        onDelete={() => {}}
        onOpenDetail={onOpen}
      />,
    );
    fireEvent.click(screen.getByText("Изначальное"));
    // inline-edit input should appear (title became editable)
    expect(screen.getByDisplayValue("Изначальное")).toBeInTheDocument();
    // and the detail panel must NOT have been requested
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("due pill for a task due today uses the warn (amber) variant, not calm info", () => {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Moscow" });
    const { container } = render(
      <TaskCard
        task={makeTask({ dueDate: `${today}T00:00:00+03:00` })}
        onComplete={vi.fn()}
        onReopen={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    // warn variant renders text-warn; the old (inverted) code used info → text-accent.
    expect(container.querySelector(".text-warn")).not.toBeNull();
    expect(container.querySelector(".text-accent")).toBeNull();
  });

  it("renders a clickable booking chip linking to the booking when relatedBooking is present", () => {
    render(
      <TaskCard
        task={makeTask({
          relatedBooking: {
            id: "bk1",
            projectName: "Съёмка рекламы",
            clientId: "cl1",
            clientName: "Мосфильм",
          },
        })}
        onComplete={vi.fn()}
        onReopen={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const link = screen.getByRole("link", { name: /Съёмка рекламы · Мосфильм/ });
    expect(link).toHaveAttribute("href", "/bookings/bk1");
  });

  it("clicking the booking chip does NOT open the detail panel", () => {
    const onOpen = vi.fn();
    render(
      <TaskCard
        task={makeTask({
          id: "tChip",
          relatedBooking: { id: "bk2", projectName: "Клип", clientId: "cl2", clientName: "Ленфильм" },
        })}
        onComplete={vi.fn()}
        onReopen={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
        onOpenDetail={onOpen}
      />,
    );
    fireEvent.click(screen.getByRole("link", { name: /Клип · Ленфильм/ }));
    expect(onOpen).not.toHaveBeenCalled();
  });
});
