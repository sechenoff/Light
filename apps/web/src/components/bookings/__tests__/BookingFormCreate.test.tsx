import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BookingForm } from "../BookingForm";

// ─── Router / navigation mocks ────────────────────────────────────────────────

const pushMock = vi.fn();
const searchParams = new Map<string, string>();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
  useSearchParams: () => ({ get: (k: string) => searchParams.get(k) ?? null }),
  usePathname: () => "/bookings/new",
}));

// ─── Fetch mock (по URL) ──────────────────────────────────────────────────────

const DRAFT_KEY = "lr:bookings:new:draft";

const EQ_ROW = {
  equipmentId: "eq-1",
  category: "Свет",
  name: "Arri SkyPanel S60",
  brand: null,
  model: null,
  stockTrackingMode: "COUNT",
  totalQuantity: 5,
  rentalRatePerShift: "5000",
  occupiedQuantity: 0,
  availableQuantity: 5,
  availability: "AVAILABLE",
  comment: null,
};

const VEHICLE = {
  id: "v1",
  slug: "gazel",
  name: "Газель",
  shiftPriceRub: "7000",
  hasGeneratorOption: false,
  generatorPriceRub: null,
  shiftHours: 12,
  overtimePercent: "10",
  displayOrder: 1,
};

type FetchCall = { url: string; init?: RequestInit };
let fetchCalls: FetchCall[] = [];

function jsonResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  window.localStorage.clear();
  searchParams.clear();
  fetchCalls = [];
  pushMock.mockReset();
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push({ url, init });
    if (url.includes("/api/vehicles")) return jsonResponse({ vehicles: [VEHICLE] });
    if (url.includes("/api/availability")) return jsonResponse({ rows: [EQ_ROW] });
    if (url.includes("/api/settings/organization")) return jsonResponse({ defaultPaymentTermsDays: 0 });
    if (url.includes("/api/bookings/quote"))
      return jsonResponse({
        shifts: 1,
        subtotal: "5000",
        discountPercent: "50",
        discountAmount: "2500",
        totalAfterDiscount: "2500",
        lines: [],
      });
    if (url.includes("/api/clients")) return jsonResponse({ clients: [] });
    if (url.includes("/api/bookings/draft")) return jsonResponse({ booking: { id: "b-new-1" } });
    return jsonResponse({});
  }) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function seedDraft(over: Record<string, unknown> = {}) {
  window.localStorage.setItem(
    DRAFT_KEY,
    JSON.stringify({
      savedAt: new Date("2026-07-03T09:15:00").getTime(),
      clientName: "Студия Тест",
      clientPhone: "",
      projectName: "Клип",
      bookingComment: "",
      discountPercent: 50,
      pickupLocal: "2026-07-10T10:00",
      returnLocal: "2026-07-11T10:00",
      skipPartialDay: false,
      gafferText: "",
      selected: [
        {
          equipmentId: "eq-1",
          name: "Arri SkyPanel S60",
          category: "Свет",
          quantity: 2,
          dailyPrice: "5000",
          availableQuantity: 5,
        },
      ],
      customItems: [],
      selectedVehicles: [],
      expectedPaymentDateLocal: "",
      ...over,
    }),
  );
}

function availabilityCalls(): FetchCall[] {
  return fetchCalls.filter((c) => c.url.includes("/api/availability"));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("BookingForm create — черновик в localStorage", () => {
  it("восстанавливает черновик и показывает плашку с временем сохранения", async () => {
    seedDraft();
    render(<BookingForm mode="create" />);
    expect(await screen.findByText(/Восстановлен черновик от 09:15/)).toBeInTheDocument();
    expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("Студия Тест");
  });

  it("«Начать заново» очищает localStorage и сбрасывает форму", async () => {
    seedDraft();
    render(<BookingForm mode="create" />);
    fireEvent.click(await screen.findByRole("button", { name: "Начать заново" }));
    await waitFor(() => {
      expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
      expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("");
    });
    expect(screen.queryByText(/Восстановлен черновик/)).toBeNull();
  });

  it("не восстанавливает черновик при префилле из календаря (?start/&end)", () => {
    seedDraft();
    searchParams.set("start", "2026-08-01T10:00");
    searchParams.set("end", "2026-08-02T10:00");
    render(<BookingForm mode="create" />);
    expect(screen.queryByText(/Восстановлен черновик/)).toBeNull();
    expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("");
  });

  it("автосохраняет черновик через ~2 с после ввода", async () => {
    render(<BookingForm mode="create" />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Кинокомпания" } });
    await waitFor(
      () => {
        const raw = window.localStorage.getItem(DRAFT_KEY);
        expect(raw).not.toBeNull();
        expect(JSON.parse(raw as string).clientName).toBe("Кинокомпания");
      },
      { timeout: 5000 },
    );
  });
});

describe("BookingForm create — валидация диапазона дат", () => {
  it("возврат раньше выдачи → inline-ошибка, каталог не перезапрашивается", async () => {
    searchParams.set("start", "2026-07-10T10:00");
    searchParams.set("end", "2026-07-12T10:00");
    render(<BookingForm mode="create" />);
    await waitFor(() => expect(availabilityCalls().length).toBe(1));

    // [0] дата выдачи, [1] дата возврата, [2] срок оплаты
    const dateInputs = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[1], { target: { value: "2026-07-01" } });

    expect(await screen.findByText(/Возврат раньше выдачи/)).toBeInTheDocument();
    // запрос доступности с end<start не отправлен
    expect(availabilityCalls().length).toBe(1);
  });
});

describe("BookingForm create — контракт с календарём", () => {
  it("?equipmentId= добавляет позицию после загрузки каталога", async () => {
    searchParams.set("start", "2026-07-10T10:00");
    searchParams.set("end", "2026-07-11T10:00");
    searchParams.set("equipmentId", "eq-1");
    render(<BookingForm mode="create" />);
    await waitFor(() => {
      expect(screen.getAllByText(/1 позиция/).length).toBeGreaterThan(0);
    });
    // Позиция и в каталоге, и в мини-списке сметы
    expect(screen.getAllByText("Arri SkyPanel S60").length).toBeGreaterThanOrEqual(2);
  });
});

describe("BookingForm create — транспорт", () => {
  it("дефолт «Часы смены» = стандартная смена машины, а не длительность аренды", async () => {
    // 3 суток аренды = 72 ч; раньше дефолт был 72 → переработка 60 ч молча
    searchParams.set("start", "2026-07-10T10:00");
    searchParams.set("end", "2026-07-13T10:00");
    render(<BookingForm mode="create" />);
    const checkbox = await screen.findByLabelText("Выбрать машину Газель");
    fireEvent.click(checkbox);
    const hours = await screen.findByLabelText("Часы смены для Газель");
    expect((hours as HTMLInputElement).value).toBe("12");
  });
});

describe("BookingForm create — новый клиент с телефоном", () => {
  it("телефон уходит в POST /draft, локальный черновик очищается", async () => {
    searchParams.set("start", "2026-07-10T10:00");
    searchParams.set("end", "2026-07-11T10:00");
    searchParams.set("equipmentId", "eq-1"); // авто-позиция → форма сабмитабельна
    render(<BookingForm mode="create" />);
    await waitFor(() => {
      expect(screen.getAllByText(/1 позиция/).length).toBeGreaterThan(0);
    });

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Новая Студия" } });
    // Поле телефона появляется для клиента, создаваемого на лету
    const phone = await screen.findByPlaceholderText("+7 916 123-45-67");
    fireEvent.change(phone, { target: { value: "+7 900 111-22-33" } });

    const saveBtn = screen.getByRole("button", { name: /Сохранить черновик/ });
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    fireEvent.click(saveBtn);

    await waitFor(() => {
      const call = fetchCalls.find((c) => c.url.includes("/api/bookings/draft"));
      expect(call).toBeTruthy();
      const body = JSON.parse(String(call?.init?.body));
      expect(body.clientPhone).toBe("+7 900 111-22-33");
      // Комментарий не содержит псевдо-позиций «Вне каталога»
      expect(body.comment).toBeUndefined();
    });
    // Бронь на сервере — черновик в localStorage удалён
    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
  });
});

// ─── 4.8: шаги + inline-валидация вместо молча задизейбленной кнопки ─────────

describe("BookingForm create — шаги и inline-валидация (4.8)", () => {
  it("рендерит рейку шагов с четырьмя шагами", async () => {
    render(<BookingForm mode="create" />);

    expect(await screen.findByRole("navigation", { name: "Шаги оформления брони" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Шаг 1: Клиент и проект/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Шаг 2: Даты/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Шаг 3: Оборудование/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Шаг 4: Детали/ })).toBeInTheDocument();
  });

  it("до попытки сохранить чеклист показывает требования нейтрально, шаги без ошибок", async () => {
    render(<BookingForm mode="create" />);

    expect(await screen.findByText("Укажите клиента")).toBeInTheDocument();
    expect(screen.getByText("Добавьте оборудование")).toBeInTheDocument();
    // Шаги не в состоянии ошибки на pristine-форме
    expect(screen.queryByRole("button", { name: /есть ошибка/ })).toBeNull();
  });

  it("клик «Сохранить черновик» на пустой форме → inline-ошибки, POST не уходит", async () => {
    render(<BookingForm mode="create" />);

    const saveBtn = await screen.findByRole("button", { name: /Сохранить черновик/ });
    expect(saveBtn).not.toBeDisabled();
    fireEvent.click(saveBtn);

    // Inline-ошибка у поля клиента
    expect(await screen.findByText(/Укажите клиента — без него бронь не сохранить/)).toBeInTheDocument();
    // Шаги 1 и 3 подсвечены как ошибочные
    expect(screen.getByRole("button", { name: /Шаг 1: Клиент и проект — есть ошибка/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Шаг 3: Оборудование — есть ошибка/ })).toBeInTheDocument();
    // POST /api/bookings/draft не отправлен
    expect(fetchCalls.some((c) => c.url.includes("/api/bookings/draft"))).toBe(false);
  });

  it("заполненная форма (черновик из localStorage) → шаги 1-3 «готово», сохранение уходит", async () => {
    seedDraft();
    render(<BookingForm mode="create" />);

    expect(await screen.findByRole("button", { name: /Шаг 1: Клиент и проект — готово/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Шаг 2: Даты — готово/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Шаг 3: Оборудование — готово/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Сохранить черновик/ }));
    await waitFor(() => {
      expect(fetchCalls.some((c) => c.url.includes("/api/bookings/draft"))).toBe(true);
    });
  });
});
