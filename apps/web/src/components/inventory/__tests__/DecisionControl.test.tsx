/**
 * Решения по расхождению: доступность из `allowedDecisions` (сервер решает,
 * клиент не прячет — блокирует и объясняет) и обязательная причина
 * «Ошибки учёта» (≥ 3 символов после обрезки), в том числе полный путь
 * строки итога до POST /decision.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("../../ToastProvider", () => ({
  toast: {
    success: (m: string) => toastSuccess(m),
    error: (m: string) => toastError(m),
    info: vi.fn(),
  },
}));

const apiFetch = vi.fn();
vi.mock("../../../lib/api", () => ({
  apiFetch: (path: string, init?: RequestInit) => apiFetch(path, init),
}));

import { AdjustReasonDialog } from "../AdjustReasonDialog";
import { DecisionControl } from "../DecisionControl";
import { DiscrepancyRow } from "../DiscrepancyRow";
import { makeTrail, shortageLine, surplusLine } from "./fixtures";

beforeEach(() => {
  vi.clearAllMocks();
});

function button(name: RegExp | string) {
  return screen.getByRole("button", { name });
}

function decisionCalls() {
  return apiFetch.mock.calls.filter(([path]) => String(path).endsWith("/decision"));
}

describe("DecisionControl — доступность решений", () => {
  it("недостача: «Пропало → потеряшки», «Ошибка учёта», «Пересчитать» — все доступны", () => {
    const onSelect = vi.fn();
    render(<DecisionControl line={shortageLine()} readOnly={false} busy={false} onSelect={onSelect} />);

    for (const name of ["Пропало → потеряшки", "Ошибка учёта", "Пересчитать"]) {
      expect(button(name)).not.toHaveAttribute("aria-disabled");
    }
    expect(screen.queryByText(/недоступно/)).not.toBeInTheDocument();

    fireEvent.click(button("Пропало → потеряшки"));
    expect(onSelect).toHaveBeenCalledWith("LOST");
  });

  it("излишек без открытых потеряшек: «Нашлось» заблокировано, причина видна текстом и в подсказке", () => {
    const onSelect = vi.fn();
    render(
      <DecisionControl line={surplusLine({ allowedDecisions: ["ADJUST"] })} readOnly={false} busy={false} onSelect={onSelect} />,
    );

    const found = button("Нашлось");
    expect(found).toHaveAttribute("aria-disabled", "true");
    expect(found).toHaveAttribute("title", expect.stringMatching(/нет открытых потеряшек/));
    // Видимый текст — для планшета, где подсказок нет.
    expect(screen.getByText(/«Нашлось» недоступно: нет открытых потеряшек/)).toBeVisible();

    fireEvent.click(found);
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(button("Ошибка учёта"));
    expect(onSelect).toHaveBeenCalledWith("ADJUST");
  });

  it("излишек с открытыми потеряшками: «Нашлось» доступно", () => {
    const onSelect = vi.fn();
    render(
      <DecisionControl
        line={surplusLine({ allowedDecisions: ["ADJUST", "FOUND"], openProblemQty: 2 })}
        readOnly={false}
        busy={false}
        onSelect={onSelect}
      />,
    );
    expect(button("Нашлось")).not.toHaveAttribute("aria-disabled");
    fireEvent.click(button("Нашлось"));
    expect(onSelect).toHaveBeenCalledWith("FOUND");
  });

  it("позиция ушла на штучный учёт: решения заблокированы одной причиной, «Пересчитать» — нет", () => {
    const onSelect = vi.fn();
    render(
      <DecisionControl
        line={shortageLine({ allowedDecisions: [], isUnitMode: true })}
        readOnly={false}
        busy={false}
        onSelect={onSelect}
      />,
    );
    expect(button("Пропало → потеряшки")).toHaveAttribute("aria-disabled", "true");
    expect(button("Ошибка учёта")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getAllByText(/штучном учёте/)).toHaveLength(1);

    fireEvent.click(button("Пересчитать"));
    expect(onSelect).toHaveBeenCalledWith("RESET");
  });

  it("принятое решение залито и нажато; решение с неподходящим знаком считается отсутствующим", () => {
    const { rerender } = render(
      <DecisionControl line={shortageLine({ decision: "LOST" })} readOnly={false} busy={false} onSelect={vi.fn()} />,
    );
    expect(button("Пропало → потеряшки")).toHaveAttribute("aria-pressed", "true");
    expect(button("Пропало → потеряшки").className).toMatch(/bg-rose/);
    expect(button("Пропало → потеряшки").className).toMatch(/text-surface/);

    // После пересчёта строка ушла в излишек — «Пропало» больше не применится.
    rerender(
      <DecisionControl line={surplusLine({ decision: "LOST" })} readOnly={false} busy={false} onSelect={vi.fn()} />,
    );
    expect(button("Нашлось")).toHaveAttribute("aria-pressed", "false");
    expect(button("Ошибка учёта")).toHaveAttribute("aria-pressed", "false");
  });

  it("завершённая инвентаризация: всё только на чтение, без объяснений недоступности", () => {
    const onSelect = vi.fn();
    render(
      <DecisionControl
        line={shortageLine({ decision: "ADJUST", allowedDecisions: [] })}
        readOnly
        busy={false}
        onSelect={onSelect}
      />,
    );
    expect(button("Ошибка учёта")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button("Пересчитать"));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByText(/недоступн/)).not.toBeInTheDocument();
  });
});

describe("AdjustReasonDialog — причина обязательна", () => {
  it("кнопка заблокирована, пока причина короче 3 символов после обрезки; отправляется обрезанный текст", () => {
    const onSubmit = vi.fn();
    render(<AdjustReasonDialog line={shortageLine()} busy={false} onClose={vi.fn()} onSubmit={onSubmit} />);

    const submit = button("Поправить учёт");
    const field = screen.getByLabelText(/Причина/);
    expect(submit).toBeDisabled();
    expect(screen.getByText("50 → 47")).toBeInTheDocument();

    fireEvent.change(field, { target: { value: "  аб  " } });
    expect(submit).toBeDisabled();

    fireEvent.change(field, { target: { value: "  по факту было 47  " } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith("по факту было 47");
  });
});

describe("DiscrepancyRow — «Ошибка учёта» доходит до сервера с причиной", () => {
  it("ADJUST спрашивает причину и шлёт POST /decision { decision: ADJUST, note }", async () => {
    const line = shortageLine();
    const decided = shortageLine({ decision: "ADJUST", decisionNote: "с импорта 50, по факту 47", decidedBy: "sechenoff" });
    // След по «Как пропало ▾» — сам по себе строка его не грузит.
    apiFetch.mockImplementation((path: string) =>
      String(path).endsWith("/trail") ? Promise.resolve({ trail: makeTrail() }) : Promise.resolve({ line: decided }),
    );
    const onLineChange = vi.fn();
    const onChanged = vi.fn();

    render(
      <ul>
        <DiscrepancyRow
          stockCountId="sc-1"
          line={line}
          status="OPEN"
          onLineChange={onLineChange}
          onRecount={vi.fn()}
          onChanged={onChanged}
          onStale={vi.fn()}
        />
      </ul>,
    );

    fireEvent.click(button("Ошибка учёта"));
    const dialog = await screen.findByRole("dialog", { name: line.name });
    expect(dialog).toBeInTheDocument();
    expect(decisionCalls()).toHaveLength(0);

    fireEvent.change(screen.getByLabelText(/Причина/), { target: { value: "с импорта 50, по факту 47" } });
    fireEvent.click(button("Поправить учёт"));

    await waitFor(() => expect(onLineChange).toHaveBeenCalledWith(decided));
    expect(decisionCalls()).toHaveLength(1);
    const [path, init] = decisionCalls()[0]!;
    expect(path).toBe("/api/stock-counts/sc-1/lines/line-1/decision");
    expect(init.method).toBe("POST");
    // С решением уходит то, что руководитель видел: счёт и «должно быть» строки.
    expect(JSON.parse(init.body)).toEqual({
      decision: "ADJUST",
      note: "с импорта 50, по факту 47",
      seenCountedQty: 47,
      seenExpectedQty: 50,
    });
    expect(onChanged).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("ошибка сервера (REASON_REQUIRED) — тост по-русски, диалог остаётся открытым", async () => {
    apiFetch.mockImplementation((path: string) =>
      String(path).endsWith("/trail")
        ? Promise.resolve({ trail: makeTrail() })
        : Promise.reject(Object.assign(new Error("Укажите причину"), { status: 400, code: "REASON_REQUIRED" })),
    );
    render(
      <ul>
        <DiscrepancyRow
          stockCountId="sc-1"
          line={shortageLine()}
          status="OPEN"
          onLineChange={vi.fn()}
          onRecount={vi.fn()}
          onChanged={vi.fn()}
          onStale={vi.fn()}
        />
      </ul>,
    );
    fireEvent.click(button("Ошибка учёта"));
    fireEvent.change(await screen.findByLabelText(/Причина/), { target: { value: "ошибка" } });
    fireEvent.click(button("Поправить учёт"));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Укажите причину поправки — не короче 3 символов"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
