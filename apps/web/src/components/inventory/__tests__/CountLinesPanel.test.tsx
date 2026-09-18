/**
 * Строка счёта: позиция в одном экземпляре — «на месте / нет» (сохраняется
 * сразу); остальные — степпер с задержкой 500 мс (пять кликов — один запрос с
 * итогом) и «= N» (сразу). Ошибка сервера — откат значения и объяснение.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastError = vi.fn();
vi.mock("../../ToastProvider", () => ({
  toast: { success: vi.fn(), error: (m: string) => toastError(m), info: vi.fn() },
}));

const apiFetch = vi.fn();
vi.mock("../../../lib/api", () => ({
  apiFetch: (path: string, init?: RequestInit) => apiFetch(path, init),
}));

import { CountLinesPanel, LINES_POLL_MS } from "../CountLinesPanel";
import type { StockCountLineView } from "../types";
import { apiError, makeCategory, makeLine } from "./fixtures";

const EXTENDER = makeLine({
  id: "line-ext",
  name: "Удлинитель PCE (15м)",
  expected: { total: 50, issued: 0, calendar: 0, repair: 0, lost: 0, expected: 50 },
});
const CABLE = makeLine({
  id: "line-cable",
  name: "Кабель 32/220 (15м)",
  expected: { total: 25, issued: 0, calendar: 4, repair: 0, lost: 0, expected: 21 },
  calendarBookings: [{ bookingId: "b-9", projectName: "Лето", clientName: "Фёдор Ильин", quantity: 4, endDate: "2026-09-20T07:00:00.000Z" }],
});
const ARM = makeLine({
  id: "line-arm",
  name: "Гибкая трубка Magic Flex ARM",
  expected: { total: 1, issued: 0, calendar: 0, repair: 0, lost: 0, expected: 1 },
});

/** Сервер отвечает строкой со снапшотом и расхождением. */
function counted(line: StockCountLineView, qty: number): StockCountLineView {
  return {
    ...line,
    expectedIsSnapshot: true,
    countedQty: qty,
    countedBy: "sechenoff",
    countedAt: "2026-09-18T09:00:00.000Z",
    diff: qty - line.expected.expected,
  };
}

function routeApi(lines: StockCountLineView[]) {
  apiFetch.mockImplementation((path: string, init?: RequestInit) => {
    if (path.includes("/lines?")) return Promise.resolve({ lines });
    const match = path.match(/\/lines\/([^/]+)\/count$/);
    if (match && init?.method === "POST") {
      const line = lines.find((l) => l.id === match[1])!;
      const { qty } = JSON.parse(String(init.body)) as { qty: number };
      return Promise.resolve({ line: counted(line, qty) });
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  });
}

function countCalls() {
  return apiFetch.mock.calls.filter(([path]) => String(path).endsWith("/count"));
}

function linesCalls() {
  return apiFetch.mock.calls.filter(([path]) => String(path).includes("/lines?"));
}

function sentQtys(): number[] {
  return countCalls().map(([, init]) => (JSON.parse(String(init.body)) as { qty: number }).qty);
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

async function renderPanel(lines: StockCountLineView[], onChanged = vi.fn()) {
  routeApi(lines);
  render(
    <CountLinesPanel
      stockCountId="sc-1"
      category={makeCategory({ lines: lines.length, counted: 0 })}
      readOnly={false}
      onChanged={onChanged}
    />,
  );
  await screen.findByText(lines[0]!.name);
  return onChanged;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CountLinesPanel — строка счёта", () => {
  it("грузит строки категории и объясняет «должно быть»: брони по календарю", async () => {
    await renderPanel([EXTENDER, CABLE]);
    expect(apiFetch).toHaveBeenCalledWith(
      "/api/stock-counts/sc-1/lines?category=%D0%AD%D0%BB%D0%B5%D0%BA%D1%82%D1%80%D0%B8%D0%BA%D0%B0+%2F+%D0%9A%D0%BE%D0%BC%D0%BC%D1%83%D1%82%D0%B0%D1%86%D0%B8%D1%8F",
      undefined,
    );
    expect(
      screen.getByText("4 по календарю у «Лето» — бронь подтверждена, но не отмечена выданной"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("не посчитано")).toHaveLength(2);
  });

  it("позиция в одном экземпляре — «на месте» / «нет», сохраняется сразу", async () => {
    const onChanged = await renderPanel([ARM]);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "на месте" }));
    await waitFor(() => expect(countCalls()).toHaveLength(1));
    const [path, init] = countCalls()[0]!;
    expect(path).toBe("/api/stock-counts/sc-1/lines/line-arm/count");
    expect(JSON.parse(init.body)).toEqual({ qty: 1 });
    expect(await screen.findByText("сошлось")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "на месте" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(onChanged).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "нет" }));
    await waitFor(() => expect(countCalls()).toHaveLength(2));
    expect(JSON.parse(countCalls()[1]![1].body)).toEqual({ qty: 0 });
    expect(await screen.findByText("−1")).toBeInTheDocument();
  });

  it("степпер: значение видно сразу, на сервер уходит один запрос с итогом через 500 мс тишины", async () => {
    await renderPanel([EXTENDER]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const minus = screen.getByRole("button", { name: `Меньше: ${EXTENDER.name}` });
    // Пустой степпер начинает от «должно быть» (50): три «−» → 47.
    fireEvent.click(minus);
    fireEvent.click(minus);
    fireEvent.click(minus);
    expect(screen.getByRole("textbox", { name: `Посчитано: ${EXTENDER.name}` })).toHaveValue("47");
    expect(screen.getByText("−3")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(countCalls()).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(countCalls()).toHaveLength(1);
    expect(JSON.parse(countCalls()[0]![1].body)).toEqual({ qty: 47 });
    // Недостача в деньгах: 250 ₽ × 3.
    expect(screen.getByText("750 ₽/смена")).toBeInTheDocument();
  });

  it("набор с клавиатуры и Enter — сохраняется сразу, без ожидания", async () => {
    await renderPanel([EXTENDER]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const input = screen.getByRole("textbox", { name: `Посчитано: ${EXTENDER.name}` });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "4" } });
    fireEvent.change(input, { target: { value: "48" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(countCalls()).toHaveLength(1);
    expect(JSON.parse(countCalls()[0]![1].body)).toEqual({ qty: 48 });
  });

  it("«= N» ставит «посчитано» = «должно быть» и сохраняет сразу", async () => {
    await renderPanel([CABLE]);
    fireEvent.click(screen.getByRole("button", { name: "Всё на месте: 21" }));
    await waitFor(() => expect(countCalls()).toHaveLength(1));
    expect(JSON.parse(countCalls()[0]![1].body)).toEqual({ qty: 21 });
    expect(await screen.findByText("сошлось")).toBeInTheDocument();
    // У посчитанной строки быстрая кнопка уходит, появляется «Пересчитать».
    expect(screen.queryByRole("button", { name: "Всё на месте: 21" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Пересчитать" })).toBeInTheDocument();
  });

  it("ошибка сохранения — откат к последнему сохранённому, тост по-русски, карточка перечитывается", async () => {
    const onChanged = await renderPanel([EXTENDER]);
    apiFetch.mockImplementation((path: string) => {
      if (String(path).endsWith("/count")) {
        return Promise.reject(apiError(409, "STOCK_COUNT_NOT_OPEN", "Инвентаризация уже завершена или отменена"));
      }
      return Promise.resolve({ lines: [EXTENDER] });
    });

    fireEvent.click(screen.getByRole("button", { name: "Всё на месте: 50" }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Инвентаризация уже завершена или отменена — изменения не сохранены"),
    );
    expect(screen.getByRole("textbox", { name: `Посчитано: ${EXTENDER.name}` })).toHaveValue("");
    expect(screen.getByText("не посчитано")).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
  });

  it("правка после изменения учёта (409 EXPECTATION_CHANGED) — строки перечитываются, на экране сохранённый счёт", async () => {
    // Посчитано 6 при «должно быть» 7; с тех пор бронь вернули — живое ожидание 10.
    const saved = counted(
      makeLine({
        id: "line-ext",
        name: EXTENDER.name,
        expected: { total: 10, issued: 3, calendar: 0, repair: 0, lost: 0, expected: 7 },
      }),
      6,
    );
    const fresh: StockCountLineView = {
      ...saved,
      live: { total: 10, issued: 0, calendar: 0, repair: 0, lost: 0, expected: 10 },
      booksChangedSinceCount: true,
    };
    let listed = 0;
    apiFetch.mockImplementation((path: string) => {
      if (String(path).includes("/lines?")) {
        listed += 1;
        return Promise.resolve({ lines: [listed === 1 ? saved : fresh] });
      }
      if (String(path).endsWith("/count")) {
        return Promise.reject(
          apiError(409, "EXPECTATION_CHANGED", "Учёт позиции изменился", { snapshotExpected: 7, liveExpected: 10 }),
        );
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    render(
      <CountLinesPanel stockCountId="sc-1" category={makeCategory({ lines: 1, counted: 1 })} readOnly={false} onChanged={vi.fn()} />,
    );
    const input = (await screen.findByRole("textbox", { name: `Посчитано: ${EXTENDER.name}` })) as HTMLInputElement;
    expect(input).toHaveValue("6");

    fireEvent.change(input, { target: { value: "7" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "С момента счёта учёт позиции изменился — нажмите «Пересчитать» и посчитайте полку заново",
      ),
    );
    await waitFor(() => expect(linesCalls()).toHaveLength(2));
    expect(await screen.findByText(/после счёта учёт изменился \(сейчас должно быть 10\)/)).toBeInTheDocument();
    fireEvent.blur(input);
    expect(screen.getByRole("textbox", { name: `Посчитано: ${EXTENDER.name}` })).toHaveValue("6");
    expect(screen.getByText("−1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Пересчитать" })).toBeInTheDocument();
  });
});

describe("CountLinesPanel — фоновое перечитывание не затирает свежее", () => {
  const CATEGORY_A = "Электрика / Коммутация";
  const CATEGORY_B = "Свет / Приборы";

  /** Первый запрос строк отвечает сразу, второй (опрос) — когда тест скажет. */
  function routeWithPoll(first: StockCountLineView[], extra: (path: string, init?: RequestInit) => unknown) {
    const poll = deferred<{ lines: StockCountLineView[] }>();
    let n = 0;
    apiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path.includes("/lines?")) {
        const category = new URLSearchParams(path.split("?")[1]).get("category");
        if (category === CATEGORY_B) return Promise.resolve({ lines: [CABLE] });
        n += 1;
        return n === 1 ? Promise.resolve({ lines: first }) : poll.promise;
      }
      const reply = extra(path, init);
      return reply === undefined ? Promise.reject(new Error(`unexpected ${path}`)) : Promise.resolve(reply);
    });
    return poll;
  }

  function panel(category = CATEGORY_A) {
    return (
      <CountLinesPanel
        stockCountId="sc-1"
        category={makeCategory({ category, lines: 1, counted: 0 })}
        readOnly={false}
        onChanged={vi.fn()}
      />
    );
  }

  it("ответ опроса, ушедшего до сохранения, не возвращает строку в «не посчитано»", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const poll = routeWithPoll([EXTENDER], (path, init) => {
      if (path.endsWith("/count") && init?.method === "POST") {
        return { line: counted(EXTENDER, (JSON.parse(String(init.body)) as { qty: number }).qty) };
      }
      return undefined;
    });
    render(panel());
    await screen.findByText(EXTENDER.name);

    act(() => {
      vi.advanceTimersByTime(LINES_POLL_MS);
    });
    expect(linesCalls()).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Всё на месте: 50" }));
    expect(await screen.findByText("сошлось")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Пересчитать" })).toBeInTheDocument();

    // Опрос читал строки до сохранения и отвечает последним.
    await act(async () => {
      poll.resolve({ lines: [EXTENDER] });
    });
    await settle();
    expect(screen.getByText("сошлось")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Пересчитать" })).toBeInTheDocument();
  });

  it("ответ опроса прошлой категории не попадает под шапку новой", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const poll = routeWithPoll([EXTENDER], () => undefined);
    const { rerender } = render(panel(CATEGORY_A));
    await screen.findByText(EXTENDER.name);

    act(() => {
      vi.advanceTimersByTime(LINES_POLL_MS);
    });
    expect(linesCalls()).toHaveLength(2);

    rerender(panel(CATEGORY_B));
    expect(await screen.findByText(CABLE.name)).toBeInTheDocument();

    await act(async () => {
      poll.resolve({ lines: [EXTENDER] });
    });
    await settle();
    expect(screen.queryByText(EXTENDER.name)).not.toBeInTheDocument();
    expect(screen.getByText(CABLE.name)).toBeInTheDocument();
  });

  it("«Пересчитать» не откатывается ответом опроса, ушедшего до сброса", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const COUNTED = counted(EXTENDER, 50);
    const poll = routeWithPoll([COUNTED], (path, init) =>
      path.endsWith("/reset") && init?.method === "POST" ? { line: EXTENDER } : undefined,
    );
    render(panel());
    await screen.findByText(EXTENDER.name);
    expect(screen.getByRole("button", { name: "Пересчитать" })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(LINES_POLL_MS);
    });
    expect(linesCalls()).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Пересчитать" }));
    expect(await screen.findByRole("button", { name: "Всё на месте: 50" })).toBeInTheDocument();

    await act(async () => {
      poll.resolve({ lines: [COUNTED] });
    });
    await settle();
    expect(screen.queryByRole("button", { name: "Пересчитать" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Всё на месте: 50" })).toBeInTheDocument();
  });
});

describe("CountLinesPanel — отложенное сохранение", () => {
  it("отложенное значение уходит при размонтировании (переход на «Итог»), таймер второй раз не шлёт", async () => {
    routeApi([EXTENDER]);
    const onChanged = vi.fn();
    const { unmount } = render(
      <CountLinesPanel
        stockCountId="sc-1"
        category={makeCategory({ lines: 1, counted: 0 })}
        readOnly={false}
        onChanged={onChanged}
      />,
    );
    await screen.findByText(EXTENDER.name);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    fireEvent.click(screen.getByRole("button", { name: `Меньше: ${EXTENDER.name}` }));
    expect(countCalls()).toHaveLength(0);

    unmount();
    expect(countCalls()).toHaveLength(1);
    expect(JSON.parse(countCalls()[0]![1].body)).toEqual({ qty: 49 });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(countCalls()).toHaveLength(1);
    expect(onChanged).toHaveBeenCalled();
  });

  it("пока запрос строки в пути, новое значение ждёт его ответа; старый ответ не перебивает новое", async () => {
    const resolvers: Array<() => void> = [];
    apiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path.includes("/lines?")) return Promise.resolve({ lines: [EXTENDER] });
      if (path.endsWith("/count") && init?.method === "POST") {
        const { qty } = JSON.parse(String(init.body)) as { qty: number };
        return new Promise((res) => resolvers.push(() => res({ line: counted(EXTENDER, qty) })));
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    render(
      <CountLinesPanel stockCountId="sc-1" category={makeCategory({ lines: 1, counted: 0 })} readOnly={false} onChanged={vi.fn()} />,
    );
    await screen.findByText(EXTENDER.name);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const minus = screen.getByRole("button", { name: `Меньше: ${EXTENDER.name}` });
    const input = () => screen.getByRole("textbox", { name: `Посчитано: ${EXTENDER.name}` });

    fireEvent.click(minus);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    fireEvent.click(minus);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    // «49» ещё в пути — «48» ждёт, а не летит параллельно.
    expect(sentQtys()).toEqual([49]);
    expect(input()).toHaveValue("48");

    await act(async () => {
      resolvers[0]!();
    });
    await settle();
    expect(sentQtys()).toEqual([49, 48]);
    expect(input()).toHaveValue("48");

    await act(async () => {
      resolvers[1]!();
    });
    await settle();
    expect(input()).toHaveValue("48");
    expect(screen.getByText("−2")).toBeInTheDocument();
  });

  it("новый клик перезапускает 500 мс тишины — это не троттлинг", async () => {
    routeApi([EXTENDER]);
    render(
      <CountLinesPanel stockCountId="sc-1" category={makeCategory({ lines: 1, counted: 0 })} readOnly={false} onChanged={vi.fn()} />,
    );
    await screen.findByText(EXTENDER.name);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const minus = screen.getByRole("button", { name: `Меньше: ${EXTENDER.name}` });

    fireEvent.click(minus);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    fireEvent.click(minus);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(countCalls()).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(countCalls()).toHaveLength(1);
    expect(JSON.parse(countCalls()[0]![1].body)).toEqual({ qty: 48 });
  });
});
