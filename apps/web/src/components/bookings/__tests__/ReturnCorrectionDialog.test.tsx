/**
 * «Часть не вернули» (мокап m4, состояние D): строки «не вернули N» с
 * потолком, срок, «Создать продолжение»; инвентаризация — кнопка серая.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("../../ToastProvider", () => ({ toast: toastMock }));

import { ReturnCorrectionDialog, capNoteOf, correctionOffered, type CorrectionPlan } from "../ReturnCorrectionDialog";

const HOUR = 3_600_000;
const at = (h: number) => new Date(Date.now() + h * HOUR).toISOString();

function plan(over: Partial<CorrectionPlan> = {}): CorrectionPlan {
  return {
    bookingId: "b1",
    docNumber: "СМ-2026-0239",
    splitRevision: 2,
    returnedAt: at(-3),
    correctableUntil: at(-3 + 7 * 24),
    blockedBy: null,
    lines: [
      {
        bookingItemId: "i-cable",
        equipmentId: "e1",
        name: "Кабель силовой 25 м",
        quantity: 3,
        unitTracked: false,
        units: [],
        paidThrough: at(-5),
        plannedStayUntil: null,
        booked: 4,
        inContinuations: 0,
        inRepair: 0,
        inProblems: 1,
      },
    ],
    ...over,
  };
}

const open = (onDone = vi.fn(), onClose = vi.fn()) =>
  render(<ReturnCorrectionDialog open bookingId="b1" docNumber="СМ-2026-0239" onClose={onClose} onDone={onDone} />);

beforeEach(() => {
  apiFetchMock.mockReset();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
});

describe("правила окна", () => {
  it("пункт меню — пока исправить можно или ждём инвентаризацию", () => {
    expect(correctionOffered(plan())).toBe(true);
    expect(correctionOffered(plan({ blockedBy: "STOCK_COUNT_OPEN" }))).toBe(true);
    expect(correctionOffered(plan({ blockedBy: "WINDOW_CLOSED" }))).toBe(false);
    expect(correctionOffered(plan({ lines: [] }))).toBe(false);
    expect(correctionOffered(null)).toBe(false);
  });

  it("почему не больше — как в мокапе", () => {
    expect(capNoteOf(plan().lines[0])).toBe("Не больше 3: было 4, одна уже в «Потеряшках».");
    expect(capNoteOf({ ...plan().lines[0], quantity: 4, inProblems: 0 })).toBeNull();
  });
});

describe("окно «Часть не вернули»", () => {
  it("«не вернули 2» на «+2 смены» — превью доплаты и «Создать продолжение»", async () => {
    const p = plan();
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/return-correction")) return p;
      if (url.endsWith("/return-correction/preview")) {
        return {
          conflicts: [],
          continuations: [
            {
              until: at(48),
              docNumber: "СМ-2026-0239-1",
              expectedPaymentDate: null,
              lines: [{ bookingItemId: "i-cable", name: "Кабель силовой 25 м", quantity: 2, billedShifts: 3, lineSum: "1200.00", afterDiscount: "600.00", negotiated: false }],
              discountPercent: "50.00",
              subtotal: "1200.00",
              discountAmount: "600.00",
              surchargeAmount: "0.00",
              total: "600.00",
            },
          ],
        };
      }
      return { continuationIds: ["c1"] };
    });
    const onDone = vi.fn();
    const onClose = vi.fn();
    open(onDone, onClose);
    expect(await screen.findByText(/исправить можно до/)).toBeInTheDocument();
    expect(screen.getByText("Не больше 3: было 4, одна уже в «Потеряшках».")).toBeInTheDocument();
    const line = screen.getByTestId("return-line");
    expect(line).toHaveTextContent("не вернули");
    fireEvent.click(within(line).getByRole("button", { name: "Больше: Кабель силовой 25 м" }));
    fireEvent.click(within(line).getByRole("button", { name: "Больше: Кабель силовой 25 м" }));
    fireEvent.click(within(line).getAllByRole("radio")[1]);
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/api/bookings/b1/return-correction/preview", expect.anything()),
    );
    await waitFor(() => expect(line).toHaveTextContent("2 шт × 3 смены → 600 ₽ со скидкой"));
    expect(screen.getByText(/Создастся продолжение СМ-2026-0239-1 с/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Создать продолжение" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const [, init] = apiFetchMock.mock.calls.find(
      ([url, opts]) => url === "/api/bookings/b1/return-correction" && (opts as { method?: string } | undefined)?.method === "POST",
    ) as [string, { method: string; body: string }];
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ expectedSplitRevision: 2, stays: [{ bookingItemId: "i-cable", quantity: 2 }] });
    expect(onClose).toHaveBeenCalled();
  });

  it("идёт инвентаризация — кнопка серая и объясняет почему", async () => {
    apiFetchMock.mockResolvedValue(plan({ blockedBy: "STOCK_COUNT_OPEN" }));
    open();
    const line = await screen.findByTestId("return-line");
    fireEvent.click(within(line).getByRole("button", { name: "Больше: Кабель силовой 25 м" }));
    expect(screen.getByText("Исправить после завершения инвентаризации")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Создать продолжение" })).toBeDisabled();
  });

  it("свободная, но зарезервированная единица — объяснение с названием брони", () => {
    const line = {
      ...plan().lines[0],
      unitTracked: true,
      quantity: 1,
      booked: 2,
      inProblems: 0,
      units: [{ id: "u1", label: "C-1" }],
      reservedUnits: [{ id: "u2", label: "C-2", reservedFor: "Сериал «Маяк»" }],
    };
    expect(capNoteOf(line)).toBe("Не больше 1: было 2, одна зарезервирована за «Сериал «Маяк»» — сначала снимите резерв там.");
  });

  it("срок исправления прошёл (устаревшая карточка) — кнопка серая, объяснение внизу, без «отметить нечего»", async () => {
    apiFetchMock.mockResolvedValue(plan({ blockedBy: "WINDOW_CLOSED", lines: [] }));
    open();
    expect(await screen.findByText("Исправить приёмку можно в течение 7 дней — срок прошёл")).toBeInTheDocument();
    expect(screen.queryByText(/Отметить нечего/)).toBeNull();
    expect(screen.getByRole("button", { name: "Создать продолжение" })).toBeDisabled();
  });

  it("приняли давно — чипы «+N смен» от приёмки, «+N» выставит ровно N смен", async () => {
    const p = plan({
      returnedAt: at(-5 * 24 - 2),
      lines: [{ ...plan().lines[0], paidThrough: at(-6 * 24), billingAnchor: at(-5 * 24 - 2) }],
    });
    apiFetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/return-correction") ? p : { continuations: [], conflicts: [] },
    );
    open();
    const line = await screen.findByTestId("return-line");
    fireEvent.click(within(line).getByRole("button", { name: "Больше: Кабель силовой 25 м" }));
    const chips = within(line).getAllByRole("radio");
    expect(chips.map((c) => c.textContent)).toEqual(["+6 смен", "+7 смен", "+8 смен", "дата…"]);
    expect(chips[0]).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "Создать продолжение" }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/api/bookings/b1/return-correction", expect.objectContaining({ method: "POST" })),
    );
    const [, init] = apiFetchMock.mock.calls.find(
      ([url, opts]) => url === "/api/bookings/b1/return-correction" && (opts as { method?: string } | undefined)?.method === "POST",
    ) as [string, { body: string }];
    const sent = JSON.parse(init.body).stays[0];
    expect(Date.parse(sent.until) - Date.parse(p.lines[0].billingAnchor!)).toBe(6 * 24 * HOUR);
  });

  it("409 «нужна другой брони» — превью пересчитано, окно открыто", async () => {
    const p = plan({ lines: [{ ...plan().lines[0], billingAnchor: at(-3) }] });
    let calls = 0;
    apiFetchMock.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url.endsWith("/return-correction") && opts?.method !== "POST") return p;
      if (url.endsWith("/preview")) {
        calls += 1;
        return { continuations: [], conflicts: [] };
      }
      throw Object.assign(new Error("Позиция «Кабель силовой 25 м» нужна брони «Клип»"), { code: "CONTINUATION_CONFLICT", status: 409 });
    });
    const onClose = vi.fn();
    open(vi.fn(), onClose);
    const line = await screen.findByTestId("return-line");
    fireEvent.click(within(line).getByRole("button", { name: "Больше: Кабель силовой 25 м" }));
    await waitFor(() => expect(calls).toBe(1));
    await new Promise((r) => setTimeout(r, 20));
    fireEvent.click(screen.getByRole("button", { name: "Создать продолжение" }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(expect.stringMatching(/нужна брони/)));
    await waitFor(() => expect(calls).toBe(2));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ничего не отмечено — создавать нечего", async () => {
    apiFetchMock.mockResolvedValue(plan());
    open();
    await screen.findByTestId("return-line");
    expect(screen.getByRole("button", { name: "Создать продолжение" })).toBeDisabled();
  });
});
