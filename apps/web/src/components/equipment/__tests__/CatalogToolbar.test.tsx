import { render, screen, within, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { CatalogToolbar, type CatalogToolbarProps } from "../CatalogToolbar";
import { getQuickPeriod } from "../catalogPeriod";

const today = getQuickPeriod("today");

function setup(overrides: Partial<CatalogToolbarProps> = {}) {
  const props: CatalogToolbarProps = {
    start: today.start,
    end: today.end,
    onPeriodChange: vi.fn(),
    search: "",
    onSearchChange: vi.fn(),
    category: undefined,
    categories: ["COB Light", "Грип", "Текстиль"],
    categoryCounts: { "COB Light": 15, Грип: 44, Текстиль: 19 },
    onCategoryChange: vi.fn(),
    isSuperAdmin: true,
    bookingHref: "/bookings/new?start=A&end=B",
    shownCount: 34,
    totalCount: 285,
    availableCount: 31,
    loadingCatalog: false,
    loadingAvail: false,
    ...overrides,
  };
  render(<CatalogToolbar {...props} />);
  return props;
}

describe("CatalogToolbar", () => {
  it("показывает период на чипе-якоре и длительность в подвале", () => {
    setup();
    // Чип продублирован (десктоп + мобильный), поэтому getAllBy.
    expect(screen.getAllByLabelText("Период проверки доступности — изменить").length).toBeGreaterThan(0);
    expect(screen.getByText("1 смена")).toBeInTheDocument();
    expect(screen.getByText("24 ч")).toBeInTheDocument();
  });

  it("активный пресет помечен aria-pressed, остальные — нет", () => {
    setup();
    const [todayBtn] = screen.getAllByRole("button", { name: "Сегодня" });
    const [tomorrowBtn] = screen.getAllByRole("button", { name: "Завтра" });
    expect(todayBtn).toHaveAttribute("aria-pressed", "true");
    expect(tomorrowBtn).toHaveAttribute("aria-pressed", "false");
  });

  it("клик по пресету отдаёт готовый диапазон наверх", () => {
    const props = setup();
    fireEvent.click(screen.getAllByRole("button", { name: "Завтра" })[0]);
    expect(props.onPeriodChange).toHaveBeenCalledWith(getQuickPeriod("tomorrow"));
  });

  it("счётчики в подвале: всего в каталоге, в фильтре, свободно", () => {
    setup({ category: "COB Light" });
    const status = screen.getByRole("status");
    expect(within(status).getByText("285")).toBeInTheDocument();
    expect(within(status).getByText("34")).toBeInTheDocument();
    expect(within(status).getByText("31")).toBeInTheDocument();
  });

  it("без фильтров «в фильтре» не показывается — счётчик один", () => {
    setup({ shownCount: 285 });
    const status = screen.getByRole("status");
    expect(within(status).queryByText(/в фильтре/)).not.toBeInTheDocument();
  });

  it("доступность ещё не загружена → честная подпись вместо нуля", () => {
    setup({ availableCount: null });
    expect(within(screen.getByRole("status")).getByText(/доступность недоступна/)).toBeInTheDocument();
  });

  it("категория в фильтре показана со счётчиком и кнопкой сброса", () => {
    const props = setup({ category: "Грип" });
    expect(screen.getAllByText("Грип").length).toBeGreaterThan(0);
    const [clear] = screen.getAllByLabelText("Сбросить фильтр категории «Грип»");
    fireEvent.click(clear);
    expect(props.onCategoryChange).toHaveBeenCalledWith(undefined);
  });

  it("список категорий открывается со счётчиками позиций", () => {
    setup();
    fireEvent.click(screen.getAllByLabelText("Фильтр по категории")[0]);
    const options = screen.getAllByRole("option");
    const labels = options.map((o) => o.textContent);
    expect(labels).toContain("Все категории78");
    expect(labels).toContain("Грип44");
  });

  it("кнопка очистки поиска появляется только при непустом запросе", () => {
    const props = setup({ search: "штатив" });
    const [clear] = screen.getAllByLabelText("Очистить поиск");
    fireEvent.click(clear);
    expect(props.onSearchChange).toHaveBeenCalledWith("");
  });

  it("пустой поиск — кнопки очистки нет", () => {
    setup({ search: "" });
    expect(screen.queryByLabelText("Очистить поиск")).not.toBeInTheDocument();
  });

  it("«Управление каталогом» видно только руководителю", () => {
    setup({ isSuperAdmin: false });
    expect(screen.queryByRole("link", { name: /Управление каталогом/ })).not.toBeInTheDocument();
  });

  it("CTA ведёт на форму брони с префиллом периода", () => {
    setup();
    const [cta] = screen.getAllByRole("link", { name: /Создать бронь/ });
    expect(cta).toHaveAttribute("href", "/bookings/new?start=A&end=B");
  });

  it("во время загрузки каталога подвал не врёт нулями", () => {
    setup({ loadingCatalog: true });
    expect(within(screen.getByRole("status")).getByText(/Загрузка каталога/)).toBeInTheDocument();
  });
});

describe("PeriodPopover внутри тулбара", () => {
  it("правки копятся в черновике и уходят только по «Применить»", () => {
    const props = setup();
    fireEvent.click(screen.getAllByLabelText("Период проверки доступности — изменить")[0]);

    const end = screen.getByLabelText("Конец") as HTMLInputElement;
    fireEvent.change(end, { target: { value: "2026-08-20T10:00" } });

    // Ключевое: до «Применить» наверх не ушло ничего — иначе каждый
    // промежуточный кадр datetime-local дёргал бы /api/availability.
    expect(props.onPeriodChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Применить" }));
    expect(props.onPeriodChange).toHaveBeenCalledTimes(1);
    expect(props.onPeriodChange).toHaveBeenCalledWith({
      start: today.start,
      end: "2026-08-20T10:00",
    });
  });

  it("«Отмена» закрывает без применения", () => {
    const props = setup();
    fireEvent.click(screen.getAllByLabelText("Период проверки доступности — изменить")[0]);
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(props.onPeriodChange).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Конец")).not.toBeInTheDocument();
  });

  it("конец раньше начала — «Применить» заблокирован и объяснён", () => {
    setup();
    fireEvent.click(screen.getAllByLabelText("Период проверки доступности — изменить")[0]);

    const end = screen.getByLabelText("Конец") as HTMLInputElement;
    fireEvent.change(end, { target: { value: "2020-01-01T10:00" } });

    expect(screen.getByRole("button", { name: "Применить" })).toBeDisabled();
    expect(screen.getByText("Конец периода должен быть позже начала")).toBeInTheDocument();
  });

  it("Esc закрывает редактор", () => {
    setup();
    fireEvent.click(screen.getAllByLabelText("Период проверки доступности — изменить")[0]);
    expect(screen.getByLabelText("Конец")).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByLabelText("Конец")).not.toBeInTheDocument();
  });
});
