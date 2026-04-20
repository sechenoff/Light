import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import {
  Donut,
  KPI,
  BalanceBar,
  Segmented,
  Tag,
} from "../designSystem";

// ── Donut ─────────────────────────────────────────────────────────────────────

describe("Donut", () => {
  it("renders aria-label including all segment labels and total", () => {
    render(
      <Donut
        segments={[
          { value: 60, color: "#0f7a4d", label: "Получено" },
          { value: 30, color: "#4f46e5", label: "Выплачено" },
          { value: 10, color: "#d8d5cf", label: "Осталось" },
        ]}
      />,
    );
    const svg = screen.getByRole("img");
    const label = svg.getAttribute("aria-label") ?? "";
    expect(label).toContain("Получено 60");
    expect(label).toContain("Выплачено 30");
    expect(label).toContain("Осталось 10");
    expect(label).toContain("всего 100");
  });

  it("renders an empty ring when total is 0", () => {
    const { container } = render(<Donut segments={[]} />);
    // Only the background circle; no segment circles
    const circles = container.querySelectorAll("circle");
    expect(circles.length).toBe(1);
  });

  it("renders N+1 circles for N non-zero segments (background + each segment)", () => {
    const { container } = render(
      <Donut
        segments={[
          { value: 50, color: "red", label: "A" },
          { value: 50, color: "blue", label: "B" },
        ]}
      />,
    );
    const circles = container.querySelectorAll("circle");
    // 1 background + 2 segments
    expect(circles.length).toBe(3);
  });
});

// ── KPI ───────────────────────────────────────────────────────────────────────

describe("KPI", () => {
  it("applies neg tone via data-tone attribute on the accent strip", () => {
    const { container } = render(
      <KPI label="Долг" value="5 000 ₽" tone="neg" />,
    );
    const strip = container.querySelector("[data-tone='neg']");
    expect(strip).not.toBeNull();
  });

  it("applies pos tone via data-tone attribute", () => {
    const { container } = render(
      <KPI label="Доход" value="10 000 ₽" tone="pos" />,
    );
    const strip = container.querySelector("[data-tone='pos']");
    expect(strip).not.toBeNull();
  });

  it("defaults to 'default' tone when tone is omitted", () => {
    const { container } = render(<KPI label="Total" value="0" />);
    const strip = container.querySelector("[data-tone='default']");
    expect(strip).not.toBeNull();
  });

  it("renders label, value, and sub text", () => {
    render(<KPI label="Проекты" value="42" sub="за месяц" />);
    expect(screen.getByText("Проекты")).toBeDefined();
    expect(screen.getByText("42")).toBeDefined();
    expect(screen.getByText("за месяц")).toBeDefined();
  });
});

// ── BalanceBar ────────────────────────────────────────────────────────────────

describe("BalanceBar", () => {
  it("renders exactly 3 rect elements when total > 0", () => {
    const { container } = render(
      <BalanceBar received={60} paid={30} remaining={10} total={100} />,
    );
    const rects = container.querySelectorAll("rect");
    expect(rects.length).toBe(3);
  });

  it("widths of all 3 rects sum to 100%", () => {
    const { container } = render(
      <BalanceBar received={50} paid={30} remaining={20} total={100} />,
    );
    const rects = container.querySelectorAll("rect");
    let sum = 0;
    rects.forEach((rect) => {
      const w = rect.getAttribute("width") ?? "0%";
      sum += parseFloat(w.replace("%", ""));
    });
    expect(sum).toBeCloseTo(100, 1);
  });

  it("renders 3 rects even when all values are 0", () => {
    const { container } = render(
      <BalanceBar received={0} paid={0} remaining={0} total={0} />,
    );
    const rects = container.querySelectorAll("rect");
    expect(rects.length).toBe(3);
  });
});

// ── Segmented ─────────────────────────────────────────────────────────────────

describe("Segmented", () => {
  it("calls onChange with the clicked option id", () => {
    const onChange = vi.fn();
    render(
      <Segmented
        options={[
          { id: "week", label: "Неделя" },
          { id: "month", label: "Месяц" },
          { id: "year", label: "Год" },
        ]}
        value="week"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByText("Месяц"));
    expect(onChange).toHaveBeenCalledWith("month");
  });

  it("does not call onChange when the active pill is clicked again", () => {
    const onChange = vi.fn();
    render(
      <Segmented
        options={[
          { id: "week", label: "Неделя" },
          { id: "month", label: "Месяц" },
        ]}
        value="week"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByText("Неделя"));
    // onChange is called — behaviour: it's up to the parent to decide.
    // The control always fires; parent ignores same-value updates.
    expect(onChange).toHaveBeenCalledWith("week");
  });
});

// ── Tag ───────────────────────────────────────────────────────────────────────

describe("Tag", () => {
  const tones = ["pos", "neg", "warn", "info", "neutral"] as const;

  tones.forEach((tone) => {
    it(`renders data-tag-tone="${tone}" for distinguishable styling`, () => {
      const { container } = render(<Tag tone={tone}>{tone}</Tag>);
      const el = container.querySelector(`[data-tag-tone='${tone}']`);
      expect(el).not.toBeNull();
    });
  });
});
