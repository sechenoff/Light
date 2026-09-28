/**
 * «+ Добор» в киоске: карточка конфликта и новые правила потолка (P4, P22, P26,
 * P17 — PIN-режим). Базовое поведение поиска — в AddonSearch.test.tsx.
 *
 *  - держатель назван: «у клиента с …», «возврат не отмечен», «на складе,
 *    зарезервирован»; «Свободно с …» только при известной дате;
 *  - в карточке конфликта выбирается количество до `ackCap`;
 *  - 409 ADDON_OVER_STOCK показывает текст сервера, а не свою сборку;
 *  - в PIN-киоске ссылки на PDF нет (там 401), вместо неё подсказка;
 *  - при договорном итоге — предупреждение, что сумма к оплате не изменится.
 */
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AddonSearch } from "../AddonSearch";
import { scanApi } from "../api";
import type { AddonConflict, AddonResult, ScanApiError } from "../types";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  window.sessionStorage.clear();
});

const DAY = 24 * 3600 * 1000;
/** Даты от текущего момента: полдень по Москве, чтобы «ДД.ММ» не прыгали. */
function isoDaysFromNow(days: number): string {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(9, 0, 0, 0);
  return d.toISOString();
}
function ddmm(iso: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
  }).formatToParts(d);
  const day = parts.find((p) => p.type === "day")?.value ?? "";
  const month = parts.find((p) => p.type === "month")?.value ?? "";
  return `${day}.${month}`;
}

function holder(over: Partial<AddonConflict> = {}): AddonConflict {
  return {
    bookingId: "b-h",
    bookingNo: "#ABC123",
    projectName: "Клип Maxi",
    from: isoDaysFromNow(-2),
    to: isoDaysFromNow(3),
    freeFrom: isoDaysFromNow(3),
    clientName: "Иванов",
    holderStatus: "CONFIRMED",
    issuedAt: null,
    overdue: false,
    freeForUs: 0,
    ackCap: 3,
    ...over,
  };
}

function busyRow(over: Partial<AddonResult> = {}): AddonResult {
  return {
    equipmentId: "eq-busy",
    name: "Сетка 8x8",
    category: "Грип",
    availableQuantity: 0,
    addCap: 0,
    ackCap: 3,
    availability: "UNAVAILABLE",
    conflict: holder(),
    ...over,
  };
}

function freeRow(over: Partial<AddonResult> = {}): AddonResult {
  return {
    equipmentId: "eq-free",
    name: "Флоппи",
    category: "Грип",
    availableQuantity: 2,
    addCap: 2,
    ackCap: 5,
    availability: "AVAILABLE",
    conflict: null,
    ...over,
  };
}

async function settleSearch() {
  await act(async () => {
    vi.advanceTimersByTime(350);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

async function type(value: string) {
  const input = screen.getByLabelText("Поиск артикула по каталогу");
  await act(async () => {
    fireEvent.change(input, { target: { value } });
  });
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
}

function renderSearch(props: Partial<Parameters<typeof AddonSearch>[0]> = {}) {
  return render(
    <AddonSearch
      sessionId="s1"
      bookingId="b-test"
      onAdded={() => {}}
      onClose={() => {}}
      {...props}
    />,
  );
}

describe("AddonSearch — держатель в карточке конфликта (P26)", () => {
  it("выданный держатель: «сейчас у клиента … с ДД.ММ», свободно с даты возврата", async () => {
    const issuedAt = isoDaysFromNow(-2);
    const conflict = holder({ holderStatus: "ISSUED", issuedAt });
    vi.spyOn(scanApi, "addonSearch").mockResolvedValue([busyRow({ conflict })]);
    renderSearch();
    await type("сетка");
    await settleSearch();

    await click(screen.getByRole("button", { name: /Сетка 8x8 — у клиента/ }));

    const card = screen.getByRole("alert");
    expect(card).toHaveTextContent(`Сейчас у клиента «Иванов» с ${ddmm(issuedAt)}`);
    expect(card).toHaveTextContent(`Свободно с ${ddmm(conflict.freeFrom!)}`);
  });

  it("просроченный выданный держатель: «возврат не отмечен, срок был …», без «Свободно с»", async () => {
    const to = isoDaysFromNow(-1);
    const conflict = holder({
      holderStatus: "ISSUED",
      issuedAt: isoDaysFromNow(-5),
      to,
      overdue: true,
      freeFrom: null,
    });
    vi.spyOn(scanApi, "addonSearch").mockResolvedValue([busyRow({ conflict })]);
    renderSearch();
    await type("сетка");
    await settleSearch();

    await click(screen.getByRole("button", { name: /Сетка 8x8 — у клиента/ }));

    const card = screen.getByRole("alert");
    expect(card).toHaveTextContent(`Возврат не отмечен — срок был ${ddmm(to)}`);
    expect(card).not.toHaveTextContent(/Свободно с/);
  });

  it("подтверждённый держатель: вещь на складе, зарезервирована", async () => {
    vi.spyOn(scanApi, "addonSearch").mockResolvedValue([busyRow()]);
    renderSearch();
    await type("сетка");
    await settleSearch();

    await click(screen.getByRole("button", { name: /Сетка 8x8 — занят/ }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Пока на складе — зарезервирован под эту бронь",
    );
  });

  it("409 ADDON_CONFLICT с freeFrom=null всё равно открывает карточку (а не общую ошибку)", async () => {
    vi.spyOn(scanApi, "addonSearch").mockResolvedValue([freeRow()]);
    const err: ScanApiError = {
      status: 409,
      code: "ADDON_CONFLICT",
      message: "Позиция занята другой бронью",
      details: holder({ holderStatus: "ISSUED", overdue: true, freeFrom: null, ackCap: 4 }),
    };
    vi.spyOn(scanApi, "addItem").mockRejectedValue(err);
    renderSearch();
    await type("флоппи");
    await settleSearch();

    await click(screen.getByRole("button", { name: /Флоппи — свободно/ }));
    await click(screen.getByRole("button", { name: /Добавить 1 шт Флоппи/ }));

    const card = await screen.findByRole("alert");
    expect(card).toHaveTextContent(/Флоппи занят/);
    expect(card).toHaveTextContent(/Возврат не отмечен/);
    expect(card).not.toHaveTextContent(/Свободно с/);
    expect(card).not.toHaveTextContent("Позиция занята другой бронью");
  });
});

describe("AddonSearch — количество под ответственность (P4)", () => {
  it("в карточке конфликта можно выбрать количество до ackCap и выдать его", async () => {
    vi.spyOn(scanApi, "addonSearch").mockResolvedValue([busyRow({ ackCap: 3 })]);
    const addSpy = vi.spyOn(scanApi, "addItem").mockResolvedValue({ bookingItemId: "bi-9" });
    const onAdded = vi.fn();
    renderSearch({ onAdded });
    await type("сетка");
    await settleSearch();

    await click(screen.getByRole("button", { name: /Сетка 8x8 — занят/ }));
    const plus = screen.getByRole("button", { name: /Увеличить — сколько добрать/ });
    await click(plus);
    await click(plus);
    expect(
      screen.getByRole("spinbutton", { name: /Сколько добрать/ }),
    ).toHaveValue(3);
    expect(plus).toBeDisabled();

    await click(
      screen.getByRole("button", { name: /Выдать 3 шт Сетка 8x8 под ответственность/ }),
    );
    expect(addSpy).toHaveBeenCalledWith("s1", "eq-busy", 3, true);
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith("bi-9", true));
  });

  it("ackCap = 0: добрать нельзя даже под ответственность — кнопка неактивна и объяснение", async () => {
    vi.spyOn(scanApi, "addonSearch").mockResolvedValue([
      busyRow({ ackCap: 0, conflict: holder({ ackCap: 0 }) }),
    ]);
    const addSpy = vi.spyOn(scanApi, "addItem");
    renderSearch();
    await type("сетка");
    await settleSearch();

    await click(screen.getByRole("button", { name: /Сетка 8x8 — занят/ }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      /На складе не осталось ни одной единицы/,
    );
    expect(screen.getByRole("button", { name: /под ответственность/ })).toBeDisabled();
    expect(addSpy).not.toHaveBeenCalled();
  });

  it("свободную строку можно поднять выше свободного до ackCap — с подсказкой; сервер отвечает конфликтом, количество сохраняется", async () => {
    vi.spyOn(scanApi, "addonSearch").mockResolvedValue([freeRow({ addCap: 2, ackCap: 5 })]);
    const err: ScanApiError = {
      status: 409,
      code: "ADDON_CONFLICT",
      message: "busy",
      details: holder({ ackCap: 5 }),
    };
    const addSpy = vi
      .spyOn(scanApi, "addItem")
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ bookingItemId: "bi-4" });
    renderSearch();
    await type("флоппи");
    await settleSearch();

    await click(screen.getByRole("button", { name: /Флоппи — свободно/ }));
    const qty = screen.getByRole("spinbutton", { name: /Количество для добавления/ });
    expect(qty).toHaveAttribute("max", "5");
    const plus = screen.getByRole("button", { name: /^Увеличить количество$/ });
    await click(plus);
    await click(plus);
    await click(plus);
    expect(qty).toHaveValue(4);
    expect(screen.getByText(/Свободно 2 — остальное только под ответственность/)).toBeInTheDocument();

    await click(screen.getByRole("button", { name: /Добавить 4 шт Флоппи/ }));
    expect(addSpy).toHaveBeenNthCalledWith(1, "s1", "eq-free", 4, undefined);
    await click(await screen.findByRole("button", { name: /Выдать 4 шт Флоппи под ответственность/ }));
    expect(addSpy).toHaveBeenLastCalledWith("s1", "eq-free", 4, true);
  });

  it("409 ADDON_OVER_STOCK показывает текст сервера как есть", async () => {
    vi.spyOn(scanApi, "addonSearch").mockResolvedValue([freeRow()]);
    const err: ScanApiError = {
      status: 409,
      code: "ADDON_OVER_STOCK",
      message: "«Флоппи»: не хватает на складе — можно добрать ещё 1",
      details: {
        equipmentId: "eq-free",
        name: "Флоппи",
        addCap: 1,
        requested: 2,
        alreadyInBooking: 0,
      },
    };
    vi.spyOn(scanApi, "addItem").mockRejectedValue(err);
    renderSearch();
    await type("флоппи");
    await settleSearch();

    await click(screen.getByRole("button", { name: /Флоппи — свободно/ }));
    await click(screen.getByRole("button", { name: /Добавить 1 шт Флоппи/ }));

    expect(
      await screen.findByText("«Флоппи»: не хватает на складе — можно добрать ещё 1"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Уже в брони:/)).not.toBeInTheDocument();
  });
});

describe("AddonSearch — PIN-киоск и договорной итог (P17, P22)", () => {
  it("в PIN-режиме после добора нет ссылки на PDF — подсказка про карточку брони", async () => {
    window.sessionStorage.setItem("warehouse_token", "tok:sig");
    vi.spyOn(scanApi, "addonSearch").mockResolvedValue([freeRow()]);
    vi.spyOn(scanApi, "addItem").mockResolvedValue({ bookingItemId: "bi-1" });
    renderSearch();
    await type("флоппи");
    await settleSearch();

    await click(screen.getByRole("button", { name: /Флоппи — свободно/ }));
    await click(screen.getByRole("button", { name: /Добавить 1 шт Флоппи/ }));

    expect(await screen.findByText(/Флоппи добавлен в выдачу/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /PDF/ })).not.toBeInTheDocument();
    expect(screen.getByText(/PDF — в карточке брони в CRM/)).toBeInTheDocument();
  });

  it("при договорном итоге предупреждает, что сумма к оплате не изменится", async () => {
    vi.spyOn(scanApi, "addonSearch").mockResolvedValue([]);
    renderSearch({ manualFinalAmount: "50000" });

    expect(
      screen.getByText(/договорной итог — сумма к оплате не изменится автоматически/),
    ).toBeInTheDocument();
  });

  it("без договорного итога предупреждения нет", async () => {
    vi.spyOn(scanApi, "addonSearch").mockResolvedValue([]);
    renderSearch({ manualFinalAmount: null });

    expect(screen.queryByText(/договорной итог/)).not.toBeInTheDocument();
  });
});

describe("AddonSearch — сессию закрыли, пока открыт поиск", () => {
  it("SESSION_* в ответе поиска уходит в чек-лист (уведомление), а не красной строкой поиска", async () => {
    const err: ScanApiError = {
      status: 409,
      code: "SESSION_CANCELLED",
      message: "Сессию склада прервали — откройте бронь заново",
      details: { sessionId: "s1", operation: "ISSUE", cancelReason: "CARD_ABORT" },
    };
    vi.spyOn(scanApi, "addonSearch").mockRejectedValue(err);
    const onSessionClosed = vi.fn();
    renderSearch({ onSessionClosed });
    await type("сетка");
    await settleSearch();

    await waitFor(() => expect(onSessionClosed).toHaveBeenCalledWith(err));
    expect(screen.queryByText("Сессию склада прервали — откройте бронь заново")).not.toBeInTheDocument();
  });
});
