/**
 * «Начать инвентаризацию»: весь склад по умолчанию (categories: null) или
 * выбранные категории — ровно отмеченные, в порядке каталога. Счётчики — только
 * позиции с учётом количеством (GET /api/stock-counts/scope); категорию, где
 * пересчитывать нечего, выбрать нельзя. 409 «уже идёт» — объяснение и переход
 * в идущую.
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

const SCOPE = {
  categories: ["Грип", "Электрика / Коммутация", "Текстиль"],
  counts: { Грип: 51, "Электрика / Коммутация": 30, Текстиль: 21 },
  unitCounts: { Грип: 0, "Электрика / Коммутация": 0, Текстиль: 0 },
};

/** Каталог, где «COB Light» — только штучный прибор, а в «Свете» штучный один из трёх. */
const SCOPE_WITH_UNIT_ONLY = {
  categories: ["Свет", "COB Light", "Грип"],
  counts: { Свет: 2, "COB Light": 0, Грип: 4 },
  unitCounts: { Свет: 1, "COB Light": 1, Грип: 0 },
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
      path === "/api/stock-counts/scope"
        ? Promise.resolve(SCOPE)
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
    apiFetch.mockResolvedValueOnce(SCOPE);
    render(<StartInventoryPanel onStarted={vi.fn()} onAlreadyOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("radio", { name: /Выбранные категории/ }));
    fireEvent.click(await screen.findByRole("button", { name: "выбрать все" }));
    expect(screen.getAllByRole("checkbox").every((c) => (c as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByText("выбрано 3 из 3")).toBeInTheDocument();
  });

  it("категория только со штучным учётом — не выбирается, «выбрать все» её пропускает", async () => {
    apiFetch.mockImplementation((path: string) =>
      path === "/api/stock-counts/scope"
        ? Promise.resolve(SCOPE_WITH_UNIT_ONLY)
        : Promise.resolve({ stockCount: makeDetail({ categories: ["Свет", "Грип"] }) }),
    );
    const onStarted = vi.fn();
    render(<StartInventoryPanel onStarted={onStarted} onAlreadyOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("radio", { name: /Выбранные категории/ }));

    const cob = (await screen.findByRole("checkbox", { name: /COB Light/ })) as HTMLInputElement;
    expect(cob).toBeDisabled();
    expect(screen.getByText("только штучный учёт — сверяется в карточке единиц")).toBeInTheDocument();
    // Счётчик смешанной категории — только позиции количеством.
    expect(screen.getByText("2 поз.")).toBeInTheDocument();
    expect(screen.getByText("выбрано 0 из 2")).toBeInTheDocument();

    fireEvent.click(cob);
    expect(cob).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "выбрать все" }));
    expect(cob).not.toBeChecked();
    expect(screen.getByText("выбрано 2 из 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Начать инвентаризацию" }));
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(startBody()).toEqual({ categories: ["Свет", "Грип"] });
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
