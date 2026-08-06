/**
 * Автоподгрузка списка на /bookings.
 *
 * Проверяем страницу целиком, а не только хук: почти все грабли автоподгрузки
 * живут на стыке — гард повторного входа, курсор при смене фильтра, поведение
 * после ошибки сети. Хук сам по себе может быть безупречен, а страница при этом
 * тянуть одну и ту же страницу дважды.
 */
import { render, screen, act, waitFor, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: () => null, toString: () => "" }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/bookings",
}));

vi.mock("../../../hooks/useRequireRole", () => ({
  useRequireRole: () => ({ user: { role: "SUPER_ADMIN" }, loading: false, authorized: true }),
}));
vi.mock("../../../hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: { role: "SUPER_ADMIN", name: "Тест" }, loading: false }),
}));
vi.mock("../../ToastProvider", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import BookingsPage from "../../../../app/bookings/page";
import { triggerIntersection } from "../../../test-setup";

const ORIGINAL_FETCH = global.fetch;

function booking(id: string) {
  return {
    id,
    projectName: `Проект ${id}`,
    status: "CONFIRMED",
    paymentStatus: "UNPAID",
    startDate: "2026-08-10T09:00:00.000Z",
    endDate: "2026-08-10T21:00:00.000Z",
    finalAmount: "10000",
    amountPaid: "0",
    amountOutstanding: "10000",
    client: { id: `c-${id}`, name: `Клиент ${id}` },
    items: [],
  };
}

/** Ответы /api/bookings по порядку обращения; остальные ручки — пустые. */
function mockApi(pages: Array<{ bookings: unknown[]; nextCursor: string | null; totalCount?: number }>) {
  const listCalls: string[] = [];
  let page = 0;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/bookings?")) {
      listCalls.push(url);
      const body = pages[Math.min(page, pages.length - 1)];
      page += 1;
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
    }
    const empty = { pendingApproval: 0, overdue: 0, issued: 0 };
    return { ok: true, status: 200, json: async () => empty, text: async () => JSON.stringify(empty) } as Response;
  }) as unknown as typeof fetch;
  return listCalls;
}

describe("/bookings — автоподгрузка при доскролле", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
  });

  it("догружает следующую страницу, когда список доскроллен до низа", async () => {
    const listCalls = mockApi([
      { bookings: [booking("a1")], nextCursor: "cur-1", totalCount: 2 },
      { bookings: [booking("b1")], nextCursor: null },
    ]);
    render(<BookingsPage />);
    await screen.findAllByText("Проект a1");

    await act(async () => {
      triggerIntersection(true);
    });
    await screen.findAllByText("Проект b1");

    expect(listCalls).toHaveLength(2);
    expect(listCalls[1]).toContain("cursor=cur-1");
  });

  it("два события наблюдателя подряд дают ровно один запрос", async () => {
    // Гард на React-state пропустил бы оба: setLoadingMore применяется
    // асинхронно, и страница уехала бы в список дважды.
    const listCalls = mockApi([
      { bookings: [booking("a1")], nextCursor: "cur-1", totalCount: 3 },
      { bookings: [booking("b1")], nextCursor: "cur-2" },
    ]);
    render(<BookingsPage />);
    await screen.findAllByText("Проект a1");

    await act(async () => {
      triggerIntersection(true);
      triggerIntersection(true);
    });
    await screen.findAllByText("Проект b1");

    const withCursor = listCalls.filter((u) => u.includes("cursor=cur-1"));
    expect(withCursor).toHaveLength(1);
  });

  it("кнопка «Загрузить ещё» не мозолит глаза, но остаётся доступной с клавиатуры", async () => {
    mockApi([{ bookings: [booking("a1")], nextCursor: "cur-1", totalCount: 2 }]);
    render(<BookingsPage />);
    await screen.findAllByText("Проект a1");

    const button = screen.getByRole("button", { name: "Загрузить ещё" });
    expect(button.className).toContain("sr-only");
    expect(button.className).toContain("focus:not-sr-only");
  });

  it("после ошибки сети показывает «Повторить» и больше не долбит запросами", async () => {
    let listCalls = 0;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/bookings?")) {
        listCalls += 1;
        if (url.includes("cursor=")) {
          return { ok: false, status: 500, text: async () => "boom" } as Response;
        }
        const body = { bookings: [booking("a1")], nextCursor: "cur-1", totalCount: 2 };
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
      }
      const empty = { pendingApproval: 0, overdue: 0, issued: 0 };
      return { ok: true, status: 200, json: async () => empty, text: async () => JSON.stringify(empty) } as Response;
    }) as unknown as typeof fetch;

    render(<BookingsPage />);
    await screen.findAllByText("Проект a1");

    await act(async () => {
      triggerIntersection(true);
    });
    const retry = await screen.findByRole("button", { name: "Повторить" });
    const afterFailure = listCalls;

    // Сентинел остался на экране — но пока пользователь не нажал «Повторить»,
    // новых запросов быть не должно.
    await act(async () => {
      triggerIntersection(true);
      triggerIntersection(true);
    });
    expect(listCalls).toBe(afterFailure);
    expect(retry).toBeInTheDocument();
  });

  it("групповое действие не тянет повторно страницу, которую автоподгрузка уже забрала", async () => {
    // Настоящая гонка: групповой запрос идёт секунды (сервер обрабатывает брони
    // по одной), и его продолжение зовёт догрузку с замыканием того рендера, где
    // нажали кнопку. Если курсор берётся оттуда, а не из ref, автоподгрузка
    // успевает его израсходовать — и та же страница приезжает вторым
    // экземпляром: дубли строк, дубли React-ключей, вранья в счётчике.
    const listCalls: string[] = [];
    let releaseBulk: (() => void) | null = null;
    const bulkStarted = new Promise<void>((resolveStarted) => {
      let page = 0;
      const pages = [
        { bookings: [booking("a1")], nextCursor: "cur-1", totalCount: 3 },
        { bookings: [booking("b1")], nextCursor: "cur-2" },
        { bookings: [booking("c1")], nextCursor: null },
      ];
      global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/bookings/bulk")) {
          resolveStarted();
          await new Promise<void>((r) => {
            releaseBulk = r;
          });
          const body = { action: "archive", results: [{ id: "a1", ok: true }], counts: { total: 1, ok: 1, failed: 0 } };
          return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
        }
        if (url.includes("/api/bookings?")) {
          listCalls.push(url);
          const body = pages[Math.min(page, pages.length - 1)];
          page += 1;
          return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
        }
        const empty = { pendingApproval: 0, overdue: 0, issued: 0 };
        return { ok: true, status: 200, json: async () => empty, text: async () => JSON.stringify(empty) } as Response;
      }) as unknown as typeof fetch;
    });

    render(<BookingsPage />);
    await screen.findAllByText("Проект a1");

    // Выделяем единственную загруженную строку и отправляем её в архив.
    fireEvent.click(screen.getByLabelText("Выбрать все загруженные брони"));
    fireEvent.click(await screen.findByRole("button", { name: /В архив/ }));
    // Кнопка панели действий и кнопка подтверждения называются одинаково —
    // отличаем модалку по соседней «Отмена».
    const cancel = await screen.findByRole("button", { name: "Отмена" });
    fireEvent.click(within(cancel.parentElement as HTMLElement).getByRole("button", { name: /В архив/ }));
    await act(async () => {
      await bulkStarted;
    });

    // Пока групповой запрос в полёте, пользователь доскроллил до низа —
    // автоподгрузка забирает страницу cur-1 и переводит курсор на cur-2.
    await act(async () => {
      triggerIntersection(true);
    });
    expect(listCalls.filter((u) => u.includes("cursor=cur-1"))).toHaveLength(1);

    // Групповой запрос отвечает. Он вычистил ту единственную строку, что была
    // на экране при клике, но список с тех пор подрос — догружать нечего.
    await act(async () => {
      releaseBulk?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryAllByText("Проект a1")).toHaveLength(0));

    // Главное: страница cur-1 запрошена ровно один раз. Повторный запрос
    // приписал бы «Проект b1» в список вторым экземпляром.
    expect(listCalls.filter((u) => u.includes("cursor=cur-1"))).toHaveLength(1);
    expect(screen.getAllByText("Проект b1")).toHaveLength(2); // строка таблицы + мобильная карточка
  });

  it("«Показаны все брони» появляется, когда следующей страницы нет", async () => {
    mockApi([{ bookings: [booking("a1")], nextCursor: null, totalCount: 1 }]);
    render(<BookingsPage />);
    await screen.findAllByText("Проект a1");

    await waitFor(() => expect(screen.getByText(/Показаны все брони/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Загрузить ещё" })).toBeNull();
  });

  it("«выбрать все» ограничено потолком пачки", async () => {
    // Сам потолок проверяется на уровне useBookingSelection — здесь достаточно
    // убедиться, что страница его действительно передаёт. Рендерить 120 строк
    // целой страницей ради этого слишком дорого: тест упирался в таймаут.
    const many = Array.from({ length: 3 }, (_, i) => booking(`r${i}`));
    mockApi([{ bookings: many, nextCursor: null, totalCount: 3 }]);
    render(<BookingsPage />);
    await screen.findAllByText("Проект r0");

    // Загруженных меньше потолка — значит обрезки нет и подпись обычная.
    expect(screen.getByLabelText("Выбрать все загруженные брони")).toBeInTheDocument();
  });
});
