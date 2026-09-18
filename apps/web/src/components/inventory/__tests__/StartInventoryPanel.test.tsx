/**
 * «Начать инвентаризацию»: весь склад по умолчанию (categories: null) или
 * выбранные категории — ровно отмеченные, в порядке каталога. 409 «уже идёт» —
 * объяснение и переход в идущую.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("../../ToastProvider", () => ({
  toast: {
    success: (m: string) => toastSuccess(m),
    error: (m: string) => toastError(m),
    info: vi.fn(),
  },
}));

const apiFetch = vi.fn();
vi.mock("../../../lib/api", () => ({
  apiFetch: (path: string, init?: RequestInit) => apiFetch(path, init),
}));

import { StartInventoryPanel } from "../StartInventoryPanel";
import { apiError, makeDetail } from "./fixtures";

const CATEGORIES = {
  categories: ["Грип", "Электрика / Коммутация", "Текстиль"],
  counts: { Грип: 51, "Электрика / Коммутация": 30, Текстиль: 21 },
};

function startBody() {
  const call = apiFetch.mock.calls.find(([path, init]) => path === "/api/stock-counts" && init?.method === "POST");
  return call ? JSON.parse(String(call[1].body)) : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("StartInventoryPanel", () => {
  it("по умолчанию — весь склад: POST { categories: null }", async () => {
    const started = makeDetail({ number: 2 });
    apiFetch.mockResolvedValueOnce({ stockCount: started });
    const onStarted = vi.fn();
    render(<StartInventoryPanel onStarted={onStarted} onAlreadyOpen={vi.fn()} />);

    expect(screen.getByRole("radio", { name: /Весь склад/ })).toBeChecked();
    expect(screen.getByText(/со штучным учётом в инвентаризацию не входят/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Начать инвентаризацию" }));

    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(started));
    expect(startBody()).toEqual({ categories: null });
    expect(toastSuccess).toHaveBeenCalledWith("Инвентаризация № 2 началась");
  });

  it("выбранные категории: грузит список со счётчиками и отправляет отмеченные в порядке каталога", async () => {
    apiFetch.mockImplementation((path: string) =>
      path === "/api/equipment/categories"
        ? Promise.resolve(CATEGORIES)
        : Promise.resolve({ stockCount: makeDetail({ categories: ["Грип", "Текстиль"] }) }),
    );
    const onStarted = vi.fn();
    render(<StartInventoryPanel onStarted={onStarted} onAlreadyOpen={vi.fn()} />);

    fireEvent.click(screen.getByRole("radio", { name: /Выбранные категории/ }));
    const start = screen.getByRole("button", { name: "Начать инвентаризацию" });
    await screen.findByRole("checkbox", { name: /Грип/ });
    expect(screen.getByText("51 поз.")).toBeInTheDocument();
    // Ничего не отмечено — начинать нечего.
    expect(start).toBeDisabled();
    expect(screen.getByText("Отметьте хотя бы одну категорию")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: /Текстиль/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Грип/ }));
    expect(start).toBeEnabled();
    fireEvent.click(start);

    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(startBody()).toEqual({ categories: ["Грип", "Текстиль"] });
  });

  it("«выбрать все» отмечает все категории", async () => {
    apiFetch.mockResolvedValueOnce(CATEGORIES);
    render(<StartInventoryPanel onStarted={vi.fn()} onAlreadyOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("radio", { name: /Выбранные категории/ }));
    fireEvent.click(await screen.findByRole("button", { name: "выбрать все" }));
    expect(screen.getAllByRole("checkbox").every((c) => (c as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByText("выбрано 3 из 3")).toBeInTheDocument();
  });

  it("409 «уже идёт» — текст сервера и переход в идущую", async () => {
    apiFetch.mockRejectedValueOnce(
      apiError(409, "STOCK_COUNT_ALREADY_OPEN", "Уже идёт инвентаризация № 1 — завершите или отмените её"),
    );
    const onAlreadyOpen = vi.fn();
    render(<StartInventoryPanel onStarted={vi.fn()} onAlreadyOpen={onAlreadyOpen} />);
    fireEvent.click(screen.getByRole("button", { name: "Начать инвентаризацию" }));

    await waitFor(() => expect(onAlreadyOpen).toHaveBeenCalled());
    expect(toastError).toHaveBeenCalledWith("Уже идёт инвентаризация № 1 — завершите или отмените её");
  });
});
