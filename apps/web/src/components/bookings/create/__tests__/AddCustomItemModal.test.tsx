import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { AddCustomItemModal } from "../AddCustomItemModal";

describe("AddCustomItemModal", () => {
  it("без префилла: пустое имя, количество 1, кнопка выключена", () => {
    render(<AddCustomItemModal isOpen onClose={vi.fn()} onAdd={vi.fn()} />);
    expect((screen.getByLabelText(/Название/) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(/Количество/) as HTMLInputElement).value).toBe("1");
    expect(screen.getByRole("button", { name: "Добавить в смету" })).toBeDisabled();
  });

  it("префилл из AI-«вне каталога»: имя и количество подставлены, нужна только цена", () => {
    const onAdd = vi.fn();
    render(
      <AddCustomItemModal
        isOpen
        onClose={vi.fn()}
        onAdd={onAdd}
        initialName="дым-машина"
        initialQuantity={2}
      />,
    );
    expect((screen.getByLabelText(/Название/) as HTMLInputElement).value).toBe("дым-машина");
    expect((screen.getByLabelText(/Количество/) as HTMLInputElement).value).toBe("2");

    fireEvent.change(screen.getByLabelText(/Цена/), { target: { value: "3000" } });
    fireEvent.click(screen.getByRole("button", { name: "Добавить в смету" }));

    expect(onAdd).toHaveBeenCalledWith({ name: "дым-машина", unitPrice: 3000, quantity: 2 });
  });

  it("нулевая цена не проходит — позиция обязана иметь цену", () => {
    const onAdd = vi.fn();
    render(
      <AddCustomItemModal isOpen onClose={vi.fn()} onAdd={onAdd} initialName="стедикам" />,
    );
    fireEvent.change(screen.getByLabelText(/Цена/), { target: { value: "0" } });
    expect(screen.getByRole("button", { name: "Добавить в смету" })).toBeDisabled();
    expect(onAdd).not.toHaveBeenCalled();
  });
});
