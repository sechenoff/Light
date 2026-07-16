import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClientAutocomplete } from "../ClientAutocomplete";

const apiFetchMock = vi.fn();
vi.mock("../../../../lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const RECENT = {
  clients: [
    { id: "c1", name: "Студия Свет", phone: "+7 900 000-00-01" },
    { id: "c2", name: "Кинокомпания Кадр", phone: null },
  ],
};

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe("ClientAutocomplete — последние клиенты на фокусе", () => {
  it("фокус на пустом поле грузит sort=recent и показывает дропдаун с заголовком", async () => {
    apiFetchMock.mockResolvedValue(RECENT);
    render(<ClientAutocomplete value="" onChange={vi.fn()} />);
    fireEvent.focus(screen.getByRole("combobox"));

    await waitFor(() => {
      expect(screen.getByText("Недавние клиенты")).toBeInTheDocument();
    });
    expect(apiFetchMock).toHaveBeenCalledWith("/api/clients?sort=recent&limit=8");
    expect(screen.getByText("Студия Свет")).toBeInTheDocument();
    expect(screen.getByText("Кинокомпания Кадр")).toBeInTheDocument();
    // Пустое поле — пункта «+ Добавить нового клиента» нет
    expect(screen.queryByText(/добавить нового клиента/i)).toBeNull();
  });

  it("клик по недавнему клиенту выбирает его", async () => {
    apiFetchMock.mockResolvedValue(RECENT);
    const onChange = vi.fn();
    render(<ClientAutocomplete value="" onChange={onChange} />);
    fireEvent.focus(screen.getByRole("combobox"));
    await screen.findByText("Студия Свет");

    fireEvent.mouseDown(screen.getByText("Студия Свет"));
    expect(onChange).toHaveBeenCalledWith("Студия Свет");
  });

  it("повторный фокус не перезапрашивает список (ленивый кэш)", async () => {
    apiFetchMock.mockResolvedValue(RECENT);
    render(<ClientAutocomplete value="" onChange={vi.fn()} />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    await screen.findByText("Студия Свет");
    fireEvent.blur(input);
    fireEvent.focus(input);
    await screen.findByText("Студия Свет");
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it("ошибка загрузки — дропдаун просто не показывается, без падения", async () => {
    apiFetchMock.mockRejectedValue(new Error("network"));
    render(<ClientAutocomplete value="" onChange={vi.fn()} />);
    fireEvent.focus(screen.getByRole("combobox"));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(screen.queryByText("Недавние клиенты")).toBeNull();
  });

  it("при вводе текста заголовок «Недавние» уходит — обычный поиск", async () => {
    apiFetchMock.mockResolvedValue(RECENT);
    render(<ClientAutocomplete value="Студ" onChange={vi.fn()} />);
    fireEvent.focus(screen.getByRole("combobox"));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(screen.queryByText("Недавние клиенты")).toBeNull();
  });
});
