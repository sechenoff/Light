/**
 * Экран счёта инвентаризации в киоске: участки → строки, сохранение счёта
 * (сразу для больших кнопок, с задержкой для степпера), очередь сохранения по
 * строке, досылка на «Паузе» и уходе с экрана, откат при ошибке,
 * 409 «инвентаризацию завершили или отменили», 401 → вход по PIN.
 *
 * Таймеры настоящие: vi.useFakeTimers без shouldAdvanceTime вешает findBy/waitFor.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  StockCountDetail,
  StockCountLineView,
} from "../../inventory/types";

const api = vi.hoisted(() => ({
  getActiveStockCount: vi.fn(),
  listStockCountLines: vi.fn(),
  countStockCountLine: vi.fn(),
  resetStockCountLine: vi.fn(),
}));

vi.mock("../api", () => ({ scanApi: api }));

const toastError = vi.hoisted(() => vi.fn());
vi.mock("../../ToastProvider", () => ({
  toast: { success: vi.fn(), error: toastError, info: vi.fn() },
}));

import { StockCountScreen } from "../StockCountScreen";

const DETAIL: StockCountDetail = {
  id: "sc-1",
  number: 1,
  status: "OPEN",
  categories: null,
  startedAt: "2026-09-18T06:30:00.000Z",
  closedAt: null,
  cancelledAt: null,
  createdByName: "sechenoff",
  closedByName: null,
  counters: ["Иван"],
  totals: {
    lines: 3,
    counted: 1,
    matched: 1,
    shortagePositions: 0,
    shortageQty: 0,
    surplusPositions: 0,
    surplusQty: 0,
    undecided: 0,
    shortageRatePerShift: "0",
  },
  categoryProgress: [
    { category: "Грип", lines: 2, counted: 1, discrepancies: 0, counters: ["Иван"] },
    { category: "Свет", lines: 1, counted: 0, discrepancies: 0, counters: [] },
  ],
  unitModeExcluded: 1,
  isFirst: true,
  decisionsPlan: {
    lostPositions: 0,
    lostQty: 0,
    adjustPositions: 0,
    adjustMinusQty: 0,
    adjustPlusQty: 0,
    foundPositions: 0,
    foundQty: 0,
  },
};

function line(over: Partial<StockCountLineView>): StockCountLineView {
  return {
    id: "ln",
    equipmentId: "eq",
    name: "Позиция",
    category: "Грип",
    ratePerShift: "100",
    position: 1,
    expected: { total: 6, issued: 0, calendar: 0, repair: 0, lost: 0, expected: 6 },
    expectedIsSnapshot: false,
    calendarBookings: [],
    countedQty: null,
    countedBy: null,
    countedAt: null,
    diff: null,
    decision: null,
    decisionNote: null,
    decidedBy: null,
    decidedAt: null,
    sourceBookingId: null,
    sourceBooking: null,
    openProblemQty: 0,
    allowedDecisions: [],
    isUnitMode: false,
    live: null,
    booksChangedSinceCount: false,
    booksAcknowledged: false,
    readyForPickupQty: 0,
    ...over,
  };
}

const CLAMP = line({
  id: "ln-clamp",
  name: "Зажим Manfrotto",
  expected: { total: 1, issued: 0, calendar: 0, repair: 0, lost: 0, expected: 1 },
});
const BALLS = line({ id: "ln-balls", name: "Гринболы", position: 2 });
const CHAIN = line({ id: "ln-chain", name: "страховка цепь", position: 3 });

function counted(l: StockCountLineView, qty: number): StockCountLineView {
  return { ...l, countedQty: qty, diff: qty - l.expected.expected, countedBy: "Иван", expectedIsSnapshot: true };
}

function scanError(status: number, code: string | null, message = "Ошибка") {
  return { status, code, message, details: null };
}

const onExit = vi.fn();
const onUnauth = vi.fn();

function renderScreen(initial: StockCountDetail | null = DETAIL) {
  return render(
    <StockCountScreen
      shell={{ tab: "count", onTab: vi.fn(), workerName: "Иван" }}
      workerName="Иван"
      initial={initial}
      onExit={onExit}
      onUnauth={onUnauth}
    />,
  );
}

async function openGrip() {
  const view = renderScreen();
  fireEvent.click(await screen.findByRole("button", { name: /Грип/ }));
  await screen.findByRole("article", { name: "Гринболы" });
  return view;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  vi.clearAllMocks();
  // Очередь mock*Once не должна перетекать из упавшего теста в следующий.
  api.countStockCountLine.mockReset();
  api.resetStockCountLine.mockReset();
  api.getActiveStockCount.mockResolvedValue(DETAIL);
  api.listStockCountLines.mockResolvedValue([CLAMP, BALLS]);
});

describe("StockCountScreen — участки", () => {
  it("показывает участки с прогрессом и кто считает", async () => {
    renderScreen();

    expect(screen.getByRole("heading", { name: "Инвентаризация № 1" })).toBeInTheDocument();
    const grip = screen.getByRole("button", { name: /Грип/ });
    expect(within(grip).getByText("1 / 2")).toBeInTheDocument();
    expect(within(grip).getByText("считает: Иван")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: /Свет/ })).getByText("ещё не начинали")).toBeInTheDocument();
    expect(screen.getByText(/1 позиция со штучным учётом сверяется/)).toBeInTheDocument();
  });

  it("законченный участок с расхождениями: название видно, расхождения — второй строкой", () => {
    // 375 px: две плашки справа оставляли названию 8–30 px («Ф…»).
    const finished: StockCountDetail = {
      ...DETAIL,
      categoryProgress: [
        {
          category: "Штативы / Стойки",
          lines: 125,
          counted: 125,
          discrepancies: 12,
          counters: ["Иван", "Олег"],
        },
      ],
    };
    api.getActiveStockCount.mockResolvedValue(finished);
    renderScreen(finished);

    const row = screen.getByRole("button", { name: /Штативы \/ Стойки/ });
    expect(within(row).getByText("Штативы / Стойки")).toBeInTheDocument();
    const diff = within(row).getByText("12 расхождений");
    expect(diff).toHaveClass("text-rose");
    expect(diff.parentElement).toHaveTextContent("посчитали: Иван, Олег · 12 расхождений");
    // «Посчитано» — зелёная галочка у счётчика, как в мокапе, а не отдельная плашка.
    const total = within(row).getByText("125 / 125");
    expect(total.parentElement).toHaveClass("text-emerald");
    expect(within(row).getByText("посчитано,")).toHaveClass("sr-only");
    expect(within(row).queryByText("✓ посчитано")).not.toBeInTheDocument();
  });

  it("участок открывается строками; шапка «Инвентаризация № N · работник»", async () => {
    await openGrip();

    expect(api.listStockCountLines).toHaveBeenCalledWith("sc-1", "Грип");
    expect(screen.getByText("Инвентаризация № 1 · Иван")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Грип" })).toBeInTheDocument();
    expect(screen.getByText("0 / 2")).toBeInTheDocument();
  });
});

describe("StockCountScreen — счёт", () => {
  it("«✓ На месте» сохраняет qty 1 сразу и показывает итог", async () => {
    api.countStockCountLine.mockResolvedValue(counted(CLAMP, 1));
    await openGrip();

    fireEvent.click(screen.getByRole("button", { name: "✓ На месте" }));

    expect(api.countStockCountLine).toHaveBeenCalledWith("sc-1", "ln-clamp", 1);
    expect(await screen.findByText("✓ на месте · 1 из 1")).toBeInTheDocument();
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
  });

  it("«Нет на полке» сохраняет qty 0", async () => {
    api.countStockCountLine.mockResolvedValue(counted(CLAMP, 0));
    await openGrip();

    fireEvent.click(screen.getByRole("button", { name: "Нет на полке" }));

    expect(api.countStockCountLine).toHaveBeenCalledWith("sc-1", "ln-clamp", 0);
    expect(await screen.findByText("−1 · решит руководитель после счёта")).toBeInTheDocument();
  });

  it("«Всё на месте · N» сохраняет «должно быть»", async () => {
    api.countStockCountLine.mockResolvedValue(counted(BALLS, 6));
    await openGrip();

    fireEvent.click(screen.getByRole("button", { name: "Всё на месте · 6" }));

    expect(api.countStockCountLine).toHaveBeenCalledWith("sc-1", "ln-balls", 6);
    expect(await screen.findByText("✓ сошлось · 6")).toBeInTheDocument();
  });

  it("степпер: несколько касаний — один запрос с последним числом", async () => {
    api.countStockCountLine.mockResolvedValue(counted(BALLS, 4));
    await openGrip();

    const minus = screen.getByRole("button", { name: "Меньше — Гринболы" });
    fireEvent.click(minus);
    fireEvent.click(minus);

    // Итог виден сразу, до ответа сервера.
    expect(screen.getByText("−2 · решит руководитель после счёта")).toBeInTheDocument();
    expect(api.countStockCountLine).not.toHaveBeenCalled();

    await waitFor(() => expect(api.countStockCountLine).toHaveBeenCalledTimes(1), {
      timeout: 2000,
    });
    expect(api.countStockCountLine).toHaveBeenCalledWith("sc-1", "ln-balls", 4);
    const footer = screen.getByRole("button", { name: "Пауза" }).closest("footer");
    expect(footer).toHaveTextContent("расхождений −2 · сошлось 0");
  });

  it("ошибка сохранения — строка откатывается, ошибка видна на карточке", async () => {
    api.countStockCountLine.mockRejectedValue(scanError(0, "NETWORK_ERROR", "Failed to fetch"));
    await openGrip();

    fireEvent.click(screen.getByRole("button", { name: "✓ На месте" }));

    const card = screen.getByRole("article", { name: "Зажим Manfrotto" });
    expect(await within(card).findByRole("alert")).toHaveTextContent(/Нет связи — не сохранилось/);
    // Откат: снова предлагает посчитать.
    expect(within(card).getByRole("button", { name: "✓ На месте" })).toBeInTheDocument();
    expect(within(card).queryByText("✓ на месте · 1 из 1")).not.toBeInTheDocument();
  });

  it("«Пересчитать» сбрасывает счёт строки", async () => {
    api.listStockCountLines.mockResolvedValue([counted(CLAMP, 1), BALLS]);
    api.resetStockCountLine.mockResolvedValue(CLAMP);
    await openGrip();

    fireEvent.click(screen.getByRole("button", { name: "Пересчитать" }));

    expect(api.resetStockCountLine).toHaveBeenCalledWith("sc-1", "ln-clamp");
    expect(await screen.findByRole("button", { name: "✓ На месте" })).toBeInTheDocument();
  });

  it("«Пауза» возвращает к участкам и перечитывает прогресс", async () => {
    await openGrip();
    const before = api.getActiveStockCount.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Пауза" }));

    expect(await screen.findByRole("heading", { name: "Инвентаризация № 1" })).toBeInTheDocument();
    await waitFor(() =>
      expect(api.getActiveStockCount.mock.calls.length).toBeGreaterThan(before),
    );
  });
});

describe("StockCountScreen — раскладка не прыгает", () => {
  it("степпер на следующей строке не сворачивает предыдущую", async () => {
    // Свёрнутая карточка над пальцем — минус ≈70 px, и второе касание
    // попадало бы в «Пересчитать» или мимо (на iOS нет scroll anchoring).
    api.listStockCountLines.mockResolvedValue([BALLS, CHAIN]);
    api.countStockCountLine.mockImplementation(async (_sc: string, id: string, qty: number) =>
      counted(id === BALLS.id ? BALLS : CHAIN, qty),
    );
    await openGrip();

    fireEvent.click(screen.getByRole("button", { name: "Меньше — Гринболы" }));
    fireEvent.click(screen.getByRole("button", { name: "Меньше — страховка цепь" }));

    expect(screen.getByRole("button", { name: "Меньше — Гринболы" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "страховка цепь" })).toHaveAttribute(
      "aria-current",
      "step",
    );
    expect(screen.getByRole("article", { name: "Гринболы" })).not.toHaveAttribute("aria-current");

    // И после ответов сервера карточка остаётся раскрытой.
    await waitFor(() => expect(api.countStockCountLine).toHaveBeenCalledTimes(2), { timeout: 2000 });
    const balls = screen.getByRole("article", { name: "Гринболы" });
    await waitFor(() => expect(within(balls).queryByText("сохраняем…")).not.toBeInTheDocument());
    expect(within(balls).getByText("−1 · решит руководитель после счёта")).toBeInTheDocument();
    expect(within(balls).getByRole("button", { name: "Меньше — Гринболы" })).toBeInTheDocument();
  });

  it("большая кнопка сворачивает свою карточку", async () => {
    api.countStockCountLine.mockResolvedValue(counted(BALLS, 6));
    await openGrip();

    fireEvent.click(screen.getByRole("button", { name: "Всё на месте · 6" }));

    expect(await screen.findByText("✓ сошлось · 6")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Меньше — Гринболы" })).not.toBeInTheDocument();
  });
});

describe("StockCountScreen — очередь сохранения", () => {
  it("касание во время сохранения: запросы по очереди, последнее число уходит после ответа", async () => {
    const d1 = deferred<StockCountLineView>();
    const d2 = deferred<StockCountLineView>();
    api.countStockCountLine.mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise);
    await openGrip();
    const minus = screen.getByRole("button", { name: "Меньше — Гринболы" });

    fireEvent.click(minus);
    await waitFor(() => expect(api.countStockCountLine).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(api.countStockCountLine).toHaveBeenLastCalledWith("sc-1", "ln-balls", 5);

    fireEvent.click(minus);
    await sleep(800); // окно задержки прошло, но первый ещё в полёте
    expect(api.countStockCountLine).toHaveBeenCalledTimes(1);

    await act(async () => d1.resolve(counted(BALLS, 5)));
    await waitFor(() => expect(api.countStockCountLine).toHaveBeenCalledTimes(2));
    expect(api.countStockCountLine).toHaveBeenLastCalledWith("sc-1", "ln-balls", 4);
    // Промежуточный ответ не откатил экран к «−1».
    expect(screen.getByText("−2 · решит руководитель после счёта")).toBeInTheDocument();

    await act(async () => d2.resolve(counted(BALLS, 4)));
    expect(screen.getByText("−2 · решит руководитель после счёта")).toBeInTheDocument();
  });

  it("«Пауза» внутри окна задержки досылает счёт сразу", async () => {
    api.countStockCountLine.mockResolvedValue(counted(BALLS, 5));
    await openGrip();

    fireEvent.click(screen.getByRole("button", { name: "Меньше — Гринболы" }));
    expect(api.countStockCountLine).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Пауза" }));

    expect(api.countStockCountLine).toHaveBeenCalledWith("sc-1", "ln-balls", 5);
  });

  it("уход с экрана внутри окна задержки досылает счёт сразу", async () => {
    api.countStockCountLine.mockResolvedValue(counted(BALLS, 5));
    const { unmount } = await openGrip();

    fireEvent.click(screen.getByRole("button", { name: "Меньше — Гринболы" }));
    expect(api.countStockCountLine).not.toHaveBeenCalled();
    unmount();

    expect(api.countStockCountLine).toHaveBeenCalledWith("sc-1", "ln-balls", 5);
  });

  it("первое сохранение прошло, второе упало — строка возвращается к первому ответу сервера", async () => {
    const d2 = deferred<StockCountLineView>();
    api.countStockCountLine
      .mockResolvedValueOnce(counted(BALLS, 5))
      .mockReturnValueOnce(d2.promise);
    await openGrip();
    const minus = screen.getByRole("button", { name: "Меньше — Гринболы" });

    fireEvent.click(minus);
    // Первое сохранение ушло и подтверждено сервером.
    await waitFor(() => expect(api.countStockCountLine).toHaveBeenCalledTimes(1), { timeout: 2000 });
    const card = screen.getByRole("article", { name: "Гринболы" });
    await waitFor(() => expect(within(card).queryByText("сохраняем…")).not.toBeInTheDocument());
    expect(within(card).getByText("−1 · решит руководитель после счёта")).toBeInTheDocument();

    fireEvent.click(minus);
    expect(within(card).getByText("−2 · решит руководитель после счёта")).toBeInTheDocument();
    await waitFor(() => expect(api.countStockCountLine).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(api.countStockCountLine).toHaveBeenLastCalledWith("sc-1", "ln-balls", 4);
    await act(async () => d2.reject(scanError(0, "NETWORK_ERROR", "Failed to fetch")));

    expect(await within(card).findByRole("alert")).toHaveTextContent(/Нет связи/);
    // Не «не посчитано» — последнее подтверждённое сервером число.
    expect(within(card).getByText("−1 · решит руководитель после счёта")).toBeInTheDocument();
    expect(within(card).getByLabelText("Посчитано — Гринболы")).toHaveValue("5");
  });

  it("учёт изменился после счёта (409 EXPECTATION_CHANGED) — подсказка «Пересчитать» и откат к сохранённому", async () => {
    const d2 = deferred<StockCountLineView>();
    api.countStockCountLine
      .mockResolvedValueOnce(counted(BALLS, 5))
      .mockReturnValueOnce(d2.promise);
    await openGrip();
    const minus = screen.getByRole("button", { name: "Меньше — Гринболы" });

    fireEvent.click(minus);
    await waitFor(() => expect(api.countStockCountLine).toHaveBeenCalledTimes(1), { timeout: 2000 });
    const card = screen.getByRole("article", { name: "Гринболы" });
    await waitFor(() => expect(within(card).queryByText("сохраняем…")).not.toBeInTheDocument());

    fireEvent.click(minus);
    await waitFor(() => expect(api.countStockCountLine).toHaveBeenCalledTimes(2), { timeout: 2000 });
    await act(async () =>
      d2.reject(scanError(409, "EXPECTATION_CHANGED", "Учёт позиции изменился после счёта")),
    );

    expect(await within(card).findByRole("alert")).toHaveTextContent(
      "С момента счёта учёт позиции изменился — нажмите «Пересчитать» и посчитайте полку заново",
    );
    expect(within(card).getByText("−1 · решит руководитель после счёта")).toBeInTheDocument();
    expect(within(card).getByLabelText("Посчитано — Гринболы")).toHaveValue("5");
  });

  it("ошибка сохранения после «Паузы» — тостом с названием позиции", async () => {
    api.countStockCountLine.mockRejectedValue(scanError(0, "NETWORK_ERROR", "Failed to fetch"));
    await openGrip();

    fireEvent.click(screen.getByRole("button", { name: "Меньше — Гринболы" }));
    fireEvent.click(screen.getByRole("button", { name: "Пауза" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastError.mock.calls[0][0]).toMatch(/«Гринболы»: Нет связи — не сохранилось/);
  });

  it("«Пауза» перечитывает прогресс только после счёта, досланного вдогонку", async () => {
    const d1 = deferred<StockCountLineView>();
    const d2 = deferred<StockCountLineView>();
    api.countStockCountLine.mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise);
    await openGrip();
    const minus = screen.getByRole("button", { name: "Меньше — Гринболы" });

    fireEvent.click(minus);
    await waitFor(() => expect(api.countStockCountLine).toHaveBeenCalledTimes(1), { timeout: 2000 });
    fireEvent.click(minus);
    await sleep(800); // второе число ждёт ответа на первое
    const before = api.getActiveStockCount.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Пауза" }));
    await act(async () => d1.resolve(counted(BALLS, 5)));
    await waitFor(() => expect(api.countStockCountLine).toHaveBeenCalledTimes(2));
    expect(api.countStockCountLine).toHaveBeenLastCalledWith("sc-1", "ln-balls", 4);
    await act(() => sleep(50));
    expect(api.getActiveStockCount.mock.calls.length).toBe(before);

    await act(async () => d2.resolve(counted(BALLS, 4)));
    await waitFor(() =>
      expect(api.getActiveStockCount.mock.calls.length).toBeGreaterThan(before),
    );
  });
});

describe("StockCountScreen — инвентаризация закончилась", () => {
  it("409 STOCK_COUNT_NOT_OPEN при счёте → сообщение и возврат на «Смену»", async () => {
    api.countStockCountLine.mockRejectedValue(
      scanError(409, "STOCK_COUNT_NOT_OPEN", "Инвентаризация уже завершена или отменена"),
    );
    await openGrip();

    fireEvent.click(screen.getByRole("button", { name: "✓ На месте" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Инвентаризацию завершили или отменили/,
    );
    fireEvent.click(screen.getByRole("button", { name: "Вернуться на «Смену»" }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("инвентаризация пропала (GET вернул null) → то же сообщение", async () => {
    api.getActiveStockCount.mockResolvedValue(null);
    renderScreen();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Инвентаризацию завершили или отменили/,
    );
  });

  it("диплинк без идущей инвентаризации → «не идёт»", async () => {
    api.getActiveStockCount.mockResolvedValue(null);
    renderScreen(null);

    expect(await screen.findByRole("alert")).toHaveTextContent(/инвентаризация не идёт/);
  });

  it("401 → вход по PIN", async () => {
    api.countStockCountLine.mockRejectedValue(scanError(401, null, "Нужен вход"));
    await openGrip();

    fireEvent.click(screen.getByRole("button", { name: "✓ На месте" }));

    await waitFor(() => expect(onUnauth).toHaveBeenCalledTimes(1));
  });
});
