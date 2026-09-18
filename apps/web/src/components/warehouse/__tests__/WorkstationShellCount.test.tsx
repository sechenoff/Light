/**
 * Каркас киоска на экране счёта инвентаризации: своей вкладки нет — в
 * навигации подсвечена «Смена»; в шапке метка «X / Y» и полоса прогресса.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkstationShell } from "../WorkstationShell";

describe("WorkstationShell — счёт инвентаризации", () => {
  it("tab=count подсвечивает «Смену» и не добавляет вкладку", () => {
    render(
      <WorkstationShell
        tab="count"
        onTab={vi.fn()}
        eyebrow="Инвентаризация № 1 · Иван"
        title="Грип"
        titleTag="23 / 51"
        headerProgress={{ done: 23, total: 51, label: "Посчитано 23 из 51" }}
        detail={<div />}
      />,
    );

    const current = screen.getAllByRole("button", { current: "page" });
    expect(current.length).toBeGreaterThan(0);
    expect(current.every((b) => b.textContent?.includes("Смена"))).toBe(true);
    expect(screen.queryByRole("button", { name: /Инвентаризация/ })).not.toBeInTheDocument();

    expect(screen.getByRole("heading", { name: "Грип" })).toBeInTheDocument();
    expect(screen.getByText("23 / 51")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: "Посчитано 23 из 51" });
    expect(bar).toHaveAttribute("aria-valuenow", "23");
    expect(bar).toHaveAttribute("aria-valuemax", "51");
  });
});
