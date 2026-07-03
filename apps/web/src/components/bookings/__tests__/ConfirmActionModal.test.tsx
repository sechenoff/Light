import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ConfirmActionModal } from "../ConfirmActionModal";

const BASE_PROPS = {
  open: true,
  title: "Отмена брони",
  subtitle: "01.05.2026 · Иванов Иван",
  message: "Отменить бронь?\n\nРезервы оборудования будут сняты.",
  confirmLabel: "Отменить бронь",
  onClose: vi.fn(),
  onConfirm: vi.fn(),
};

describe("ConfirmActionModal", () => {
  it("renders nothing when closed", () => {
    const { container } = render(<ConfirmActionModal {...BASE_PROPS} open={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders title, subtitle and message when open", () => {
    render(<ConfirmActionModal {...BASE_PROPS} />);
    expect(screen.getByText("Отмена брони")).toBeInTheDocument();
    expect(screen.getByText("01.05.2026 · Иванов Иван")).toBeInTheDocument();
    expect(screen.getByText(/Резервы оборудования будут сняты/)).toBeInTheDocument();
  });

  it("calls onConfirm when confirm button is clicked", () => {
    const onConfirm = vi.fn();
    render(<ConfirmActionModal {...BASE_PROPS} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "Отменить бронь" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onClose on cancel button, Escape and backdrop click", () => {
    const onClose = vi.fn();
    render(<ConfirmActionModal {...BASE_PROPS} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("does not close while loading and disables buttons", () => {
    const onClose = vi.fn();
    render(<ConfirmActionModal {...BASE_PROPS} onClose={onClose} loading />);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Выполняю…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Отмена" })).toBeDisabled();
  });
});
