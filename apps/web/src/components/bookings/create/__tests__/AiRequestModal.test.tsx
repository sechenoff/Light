import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { AiRequestModal } from "../AiRequestModal";

const base = {
  open: true,
  text: "",
  onTextChange: vi.fn(),
  onParse: vi.fn(),
  onClose: vi.fn(),
  parsing: false,
};

describe("AiRequestModal", () => {
  it("закрыта — ничего не рендерит", () => {
    const { container } = render(<AiRequestModal {...base} open={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("открыта — dialog с textarea, «Распознать» заблокирована при пустом тексте", () => {
    render(<AiRequestModal {...base} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/по строке на позицию/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^распознать$/i })).toBeDisabled();
  });

  it("считает непустые строки в лейбле кнопки и зовёт onParse", () => {
    const onParse = vi.fn();
    render(<AiRequestModal {...base} text={"2x ARRI SkyPanel\n\n1x Kino Flo"} onParse={onParse} />);
    fireEvent.click(screen.getByRole("button", { name: /распознать 2 строки/i }));
    expect(onParse).toHaveBeenCalled();
  });

  it("ввод текста зовёт onTextChange", () => {
    const onTextChange = vi.fn();
    render(<AiRequestModal {...base} onTextChange={onTextChange} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "нова x2" } });
    expect(onTextChange).toHaveBeenCalledWith("нова x2");
  });

  it("parsing=true — кнопка «Распознаю...», textarea и закрытие заблокированы", () => {
    const onClose = vi.fn();
    render(<AiRequestModal {...base} text={"строка"} parsing={true} onClose={onClose} />);
    expect(screen.getByRole("button", { name: /распознаю/i })).toBeDisabled();
    expect(screen.getByRole("textbox")).toBeDisabled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("крестик зовёт onClose", () => {
    const onClose = vi.fn();
    render(<AiRequestModal {...base} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /закрыть/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("«Отмена» зовёт onClose", () => {
    const onClose = vi.fn();
    render(<AiRequestModal {...base} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /отмена/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("Esc зовёт onClose", () => {
    const onClose = vi.fn();
    render(<AiRequestModal {...base} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("клик по фону закрывает, клик по панели — нет", () => {
    const onClose = vi.fn();
    render(<AiRequestModal {...base} onClose={onClose} />);
    fireEvent.click(screen.getByRole("textbox"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
