/**
 * Окно «Принять возврат» (мокап m4-return-dialog): обычная бронь — одно
 * подтверждение; позиции «по плану» — отмечены сразу; «Вернули не всё» —
 * остаётся у клиента по строкам, штучные — по единицам.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("../../ToastProvider", () => ({ toast: toastMock }));

import { ReturnDialog } from "../ReturnDialog";
import { initialStays, partialReturnBody, setStayQuantity, summarize, toggleStayUnit, type ReturnPlan } from "../returnDialogState";

const HOUR = 3_600_000;
const later = (h: number) => new Date(Date.now() + h * HOUR).toISOString();

function plan(over: Partial<ReturnPlan> = {}): ReturnPlan {
  return {
    bookingId: "b1",
    splitRevision: 3,
    hasPlannedStays: false,
    kioskSession: null,
    lines: [
      { bookingItemId: "i-storm", equipmentId: "e1", name: "Aputure STORM 400x", quantity: 2, unitTracked: false, units: [], paidThrough: later(20), plannedStayUntil: null },
      { bookingItemId: "i-stand", equipmentId: "e2", name: "Стойка C-Stand", quantity: 6, unitTracked: false, units: [], paidThrough: later(20), plannedStayUntil: null },
    ],
    ...over,
  };
}

function mockApi(p: ReturnPlan, response: unknown = { warning: null, closedScanSessions: 0, continuationIds: ["c1"] }) {
  apiFetchMock.mockImplementation(async (url: string) => (url.endsWith("/return-plan") ? p : response));
}

const open = (onDone = vi.fn(), onClose = vi.fn()) =>
  render(<ReturnDialog open bookingId="b1" projectName="Реклама кофейни «Зерно»" docNumber="СМ-2026-0231" onClose={onClose} onDone={onDone} />);

beforeEach(() => {
  apiFetchMock.mockReset();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
});

describe("логика окна", () => {
  it("«по плану» — целиком до своего срока; тело запроса со splitRevision", () => {
    const p = plan({
      hasPlannedStays: true,
      lines: [{ ...plan().lines[0], plannedStayUntil: later(30), paidThrough: later(30) }, plan().lines[1]],
    });
    const stays = initialStays(p);
    expect(stays.get("i-storm")).toMatchObject({ quantity: 2 });
    expect(summarize(p, stays)).toMatchObject({ acceptedUnits: 6, acceptedLines: 1, keptUnits: 2 });
    expect(partialReturnBody(p, stays)).toEqual({
      expectedSplitRevision: 3,
      stays: [{ bookingItemId: "i-storm", quantity: 2, until: p.lines[0].plannedStayUntil }],
    });
  });

  it("штучная позиция: количество — по отмеченным единицам", () => {
    const line = { ...plan().lines[0], unitTracked: true, units: [{ id: "u1", label: "ZEISS-1" }, { id: "u2", label: "ZEISS-2" }] };
    let stays = setStayQuantity(new Map(), line, 1);
    expect(stays.get("i-storm")).toMatchObject({ quantity: 1, unitIds: ["u1"] });
    stays = toggleStayUnit(stays, line, "u2");
    expect(stays.get("i-storm")).toMatchObject({ quantity: 2, unitIds: ["u1", "u2"] });
    stays = toggleStayUnit(toggleStayUnit(stays, line, "u1"), line, "u2");
    expect(stays.has("i-storm")).toBe(false);
  });
});

describe("окно «Принять возврат»", () => {
  it("обычная бронь — одно подтверждение «Вернули всё», без флага «всё вернули»", async () => {
    // Флаг уходит только при позициях «по плану»: иначе, если смены строки
    // поменяли, пока окно открыто, сервер сам остановит приёмку.
    mockApi(plan());
    const onDone = vi.fn();
    open(onDone);
    fireEvent.click(await screen.findByRole("button", { name: "Вернули всё" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/bookings/b1/status",
      expect.objectContaining({ body: JSON.stringify({ action: "return" }) }),
    );
  });

  it("позиции «по плану» отмечены сразу, главная кнопка — «Принять 1 позицию»", async () => {
    mockApi(
      plan({
        hasPlannedStays: true,
        lines: [{ ...plan().lines[0], plannedStayUntil: later(30), paidThrough: later(30) }, plan().lines[1]],
      }),
    );
    const onDone = vi.fn();
    open(onDone);
    expect(await screen.findByText("По плану остаются у клиента · оплачено")).toBeInTheDocument();
    // «Вернули всё · N» и «Принять N позиций» считают одно и то же — позиции.
    expect(screen.getByRole("button", { name: "Вернули всё · 2" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Принять 1 позицию" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const [, init] = apiFetchMock.mock.calls.find(([url]) => url === "/api/bookings/b1/return-partial")!;
    expect(JSON.parse(init.body)).toMatchObject({ expectedSplitRevision: 3, stays: [{ bookingItemId: "i-storm", quantity: 2 }] });
  });

  it("«Вернули не всё» — по строке «остаётся у клиента», запрос частичной приёмки", async () => {
    const p = plan();
    mockApi(p);
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Вернули не всё" }));
    const stand = screen.getAllByTestId("return-line").find((li) => li.textContent?.includes("Стойка C-Stand"))!;
    fireEvent.click(within(stand).getByRole("button", { name: "Больше: Стойка C-Stand" }));
    fireEvent.click(within(stand).getByRole("button", { name: "Больше: Стойка C-Stand" }));
    expect(screen.getByText(/у клиента остаётся/)).toHaveTextContent("2 шт");
    fireEvent.click(screen.getByRole("button", { name: "Принять 2 позиции" }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/api/bookings/b1/return-partial", expect.anything()));
    const [, init] = apiFetchMock.mock.calls.find(([url]) => url === "/api/bookings/b1/return-partial")!;
    expect(JSON.parse(init.body).stays).toEqual([{ bookingItemId: "i-stand", quantity: 2, until: p.lines[1].paidThrough }]);
  });

  it("оплаченный срок уже прошёл — оставить нельзя, подсказка про дополнительную смету", async () => {
    mockApi(plan({ lines: [{ ...plan().lines[0], paidThrough: later(-2) }, plan().lines[1]] }));
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Вернули не всё" }));
    const storm = screen.getAllByTestId("return-line").find((li) => li.textContent?.includes("STORM"))!;
    expect(within(storm).getByRole("button", { name: "Больше: Aputure STORM 400x" })).toBeDisabled();
    expect(storm).toHaveTextContent("с дополнительной сметой");
  });

  it("открытая приёмка в киоске — сначала выбор: закончить там или принять здесь", async () => {
    mockApi(plan({ kioskSession: { workerName: "Иван", startedAt: new Date().toISOString() } }));
    open();
    expect(await screen.findByText(/В киоске открыта приёмка \(Иван/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Закончу в киоске" })).toHaveAttribute("href", "/warehouse/scan?booking=b1");
    expect(screen.queryByRole("button", { name: "Вернули всё" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Принять здесь, закрыть киоск" }));
    expect(screen.getByRole("button", { name: "Вернули всё" })).toBeInTheDocument();
  });

  it("план не загрузился — «Повторить» и обычная приёмка целиком", async () => {
    let calls = 0;
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/return-plan")) {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error("Сервер недоступен"), { status: 502 });
        return plan();
      }
      return { warning: null, closedScanSessions: 0 };
    });
    const onDone = vi.fn();
    open(onDone);
    expect(await screen.findByText("Сервер недоступен")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByText(/Всё оборудование вернули на склад/)).toBeInTheDocument();
    expect(calls).toBe(2);
  });

  it("план не загрузился — «Вернули всё» принимает бронь, как раньше", async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/return-plan")) throw Object.assign(new Error("Сервер недоступен"), { status: 502 });
      return { warning: null, closedScanSessions: 0 };
    });
    const onDone = vi.fn();
    open(onDone);
    fireEvent.click(await screen.findByRole("button", { name: "Вернули всё" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(apiFetchMock).toHaveBeenCalledWith("/api/bookings/b1/status", expect.objectContaining({ body: JSON.stringify({ action: "return" }) }));
  });

  it("бронь уже приняли — понятный текст, окно закрыто, список перечитан", async () => {
    apiFetchMock.mockRejectedValue(
      Object.assign(new Error("Принять часть можно только у выданной брони — обновите страницу"), {
        status: 409,
        code: "PARTIAL_RETURN_NOT_ISSUED",
      }),
    );
    const onDone = vi.fn();
    const onClose = vi.fn();
    open(onDone, onClose);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onDone).toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledWith("Принять часть можно только у выданной брони. Данные обновлены");
  });

  it("Esc закрывает окно", async () => {
    mockApi(plan());
    const onClose = vi.fn();
    open(vi.fn(), onClose);
    await screen.findByRole("button", { name: "Вернули всё" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("двойное нажатие — один запрос", async () => {
    let release!: () => void;
    apiFetchMock.mockImplementation((url: string) =>
      url.endsWith("/return-plan")
        ? Promise.resolve(plan())
        : new Promise((resolve) => {
            release = () => resolve({ warning: null, closedScanSessions: 0 });
          }),
    );
    const onDone = vi.fn();
    open(onDone);
    const button = await screen.findByRole("button", { name: "Вернули всё" });
    fireEvent.click(button);
    fireEvent.click(button);
    release();
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(apiFetchMock.mock.calls.filter(([url]) => url === "/api/bookings/b1/status")).toHaveLength(1);
  });

  it("по плану: «Вернули всё · N» — приёмка целиком с флагом «всё вернули»", async () => {
    mockApi(
      plan({
        hasPlannedStays: true,
        lines: [{ ...plan().lines[0], plannedStayUntil: later(30), paidThrough: later(30) }, plan().lines[1]],
      }),
    );
    const onDone = vi.fn();
    open(onDone);
    fireEvent.click(await screen.findByRole("button", { name: "Вернули всё · 2" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/bookings/b1/status",
      expect.objectContaining({ body: JSON.stringify({ action: "return", allReturned: true }) }),
    );
  });

  it("штучная позиция: единицы отмечаются кнопками, степпера нет", async () => {
    const line = {
      ...plan().lines[0],
      unitTracked: true,
      units: [
        { id: "u1", label: "ZEISS-1" },
        { id: "u2", label: "ZEISS-2" },
      ],
    };
    mockApi(plan({ lines: [line, plan().lines[1]] }));
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Вернули не всё" }));
    const storm = screen.getAllByTestId("return-line").find((li) => li.textContent?.includes("STORM"))!;
    expect(within(storm).queryByRole("button", { name: /Больше:/ })).not.toBeInTheDocument();
    fireEvent.click(within(storm).getByRole("button", { name: "ZEISS-2" }));
    expect(within(storm).getByRole("button", { name: "ZEISS-2" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Принять 2 позиции" }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/api/bookings/b1/return-partial", expect.anything()));
    const [, init] = apiFetchMock.mock.calls.find(([url]) => url === "/api/bookings/b1/return-partial")!;
    expect(JSON.parse(init.body).stays).toEqual([
      expect.objectContaining({ bookingItemId: "i-storm", quantity: 1, equipmentUnitIds: ["u2"] }),
    ]);
  });

  it("всё остаётся у клиента — кнопка не обещает «принять 0 позиций»", async () => {
    mockApi(
      plan({
        hasPlannedStays: true,
        lines: [{ ...plan().lines[0], plannedStayUntil: later(30), paidThrough: later(30) }],
      }),
    );
    open();
    expect(await screen.findByRole("button", { name: "Оставить всё у клиента" })).toBeInTheDocument();
  });
});

describe("initialStays — штучная позиция по плану", () => {
  it("живых единиц меньше, чем штук, — оставляем столько, сколько на руках", () => {
    const p = plan({
      hasPlannedStays: true,
      lines: [
        {
          ...plan().lines[0],
          unitTracked: true,
          quantity: 3,
          units: [{ id: "u1", label: null }, { id: "u2", label: null }],
          plannedStayUntil: later(30),
          paidThrough: later(30),
        },
      ],
    });
    expect(initialStays(p).get("i-storm")).toMatchObject({ quantity: 2, unitIds: ["u1", "u2"] });
  });
});
