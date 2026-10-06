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
import { formatWhen, initialStays, partialReturnBody, setStayQuantity, summarize, toggleStayUnit, type ReturnPlan } from "../returnDialogState";

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

  it("оплаченный срок прошёл — «+1 смена» с дополнительной сметой из превью", async () => {
    const p = plan({ lines: [{ ...plan().lines[0], paidThrough: later(-2) }, plan().lines[1]] });
    const previewBody = {
      conflicts: [],
      parentNegotiatedTotal: null,
      continuations: [
        {
          until: later(22),
          docNumber: "СМ-2026-0231-1",
          expectedPaymentDate: null,
          lines: [{ bookingItemId: "i-storm", name: "Aputure STORM 400x", quantity: 1, billedShifts: 1, lineSum: "4000.00", afterDiscount: "2000.00", negotiated: false }],
          discountPercent: "50.00",
          subtotal: "4000.00",
          discountAmount: "2000.00",
          surchargeAmount: "0.00",
          total: "2000.00",
        },
      ],
    };
    apiFetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/return-plan") ? p : url.endsWith("/return-partial/preview") ? previewBody : { warning: null, closedScanSessions: 0, continuationIds: ["c1"] },
    );
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Вернули не всё" }));
    const storm = screen.getAllByTestId("return-line").find((li) => li.textContent?.includes("STORM"))!;
    fireEvent.click(within(storm).getByRole("button", { name: "Больше: Aputure STORM 400x" }));
    // Оплаченное прошло — первый чип «+1 смена», он и выбран.
    const chips = within(storm).getAllByRole("radio");
    expect(chips.map((c) => c.textContent)).toEqual(["+1 смена", "+2 смены", "+3 смены", "дата…"]);
    expect(chips[0]).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(storm).toHaveTextContent("1 шт × 1 смена → 2 000 ₽ со скидкой"));
    const price = screen.getByRole("region", { name: "Дополнительная смета" });
    expect(price).toHaveTextContent("К оплате");
    expect(price).toHaveTextContent("2 000");
    fireEvent.click(screen.getByRole("button", { name: "Принять 2 позиции" }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/api/bookings/b1/return-partial", expect.anything()));
    const [, init] = apiFetchMock.mock.calls.find(([url]) => url === "/api/bookings/b1/return-partial")!;
    const sent = JSON.parse(init.body).stays[0];
    expect(sent.bookingItemId).toBe("i-storm");
    // +1 смена от сейчас (оплаченное прошло).
    expect(Date.parse(sent.until) - Date.now()).toBeGreaterThan(23 * HOUR);
  });

  it("оставленное нужно другой брони — «Принять» ждёт решения; под ответственность — уходит с флагом", async () => {
    const p = plan({ lines: [{ ...plan().lines[0], paidThrough: later(-2) }, plan().lines[1]] });
    const previewBody = {
      parentNegotiatedTotal: null,
      continuations: [],
      conflicts: [
        {
          bookingItemId: "i-storm",
          equipmentId: "e1",
          name: "Aputure STORM 400x",
          needed: 1,
          available: 0,
          from: later(5),
          until: later(22),
          holder: { bookingId: "b-other", projectName: "Клип «Ночной рейс»", clientName: "Студия «Полдень»", from: later(5) },
        },
      ],
    };
    apiFetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/return-plan") ? p : url.endsWith("/return-partial/preview") ? previewBody : { warning: null, closedScanSessions: 0, continuationIds: ["c1"] },
    );
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Вернули не всё" }));
    const storm = screen.getAllByTestId("return-line").find((li) => li.textContent?.includes("STORM"))!;
    fireEvent.click(within(storm).getByRole("button", { name: "Больше: Aputure STORM 400x" }));
    const holder = await within(storm).findByRole("group", { name: "Нужен другой брони: Aputure STORM 400x" });
    expect(holder).toHaveTextContent("Нужен брони «Клип «Ночной рейс»»");
    const primary = screen.getByRole("button", { name: "Принять 2 позиции" });
    expect(primary).toBeDisabled();
    fireEvent.click(within(holder).getByRole("button", { name: "Оставить под ответственность" }));
    expect(primary).toBeEnabled();
    fireEvent.click(primary);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/api/bookings/b1/return-partial", expect.anything()));
    const [, init] = apiFetchMock.mock.calls.find(([url]) => url === "/api/bookings/b1/return-partial")!;
    expect(JSON.parse(init.body).stays[0]).toMatchObject({ bookingItemId: "i-storm", acknowledgedConflict: true });
  });

  it("пока оплачено — «до конца оплаченного» без доплаты; «Только до …» у держателя возвращает этот срок", async () => {
    const p = plan();
    apiFetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/return-plan") ? p : url.endsWith("/return-partial/preview") ? { continuations: [], conflicts: [], parentNegotiatedTotal: null } : {},
    );
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Вернули не всё" }));
    const stand = screen.getAllByTestId("return-line").find((li) => li.textContent?.includes("Стойка"))!;
    fireEvent.click(within(stand).getByRole("button", { name: "Больше: Стойка C-Stand" }));
    const chips = within(stand).getAllByRole("radio");
    expect(chips[0]).toHaveTextContent("до конца оплаченного");
    expect(chips[0]).toHaveAttribute("aria-checked", "true");
    expect(stand).toHaveTextContent("без доплаты");
    fireEvent.click(chips[2]);
    expect(chips[2]).toHaveAttribute("aria-checked", "true");
    expect(stand).not.toHaveTextContent("без доплаты");
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

describe("окно «Принять возврат»: сверх оплаченного", () => {
  const expired = () => plan({ lines: [{ ...plan().lines[0], paidThrough: later(-2) }, plan().lines[1]] });
  const conflictPreview = (neededFrom: string) => ({
    parentNegotiatedTotal: null,
    continuations: [],
    conflicts: [
      {
        bookingItemId: "i-storm",
        equipmentId: "e1",
        name: "Aputure STORM 400x",
        needed: 1,
        available: 0,
        from: later(1),
        until: later(22),
        neededFrom,
        holder: { bookingId: "b-other", projectName: "Клип Север", clientName: null, from: neededFrom },
      },
    ],
  });
  const previewCalls = () => apiFetchMock.mock.calls.filter(([url]) => String(url).endsWith("/return-partial/preview")).length;
  const stormLine = () => screen.getAllByTestId("return-line").find((li) => li.textContent?.includes("STORM"))!;

  it("в пределах оплаченного превью не запрашивается; срок дальше — запрашивается", async () => {
    const p = plan();
    apiFetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/return-plan") ? p : { continuations: [], conflicts: [], parentNegotiatedTotal: null },
    );
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Вернули не всё" }));
    fireEvent.click(within(stormLine()).getByRole("button", { name: "Больше: Aputure STORM 400x" }));
    await new Promise((r) => setTimeout(r, 500));
    expect(previewCalls()).toBe(0);
    fireEvent.click(within(stormLine()).getAllByRole("radio")[1]);
    await waitFor(() => expect(previewCalls()).toBe(1));
  });

  it("карточка держателя называет начало его брони, а не начало проверки", async () => {
    const p = expired();
    const neededFrom = later(30);
    apiFetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/return-plan") ? p : url.endsWith("/return-partial/preview") ? conflictPreview(neededFrom) : {},
    );
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Вернули не всё" }));
    fireEvent.click(within(stormLine()).getByRole("button", { name: "Больше: Aputure STORM 400x" }));
    const holder = await within(stormLine()).findByRole("group", { name: "Нужен другой брони: Aputure STORM 400x" });
    expect(holder).toHaveTextContent(`с ${formatWhen(neededFrom)}`);
    // Скрыт поиском — кнопка всё равно объясняет, кого ждём.
    expect(screen.getByText(/Нужно другой брони: «Aputure STORM 400x»/)).toBeInTheDocument();
  });

  it("другой срок — «под ответственность» спрашивается заново", async () => {
    const p = expired();
    apiFetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/return-plan") ? p : url.endsWith("/return-partial/preview") ? conflictPreview(later(5)) : {},
    );
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Вернули не всё" }));
    fireEvent.click(within(stormLine()).getByRole("button", { name: "Больше: Aputure STORM 400x" }));
    const holder = await within(stormLine()).findByRole("group", { name: "Нужен другой брони: Aputure STORM 400x" });
    fireEvent.click(within(holder).getByRole("button", { name: "Оставить под ответственность" }));
    const primary = screen.getByRole("button", { name: "Принять 2 позиции" });
    expect(primary).toBeEnabled();
    fireEvent.click(within(stormLine()).getAllByRole("radio")[1]);
    expect(primary).toBeDisabled();
    const again = await within(stormLine()).findByRole("group", { name: "Нужен другой брони: Aputure STORM 400x" });
    expect(within(again).getByRole("button", { name: "Оставить под ответственность" })).toHaveAttribute("aria-pressed", "false");
  });

  it("позицию заняли, пока окно было открыто: 409 при «Принять» — превью пересчитано, появилась карточка держателя", async () => {
    const p = expired();
    let conflictNow = false;
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/return-plan")) return p;
      if (url.endsWith("/return-partial/preview")) {
        return conflictNow ? conflictPreview(later(5)) : { continuations: [], conflicts: [], parentNegotiatedTotal: null };
      }
      conflictNow = true;
      throw Object.assign(new Error("Позиция «Aputure STORM 400x» нужна брони «Клип Север»"), { code: "CONTINUATION_CONFLICT", status: 409 });
    });
    const onClose = vi.fn();
    open(vi.fn(), onClose);
    fireEvent.click(await screen.findByRole("button", { name: "Вернули не всё" }));
    fireEvent.click(within(stormLine()).getByRole("button", { name: "Больше: Aputure STORM 400x" }));
    await waitFor(() => expect(previewCalls()).toBe(1));
    await new Promise((r) => setTimeout(r, 20));
    fireEvent.click(screen.getByRole("button", { name: "Принять 2 позиции" }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(expect.stringMatching(/Клип Север/)));
    expect(await within(stormLine()).findByRole("group", { name: "Нужен другой брони: Aputure STORM 400x" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
