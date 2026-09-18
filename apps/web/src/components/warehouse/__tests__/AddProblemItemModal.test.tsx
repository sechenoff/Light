/**
 * AddProblemItemModal — «Завести потеряшку» вручную (мокап concept-a, врезка 1).
 *
 * Mocks: ToastProvider и JWT-клиент `apiFetch` (маршрутизация по URL).
 * Проверяем: поиск → выбор позиции → плитки наличия и потолок степпера
 * «на полке должно быть»; обязательный комментарий; поле «Ожидается к» только
 * для «Остался на площадке»; тело POST (в т.ч. sourceBookingId из следа);
 * штучная позиция — выбор единицы без штрихкодов (на съёмке и в мастерской —
 * недоступны); брони на съёмке в следе не предлагаются; единицы — загрузка,
 * ошибка с повтором, пустой список; ошибки по кодам; Esc/фон.
 */
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { AddProblemItemModal, formatTrailDates, trailRowNote } from "../AddProblemItemModal";

// --- Fixtures ---

const COUNT_EQ = {
  id: "eq-count",
  name: "Набор зарядок",
  category: "Аккумуляторный свет",
  totalQuantity: 5,
  stockTrackingMode: "COUNT" as const,
  unitStatusCounts: null,
};

const UNIT_EQ = {
  id: "eq-unit",
  name: "Прожектор HMI 1.8",
  category: "Свет",
  totalQuantity: 3,
  stockTrackingMode: "UNIT" as const,
  unitStatusCounts: { AVAILABLE: 2, MISSING: 1 },
};

function trail(overrides: Record<string, unknown> = {}) {
  return {
    equipmentId: "eq-count",
    name: "Набор зарядок",
    category: "Аккумуляторный свет",
    windowFrom: "2026-07-20T09:00:00.000Z",
    windowIsDefault: true,
    totalBookings: 2,
    verifiedReturns: 1,
    bookings: [
      {
        bookingId: "bk-1",
        projectName: "Сериал «Тихий дом»",
        clientName: "Кинокомпания «Север»",
        startDate: "2026-09-09T09:00:00.000Z",
        endDate: "2026-09-11T18:00:00.000Z",
        quantity: 1,
        status: "RETURNED",
        returnMode: "KIOSK",
        returnedBy: "Иван",
        remarks: { problemQty: 0, repairQty: 0 },
      },
      {
        bookingId: "bk-2",
        projectName: "Клип «Лето»",
        clientName: "Фёдор Ильин",
        startDate: "2026-08-30T09:00:00.000Z",
        endDate: "2026-09-01T18:00:00.000Z",
        quantity: 2,
        status: "RETURNED",
        returnMode: "MANUAL",
        returnedBy: "sechenoff",
        remarks: null,
      },
    ],
    suggestedBookingId: "bk-2",
    openProblems: [],
    onShelf: { total: 5, issued: 1, calendar: 1, repair: 0, lost: 1, expected: 2 },
    ...overrides,
  };
}

const UNITS = [
  { id: "u-1", status: "AVAILABLE", serialNumber: "SN-1", comment: null, barcode: "LR-HMI-001" },
  { id: "u-2", status: "ISSUED", serialNumber: null, comment: null, barcode: "LR-HMI-002" },
  { id: "u-3", status: "MISSING", serialNumber: "SN-3", comment: null, barcode: "LR-HMI-003" },
  { id: "u-4", status: "MAINTENANCE", serialNumber: "SN-4", comment: null, barcode: "LR-HMI-004" },
];

/** Бронь следа, которая ещё на съёмке (формула полки её уже вычла). */
const OUT_BOOKING = {
  bookingId: "bk-out",
  projectName: "Фильм «Прямо сейчас»",
  clientName: "Студия «Юг»",
  startDate: "2026-09-16T09:00:00.000Z",
  endDate: "2026-09-20T18:00:00.000Z",
  quantity: 1,
  status: "ISSUED",
  returnMode: "OUT",
  returnedBy: null,
  remarks: null,
};

/** Ошибка apiFetch: Error + status/code/details, как у ApiFetchError. */
function apiError(status: number, message: string, code?: string, details?: Record<string, unknown>) {
  return Object.assign(new Error(message), { status, code, details });
}

const CREATED_ITEM = { id: "pi-new", source: "MANUAL", status: "SEARCHING" };

let trailResponse: ReturnType<typeof trail>;
let postImpl: (init?: RequestInit) => Promise<unknown>;
let unitsImpl: () => Promise<unknown>;

function routeApi() {
  apiFetch.mockImplementation((path: string, init?: RequestInit) => {
    if (path.startsWith("/api/equipment?search=")) {
      return Promise.resolve({ equipments: [COUNT_EQ, UNIT_EQ] });
    }
    if (path.startsWith("/api/problem-items/trail")) {
      return Promise.resolve({ trail: trailResponse });
    }
    if (path === "/api/equipment/eq-unit/units") {
      return unitsImpl();
    }
    if (path === "/api/problem-items" && init?.method === "POST") {
      return postImpl(init);
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  });
}

function renderModal() {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  const utils = render(<AddProblemItemModal open onClose={onClose} onCreated={onCreated} />);
  return { ...utils, onClose, onCreated, dialog: screen.getByRole("dialog", { name: "Завести потеряшку" }) };
}

async function pickPosition(name: string) {
  fireEvent.change(screen.getByLabelText("Поиск позиции"), { target: { value: "заряд" } });
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(name) }));
}

function submitButton() {
  return screen.getByRole("button", { name: "Завести потеряшку" });
}

function postBody(): Record<string, unknown> {
  const call = apiFetch.mock.calls.find((c) => c[0] === "/api/problem-items" && c[1]?.method === "POST");
  expect(call).toBeDefined();
  return JSON.parse(call![1].body as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  trailResponse = trail();
  postImpl = () => Promise.resolve({ item: CREATED_ITEM });
  unitsImpl = () => Promise.resolve({ units: UNITS });
  routeApi();
});

describe("AddProblemItemModal", () => {
  it("фокус сразу в поиске; метка «вручную»; без позиции отправить нельзя", async () => {
    renderModal();
    const search = screen.getByLabelText("Поиск позиции");
    await waitFor(() => expect(document.activeElement).toBe(search));
    expect(screen.getByText("вручную")).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
  });

  it("поиск → позиция: плитки наличия и степпер до «должно быть на полке»", async () => {
    renderModal();
    await pickPosition("Набор зарядок");

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith("/api/problem-items/trail?equipmentId=eq-count", undefined),
    );
    // Плитки: всего 5 · на съёмке 1+1 · мастерская 0 · на полке 2
    const tiles = await screen.findByText("должно быть на полке");
    expect(tiles.nextSibling?.textContent).toBe("2");
    expect(screen.getByText("сейчас на съёмке").nextSibling?.textContent).toBe("2");
    expect(screen.getByText("всего по учёту").nextSibling?.textContent).toBe("5");
    expect(screen.getByText(/ещё 1 — уже в потеряшках/)).toBeInTheDocument();
    expect(screen.getByText(/больше, чем должно лежать, завести нельзя/)).toBeInTheDocument();

    const minus = screen.getByRole("button", { name: "Меньше" });
    const plus = screen.getByRole("button", { name: "Больше" });
    const value = screen.getByLabelText("Количество");
    expect(value).toHaveTextContent("1");
    expect(minus).toBeDisabled();
    fireEvent.click(plus);
    expect(value).toHaveTextContent("2");
    // Потолок — «должно быть на полке»: дальше не пускает.
    expect(plus).toBeDisabled();
    fireEvent.click(plus);
    expect(value).toHaveTextContent("2");
    // Подвал считает то же количество.
    expect(screen.getByText(/Доступность позиции уменьшится на/)).toHaveTextContent("уменьшится на 2");
  });

  it("комментарий обязателен: кнопка активна только с ≥ 3 символами после trim", async () => {
    renderModal();
    await pickPosition("Набор зарядок");
    await screen.findByText("должно быть на полке");

    expect(submitButton()).toBeDisabled();
    const comment = screen.getByLabelText(/Комментарий/);
    fireEvent.change(comment, { target: { value: "  ab  " } });
    expect(submitButton()).toBeDisabled();
    fireEvent.click(submitButton());
    expect(apiFetch.mock.calls.some((c) => c[1]?.method === "POST")).toBe(false);

    fireEvent.change(comment, { target: { value: "в кейсе один набор" } });
    expect(submitButton()).toBeEnabled();
  });

  it("«Ожидается к» — только для «Остался на площадке»", async () => {
    renderModal();
    expect(screen.queryByLabelText(/Ожидается к/)).not.toBeInTheDocument();

    const reasons = screen.getByRole("group", { name: "Что случилось" });
    // По умолчанию — «Не нашли на складе».
    expect(within(reasons).getByRole("button", { name: "Не нашли на складе" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(within(reasons).getByRole("button", { name: "Остался на площадке" }));
    expect(screen.getByLabelText(/Ожидается к/)).toBeInTheDocument();

    fireEvent.click(within(reasons).getByRole("button", { name: "Потерян" }));
    expect(screen.queryByLabelText(/Ожидается к/)).not.toBeInTheDocument();
  });

  it("след: подсказка сервера выбрана заранее; POST несёт количество, причину и бронь", async () => {
    const { onCreated, onClose } = renderModal();
    await pickPosition("Набор зарядок");
    await screen.findByText("должно быть на полке");

    // Строки следа: проект · клиент, как принимали, даты.
    expect(screen.getByText("Сериал «Тихий дом»")).toBeInTheDocument();
    expect(screen.getByText("выдано 1 · принимал Иван")).toBeInTheDocument();
    expect(screen.getByText("выдано 2 · отмечен вручную (sechenoff)")).toBeInTheDocument();
    expect(screen.getByText("9–11 сен")).toBeInTheDocument();
    const suggested = screen.getByRole("radio", { name: /Клип «Лето»/ });
    expect(suggested).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Больше" }));
    fireEvent.change(screen.getByLabelText(/Комментарий/), {
      target: { value: "  при сверке двух нет  " },
    });
    fireEvent.click(submitButton());

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(CREATED_ITEM));
    expect(postBody()).toEqual({
      equipmentId: "eq-count",
      quantity: 2,
      reason: "NOT_ON_SHELF",
      comment: "при сверке двух нет",
      sourceBookingId: "bk-2",
    });
    expect(toastSuccess).toHaveBeenCalledWith("Потеряшка заведена: Набор зарядок ×2");
    expect(onClose).toHaveBeenCalled();
  });

  it("«Не связано с бронью» → sourceBookingId null; «Остался на площадке» → срок в ISO", async () => {
    renderModal();
    await pickPosition("Набор зарядок");
    await screen.findByText("должно быть на полке");

    fireEvent.click(screen.getByRole("radio", { name: /Не связано с бронью/ }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "Что случилось" })).getByRole("button", {
        name: "Остался на площадке",
      }),
    );
    fireEvent.change(screen.getByLabelText(/Ожидается к/), { target: { value: "2026-09-25" } });
    fireEvent.change(screen.getByLabelText(/Комментарий/), { target: { value: "гаффер привезёт" } });
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(postBody()).toEqual({
        equipmentId: "eq-count",
        quantity: 1,
        reason: "LEFT_ON_SITE",
        comment: "гаффер привезёт",
        expectedBackDate: "2026-09-25T00:00:00.000Z",
        sourceBookingId: null,
      }),
    );
  });

  it("штучная позиция: выбор единицы без штрихкодов, в теле equipmentUnitId", async () => {
    trailResponse = trail({ equipmentId: "eq-unit", suggestedBookingId: null, bookings: [] });
    const { container } = renderModal();
    await pickPosition("Прожектор HMI");

    const unitsGroup = await screen.findByRole("group", { name: "Единица" });
    // Пропавшие/списанные не предлагаются; серийник или «ед. N» — не штрихкод.
    expect(within(unitsGroup).getByRole("button", { name: "№ SN-1" })).toBeEnabled();
    // На съёмке и в мастерской — видно, но не выбрать: их оформляют приёмка и ремонт.
    expect(within(unitsGroup).getByRole("button", { name: "ед. 2 · на съёмке — отметят на приёмке" })).toBeDisabled();
    expect(
      within(unitsGroup).getByRole("button", { name: "№ SN-4 · в мастерской — списание через ремонт" }),
    ).toBeDisabled();
    expect(within(unitsGroup).queryByText(/SN-3/)).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/LR-[A-Z0-9]+-\d+/);
    // Количества для штучной нет.
    expect(screen.queryByRole("button", { name: "Больше" })).not.toBeInTheDocument();
    expect(screen.getByText("За это время позицию не выдавали.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Комментарий/), { target: { value: "не вернулся" } });
    expect(submitButton()).toBeDisabled();
    fireEvent.click(within(unitsGroup).getByRole("button", { name: "№ SN-1" }));
    expect(submitButton()).toBeEnabled();
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(postBody()).toEqual({
        equipmentId: "eq-unit",
        equipmentUnitId: "u-1",
        reason: "NOT_ON_SHELF",
        comment: "не вернулся",
        sourceBookingId: null,
      }),
    );
  });

  it("на полке по учёту ничего: объясняем и не даём отправить", async () => {
    trailResponse = trail({ onShelf: { total: 2, issued: 2, calendar: 0, repair: 0, lost: 0, expected: 0 } });
    renderModal();
    await pickPosition("Набор зарядок");
    expect(await screen.findByText(/заводить пропажу не из чего/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Комментарий/), { target: { value: "не нашли" } });
    expect(submitButton()).toBeDisabled();
  });

  it("QUANTITY_EXCEEDS_SHELF: объясняем по-русски и перечитываем наличие", async () => {
    postImpl = () =>
      Promise.reject(
        Object.assign(new Error("Больше, чем должно лежать на полке: по учёту там 1"), {
          status: 400,
          code: "QUANTITY_EXCEEDS_SHELF",
          details: { expected: 1 },
        }),
      );
    const { onCreated } = renderModal();
    await pickPosition("Набор зарядок");
    await screen.findByText("должно быть на полке");
    fireEvent.change(screen.getByLabelText(/Комментарий/), { target: { value: "не нашли" } });
    fireEvent.click(submitButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Больше, чем должно лежать на полке: по учёту там 1. Наличие обновлено.",
    );
    await waitFor(() =>
      expect(apiFetch.mock.calls.filter((c) => String(c[0]).startsWith("/api/problem-items/trail"))).toHaveLength(2),
    );
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("STOCK_COUNT_LINE_COUNTED: номер инвентаризации и ссылка в неё", async () => {
    postImpl = () =>
      Promise.reject(
        Object.assign(new Error("Позиция уже посчитана в идущей инвентаризации № 4 — отметьте недостачу там"), {
          status: 409,
          code: "STOCK_COUNT_LINE_COUNTED",
          details: { stockCountId: "sc-4", stockCountNumber: 4 },
        }),
      );
    renderModal();
    await pickPosition("Набор зарядок");
    await screen.findByText("должно быть на полке");
    fireEvent.change(screen.getByLabelText(/Комментарий/), { target: { value: "не нашли" } });
    fireEvent.click(submitButton());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Позиция уже посчитана в идущей инвентаризации № 4 — отметьте недостачу там.");
    expect(within(alert).getByRole("link", { name: "Открыть инвентаризацию →" })).toHaveAttribute(
      "href",
      "/warehouse/inventory/sc-4",
    );
  });

  it("след: брони на съёмке радио не получают — вместо них пояснение", async () => {
    trailResponse = trail({ bookings: [OUT_BOOKING, ...trail().bookings] });
    renderModal();
    await pickPosition("Набор зарядок");
    await screen.findByText("должно быть на полке");

    expect(screen.queryByRole("radio", { name: /Прямо сейчас/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Фильм «Прямо сейчас»")).not.toBeInTheDocument();
    // Две вернувшиеся брони + «Не связано с бронью».
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByRole("radio", { name: /Клип «Лето»/ })).toBeChecked();
    expect(
      screen.getByText("Брони на съёмке здесь не показаны — если пропало там, отметят на приёмке."),
    ).toBeInTheDocument();
  });

  it("след только из броней на съёмке: «вернувшихся выдач нет», а не «не выдавали»", async () => {
    trailResponse = trail({ bookings: [OUT_BOOKING], suggestedBookingId: null });
    renderModal();
    await pickPosition("Набор зарядок");
    await screen.findByText("должно быть на полке");

    expect(screen.getByText("Вернувшихся выдач за это время нет.")).toBeInTheDocument();
    expect(screen.queryByText(/позицию не выдавали/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(1);
    expect(screen.getByRole("radio", { name: /Не связано с бронью/ })).toBeChecked();
  });

  it("BOOKING_STILL_OUT: объясняем, перечитываем след и снимаем выбор с уехавшей брони", async () => {
    postImpl = () =>
      Promise.reject(
        apiError(409, "Бронь ещё на съёмке — пропажу по ней отметят на приёмке", "BOOKING_STILL_OUT", {
          bookingId: "bk-1",
        }),
      );
    renderModal();
    await pickPosition("Набор зарядок");
    await screen.findByText("должно быть на полке");

    fireEvent.click(screen.getByRole("radio", { name: /Тихий дом/ }));
    fireEvent.change(screen.getByLabelText(/Комментарий/), { target: { value: "забыли на площадке" } });
    // Пока модалка была открыта, «Тихий дом» снова выдали.
    trailResponse = trail({
      bookings: [{ ...trail().bookings[0], status: "ISSUED", returnMode: "OUT" }, trail().bookings[1]],
    });
    fireEvent.click(submitButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Бронь ещё на съёмке — пропажу по ней отметят на приёмке.",
    );
    await waitFor(() => expect(screen.queryByRole("radio", { name: /Тихий дом/ })).not.toBeInTheDocument());
    // Выбор вернулся на подсказку сервера — не остался висеть на уехавшей брони.
    expect(screen.getByRole("radio", { name: /Клип «Лето»/ })).toBeChecked();
    expect(apiFetch.mock.calls.filter((c) => String(c[0]).startsWith("/api/problem-items/trail"))).toHaveLength(2);
  });

  it.each([
    ["UNIT_IN_REPAIR", "Эта единица в мастерской — спишите её через ремонт или сначала закройте ремонт."],
    ["UNIT_ISSUED", "Единица на съёмке — пропажу отметят на приёмке."],
  ])("%s: объясняем, сбрасываем единицу и перечитываем список", async (code, text) => {
    trailResponse = trail({ equipmentId: "eq-unit", suggestedBookingId: null, bookings: [] });
    postImpl = () => Promise.reject(apiError(409, "Отказ сервера", code));
    renderModal();
    await pickPosition("Прожектор HMI");
    const unitsGroup = await screen.findByRole("group", { name: "Единица" });
    fireEvent.click(within(unitsGroup).getByRole("button", { name: "№ SN-1" }));
    fireEvent.change(screen.getByLabelText(/Комментарий/), { target: { value: "не вернулся" } });
    fireEvent.click(submitButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    await waitFor(() =>
      expect(apiFetch.mock.calls.filter((c) => c[0] === "/api/equipment/eq-unit/units")).toHaveLength(2),
    );
    const refreshed = await screen.findByRole("group", { name: "Единица" });
    expect(within(refreshed).getByRole("button", { name: "№ SN-1" })).toHaveAttribute("aria-pressed", "false");
    expect(submitButton()).toBeDisabled();
  });

  it("единицы не загрузились: честная ошибка и «Повторить», а не «все пропали»", async () => {
    trailResponse = trail({ equipmentId: "eq-unit", suggestedBookingId: null, bookings: [] });
    let calls = 0;
    unitsImpl = () => {
      calls += 1;
      return calls === 1
        ? Promise.reject(apiError(500, "Внутренняя ошибка сервера"))
        : Promise.resolve({ units: UNITS });
    };
    renderModal();
    await pickPosition("Прожектор HMI");

    expect(await screen.findByText(/Не удалось загрузить единицы/)).toBeInTheDocument();
    expect(screen.queryByText(/уже числятся пропавшими/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));

    const unitsGroup = await screen.findByRole("group", { name: "Единица" });
    expect(within(unitsGroup).getByRole("button", { name: "№ SN-1" })).toBeInTheDocument();
    expect(screen.queryByText(/Не удалось загрузить единицы/)).not.toBeInTheDocument();
  });

  it("не загрузились ни наличие, ни единицы: одна кнопка «Повторить» на оба запроса", async () => {
    apiFetch.mockImplementation((path: string) => {
      if (path.startsWith("/api/equipment?search=")) return Promise.resolve({ equipments: [COUNT_EQ, UNIT_EQ] });
      return Promise.reject(apiError(500, "Внутренняя ошибка сервера"));
    });
    renderModal();
    await pickPosition("Прожектор HMI");

    expect(await screen.findByText(/Не удалось загрузить единицы/)).toBeInTheDocument();
    expect(screen.getByText(/Не удалось загрузить наличие/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Повторить" })).toHaveLength(1);
  });

  it("у позиции не заведено единиц — так и говорим", async () => {
    trailResponse = trail({ equipmentId: "eq-unit", suggestedBookingId: null, bookings: [] });
    unitsImpl = () => Promise.resolve({ units: [] });
    renderModal();
    await pickPosition("Прожектор HMI");

    expect(await screen.findByText(/не заведено ни одной единицы/)).toBeInTheDocument();
    expect(screen.queryByText(/уже числятся пропавшими/)).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Единица" })).not.toBeInTheDocument();
  });

  it("все единицы на съёмке или в мастерской: выбрать нечего, объясняем куда идти", async () => {
    trailResponse = trail({ equipmentId: "eq-unit", suggestedBookingId: null, bookings: [] });
    unitsImpl = () => Promise.resolve({ units: [UNITS[1], UNITS[2], UNITS[3]] });
    renderModal();
    await pickPosition("Прожектор HMI");

    const unitsGroup = await screen.findByRole("group", { name: "Единица" });
    for (const chip of within(unitsGroup).getAllByRole("button")) expect(chip).toBeDisabled();
    expect(screen.getByText(/Свободных на складе единиц нет/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Комментарий/), { target: { value: "не нашли" } });
    expect(submitButton()).toBeDisabled();
  });

  it("Esc и клик по фону закрывают; «изменить» возвращает поиск", async () => {
    const { onClose, dialog } = renderModal();
    await pickPosition("Набор зарядок");
    await screen.findByText("должно быть на полке");

    fireEvent.click(screen.getByRole("button", { name: "изменить" }));
    expect(screen.getByLabelText("Поиск позиции")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(dialog.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(2);
    // Клик внутри диалога не закрывает.
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("подписи следа", () => {
  it("даты — диапазоном по-русски, через границу месяца тоже", () => {
    expect(formatTrailDates("2026-09-09T09:00:00.000Z", "2026-09-11T18:00:00.000Z")).toBe("9–11 сен");
    expect(formatTrailDates("2026-08-30T09:00:00.000Z", "2026-09-01T18:00:00.000Z")).toBe("30 авг – 1 сен");
    expect(formatTrailDates("2026-09-09T09:00:00.000Z", "2026-09-09T18:00:00.000Z")).toBe("9 сен");
  });

  it("как вернули — словами, без кодов", () => {
    const base = {
      bookingId: "b",
      projectName: "П",
      clientName: "К",
      startDate: "2026-09-01T09:00:00.000Z",
      endDate: "2026-09-02T09:00:00.000Z",
      quantity: 3,
      remarks: null,
    };
    expect(trailRowNote({ ...base, status: "ISSUED", returnMode: "OUT", returnedBy: null })).toBe(
      "выдано 3 · ещё на съёмке",
    );
    expect(trailRowNote({ ...base, status: "RETURNED", returnMode: "AUTO", returnedBy: "_system_" })).toBe(
      "выдано 3 · возврат отмечен автоматически",
    );
    expect(trailRowNote({ ...base, status: "CONFIRMED", returnMode: "MANUAL", returnedBy: null })).toBe(
      "выдано 3 · срок вышел, возврат не отмечен",
    );
    expect(
      trailRowNote({
        ...base,
        status: "RETURNED",
        returnMode: "KIOSK",
        returnedBy: "Олег",
        remarks: { problemQty: 1, repairQty: 1 },
      }),
    ).toBe("выдано 3 · принимал Олег · замечаний при приёмке: 2");
  });
});
