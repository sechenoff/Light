/**
 * «Итог»: список расхождений не отстаёт от сервера, когда строку поменяли
 * не отсюда (киоск пересчитал — решение сброшено; решение сняли в другой
 * вкладке). Свои решения лишних перечитываний не вызывают, а стойкое
 * расхождение не зацикливает запросы.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ToastProvider", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const apiFetch = vi.fn();
vi.mock("../../../lib/api", () => ({
  apiFetch: (path: string, init?: RequestInit) => apiFetch(path, init),
}));

import { ReviewPanel } from "../ReviewPanel";
import type { StockCountDetail, StockCountLineView, StockCountTotals } from "../types";
import { makeDetail, makeTotals, makeTrail, shortageLine } from "./fixtures";

const DECIDED_AT = "2026-09-18T12:05:00.000Z";

let listLines: StockCountLineView[] = [];
let decisionReply: StockCountLineView | null = null;

function routeApi() {
  apiFetch.mockImplementation((path: string, init?: RequestInit) => {
    if (path.includes("/lines?filter=discrepancy")) return Promise.resolve({ lines: listLines });
    if (path.endsWith("/trail")) return Promise.resolve({ trail: makeTrail() });
    if (path.endsWith("/decision") && init?.method === "POST") return Promise.resolve({ line: decisionReply });
    return Promise.reject(new Error(`unexpected ${path}`));
  });
}

function listCalls() {
  return apiFetch.mock.calls.filter(([path]) => String(path).includes("/lines?filter=discrepancy"));
}

/** Одна недостача, остальное сошлось. Каждый вызов — новый объект, как у опроса. */
function detailWith(totals: Partial<StockCountTotals>): StockCountDetail {
  return makeDetail({
    isFirst: false,
    totals: makeTotals({
      lines: 4,
      counted: 1,
      matched: 0,
      shortagePositions: 1,
      shortageQty: 3,
      surplusPositions: 0,
      surplusQty: 0,
      undecided: 0,
      ...totals,
    }),
  });
}

function renderPanel(detail: StockCountDetail) {
  const props = { onChanged: vi.fn(), onStale: vi.fn(), onRecount: vi.fn(), onCompleted: vi.fn() };
  const utils = render(<ReviewPanel detail={detail} {...props} />);
  return {
    ...utils,
    rerenderWith: (next: StockCountDetail) => utils.rerender(<ReviewPanel detail={next} {...props} />),
  };
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

function lostButton() {
  return within(screen.getByTestId("discrepancy-line-1")).getByRole("button", { name: "Пропало → потеряшки" });
}

beforeEach(() => {
  vi.clearAllMocks();
  listLines = [];
  decisionReply = null;
  routeApi();
});

describe("ReviewPanel — список догоняет сервер", () => {
  it("киоск пересчитал строку (−2 → −3) и сервер снял «Пропало» — список перечитывается, строка снова без решения", async () => {
    listLines = [shortageLine({ countedQty: 48, diff: -2, decision: "LOST", decidedBy: "sechenoff", decidedAt: DECIDED_AT })];
    const { rerenderWith } = renderPanel(detailWith({ shortageQty: 2, undecided: 0 }));
    await screen.findByTestId("discrepancy-line-1");
    expect(lostButton()).toHaveAttribute("aria-pressed", "true");
    expect(listCalls()).toHaveLength(1);

    // Счёт, позиции и «посчитано» те же — меняются только количество и «без решения».
    listLines = [shortageLine({ countedQty: 47, diff: -3, decision: null })];
    rerenderWith(detailWith({ shortageQty: 3, undecided: 1 }));

    await waitFor(() => expect(listCalls()).toHaveLength(2));
    expect(await screen.findByRole("button", { name: "без решения · 1" })).toBeInTheDocument();
    expect(lostButton()).toHaveAttribute("aria-pressed", "false");
    expect(within(screen.getByTestId("discrepancy-line-1")).getByText("−3")).toBeInTheDocument();
  });

  it("решение сняли, а пересчитали в то же число — двигается только «без решения», и этого хватает", async () => {
    listLines = [
      shortageLine({ decision: "ADJUST", decisionNote: "ошибка", decidedBy: "sechenoff", decidedAt: DECIDED_AT }),
    ];
    const { rerenderWith } = renderPanel(detailWith({ undecided: 0 }));
    const row = await screen.findByTestId("discrepancy-line-1");
    expect(within(row).getByRole("button", { name: "Ошибка учёта" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "без решения · 0" })).toBeInTheDocument();

    listLines = [shortageLine()];
    rerenderWith(detailWith({ undecided: 1 }));

    await waitFor(() => expect(listCalls()).toHaveLength(2));
    expect(await screen.findByRole("button", { name: "без решения · 1" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "без решения · 0" })).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId("discrepancy-line-1")).getByRole("button", { name: "Ошибка учёта" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("строку без решения пересчитали (−3 → −2) — меняется только количество, список всё равно перечитывается", async () => {
    listLines = [shortageLine()];
    const { rerenderWith } = renderPanel(detailWith({ shortageQty: 3, undecided: 1 }));
    await screen.findByTestId("discrepancy-line-1");

    listLines = [shortageLine({ countedQty: 48, diff: -2 })];
    rerenderWith(detailWith({ shortageQty: 2, undecided: 1 }));

    await waitFor(() => expect(listCalls()).toHaveLength(2));
    expect(await within(screen.getByTestId("discrepancy-line-1")).findByText("−2")).toBeInTheDocument();
  });

  it("своё решение не вызывает лишнего перечитывания списка", async () => {
    listLines = [shortageLine()];
    decisionReply = shortageLine({ decision: "LOST", decidedBy: "sechenoff", decidedAt: DECIDED_AT });
    const { rerenderWith } = renderPanel(detailWith({ undecided: 1 }));
    await screen.findByTestId("discrepancy-line-1");

    fireEvent.click(lostButton());
    await waitFor(() => expect(lostButton()).toHaveAttribute("aria-pressed", "true"));

    // Карточка догнала решение: итоги сходятся со списком на экране.
    rerenderWith(detailWith({ undecided: 0 }));
    await settle();
    rerenderWith(detailWith({ undecided: 0 }));
    await settle();
    expect(listCalls()).toHaveLength(1);
  });

  it("стойкое расхождение итогов и списка — одно перечитывание на состояние сервера, без цикла", async () => {
    listLines = [shortageLine({ decision: "ADJUST", decisionNote: "ошибка", decidedBy: "sechenoff", decidedAt: DECIDED_AT })];
    const { rerenderWith } = renderPanel(detailWith({ undecided: 1 }));
    await screen.findByTestId("discrepancy-line-1");

    rerenderWith(detailWith({ undecided: 1 }));
    await waitFor(() => expect(listCalls()).toHaveLength(2));
    await settle();

    rerenderWith(detailWith({ undecided: 1 }));
    await settle();
    rerenderWith(detailWith({ undecided: 1 }));
    await settle();
    expect(listCalls()).toHaveLength(2);
  });

  it("сменился состав расхождений — список перечитывается один раз, а не дважды", async () => {
    listLines = [shortageLine()];
    const { rerenderWith } = renderPanel(detailWith({ undecided: 1 }));
    await screen.findByTestId("discrepancy-line-1");

    listLines = [shortageLine(), shortageLine({ id: "line-3", name: "Кабель 32/220 (15м)", countedQty: 24, diff: -1 })];
    rerenderWith(detailWith({ counted: 2, shortagePositions: 2, shortageQty: 4, undecided: 2 }));

    expect(await screen.findByTestId("discrepancy-line-3")).toBeInTheDocument();
    await settle();
    expect(listCalls()).toHaveLength(2);
  });
});
