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
  onImportFile: vi.fn(),
  importing: false,
};

const pdf = () => new File(["%PDF-1.4"], "заявка.pdf", { type: "application/pdf" });

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

  describe("заявка файлом", () => {
    it("поле принимает PDF и фото; выбранный файл уходит в onImportFile", () => {
      const onImportFile = vi.fn();
      render(<AiRequestModal {...base} onImportFile={onImportFile} />);
      const input = screen.getByLabelText(/загрузить заявку файлом/i);
      expect(input).toHaveAttribute("accept", expect.stringContaining("application/pdf"));
      expect(input).toHaveAttribute("accept", expect.stringContaining("image/jpeg"));

      const file = pdf();
      fireEvent.change(input, { target: { files: [file] } });

      expect(onImportFile).toHaveBeenCalledTimes(1);
      expect(onImportFile.mock.calls[0][0]).toBe(file);
    });

    it("перетаскивание файла на зону тоже зовёт onImportFile", () => {
      const onImportFile = vi.fn();
      render(<AiRequestModal {...base} onImportFile={onImportFile} />);
      const zone = screen.getByText(/загрузить заявку файлом/i).closest("label")!;
      const file = pdf();
      fireEvent.drop(zone, { dataTransfer: { files: [file] } });
      expect(onImportFile).toHaveBeenCalledWith(file);
    });

    it("importing=true — «Читаю документ», textarea заблокирована, Esc не закрывает", () => {
      const onClose = vi.fn();
      render(<AiRequestModal {...base} importing={true} onClose={onClose} />);
      expect(screen.getByText(/читаю документ/i)).toBeInTheDocument();
      expect(screen.getByRole("textbox")).toBeDisabled();
      expect(screen.getByLabelText(/загрузить заявку файлом/i)).toBeDisabled();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onClose).not.toHaveBeenCalled();
    });

    it("пока идёт текстовое распознавание, файл не принимается", () => {
      const onImportFile = vi.fn();
      render(<AiRequestModal {...base} text="строка" parsing={true} onImportFile={onImportFile} />);
      fireEvent.change(screen.getByLabelText(/загрузить заявку файлом/i), { target: { files: [pdf()] } });
      expect(onImportFile).not.toHaveBeenCalled();
    });
  });
});
