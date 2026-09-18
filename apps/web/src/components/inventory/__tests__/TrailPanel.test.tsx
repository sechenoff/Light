/**
 * «Как пропало»: как принимали каждую бронь (киоск / вручную / автоматически /
 * ещё у клиента / срок вышел), честный вердикт и привязка «Пропало» к брони —
 * по умолчанию к подсказке сервера (единственная бронь без пересчёта), но
 * только если эту подсказку руководитель уже видел: в строке или в следе.
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
import { TrailPanel, trailVerdict } from "../TrailPanel";
import { apiError, makeTrail, makeTrailBooking, shortageLine } from "./fixtures";

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

  function renderRow() {
    const onLineChange = vi.fn();
    render(
      <ul>
        <DiscrepancyRow
          stockCountId="sc-1"
          line={shortageLine()}
          status="OPEN"
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
    expect(decisionBody()).toEqual({ decision: "LOST", sourceBookingId: "b-1" });
  });

  it("«не определено» — «Пропало» без брони", async () => {
    apiFetch.mockImplementation((path: string) =>
      String(path).endsWith("/trail")
        ? Promise.resolve({ trail: SUGGESTED })
        : Promise.resolve({ line: shortageLine({ decision: "LOST" }) }),
    );
    const onLineChange = renderRow();

    fireEvent.click(screen.getByRole("button", { name: /Как пропало/ }));
    const select = await screen.findByLabelText("Если в потеряшки — привязать к брони:");
    fireEvent.change(select, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Пропало → потеряшки" }));

    await waitFor(() => expect(onLineChange).toHaveBeenCalled());
    expect(decisionBody()).toEqual({ decision: "LOST", sourceBookingId: null });
  });

  it("подсказка видна в строке до решения — «Пропало» уходит с той бронью, которую показали", async () => {
    apiFetch.mockImplementation((path: string) =>
      String(path).endsWith("/trail")
        ? Promise.resolve({ trail: SUGGESTED })
        : Promise.resolve({ line: shortageLine({ decision: "LOST", sourceBookingId: "b-1" }) }),
    );
    const onLineChange = renderRow();

    // До любого клика: след подгрузился сам, подсказка — прямо в строке.
    expect(
      await screen.findByText(
        "вероятно — «Северный ветер» (25 шт, 14–16 сен): единственная бронь, принятая без пересчёта",
      ),
    ).toBeInTheDocument();
    expect(apiFetch.mock.calls.some(([path]) => String(path).endsWith("/decision"))).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Пропало → потеряшки" }));
    await waitFor(() => expect(onLineChange).toHaveBeenCalled());
    expect(decisionBody()).toEqual({ decision: "LOST", sourceBookingId: "b-1" });
  });

  it("след не загрузился — «Пропало» без брони, в строке прежняя разбивка и без красной ошибки", async () => {
    apiFetch.mockImplementation((path: string) =>
      String(path).endsWith("/trail")
        ? Promise.reject(apiError(500, "INTERNAL", "Request failed 500"))
        : Promise.resolve({ line: shortageLine({ decision: "LOST" }) }),
    );
    const onLineChange = renderRow();

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/stock-counts/sc-1/lines/line-1/trail", undefined));
    await act(async () => {
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    expect(screen.getByText("по учёту 50")).toBeInTheDocument();
    expect(screen.queryByText(/вероятно — «/)).not.toBeInTheDocument();
    expect(screen.queryByText("Не удалось собрать брони с этой позицией")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Пропало → потеряшки" }));
    await waitFor(() => expect(onLineChange).toHaveBeenCalled());
    expect(decisionBody()).toEqual({ decision: "LOST", sourceBookingId: null });
  });

  it("подсказка вне загруженного окна следа — в строке её нет, и «Пропало» её не привязывает", async () => {
    apiFetch.mockImplementation((path: string) =>
      String(path).endsWith("/trail")
        ? Promise.resolve({ trail: { ...SUGGESTED, suggestedBookingId: "b-old" } })
        : Promise.resolve({ line: shortageLine({ decision: "LOST" }) }),
    );
    const onLineChange = renderRow();

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/stock-counts/sc-1/lines/line-1/trail", undefined));
    await act(async () => {
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    expect(screen.queryByText(/вероятно — «/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Пропало → потеряшки" }));
    await waitFor(() => expect(onLineChange).toHaveBeenCalled());
    expect(decisionBody()).toEqual({ decision: "LOST", sourceBookingId: null });
  });

  it("«Пропало» уже записано без брони — в следе выбрано «не определено», а не подсказка", async () => {
    apiFetch.mockImplementation((path: string) =>
      String(path).endsWith("/trail") ? Promise.resolve({ trail: SUGGESTED }) : Promise.reject(new Error(path)),
    );
    render(
      <ul>
        <DiscrepancyRow
          stockCountId="sc-1"
          line={shortageLine({ decision: "LOST", sourceBookingId: null, decidedBy: "sechenoff" })}
          status="OPEN"
          onLineChange={vi.fn()}
          onRecount={vi.fn()}
          onChanged={vi.fn()}
          onStale={vi.fn()}
        />
      </ul>,
    );
    expect(screen.getByText(/бронь не определена/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Как пропало/ }));
    const select = (await screen.findByLabelText("Если в потеряшки — привязать к брони:")) as HTMLSelectElement;
    expect(select.value).toBe("");
  });

  it("у строки с решением след сам не грузится; уже в потеряшках — это остаётся в строке рядом с подсказкой", async () => {
    apiFetch.mockImplementation((path: string) =>
      String(path).endsWith("/trail") ? Promise.resolve({ trail: SUGGESTED }) : Promise.reject(new Error(path)),
    );
    const { rerender } = render(
      <ul>
        <DiscrepancyRow
          stockCountId="sc-1"
          line={shortageLine({ decision: "ADJUST", decisionNote: "ошибка", decidedBy: "sechenoff" })}
          status="OPEN"
          onLineChange={vi.fn()}
          onRecount={vi.fn()}
          onChanged={vi.fn()}
          onStale={vi.fn()}
        />
      </ul>,
    );
    await act(async () => {
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    expect(apiFetch).not.toHaveBeenCalled();

    // Решение сняли (пересчёт) — строка ждёт решения, след подгружается.
    const lost = { ...shortageLine(), expected: { total: 50, issued: 0, calendar: 0, repair: 0, lost: 2, expected: 48 } };
    rerender(
      <ul>
        <DiscrepancyRow
          stockCountId="sc-1"
          line={lost}
          status="OPEN"
          onLineChange={vi.fn()}
          onRecount={vi.fn()}
          onChanged={vi.fn()}
          onStale={vi.fn()}
        />
      </ul>,
    );
    expect(await screen.findByText(/вероятно — «Северный ветер»/)).toBeInTheDocument();
    expect(screen.getByText("уже 2 в потеряшках — эти 3 пропали сверху")).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });
});
