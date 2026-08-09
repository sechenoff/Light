import { render, screen, within, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BookingForm, type BookingDetail } from "../BookingForm";

// ─── Router / navigation mocks ────────────────────────────────────────────────

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
  usePathname: () => "/bookings/booking-123/edit",
  useParams: () => ({ id: "booking-123" }),
}));

// ─── API mock ─────────────────────────────────────────────────────────────────

const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ vehicles: [] }),
  });
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

// ─── Test data ────────────────────────────────────────────────────────────────

const BOOKING: BookingDetail = {
  id: "booking-123",
  status: "DRAFT",
  projectName: "Клип «Лето»",
  startDate: "2026-05-01T10:00:00.000Z",
  endDate: "2026-05-03T10:00:00.000Z",
  comment: "Доставка утром",
  discountPercent: "15",
  vehicleId: "vehicle-abc",
  vehicleWithGenerator: true,
  vehicleShiftHours: "12",
  vehicleSkipOvertime: false,
  vehicleKmOutsideMkad: 30,
  vehicleTtkEntry: false,
  client: { id: "client-1", name: "Студия Свет", phone: null },
  items: [
    {
      id: "item-1",
      equipmentId: "eq-1",
      quantity: 2,
      customName: null,
      customUnitPrice: null,
      customCategory: null,
      equipment: {
        id: "eq-1",
        name: "Arri SkyPanel S60",
        category: "Свет",
        brand: "Arri",
        model: "S60",
        rentalRatePerShift: "5000",
      },
    },
    {
      id: "item-2",
      equipmentId: "eq-2",
      quantity: 1,
      customName: null,
      customUnitPrice: null,
      customCategory: null,
      equipment: {
        id: "eq-2",
        name: "Godox SL200",
        category: "Свет",
        brand: "Godox",
        model: "SL200",
        rentalRatePerShift: "1500",
      },
    },
  ],
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("BookingForm in edit mode", () => {
  it("prefills clientName input with booking client name", () => {
    render(<BookingForm mode="edit" initialBooking={BOOKING} bookingId="booking-123" />);
    // In edit mode, client is shown as read-only label (not an input)
    expect(screen.getByText("Студия Свет")).toBeInTheDocument();
  });

  it("позиции брони видны в «Составе заявки»", () => {
    render(<BookingForm mode="edit" initialBooking={BOOKING} bookingId="booking-123" />);
    expect(screen.getAllByText("Arri SkyPanel S60").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Godox SL200").length).toBeGreaterThanOrEqual(1);
  });

  it("правая колонка не дублирует список позиций — только расчёт и кнопки", () => {
    // Список стоял и в составе, и в «Расчёте»: одна и та же информация в двух
    // местах на одном экране, причём в правой колонке — без цен и арифметики.
    render(<BookingForm mode="edit" initialBooking={BOOKING} bookingId="booking-123" />);
    const panel = screen.getByText("Расчёт").closest("aside")!;
    expect(panel).not.toBeNull();
    expect(panel.textContent).not.toContain("Arri SkyPanel S60");
    expect(panel.textContent).not.toContain("Godox SL200");
    // Расчёт и действия на месте.
    expect(panel.textContent).toContain("Итого");
    expect(panel.querySelector("button")).not.toBeNull();
  });

  it("на правке брони есть печать и выгрузка сметы", () => {
    render(<BookingForm mode="edit" initialBooking={BOOKING} bookingId="booking-123" />);
    const panel = screen.getByText("Расчёт").closest("aside")!;
    expect(within(panel).getByRole("button", { name: "Печать" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "PDF" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Excel" })).toBeInTheDocument();
  });

  it("предупреждение о несохранённом реагирует на договорную цену позиции", () => {
    // Подпись формы сериализовала позиции как [id, quantity] и не замечала
    // договорную ставку — предупреждение молчало ровно в том случае, ради
    // которого оно и нужно.
    render(<BookingForm mode="edit" initialBooking={BOOKING} bookingId="booking-123" />);
    const panel = screen.getByText("Расчёт").closest("aside")!;
    expect(within(panel).queryByText(/последнее сохранённое состояние/i)).toBeNull();

    const price = screen.getAllByLabelText("Цена за смену: Arri SkyPanel S60")[0];
    fireEvent.focus(price);
    fireEvent.change(price, { target: { value: "3000" } });
    fireEvent.blur(price);

    expect(within(panel).getByText(/последнее сохранённое состояние/i)).toBeInTheDocument();
  });

  it("renders 'Сохранить изменения' button", () => {
    render(<BookingForm mode="edit" initialBooking={BOOKING} bookingId="booking-123" />);
    expect(screen.getByRole("button", { name: /сохранить изменения/i })).toBeInTheDocument();
  });

  it("does not render 'Отправить на согласование' button in edit mode", () => {
    render(<BookingForm mode="edit" initialBooking={BOOKING} bookingId="booking-123" />);
    expect(screen.queryByRole("button", { name: /согласован/i })).toBeNull();
  });
});
