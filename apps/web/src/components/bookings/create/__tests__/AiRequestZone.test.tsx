import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { AiRequestZone } from "../AiRequestZone";

const base = {
  open: true,
  text: "",
  onTextChange: vi.fn(),
  onParse: vi.fn(),
  onCancel: vi.fn(),
  parsing: false,
};

describe("AiRequestZone", () => {
  it("закрыта — ничего не рендерит", () => {
    const { container } = render(<AiRequestZone {...base} open={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("открыта — textarea с подсказкой, «Распознать» заблокирована при пустом тексте", () => {
    render(<AiRequestZone {...base} />);
    expect(screen.getByPlaceholderText(/список от гафера/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^распознать$/i })).toBeDisabled();
  });

  it("считает непустые строки в лейбле кнопки и зовёт onParse", () => {
    const onParse = vi.fn();
    render(<AiRequestZone {...base} text={"2x ARRI SkyPanel\n\n1x Kino Flo"} onParse={onParse} />);
    const btn = screen.getByRole("button", { name: /распознать 2 строки/i });
    fireEvent.click(btn);
    expect(onParse).toHaveBeenCalled();
  });

  it("ввод текста зовёт onTextChange", () => {
    const onTextChange = vi.fn();
    render(<AiRequestZone {...base} onTextChange={onTextChange} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "нова x2" } });
    expect(onTextChange).toHaveBeenCalledWith("нова x2");
  });

  it("parsing=true — кнопка заблокирована с текстом «Распознаю...»", () => {
    render(<AiRequestZone {...base} text={"строка"} parsing={true} />);
    const btn = screen.getByRole("button", { name: /распознаю/i });
    expect(btn).toBeDisabled();
  });

  it("«Отмена» зовёт onCancel", () => {
    const onCancel = vi.fn();
    render(<AiRequestZone {...base} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: /отмена/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});
