/**
 * Тесты карточки машины на витрине автопарка.
 *
 * Ключевое, что здесь легко сломать незаметно:
 *  — экономика не должна рендериться для роли без доступа к финансам;
 *  — «0 ₽» и «нет данных» должны различаться (прочерк ≠ ноль);
 *  — пустые состояния (нет ТО, нет интервала, нет броней) обязаны быть честными,
 *    а не показывать выдуманный прогноз;
 *  — «Пора на ТО» обязана визуально отличаться от «Скоро ТО».
 */

import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import { VehicleCard } from "../VehicleCard";
import type { FleetVehicle, VehicleStats } from "../types";

function makeStats(over: Partial<VehicleStats> = {}): VehicleStats {
  return {
    mileageDelta: 1200,
    mileageSamples: 3,
    kmSinceService: 6739,
    daysSinceService: 50,
    kmToNextService: 3261,
    serviceHealth: "OK",
    serviceCost: "76392.74",
    serviceCount: 1,
    revenue: "180000.00",
    net: "103607.26",
    bookingsCount: 2,
    rentedDays: 3,
    utilizationPct: 3,
    occupancy: new Array(14).fill(false),
    ...over,
  };
}

function makeVehicle(over: Partial<FleetVehicle> = {}): FleetVehicle {
  return {
    id: "v1",
    name: "Ford",
    slug: "ford",
    licensePlate: "У220ВН797",
    currentMileage: 90239,
    serviceIntervalKm: 10000,
    lastServiceAt: "2026-06-12T00:00:00.000Z",
    lastServiceMileage: 83500,
    lastServiceKind: "REPAIR",
    lastServiceDescription: "Дверь сдвижная правая",
    lastServiceCost: "76392.74",
    notes: null,
    active: true,
    shiftPriceRub: "12000.00",
    shiftHours: 12,
    overtimePercent: "10.00",
    hasGeneratorOption: false,
    generatorPriceRub: null,
    stats: makeStats(),
    upcomingBookings: [],
    ...over,
  };
}

const base = { period: "90" as const, canEdit: true };

describe("VehicleCard — доступ к экономике", () => {
  it("показывает блок экономики руководителю", () => {
    render(<VehicleCard vehicle={makeVehicle()} {...base} canSeeMoney />);
    expect(screen.getByText(/Экономика/i)).toBeInTheDocument();
    expect(screen.getByText("Заработала")).toBeInTheDocument();
  });

  it("полностью скрывает экономику для роли без доступа к финансам", () => {
    render(<VehicleCard vehicle={makeVehicle()} {...base} canSeeMoney={false} />);
    expect(screen.queryByText(/Экономика/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Заработала")).not.toBeInTheDocument();
  });

  it("техник не видит кнопок записи ТО и пробега", () => {
    render(
      <VehicleCard vehicle={makeVehicle()} period="90" canSeeMoney={false} canEdit={false} />,
    );
    expect(screen.queryByText("Записать ТО")).not.toBeInTheDocument();
    expect(screen.queryByText("Записать пробег")).not.toBeInTheDocument();
    // Ссылка на карточку остаётся — чтение доступно всем.
    expect(screen.getByText(/Открыть карточку/)).toBeInTheDocument();
  });
});

describe("VehicleCard — честность пустых данных", () => {
  it("рисует прочерки вместо нулей, когда машина не выезжала и не обслуживалась", () => {
    render(
      <VehicleCard
        vehicle={makeVehicle({
          stats: makeStats({
            bookingsCount: 0,
            serviceCount: 0,
            revenue: "0.00",
            serviceCost: "0.00",
            net: "0.00",
          }),
        })}
        {...base}
        canSeeMoney
      />,
    );
    expect(screen.getByText(/ни разу не выезжала на бронь/)).toBeInTheDocument();
    // Три прочерка: заработала / обслуживание / итог.
    expect(screen.getAllByText("—")).toHaveLength(3);
  });

  it("при отсутствии интервала не выдумывает прогноз ТО", () => {
    render(
      <VehicleCard
        vehicle={makeVehicle({
          serviceIntervalKm: null,
          stats: makeStats({ serviceHealth: "NO_INTERVAL", kmToNextService: null }),
        })}
        {...base}
        canSeeMoney
      />,
    );
    expect(screen.getAllByText(/Интервал не задан|Интервал ТО не задан/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Ещё .* км/)).not.toBeInTheDocument();
  });

  it("при отсутствии записей ТО честно сообщает об этом", () => {
    render(
      <VehicleCard
        vehicle={makeVehicle({
          lastServiceAt: null,
          lastServiceMileage: null,
          lastServiceKind: null,
          stats: makeStats({
            serviceHealth: "NO_SERVICE",
            kmSinceService: null,
            kmToNextService: null,
            daysSinceService: null,
          }),
        })}
        {...base}
        canSeeMoney
      />,
    );
    expect(screen.getByText(/Записей об обслуживании ещё нет/)).toBeInTheDocument();
  });

  it("при нехватке замеров не показывает дельту пробега", () => {
    render(
      <VehicleCard
        vehicle={makeVehicle({ stats: makeStats({ mileageDelta: null, mileageSamples: 1 }) })}
        {...base}
        canSeeMoney
      />,
    );
    expect(screen.getByText(/Мало замеров/)).toBeInTheDocument();
  });
});

describe("VehicleCard — состояния ТО и занятости", () => {
  it("просроченное ТО показывает перепробег", () => {
    render(
      <VehicleCard
        vehicle={makeVehicle({
          stats: makeStats({ serviceHealth: "OVERDUE", kmToNextService: -1000 }),
        })}
        {...base}
        canSeeMoney
      />,
    );
    // Подпись дублируется намеренно: в плашке-предупреждении и в приборе «Обслуживание».
    expect(screen.getAllByText(/Пора на ТО/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/перепробег/i).length).toBeGreaterThan(0);
  });

  it("скорое ТО показывает остаток километров", () => {
    render(
      <VehicleCard
        vehicle={makeVehicle({
          stats: makeStats({ serviceHealth: "DUE_SOON", kmToNextService: 300 }),
        })}
        {...base}
        canSeeMoney
      />,
    );
    expect(screen.getAllByText(/Скоро ТО/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Осталось 300 км/)).toBeInTheDocument();
  });

  it("выданная сейчас машина помечена и ведёт на свою бронь", () => {
    render(
      <VehicleCard
        vehicle={makeVehicle({
          stats: makeStats({ occupancy: [true, true, ...new Array(12).fill(false)] }),
          upcomingBookings: [
            {
              bookingId: "b1",
              projectName: "Реклама «Волна»",
              clientName: "Петя Куб",
              startDate: "2026-07-31T00:00:00.000Z",
              endDate: "2026-08-03T00:00:00.000Z",
              status: "ISSUED",
              isCurrent: true,
              subtotalRub: "56000.00",
            },
          ],
        })}
        {...base}
        canSeeMoney
      />,
    );
    expect(screen.getByText("Выдана")).toBeInTheDocument();
    expect(screen.getByText(/Сейчас:/)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Петя Куб/ });
    expect(link).toHaveAttribute("href", "/bookings/b1");
  });

  it("свободная машина без броней сообщает об этом", () => {
    render(<VehicleCard vehicle={makeVehicle()} {...base} canSeeMoney />);
    expect(screen.getByText("Свободна")).toBeInTheDocument();
    expect(screen.getByText(/Броней на ближайшие 14 дней нет/)).toBeInTheDocument();
  });

  it("быстрые действия ведут на карточку с раскрытой формой", () => {
    render(<VehicleCard vehicle={makeVehicle()} {...base} canSeeMoney />);
    expect(screen.getByRole("link", { name: /Записать ТО/ })).toHaveAttribute(
      "href",
      "/vehicles/v1?action=service",
    );
    expect(screen.getByRole("link", { name: /Записать пробег/ })).toHaveAttribute(
      "href",
      "/vehicles/v1?action=mileage",
    );
  });
});
