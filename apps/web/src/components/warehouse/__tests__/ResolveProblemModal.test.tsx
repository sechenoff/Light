/**
 * Overlay-canon a11y tests for ResolveProblemModal: focus returns to the
 * triggering element on close, Tab/Shift+Tab are trapped within the dialog
 * (last↔first wrap), and body scroll is locked while open and restored on
 * close. The note-gate / payload behaviour is covered via ProblemItemsPage.
 */
import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ResolveProblemModal } from "../ResolveProblemModal";

beforeEach(() => {
  document.body.style.overflow = "";
});

describe("ResolveProblemModal — overlay a11y", () => {
  it("returns focus to the triggering element when closed", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Отметить «Найдено»";
    document.body.appendChild(trigger);
    trigger.focus();
    expect(trigger).toHaveFocus();

    const { rerender } = render(
      <ResolveProblemModal
        open
        outcome="FOUND"
        equipmentName="Aputure 600d"
        onClose={() => {}}
        onSubmit={() => {}}
      />,
    );

    // Auto-focus moves into the textarea on open (kept from prior behaviour).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(screen.getByLabelText(/Заметка/)).toHaveFocus();

    // Closing the modal must restore focus to the trigger.
    await act(async () => {
      rerender(
        <ResolveProblemModal
          open={false}
          outcome="FOUND"
          equipmentName="Aputure 600d"
          onClose={() => {}}
          onSubmit={() => {}}
        />,
      );
    });
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it("traps Tab/Shift+Tab within the dialog (last↔first wrap)", () => {
    render(
      <ResolveProblemModal
        open
        outcome="NOT_FOUND"
        equipmentName="Tripod Manfrotto"
        onClose={() => {}}
        onSubmit={() => {}}
      />,
    );
    const dialog = screen.getByRole("dialog");
    // A valid note enables the submit button so the LAST focusable is not
    // a disabled element (disabled controls cannot hold focus in jsdom).
    fireEvent.change(screen.getByLabelText(/Заметка/), {
      target: { value: "нашёлся на складе" },
    });
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !(el as HTMLButtonElement).disabled);
    expect(focusables.length).toBeGreaterThanOrEqual(2);
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    last.focus();
    expect(last).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(first).toHaveFocus();

    first.focus();
    expect(first).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
  });

  it("locks body scroll while open and restores it on close", () => {
    document.body.style.overflow = "auto";
    const { rerender } = render(
      <ResolveProblemModal
        open
        outcome="FOUND"
        equipmentName="Aputure 600d"
        onClose={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(document.body.style.overflow).toBe("hidden");

    rerender(
      <ResolveProblemModal
        open={false}
        outcome="FOUND"
        equipmentName="Aputure 600d"
        onClose={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(document.body.style.overflow).toBe("auto");
  });

  it("Esc still closes (overlay canon preserved)", () => {
    const onClose = vi.fn();
    render(
      <ResolveProblemModal
        open
        outcome="FOUND"
        equipmentName="Aputure 600d"
        onClose={onClose}
        onSubmit={() => {}}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
