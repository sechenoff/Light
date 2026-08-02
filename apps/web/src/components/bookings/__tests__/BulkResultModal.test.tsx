import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { BulkResultModal, type BulkFailure } from "../BulkResultModal";

const fail = (id: string, message = "Недопустимый переход"): BulkFailure => ({
  id,
  code: "INVALID_BOOKING_STATE",
  message,
  title: `30.06.2026 · Петя Куб · Проект ${id}`,
});

describe("BulkResultModal", () => {
  it("закрытая модалка ничего не рендерит", () => {
    const { container } = render(
      <BulkResultModal open={false} actionLabel="Согласовать" okCount={0} failures={[]} onClose={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("при частичном успехе показывает оба счётчика", () => {
    render(
      <BulkResultModal
        open
        actionLabel="Согласовать"
        okCount={2}
        failures={[fail("a"), fail("b")]}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Выполнено частично")).toBeInTheDocument();
    expect(screen.getByText(/Успешно:/)).toBeInTheDocument();
  });

  it("когда не прошло ничего — заголовок не обещает частичного успеха", () => {
    render(
      <BulkResultModal open actionLabel="Отменить" okCount={0} failures={[fail("a")]} onClose={vi.fn()} />,
    );
    expect(screen.getByText("Ничего не выполнено")).toBeInTheDocument();
    // «Успешно: 0» противоречило бы заголовку и намекало, что часть прошла.
    expect(screen.queryByText(/Успешно:/)).toBeNull();
  });

  it("перечисляет брони человеческими подписями, а не id", () => {
    render(
      <BulkResultModal open actionLabel="В архив" okCount={1} failures={[fail("xyz", "Бронь уже в архиве")]} onClose={vi.fn()} />,
    );
    expect(screen.getByText(/Петя Куб/)).toBeInTheDocument();
    expect(screen.getByText("Бронь уже в архиве")).toBeInTheDocument();
  });

  it("закрывается кнопкой и по Esc", () => {
    const onClose = vi.fn();
    render(
      <BulkResultModal open actionLabel="Согласовать" okCount={1} failures={[fail("a")]} onClose={onClose} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Понятно" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
