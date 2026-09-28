/**
 * «+ Добор» и незавершённая сессия киоска; карточка держателя конфликта.
 *
 * На проде единственная попытка добора со страницы (05.09) упёрлась в
 * брошенную приёмку: совет «завершите или отмените её в киоске» выполнить было
 * нечем. Теперь модалка показывает, кто и когда начал, и даёт прервать сессию
 * прямо отсюда. Карточка конфликта различает «вещь у клиента» и «бронь на даты».
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("../../ToastProvider", () => ({ toast: toastMock }));

import { AddonItemsModal } from "../AddonItemsModal";

const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();
/** «ДД.ММ» по Москве — так модалка печатает даты. */
function ddmm(isoDate: string) {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" })
    .format(new Date(isoDate))
    .split("-");
  void y;
  return `${d}.${m}`;
}

const FREE_ROW = {
  equipmentId: "eq-free",
  name: "Aputure 600d",
  category: "Свет",
  brand: null,
  model: null,
  stockTrackingMode: "COUNT",
  rentalRatePerShift: "1000",
  availableQuantity: 2,
  addCap: 2,
  ackCap: 2,
  alreadyInBooking: 0,
  availability: "AVAILABLE",
  conflict: null,
};

function busyRow(conflict: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    equipmentId: "eq-busy",
    name: "Joker 800",
    category: "Свет",
    brand: null,
    model: null,
    stockTrackingMode: "COUNT",
    rentalRatePerShift: "500",
    availableQuantity: 0,
    addCap: 0,
    ackCap: 3,
    alreadyInBooking: 1,
    availability: "UNAVAILABLE",
    conflict: {
      bookingId: "b-other",
      bookingNo: "#A1B2C3",
      projectName: "Чужой проект",
      clientName: "Гаффер Петров",
      from: iso(-3),
      to: iso(2),
      freeFrom: iso(2),
      holderStatus: "CONFIRMED",
      issuedAt: null,
      overdue: false,
      freeForUs: 0,
      ackCap: 3,
      ...conflict,
    },
    ...extra,
  };
}

function renderModal(overrides: Partial<React.ComponentProps<typeof AddonItemsModal>> = {}) {
  const onAdded = vi.fn();
  const onClose = vi.fn();
  const onSessionClosed = vi.fn();
  render(
    <AddonItemsModal
      open
      bookingId="b1"
      shifts={2}
      discountPercent={null}
      hasManualFinalAmount={false}
      onClose={onClose}
      onAdded={onAdded}
      onSessionClosed={onSessionClosed}
      {...overrides}
    />,
  );
  return { onAdded, onClose, onSessionClosed };
}

async function addToCart(query: string, name: string) {
  fireEvent.change(screen.getByLabelText("Поиск по каталогу"), { target: { value: query } });
  fireEvent.click(await screen.findByRole("button", { name: `Добавить ${name}` }));
}

beforeEach(() => {
  apiFetchMock.mockReset();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
  toastMock.info.mockReset();
});

describe("AddonItemsModal — незавершённая сессия киоска", () => {
  const startedAt = new Date(Date.now() - 2 * DAY).toISOString();
  const sessionActive = () =>
    Object.assign(
      new Error("На складе идёт приёмка по этой брони (jony, с 03.09 19:46) — завершите её в киоске или прервите."),
      {
        status: 409,
        code: "SCAN_SESSION_ACTIVE",
        details: { sessionId: "sess-1", operation: "RETURN", workerName: "jony", startedAt, hasDraft: true },
      },
    );

  it("показывает, кто начал, и прерывает сессию по подтверждению", async () => {
    let addonCalls = 0;
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.includes("/addon-search")) return { results: [FREE_ROW] };
      if (path.endsWith("/addon-items")) {
        addonCalls += 1;
        throw sessionActive();
      }
      if (path === "/api/warehouse/sessions/sess-1/cancel" && init?.method === "POST") {
        return { id: "sess-1", status: "CANCELLED", cancelled: true };
      }
      throw new Error(`unexpected ${path}`);
    });
    const { onAdded, onSessionClosed } = renderModal();
    await addToCart("apu", "Aputure 600d");
    fireEvent.click(screen.getByRole("button", { name: "Добавить доп-сметой" }));

    const block = await screen.findByRole("region", { name: "Незавершённая сессия киоска" });
    expect(block).toHaveTextContent("jony");
    expect(block).toHaveTextContent("идёт приёмка");
    expect(block).toHaveTextContent("сохранённые отметки");
    expect(addonCalls).toBe(1);
    expect(onAdded).not.toHaveBeenCalled();

    fireEvent.click(within(block).getByRole("button", { name: "Прервать приёмку в киоске" }));
    // Сначала — подтверждение, запрос ещё не ушёл.
    expect(apiFetchMock.mock.calls.some(([p]) => String(p).includes("/cancel"))).toBe(false);
    expect(block).toHaveTextContent("останется «Выдана»");
    fireEvent.click(within(block).getByRole("button", { name: "Да, прервать" }));

    await waitFor(() => expect(onSessionClosed).toHaveBeenCalledTimes(1));
    const cancel = apiFetchMock.mock.calls.find(([p]) => String(p).includes("/cancel"));
    expect(JSON.parse(String(cancel![1].body))).toEqual({ reason: "CARD_ABORT" });
    expect(screen.queryByRole("region", { name: "Незавершённая сессия киоска" })).not.toBeInTheDocument();
    expect(toastMock.success).toHaveBeenCalledWith(expect.stringContaining("Приёмка в киоске прервана"));
    // Корзина на месте — добор можно отправить заново.
    expect(screen.getByLabelText("Количество Aputure 600d")).toHaveValue(1);
  });

  it("сессия блокирует без черновика (добор на месте) — «отметок нет» не пишем", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path.includes("/addon-search")) return { results: [FREE_ROW] };
      if (path.endsWith("/addon-items")) {
        const e = sessionActive();
        (e.details as { hasDraft: boolean }).hasDraft = false;
        throw e;
      }
      throw new Error(`unexpected ${path}`);
    });
    renderModal();
    await addToCart("apu", "Aputure 600d");
    fireEvent.click(screen.getByRole("button", { name: "Добавить доп-сметой" }));
    const block = await screen.findByRole("region", { name: "Незавершённая сессия киоска" });
    expect(block).not.toHaveTextContent("отметок");
    expect(block).not.toHaveTextContent("Отметок");
    expect(within(block).getByRole("button", { name: "Прервать приёмку в киоске" })).toBeInTheDocument();
  });

  it("«Не прерывать» оставляет сессию в покое", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path.includes("/addon-search")) return { results: [FREE_ROW] };
      if (path.endsWith("/addon-items")) throw sessionActive();
      throw new Error(`unexpected ${path}`);
    });
    renderModal();
    await addToCart("apu", "Aputure 600d");
    fireEvent.click(screen.getByRole("button", { name: "Добавить доп-сметой" }));
    const block = await screen.findByRole("region", { name: "Незавершённая сессия киоска" });
    fireEvent.click(within(block).getByRole("button", { name: "Прервать приёмку в киоске" }));
    fireEvent.click(within(block).getByRole("button", { name: "Не прерывать" }));
    expect(within(block).getByRole("button", { name: "Прервать приёмку в киоске" })).toBeInTheDocument();
    expect(apiFetchMock.mock.calls.some(([p]) => String(p).includes("/cancel"))).toBe(false);
  });

  it("сессию успели закрыть — блок исчезает, показывается ответ сервера", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path.includes("/addon-search")) return { results: [FREE_ROW] };
      if (path.endsWith("/addon-items")) throw sessionActive();
      if (path.includes("/cancel")) {
        throw Object.assign(new Error("Приёмка по этой брони уже завершена"), {
          status: 409,
          code: "SESSION_ALREADY_COMPLETED",
        });
      }
      throw new Error(`unexpected ${path}`);
    });
    const { onSessionClosed } = renderModal();
    await addToCart("apu", "Aputure 600d");
    fireEvent.click(screen.getByRole("button", { name: "Добавить доп-сметой" }));
    const block = await screen.findByRole("region", { name: "Незавершённая сессия киоска" });
    fireEvent.click(within(block).getByRole("button", { name: "Прервать приёмку в киоске" }));
    fireEvent.click(within(block).getByRole("button", { name: "Да, прервать" }));
    await waitFor(() => expect(onSessionClosed).toHaveBeenCalledTimes(1));
    expect(toastMock.info).toHaveBeenCalledWith("Приёмка по этой брони уже завершена");
    expect(screen.queryByRole("region", { name: "Незавершённая сессия киоска" })).not.toBeInTheDocument();
  });
});

describe("AddonItemsModal — кто держит позицию", () => {
  it("вещь у клиента: «сейчас у клиента … с ДД.ММ» и предупреждение про полку", async () => {
    const issuedAt = iso(-3);
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path.includes("/addon-search"))
        return { results: [busyRow({ holderStatus: "ISSUED", issuedAt })] };
      throw new Error(`unexpected ${path}`);
    });
    renderModal();
    await addToCart("joker", "Joker 800");
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(`сейчас у клиента «Гаффер Петров» с ${ddmm(issuedAt)}`);
    expect(alert).toHaveTextContent(`Свободно с ${ddmm(iso(2))}`);
    expect(alert).toHaveTextContent("физически на полке");
  });

  it("имя клиента неизвестно — «сейчас у клиента с ДД.ММ», проект клиентом не называется", async () => {
    const issuedAt = iso(-3);
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path.includes("/addon-search"))
        return { results: [busyRow({ holderStatus: "ISSUED", issuedAt, clientName: null })] };
      throw new Error(`unexpected ${path}`);
    });
    renderModal();
    await addToCart("joker", "Joker 800");
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(`сейчас у клиента с ${ddmm(issuedAt)} · бронь #A1B2C3 «Чужой проект»`);
    expect(alert).not.toHaveTextContent("у клиента «Чужой проект»");
  });

  it("просроченная выдача: «возврат не отмечен, срок был ДД.ММ», без «Свободно с»", async () => {
    const to = iso(-1);
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path.includes("/addon-search"))
        return {
          results: [busyRow({ holderStatus: "ISSUED", issuedAt: iso(-5), to, freeFrom: null, overdue: true })],
        };
      throw new Error(`unexpected ${path}`);
    });
    renderModal();
    await addToCart("joker", "Joker 800");
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(`возврат не отмечен, срок был ${ddmm(to)}`);
    expect(alert).not.toHaveTextContent("Свободно с");
  });

  it("бронь на даты (не выдана): номер, проект, период и когда освободится", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path.includes("/addon-search")) return { results: [busyRow({})] };
      throw new Error(`unexpected ${path}`);
    });
    renderModal();
    await addToCart("joker", "Joker 800");
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("#A1B2C3");
    expect(alert).toHaveTextContent("«Чужой проект»");
    expect(alert).toHaveTextContent(`Свободно с ${ddmm(iso(2))}`);
    expect(alert).not.toHaveTextContent("у клиента");
  });

  it("бронь на согласовании подписана как «на согласовании»", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path.includes("/addon-search")) return { results: [busyRow({ holderStatus: "PENDING_APPROVAL" })] };
      throw new Error(`unexpected ${path}`);
    });
    renderModal();
    await addToCart("joker", "Joker 800");
    expect(screen.getByRole("alert")).toHaveTextContent("на согласовании");
  });

  it("под ответственность степпер ограничен ackCap, а не 99", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path.includes("/addon-search")) return { results: [busyRow({})] };
      throw new Error(`unexpected ${path}`);
    });
    renderModal();
    await addToCart("joker", "Joker 800");
    const plus = screen.getByRole("button", { name: "Больше: Joker 800" });
    for (let i = 0; i < 5; i += 1) fireEvent.click(plus);
    expect(screen.getByLabelText("Количество Joker 800")).toHaveValue(3);
    expect(plus).toBeDisabled();
  });

  it("держатель есть, но брать нечего (ackCap 0) — позицию не добавить", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path.includes("/addon-search")) return { results: [busyRow({ ackCap: 0 }, { ackCap: 0 })] };
      throw new Error(`unexpected ${path}`);
    });
    renderModal();
    fireEvent.change(screen.getByLabelText("Поиск по каталогу"), { target: { value: "joker" } });
    expect(await screen.findByRole("button", { name: "Добавить Joker 800" })).toBeDisabled();
  });
});
