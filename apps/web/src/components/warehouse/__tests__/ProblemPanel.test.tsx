import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ProblemPanel } from "../ProblemPanel";
import { scanApi } from "../api";

// Visible label text only — the emoji is a separate aria-hidden <span>, so
// the chip's text is split across two nodes (match the label node).
const REASON_LABELS = [
  "Остался на площадке",
  "Потерян",
  "Уничтожен",
  "Украден",
];

function noop() {}

describe("ProblemPanel", () => {
  it("renders a rose canon panel with all 4 reason chips + sub-note", () => {
    const { container } = render(
      <ProblemPanel
        reason={null}
        onReasonChange={noop}
        comment=""
        onCommentChange={noop}
        expectedBackDate={null}
        onExpectedBackDateChange={noop}
      />,
    );

    const panel = container.querySelector(
      '[aria-label="Проблема — причина и комментарий"]',
    );
    expect(panel).toBeInTheDocument();
    expect(panel?.className).toMatch(/bg-rose-soft/);
    expect(panel?.className).toMatch(/border-rose-border/);

    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(4);
    for (const label of REASON_LABELS) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(
      screen.getByText("→ в список «Потеряшки» · заявка на поиск"),
    ).toBeInTheDocument();
  });

  it("chips carry the exact Russian aria-labels and single-select state", () => {
    render(
      <ProblemPanel
        reason="LOST"
        onReasonChange={noop}
        comment=""
        onCommentChange={noop}
        expectedBackDate={null}
        onExpectedBackDateChange={noop}
      />,
    );
    expect(
      screen.getByRole("radio", { name: "Причина: Остался на площадке" }),
    ).toHaveAttribute("aria-checked", "false");
    expect(
      screen.getByRole("radio", { name: "Причина: Потерян" }),
    ).toHaveAttribute("aria-checked", "true");
    // exactly one selected
    expect(
      screen.getAllByRole("radio").filter(
        (r) => r.getAttribute("aria-checked") === "true",
      ),
    ).toHaveLength(1);
  });

  it("selecting a chip fires onReasonChange with the reason code", () => {
    const onReasonChange = vi.fn();
    render(
      <ProblemPanel
        reason={null}
        onReasonChange={onReasonChange}
        comment=""
        onCommentChange={noop}
        expectedBackDate={null}
        onExpectedBackDateChange={noop}
      />,
    );
    screen.getByRole("radio", { name: "Причина: Украден" }).click();
    expect(onReasonChange).toHaveBeenCalledWith("STOLEN");
  });

  it("date input appears ONLY for LEFT_ON_SITE", () => {
    const { rerender } = render(
      <ProblemPanel
        reason="LOST"
        onReasonChange={noop}
        comment=""
        onCommentChange={noop}
        expectedBackDate={null}
        onExpectedBackDateChange={noop}
      />,
    );
    expect(
      screen.queryByLabelText(/Ожидается к дате/),
    ).not.toBeInTheDocument();

    rerender(
      <ProblemPanel
        reason="LEFT_ON_SITE"
        onReasonChange={noop}
        comment=""
        onCommentChange={noop}
        expectedBackDate={null}
        onExpectedBackDateChange={noop}
      />,
    );
    expect(screen.getByLabelText(/Ожидается к дате/)).toBeInTheDocument();
  });

  it("date input binds to expectedBackDate and emits ISO / null", () => {
    const onExpectedBackDateChange = vi.fn();
    render(
      <ProblemPanel
        reason="LEFT_ON_SITE"
        onReasonChange={noop}
        comment=""
        onCommentChange={noop}
        expectedBackDate="2026-05-22"
        onExpectedBackDateChange={onExpectedBackDateChange}
      />,
    );
    const input = screen.getByLabelText(
      /Ожидается к дате/,
    ) as HTMLInputElement;
    expect(input.value).toBe("2026-05-22");

    fireEvent.change(input, { target: { value: "2026-06-01" } });
    expect(onExpectedBackDateChange).toHaveBeenCalledWith("2026-06-01");

    fireEvent.change(input, { target: { value: "" } });
    expect(onExpectedBackDateChange).toHaveBeenCalledWith(null);
  });

  it("switching the reason away from LEFT_ON_SITE clears the date", () => {
    const onExpectedBackDateChange = vi.fn();
    const onReasonChange = vi.fn();
    render(
      <ProblemPanel
        reason="LEFT_ON_SITE"
        onReasonChange={onReasonChange}
        comment=""
        onCommentChange={noop}
        expectedBackDate="2026-05-22"
        onExpectedBackDateChange={onExpectedBackDateChange}
      />,
    );
    screen.getByRole("radio", { name: "Причина: Потерян" }).click();
    expect(onExpectedBackDateChange).toHaveBeenCalledWith(null);
    expect(onReasonChange).toHaveBeenCalledWith("LOST");
  });

  it("does NOT clear the date when re-selecting LEFT_ON_SITE", () => {
    const onExpectedBackDateChange = vi.fn();
    render(
      <ProblemPanel
        reason="LEFT_ON_SITE"
        onReasonChange={vi.fn()}
        comment=""
        onCommentChange={noop}
        expectedBackDate="2026-05-22"
        onExpectedBackDateChange={onExpectedBackDateChange}
      />,
    );
    screen
      .getByRole("radio", { name: "Причина: Остался на площадке" })
      .click();
    expect(onExpectedBackDateChange).not.toHaveBeenCalled();
  });

  it("comment textarea fires onCommentChange", () => {
    const onCommentChange = vi.fn();
    render(
      <ProblemPanel
        reason="LOST"
        onReasonChange={noop}
        comment=""
        onCommentChange={onCommentChange}
        expectedBackDate={null}
        onExpectedBackDateChange={noop}
      />,
    );
    const ta = screen.getByPlaceholderText("Комментарий (обязательно)");
    fireEvent.change(ta, { target: { value: "Не вернули со смены" } });
    expect(onCommentChange).toHaveBeenCalledWith("Не вернули со смены");
  });

  it("makes NO API/DB calls (pure controlled form)", () => {
    const spies = Object.keys(scanApi).map((k) =>
      vi.spyOn(scanApi, k as keyof typeof scanApi),
    );
    const onReasonChange = vi.fn();
    render(
      <ProblemPanel
        reason="LEFT_ON_SITE"
        onReasonChange={onReasonChange}
        comment=""
        onCommentChange={noop}
        expectedBackDate={null}
        onExpectedBackDateChange={noop}
      />,
    );
    screen.getByRole("radio", { name: "Причина: Потерян" }).click();
    fireEvent.change(
      screen.getByPlaceholderText("Комментарий (обязательно)"),
      { target: { value: "test" } },
    );
    for (const s of spies) {
      expect(s).not.toHaveBeenCalled();
    }
  });

  it("renders NO barcode anywhere", () => {
    const { container } = render(
      <ProblemPanel
        reason="LEFT_ON_SITE"
        onReasonChange={noop}
        comment="Пропал"
        onCommentChange={noop}
        expectedBackDate="2026-05-22"
        onExpectedBackDateChange={noop}
      />,
    );
    expect(container.textContent || "").not.toMatch(/LR-[A-Z0-9]+-\d+/);
  });

  it("disables chips, date and textarea when disabled", () => {
    render(
      <ProblemPanel
        reason="LEFT_ON_SITE"
        onReasonChange={noop}
        comment=""
        onCommentChange={noop}
        expectedBackDate={null}
        onExpectedBackDateChange={noop}
        disabled
      />,
    );
    for (const r of screen.getAllByRole("radio")) {
      expect(r).toBeDisabled();
    }
    expect(screen.getByLabelText(/Ожидается к дате/)).toBeDisabled();
    expect(
      screen.getByPlaceholderText("Комментарий (обязательно)"),
    ).toBeDisabled();
  });
});
