import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ScanShell } from "../ScanShell";

describe("ScanShell", () => {
  it("renders the dark canon header band with eyebrow + title", () => {
    const { container } = render(
      <ScanShell
        eyebrow="Склад · Выдача"
        title="Выберите бронь"
        detail={<div>detail</div>}
      />,
    );
    const header = container.querySelector("header");
    expect(header).not.toBeNull();
    // Deep-navy canon accent band (not raw slate/blue literal).
    expect(header?.className).toContain("bg-accent");
    expect(screen.getByText("Склад · Выдача")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Выберите бронь" }),
    ).toBeInTheDocument();
  });

  it("uses the two-pane lg: grid only when a list slot is provided", () => {
    const { container, rerender } = render(
      <ScanShell title="t" detail={<div>only-detail</div>} />,
    );
    // No list → no two-pane grid wrapper.
    expect(container.querySelector(".lg\\:grid")).toBeNull();

    rerender(
      <ScanShell
        title="t"
        list={<div data-testid="list">list</div>}
        detail={<div data-testid="detail">detail</div>}
      />,
    );
    const grid = container.querySelector(".lg\\:grid");
    expect(grid).not.toBeNull();
    // Desktop two-pane column template per mockup block 4.
    expect(grid?.className).toContain(
      "lg:grid-cols-[minmax(280px,360px)_1fr]",
    );
    expect(screen.getByTestId("list")).toBeInTheDocument();
    expect(screen.getByTestId("detail")).toBeInTheDocument();
    // List sits in <aside>, detail in <main>.
    expect(container.querySelector("aside")).not.toBeNull();
    expect(container.querySelector("main")).not.toBeNull();
  });

  it("renders worker name + logout when provided", () => {
    let loggedOut = false;
    render(
      <ScanShell
        title="t"
        workerName="Иван Кладовщик"
        onLogout={() => {
          loggedOut = true;
        }}
        detail={<div>d</div>}
      />,
    );
    expect(screen.getByText("Иван Кладовщик")).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: "Выйти" });
    btn.click();
    expect(loggedOut).toBe(true);
  });
});
