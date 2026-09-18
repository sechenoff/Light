/**
 * Строка «Итога» и целостность решения:
 *  - строку пересчитали, пока руководитель решал (409 LINE_CHANGED) — тост с
 *    новым расхождением, перечитывание, набранная причина не теряется;
 *  - учёт позиции изменился после счёта — что именно, «Обновить ожидание» и
 *    «Оставить как посчитано» (решение уходит с подтверждением);
 *  - «Ошибка учёта» обещает поправку от текущего количества, а излишек, который
 *    может быть невозвращённой бронью, предупреждает.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const toastError = vi.fn();
vi.mock("../../ToastProvider", () => ({
  toast: { success: vi.fn(), error: (m: string) => toastError(m), info: vi.fn() },
}));

const apiFetch = vi.fn();
vi.mock("../../../lib/api", () => ({
  apiFetch: (path: string, init?: RequestInit) => apiFetch(path, init),
}));

import { DiscrepancyRow } from "../DiscrepancyRow";
import type { StockCountLineView } from "../types";
import { apiError, shortageLine, surplusLine } from "./fixtures";

beforeEach(() => {
  vi.clearAllMocks();
});

function renderRow(line: StockCountLineView) {
  const props = { onLineChange: vi.fn(), onRecount: vi.fn(), onChanged: vi.fn(), onStale: vi.fn() };
  const utils = render(
    <ul>
      <DiscrepancyRow stockCountId="sc-1" line={line} status="OPEN" {...props} />
    </ul>,
  );
  return {
    ...props,
    rerenderWith: (next: StockCountLineView) =>
      utils.rerender(
        <ul>
          <DiscrepancyRow stockCountId="sc-1" line={next} status="OPEN" {...props} />
        </ul>,
      ),
  };
}

function bodyOf(suffix: string) {
  const call = apiFetch.mock.calls.find(([path]) => String(path).endsWith(suffix));
  return call?.[1]?.body ? JSON.parse(String(call[1].body)) : call ? {} : null;
}

/** Учёт догнал полку после счёта: бронь с 4 шт отметили возвращённой. */
const BOOKS_CHANGED = surplusLine({
  expected: { total: 10, issued: 4, calendar: 0, repair: 0, lost: 0, expected: 6 },
  countedQty: 10,
  diff: 4,
  live: { total: 10, issued: 0, calendar: 0, repair: 0, lost: 0, expected: 10 },
  booksChangedSinceCount: true,
});

describe("DiscrepancyRow — строку пересчитали, пока решали", () => {
  it("409 LINE_CHANGED: тост с новым расхождением, перечитывание, причина в открытом диалоге остаётся", async () => {
    apiFetch.mockRejectedValue(
      apiError(409, "LINE_CHANGED", "Строку пересчитали", { countedQty: 51, expectedQty: 50, diff: 1 }),
    );
    const { onStale, rerenderWith } = renderRow(shortageLine({ countedQty: 48, diff: -2 }));

    fireEvent.click(screen.getByRole("button", { name: "Ошибка учёта" }));
    fireEvent.change(await screen.findByLabelText(/Причина/), { target: { value: "2 шт списаны в 2024" } });
    fireEvent.click(screen.getByRole("button", { name: "Поправить учёт" }));

    await waitFor(() => expect(onStale).toHaveBeenCalled());
    expect(toastError).toHaveBeenCalledWith("Строку пересчитали: теперь +1 — проверьте и решите заново");
    expect(bodyOf("/decision")).toMatchObject({ decision: "ADJUST", seenCountedQty: 48, seenExpectedQty: 50 });

    // Список перечитался — та же строка с новым счётом; диалог открыт, причина на месте.
    rerenderWith(shortageLine({ countedQty: 49, diff: -1 }));
    const dialog = screen.getByRole("dialog");
    expect(screen.getByLabelText(/Причина/)).toHaveValue("2 шт списаны в 2024");
    // В диалоге — уже новое расхождение.
    expect(within(dialog).getByText("−1")).toBeInTheDocument();
  });
});

describe("DiscrepancyRow — учёт изменился после счёта", () => {
  it("показывает, что изменилось, и «Обновить ожидание» пересобирает снапшот", async () => {
    const refreshed = surplusLine({
      expected: { total: 10, issued: 0, calendar: 0, repair: 0, lost: 0, expected: 10 },
      countedQty: 10,
      diff: 0,
    });
    apiFetch.mockResolvedValue({ line: refreshed });
    const { onLineChange, onChanged } = renderRow(BOOKS_CHANGED);

    expect(
      screen.getByText("учёт изменился после счёта: на съёмках 4 → 0 (ожидание 6 → 10)"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Обновить ожидание" }));
    await waitFor(() => expect(onLineChange).toHaveBeenCalledWith(refreshed));
    expect(apiFetch).toHaveBeenCalledWith(
      "/api/stock-counts/sc-1/lines/line-2/refresh-expected",
      expect.objectContaining({ method: "POST" }),
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it("«Оставить как посчитано» — следующая «Ошибка учёта» уходит с подтверждением", async () => {
    apiFetch.mockResolvedValue({ line: { ...BOOKS_CHANGED, decision: "ADJUST", booksAcknowledged: true } });
    renderRow(BOOKS_CHANGED);

    fireEvent.click(screen.getByRole("button", { name: "Оставить как посчитано" }));
    expect(screen.getByText(/оставлено как посчитано/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Ошибка учёта" }));
    fireEvent.change(await screen.findByLabelText(/Причина/), { target: { value: "не завели при покупке" } });
    fireEvent.click(screen.getByRole("button", { name: "Поправить учёт" }));

    await waitFor(() => expect(bodyOf("/decision")).not.toBeNull());
    expect(bodyOf("/decision")).toEqual({
      decision: "ADJUST",
      note: "не завели при покупке",
      seenCountedQty: 10,
      seenExpectedQty: 6,
      acknowledgeBooksChanged: true,
    });
  });

  it("решение уже есть — «Оставить как посчитано» подтверждает его сразу, с той же бронью", async () => {
    const lost = shortageLine({
      decision: "LOST",
      decidedBy: "sechenoff",
      sourceBookingId: "b-1",
      sourceBooking: { id: "b-1", projectName: "Северный ветер", clientName: "Студия «Норд»" },
      live: { total: 50, issued: 0, calendar: 0, repair: 1, lost: 0, expected: 49 },
      booksChangedSinceCount: true,
    });
    apiFetch.mockResolvedValue({ line: { ...lost, booksAcknowledged: true } });
    renderRow(lost);

    fireEvent.click(screen.getByRole("button", { name: "Оставить как посчитано" }));
    await waitFor(() => expect(bodyOf("/decision")).not.toBeNull());
    expect(bodyOf("/decision")).toEqual({
      decision: "LOST",
      note: null,
      sourceBookingId: "b-1",
      seenCountedQty: 47,
      seenExpectedQty: 50,
      acknowledgeBooksChanged: true,
    });
  });

  it("без подтверждения сервер отвечает 409 LINE_BOOKS_CHANGED — объяснение и перечитывание", async () => {
    apiFetch.mockRejectedValue(apiError(409, "LINE_BOOKS_CHANGED", "Учёт изменился", {}));
    const { onStale } = renderRow(
      shortageLine({
        live: { total: 50, issued: 0, calendar: 0, repair: 1, lost: 0, expected: 49 },
        booksChangedSinceCount: true,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Пропало → потеряшки" }));
    await waitFor(() => expect(onStale).toHaveBeenCalled());
    expect(bodyOf("/decision")).not.toHaveProperty("acknowledgeBooksChanged");
    expect(toastError).toHaveBeenCalledWith(
      "Учёт позиции изменился после счёта — обновите ожидание или оставьте как посчитано",
    );
  });
});

describe("DiscrepancyRow — «Ошибка учёта» от текущего количества", () => {
  it("количество поменяли после счёта: обещание — от живого учёта, как применит сервер", async () => {
    const line = shortageLine({
      expected: { total: 10, issued: 0, calendar: 0, repair: 0, lost: 0, expected: 10 },
      countedQty: 8,
      diff: -2,
      decision: "ADJUST",
      decisionNote: "пересорт",
      decidedBy: "sechenoff",
      live: { total: 12, issued: 0, calendar: 0, repair: 0, lost: 0, expected: 12 },
      booksChangedSinceCount: true,
      booksAcknowledged: true,
    });
    renderRow(line);
    expect(screen.getByText("учёт поправится с 12 до 10")).toBeInTheDocument();
    expect(screen.getByText(/оставлено как посчитано/)).toBeInTheDocument();
  });

  it("излишек при броне на съёмке: пояснение со снапшота и предупреждение в диалоге", async () => {
    renderRow(
      surplusLine({
        expected: { total: 10, issued: 4, calendar: 0, repair: 0, lost: 0, expected: 6 },
        countedQty: 10,
        diff: 4,
      }),
    );
    expect(
      screen.getByText("при счёте на съёмках 4 · открытых потеряшек по позиции нет — учёт поправится с 10 до 14"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Ошибка учёта" }));
    expect(await screen.findByText("Излишек может быть бронью, не отмеченной возвращённой")).toBeInTheDocument();
  });

  it("недостача: починенное за неделю — отдельной строкой", () => {
    renderRow(shortageLine({ readyForPickupQty: 2 }));
    expect(screen.getByText("2 починено за неделю — может лежать на верстаке")).toBeInTheDocument();
  });
});
