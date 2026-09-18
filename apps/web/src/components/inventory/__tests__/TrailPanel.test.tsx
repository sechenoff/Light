/**
 * «Как пропало»: как принимали каждую бронь (киоск / вручную / автоматически /
 * ещё у клиента / срок вышел / вернули после счёта), честный вердикт и привязка
 * «Пропало» к брони — по умолчанию к подсказке сервера (единственная бронь без
 * пересчёта), но только если эту подсказку руководитель уже видел: в строке
 * (общий запрос «Итога») или в раскрытом следе. Сама строка след не грузит.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { TrailPanel, repairVerdict, trailVerdict } from "../TrailPanel";
import type { StockCountLineView, TrailSuggestion } from "../types";
import { makeTrail, makeTrailBooking, shortageLine } from "./fixtures";

beforeEach(() => {
  vi.clearAllMocks();
});

function renderTrail(trail = makeTrail(), bind = { editable: true, value: "", onChange: vi.fn() }) {
  return render(
    <TrailPanel trail={trail} loading={false} error={null} onRetry={vi.fn()} qty={3} name="Удлинитель PCE (15м)" bind={bind} />,
  );
}

describe("TrailPanel — как принимали", () => {
  it("режимы приёмки и отметки пересчёта — русскими словами", () => {
    renderTrail();
    expect(screen.getByText("Как пропало: 3 шт · Удлинитель PCE (15м)")).toBeInTheDocument();
    expect(screen.getByText(/прошлой инвентаризации не было — смотрим 60 дней · 4 брони с этой позицией/)).toBeInTheDocument();

    const row = (project: string) => screen.getByText(`«${project}»`).closest("li")!;
    expect(within(row("Северный ветер")).getByText("возврат отмечен вручную")).toBeInTheDocument();
    expect(within(row("Северный ветер")).getByText("без пересчёта")).toBeInTheDocument();
    expect(within(row("Сериал «Тихий дом»")).getByText("отмечен автоматически")).toBeInTheDocument();
    expect(within(row("Реклама «Полёт»")).getByText("принято в киоске · Иван")).toBeInTheDocument();
    expect(within(row("Реклама «Полёт»")).getByText("без замечаний")).toBeInTheDocument();
    expect(within(row("Клип «Лето»")).getByText("ещё у клиента")).toBeInTheDocument();
    expect(within(row("Реклама «Полёт»")).getByText("5–8 сен")).toBeInTheDocument();
  });

  it("подтверждённая бронь с вышедшим сроком и замечания киоска", () => {
    renderTrail(
      makeTrail({
        totalBookings: 2,
        verifiedReturns: 1,
        bookings: [
          makeTrailBooking({ bookingId: "b-c", projectName: "Река", status: "CONFIRMED", returnMode: "MANUAL", returnedBy: null }),
          makeTrailBooking({
            bookingId: "b-k",
            projectName: "Полёт",
            returnMode: "KIOSK",
            returnedBy: "Олег",
            remarks: { problemQty: 2, repairQty: 1 },
          }),
        ],
      }),
    );
    expect(screen.getByText("срок вышел, возврат не отмечен")).toBeInTheDocument();
    expect(screen.getByText("замечания: 2 в потеряшки, 1 в ремонт")).toBeInTheDocument();
  });

  it("вердикт: одна бронь с пересчётом из трёх вернувшихся, точнее не сказать", () => {
    const v = trailVerdict(makeTrail(), 3);
    expect(v.lead).toBe("С пересчётом принята 1 бронь из 3 (5–8 сен, без замечаний).");
    expect(v.rest).toBe(
      " Остальные 2 закрыты отметкой статуса — никто не считал. 3 шт ушли в одной из них или потерялись на складе; точнее по данным не сказать.",
    );
    renderTrail();
    expect(screen.getByText(v.lead)).toBeInTheDocument();
    expect(screen.getByText(/Чтобы в следующий раз знать точно/)).toBeInTheDocument();
  });

  it("больше пяти броней — «ещё N» раскрывает остальные", () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      makeTrailBooking({ bookingId: `b-${i}`, projectName: `Проект ${i + 1}` }),
    );
    renderTrail(makeTrail({ bookings: many, totalBookings: 7, verifiedReturns: 0 }));
    expect(screen.queryByText("«Проект 6»")).not.toBeInTheDocument();
    expect(screen.getByText(/ещё 2 брони — все без пересчёта на приёмке/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "показать" }));
    expect(screen.getByText("«Проект 7»")).toBeInTheDocument();
  });
});

describe("DiscrepancyRow — привязка «Пропало» к брони", () => {
  const SUGGESTED = makeTrail({
    totalBookings: 2,
    verifiedReturns: 1,
    suggestedBookingId: "b-1",
    bookings: [
      makeTrailBooking(),
      makeTrailBooking({ bookingId: "b-3", projectName: "Полёт", returnMode: "KIOSK", returnedBy: "Иван", remarks: { problemQty: 0, repairQty: 0 } }),
    ],
  });
  /** Подсказка из общего запроса «Итога» — та же бронь b-1. */
  const SUGGESTION: TrailSuggestion = {
    bookingId: "b-1",
    projectName: "Северный ветер",
    clientName: "Студия «Норд»",
    quantity: 25,
    startDate: "2026-09-14T07:00:00.000Z",
    endDate: "2026-09-16T07:00:00.000Z",
  };
  const SEEN = { seenCountedQty: 47, seenExpectedQty: 50 };

  function renderRow(opts: { line?: StockCountLineView; suggestion?: TrailSuggestion | null } = {}) {
    const onLineChange = vi.fn();
    render(
      <ul>
        <DiscrepancyRow
          stockCountId="sc-1"
          line={opts.line ?? shortageLine()}
          status="OPEN"
          suggestion={opts.suggestion ?? null}
          onLineChange={onLineChange}
          onRecount={vi.fn()}
          onChanged={vi.fn()}
          onStale={vi.fn()}
        />
      </ul>,
    );
    return onLineChange;
  }

  function decisionBody() {
    const call = apiFetch.mock.calls.find(([path]) => String(path).endsWith("/decision"));
    return call ? JSON.parse(String(call[1].body)) : null;
  }

  function trailCalls() {
    return apiFetch.mock.calls.filter(([path]) => String(path).endsWith("/trail"));
  }

  it("раскрытый след предвыбирает подсказанную бронь, «Пропало» уходит с ней", async () => {
    apiFetch.mockImplementation((path: string) =>
      String(path).endsWith("/trail")
        ? Promise.resolve({ trail: SUGGESTED })
        : Promise.resolve({ line: shortageLine({ decision: "LOST", sourceBookingId: "b-1" }) }),
    );
    const onLineChange = renderRow();

    fireEvent.click(screen.getByRole("button", { name: /Как пропало/ }));
    const select = (await screen.findByLabelText("Если в потеряшки — привязать к брони:")) as HTMLSelectElement;
    expect(apiFetch).toHaveBeenCalledWith("/api/stock-counts/sc-1/lines/line-1/trail", undefined);
    expect(select.value).toBe("b-1");
    expect(screen.getByText(/вероятнее всего, 3 шт ушли с ней/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Пропало → потеряшки" }));
    await waitFor(() => expect(onLineChange).toHaveBeenCalled());
    expect(decisionBody()).toEqual({ decision: "LOST", sourceBookingId: "b-1", ...SEEN });
  });

  it("«не определено» — «Пропало» без брони", async () => {
    apiFetch.mockImplementation((path: string) =>
      String(path).endsWith("/trail")
        ? Promise.resolve({ trail: SUGGESTED })
        : Promise.resolve({ line: shortageLine({ decision: "LOST" }) }),
    );
    const onLineChange = renderRow({ suggestion: SUGGESTION });

    fireEvent.click(screen.getByRole("button", { name: /Как пропало/ }));
    const select = await screen.findByLabelText("Если в потеряшки — привязать к брони:");
    fireEvent.change(select, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Пропало → потеряшки" }));

    await waitFor(() => expect(onLineChange).toHaveBeenCalled());
    expect(decisionBody()).toEqual({ decision: "LOST", sourceBookingId: null, ...SEEN });
  });

  it("общая подсказка видна в строке до решения — «Пропало» уходит с ней, след не грузится", async () => {
    apiFetch.mockImplementation(() => Promise.resolve({ line: shortageLine({ decision: "LOST", sourceBookingId: "b-1" }) }));
    const onLineChange = renderRow({ suggestion: SUGGESTION });

    expect(
      screen.getByText("вероятно — «Северный ветер» (25 шт, 14–16 сен): единственная бронь, принятая без пересчёта"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Пропало → потеряшки" }));
    await waitFor(() => expect(onLineChange).toHaveBeenCalled());
    expect(decisionBody()).toEqual({ decision: "LOST", sourceBookingId: "b-1", ...SEEN });
    expect(trailCalls()).toHaveLength(0);
  });

  it("подсказки нет — «Пропало» без брони, в строке прежняя разбивка, след сам не грузится", async () => {
    apiFetch.mockImplementation(() => Promise.resolve({ line: shortageLine({ decision: "LOST" }) }));
    const onLineChange = renderRow();

    await act(async () => {
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    expect(screen.getByText("по учёту 50")).toBeInTheDocument();
    expect(screen.queryByText(/вероятно — «/)).not.toBeInTheDocument();
    expect(trailCalls()).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Пропало → потеряшки" }));
    await waitFor(() => expect(onLineChange).toHaveBeenCalled());
    expect(decisionBody()).toEqual({ decision: "LOST", sourceBookingId: null, ...SEEN });
  });

  it("раскрытый след авторитетнее общей подсказки: подсказки в нём не видно — строка её не обещает", async () => {
    apiFetch.mockImplementation((path: string) =>
      String(path).endsWith("/trail")
        ? Promise.resolve({ trail: { ...SUGGESTED, suggestedBookingId: "b-old" } })
        : Promise.resolve({ line: shortageLine({ decision: "LOST" }) }),
    );
    const onLineChange = renderRow({ suggestion: SUGGESTION });
    expect(screen.getByText(/вероятно — «Северный ветер»/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Как пропало/ }));
    await screen.findByLabelText("Если в потеряшки — привязать к брони:");
    expect(screen.queryByText(/вероятно — «/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Пропало → потеряшки" }));
    await waitFor(() => expect(onLineChange).toHaveBeenCalled());
    expect(decisionBody()).toEqual({ decision: "LOST", sourceBookingId: null, ...SEEN });
  });

  it("«Пропало» уже записано без брони — в следе выбрано «не определено», а не подсказка", async () => {
    apiFetch.mockImplementation((path: string) =>
      String(path).endsWith("/trail") ? Promise.resolve({ trail: SUGGESTED }) : Promise.reject(new Error(path)),
    );
    renderRow({
      line: shortageLine({ decision: "LOST", sourceBookingId: null, decidedBy: "sechenoff" }),
      suggestion: SUGGESTION,
    });
    expect(screen.getByText(/бронь не определена/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Как пропало/ }));
    const select = (await screen.findByLabelText("Если в потеряшки — привязать к брони:")) as HTMLSelectElement;
    expect(select.value).toBe("");
  });

  it("уже в потеряшках — это остаётся в строке рядом с подсказкой", () => {
    const lost = { ...shortageLine(), expected: { total: 50, issued: 0, calendar: 0, repair: 0, lost: 2, expected: 48 } };
    renderRow({ line: lost, suggestion: SUGGESTION });
    expect(screen.getByText(/вероятно — «Северный ветер»/)).toBeInTheDocument();
    expect(screen.getByText("уже 2 в потеряшках — эти 3 пропали сверху")).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe("TrailPanel — мастерская в окне", () => {
  it("списанное и починенное — в вердикте вместо подсказки брони", () => {
    const trail = makeTrail({
      totalBookings: 1,
      verifiedReturns: 0,
      bookings: [makeTrailBooking()],
      suggestedBookingId: null,
      repairEvents: { writtenOffQty: 2, readyForPickupQty: 1 },
    });
    const v = trailVerdict(trail, 3);
    expect(v.rest).toBe(
      " За это время в мастерской списали 2 шт и починили 1 шт — починенное может лежать на верстаке; если списанное не вычтено из учёта, это «Ошибка учёта».",
    );
    expect(repairVerdict({ repairEvents: { writtenOffQty: 0, readyForPickupQty: 0 } })).toBeNull();
  });

  it("бронь, принятая после счёта, — «вернули после счёта», не кандидат", () => {
    renderTrail(
      makeTrail({
        totalBookings: 1,
        verifiedReturns: 0,
        bookings: [makeTrailBooking({ returnMode: "OUT", status: "RETURNED", returnedBy: null })],
      }),
    );
    expect(screen.getByText("вернули после счёта")).toBeInTheDocument();
    expect(screen.getByText("на съёмке")).toBeInTheDocument();
  });
});
