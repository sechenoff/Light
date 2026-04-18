import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { TaskAssigneePill } from "../TaskAssigneePill";

describe("TaskAssigneePill", () => {
  it("renders username and avatar initial for a known user", () => {
    render(<TaskAssigneePill user={{ id: "u1", username: "Иван" }} />);
    expect(screen.getByText("Иван")).toBeInTheDocument();
    // Avatar initial
    expect(screen.getByText("И")).toBeInTheDocument();
  });

  it("renders «никому» fallback when user is null", () => {
    render(<TaskAssigneePill user={null} />);
    expect(screen.getByText("никому")).toBeInTheDocument();
    expect(screen.getByText("?")).toBeInTheDocument();
  });

  it("renders «никому» fallback when user is undefined", () => {
    render(<TaskAssigneePill user={undefined} />);
    expect(screen.getByText("никому")).toBeInTheDocument();
  });

  it("applies a deterministic color class from the avatar color palette", () => {
    const { container } = render(<TaskAssigneePill user={{ id: "u1", username: "Alice" }} />);
    const avatar = container.querySelector("span span");
    expect(avatar).not.toBeNull();
    const colorClasses = ["bg-teal", "bg-amber", "bg-indigo", "bg-rose", "bg-emerald"];
    const hasColorClass = colorClasses.some((c) => avatar!.className.includes(c));
    expect(hasColorClass).toBe(true);
  });
});
