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

const open = (onDone = vi.fn()) =>
  render(<ReturnDialog open bookingId="b1" projectName="Реклама кофейни «Зерно»" docNumber="СМ-2026-0231" onClose={vi.fn()} onDone={onDone} />);

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
  it("обычная бронь — одно подтверждение «Вернули всё»", async () => {
    mockApi(plan());
    const onDone = vi.fn();
    open(onDone);
    fireEvent.click(await screen.findByRole("button", { name: "Вернули всё" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/bookings/b1/status",
      expect.objectContaining({ body: JSON.stringify({ action: "return", allReturned: true }) }),
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
    expect(screen.getByRole("button", { name: "Вернули всё · 8" })).toBeInTheDocument();
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

  it("открытая приёмка в киоске — предупреждение", async () => {
    mockApi(plan({ kioskSession: { workerName: "Иван", startedAt: new Date().toISOString() } }));
    open();
    expect(await screen.findByText(/В киоске открыта приёмка \(Иван/)).toBeInTheDocument();
  });
});
