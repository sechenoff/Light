/**
 * Чек-лист выдачи и жизнь сессии (перенос zz-hunt «скептик kiosk-ui» F2/F3/F8
 * и новые сценарии пакета «Выдача»).
 *
 *  F3  Смена sessionId у смонтированного чек-листа не оставляет чужой итог.
 *  F2  Степпер и отметки переживают размонтирование: черновик уходит на
 *      сервер (`PUT /draft`) и возвращается через `/state`.
 *  F8  Каталожные доборы (originalQuantity 0) считаются в «Добавлено доборов»,
 *      рост основной сметы виден в блоке «Финансы».
 *  +   `itemsVersion`/`draftRevision` в `/complete`, коды `SESSION_*` →
 *      `SessionClosedNotice`, ранняя выдача с «Выдать заранее», подсветка
 *      строки при ADDON_OVER_STOCK, «под ответственность» у степпера,
 *      `CHECKLIST_OUTDATED` → перечитать и наложить погруженное, «Нечего
 *      выдавать», финансы произвольной позиции и договорной итог.
 *
 * Хук черновика настоящий; сервер черновиков — объект `server` ниже.
 */
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  ChecklistDraftV1,
  ChecklistItem,
  ChecklistState,
  CompleteResult,
  ScanApiError,
} from "../types";
import type { UseScanSessionResult } from "../useScanSession";
import { _resetChecklistDraftsForTests } from "../useChecklistDraft";

let mockState: ChecklistState | null = null;
let mockClosedError: ScanApiError | null = null;
const refreshSpy = vi.fn(async () => mockState);
vi.mock("../useScanSession", () => ({
  useScanSession: (): Partial<UseScanSessionResult> => ({
    state: mockState,
    loading: false,
    error: mockClosedError,
    closedError: mockClosedError,
    openSession: vi.fn(async () => {}),
    check: vi.fn(async () => {}),
    uncheck: vi.fn(async () => {}),
    refresh: refreshSpy,
  }),
}));
vi.mock("../AddonSearch", () => ({ AddonSearch: () => null }));
vi.mock("../DriverPanel", () => ({ DriverPanel: () => null }));

/** «Сервер» черновиков одной сессии. */
const server: { revision: number; draft: ChecklistDraftV1 | null; savedAt: string | null } = {
  revision: 0,
  draft: null,
  savedAt: null,
};

const completeSpy = vi.fn();
const saveDraftSpy = vi.fn(async (_sid: string, revision: number, draft: ChecklistDraftV1) => {
  if (revision !== server.revision) {
    const err: ScanApiError = {
      status: 409,
      code: "DRAFT_OUTDATED",
      message: "Чек-лист изменили на другом устройстве — загружена свежая версия",
      details: { revision: server.revision, draft: server.draft, savedAt: server.savedAt, savedBy: "Пётр" },
    };
    throw err;
  }
  server.revision += 1;
  server.draft = draft;
  server.savedAt = new Date().toISOString();
  return { revision: server.revision, savedAt: server.savedAt };
});
const cancelSpy = vi.fn(async () => ({ cancelled: true }));

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    scanApi: {
      ...actual.scanApi,
      complete: (s: string, p: unknown) => completeSpy(s, p),
      saveDraft: (s: string, r: number, d: ChecklistDraftV1) => saveDraftSpy(s, r, d),
      cancel: (...args: unknown[]) => cancelSpy(...(args as [])),
    },
  };
});

import { IssueChecklist } from "../IssueChecklist";

const DAY = 24 * 3600 * 1000;

function item(
  id: string,
  name: string,
  quantity: number,
  over: Partial<ChecklistItem> = {},
): ChecklistItem {
  return {
    bookingItemId: id,
    equipmentId: `eq-${id}`,
    equipmentName: name,
    category: "Свет",
    quantity,
    checkedQty: 0,
    trackingMode: "COUNT",
    isExtra: false,
    rentalRatePerShift: "1000",
    originalQuantity: quantity,
    addCap: 5,
    ackCap: 5,
    ...over,
  };
}

function st(
  sessionId: string,
  items: ChecklistItem[],
  over: Partial<ChecklistState> = {},
): ChecklistState {
  const start = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
  return {
    sessionId,
    bookingId: `b-${sessionId}`,
    operation: "ISSUE",
    items,
    progress: { checkedItems: 0, totalItems: items.length },
    shifts: 1,
    discountPercent: "0",
    mainOriginalAfterDiscount: "3000",
    session: {
      status: "ACTIVE",
      operation: "ISSUE",
      workerName: "Иван",
      startedAt: new Date(Date.now() - 3600 * 1000).toISOString(),
    },
    booking: {
      status: "CONFIRMED",
      startDate: start,
      endDate: new Date(Date.now() + 2 * DAY).toISOString(),
      finalAmount: "3000",
      manualFinalAmount: null,
    },
    draft: server.draft,
    draftRevision: server.revision,
    draftSavedAt: server.savedAt,
    draftSavedBy: server.draft ? "Иван" : null,
    itemsVersion: "v-1",
    ...over,
  };
}

function res(over: Partial<CompleteResult> = {}): CompleteResult {
  return {
    sessionId: "s1",
    operation: "ISSUE",
    scannedCount: 0,
    expectedCount: 0,
    missingItems: [],
    substitutedItems: [],
    reservedButUnavailable: [],
    mainAfterDiscount: "5000",
    mainOriginalAfterDiscount: "3000",
    addonAfterDiscount: "0",
    finalAmount: "5000",
    paymentStatus: "NOT_PAID",
    amountPaid: "0",
    createdRepairIds: [],
    failedBrokenUnits: [],
    createdProblemItemIds: [],
    failedProblemUnits: [],
    ...over,
  };
}

function apiError(code: string, message: string, details: unknown = null, status = 409): ScanApiError {
  return { status, code, message, details };
}

async function markAllAndFinish() {
  fireEvent.click((await screen.findAllByRole("button", { name: /Отметить все позиции/ }))[0]);
  fireEvent.click(screen.getByRole("button", { name: /Готово, выдать/ }));
}

function lastPayload(): Record<string, unknown> {
  const calls = completeSpy.mock.calls;
  return calls[calls.length - 1][1] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetChecklistDraftsForTests();
  server.revision = 0;
  server.draft = null;
  server.savedAt = null;
  mockClosedError = null;
  window.sessionStorage.clear();
  completeSpy.mockResolvedValue(res());
});

describe("IssueChecklist — сессия (перенос zz-hunt)", () => {
  it("F3: смена sessionId сбрасывает экран итога — у брони E2 свой чек-лист", async () => {
    mockState = st("s1", [item("a1", "Штатив", 1)]);
    const { rerender } = render(
      <IssueChecklist sessionId="s1" projectName="Бронь E1" onBack={() => {}} />,
    );
    await markAllAndFinish();
    await screen.findByText("Выдача оформлена");

    mockState = st("s2", [item("b1", "Прибор", 3)]);
    rerender(<IssueChecklist sessionId="s2" projectName="Бронь E2" onBack={() => {}} />);

    await waitFor(() => expect(screen.queryByText("Выдача оформлена")).not.toBeInTheDocument());
    expect(
      screen.getByRole("button", { name: /Готово, выдать|Завершить выдачу/ }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Количество к выдаче — Прибор/)).toHaveValue(3);
    expect(completeSpy).toHaveBeenCalledTimes(1);
  });

  it("F2: черновик переживает размонтирование — обнулённая строка остаётся 0, отметка на месте", async () => {
    mockState = st("s1", [item("a1", "Штатив", 2), item("u1", "Удлинитель", 5)]);
    const first = render(<IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />);
    fireEvent.change(await screen.findByLabelText(/Количество к выдаче — Удлинитель/), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Отметить «Выдано» — Штатив/ }));
    first.unmount();

    // Досылка при размонтировании дошла до сервера.
    await waitFor(() => expect(server.draft?.issue?.rows.u1?.qty).toBe(0));
    expect(server.draft?.issue?.rows.a1).toEqual({ qty: 2, checked: true, equipmentId: "eq-a1" });

    mockState = st("s1", [item("a1", "Штатив", 2), item("u1", "Удлинитель", 5)]);
    render(
      <IssueChecklist
        sessionId="s1"
        projectName="P"
        onBack={() => {}}
        resumed={{ id: "s1", bookingId: "b-s1", operation: "ISSUE", status: "ACTIVE", resumed: true }}
      />,
    );
    expect(await screen.findByLabelText(/Количество к выдаче — Удлинитель/)).toHaveValue(0);
    expect(
      screen.getByRole("button", { name: /Снять отметку «Выдано» — Штатив/ }),
    ).toHaveAttribute("aria-pressed", "true");
    // Плашка пишет правду: восстановлено, а не «сохранено» наугад.
    expect(screen.getByText(/Количества и отметки восстановлены/)).toBeInTheDocument();
  });

  it("продолженная сессия без черновика — плашка честно пишет, что отметок нет", async () => {
    mockState = st("s1", [item("a1", "Штатив", 2)]);
    render(
      <IssueChecklist
        sessionId="s1"
        projectName="P"
        onBack={() => {}}
        resumed={{ id: "s1", bookingId: "b-s1", operation: "ISSUE", status: "ACTIVE", resumed: true }}
      />,
    );
    const banner = await screen.findByText(/Продолжена выдача/);
    expect(banner.closest("[role=status]")).toHaveTextContent(
      "Сохранённых отметок нет — проверьте количества.",
    );
    expect(screen.queryByText(/Доборы и принятые позиции сохранены/)).not.toBeInTheDocument();
  });

  it("F8: каталожные доборы (originalQuantity 0) считаются в «Добавлено доборов», рост суммы виден", async () => {
    mockState = st("s1", [
      item("a1", "Штатив", 2),
      item("x1", "Сетка (добор)", 1, { originalQuantity: 0 }),
      item("x2", "Флоппи (добор)", 2, { originalQuantity: 0 }),
    ]);
    render(<IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />);
    await markAllAndFinish();
    await screen.findByText("Выдача оформлена");
    const addonsRow = screen.getByText("Добавлено доборов").closest("div")!;
    expect(addonsRow.textContent).toMatch(/Добавлено доборов\s*2/);
    expect(screen.getByText("Финансы")).toBeInTheDocument();
  });
});

describe("IssueChecklist — «Готово» и ответы сервера", () => {
  it("передаёт itemsVersion и ревизию черновика; черновик досылается до завершения", async () => {
    mockState = st("s1", [item("a1", "Штатив", 2)]);
    render(<IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />);
    fireEvent.click(await screen.findByLabelText(/Уменьшить количество — Штатив/));
    await markAllAndFinish();

    await waitFor(() => expect(completeSpy).toHaveBeenCalledTimes(1));
    expect(saveDraftSpy).toHaveBeenCalled();
    expect(lastPayload()).toMatchObject({
      itemsVersion: "v-1",
      draftRevision: server.revision,
      issuanceAdjustments: [{ bookingItemId: "a1", actualQuantity: 1 }],
    });
    expect(lastPayload()).not.toHaveProperty("force");
  });

  it("«открыл и посмотрел» не пишет черновик", async () => {
    mockState = st("s1", [item("a1", "Штатив", 2)]);
    render(<IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />);
    await screen.findByLabelText(/Количество к выдаче — Штатив/);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 900));
    });
    expect(saveDraftSpy).not.toHaveBeenCalled();
  });

  it("SESSION_ALREADY_COMPLETED при «Готово» → уведомление «Выдача уже оформлена» и «К списку броней»", async () => {
    completeSpy.mockRejectedValueOnce(
      apiError("SESSION_ALREADY_COMPLETED", "Выдача по этой брони уже оформлена", {
        sessionId: "s1",
        operation: "ISSUE",
        completedAt: new Date().toISOString(),
        completedBy: "Пётр",
      }),
    );
    const onSessionClosed = vi.fn();
    mockState = st("s1", [item("a1", "Штатив", 2)]);
    render(
      <IssueChecklist
        sessionId="s1"
        projectName="P"
        onBack={() => {}}
        onSessionClosed={onSessionClosed}
      />,
    );
    await markAllAndFinish();

    expect(await screen.findByText("Выдача уже оформлена")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Готово, выдать/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /К списку броней/ }));
    expect(onSessionClosed).toHaveBeenCalledTimes(1);
  });

  it("SESSION_STALE при загрузке → SessionClosedNotice с текстом сервера", async () => {
    mockState = null;
    mockClosedError = apiError(
      "SESSION_STALE",
      "Бронь уже выдана на карточке — чек-лист закрыт, изменения из него не применены",
      { sessionId: "s1", operation: "ISSUE", bookingStatus: "ISSUED" },
    );
    render(<IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />);
    expect(await screen.findByText("Чек-лист закрыт")).toBeInTheDocument();
    expect(screen.getByText(/Бронь уже выдана на карточке/)).toBeInTheDocument();
  });

  it("ISSUE_TOO_EARLY → модалка с текстом сервера; «Выдать заранее» повторяет с force", async () => {
    const text =
      "Аренда начинается 12.10 в 10:00 — до начала больше суток. Выдать раньше срока?";
    completeSpy
      .mockRejectedValueOnce(apiError("ISSUE_TOO_EARLY", text, { startDate: new Date().toISOString() }))
      .mockResolvedValueOnce(res());
    mockState = st("s1", [item("a1", "Штатив", 2)]);
    render(<IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />);
    await markAllAndFinish();

    const dialog = await screen.findByRole("dialog", { name: /Выдача раньше срока/ });
    expect(within(dialog).getByText(text)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Выдать заранее" }));

    await screen.findByText("Выдача оформлена");
    expect(completeSpy).toHaveBeenCalledTimes(2);
    expect(lastPayload()).toMatchObject({ force: true });
  });

  it("ISSUE_TOO_EARLY → «Проверить бронь» закрывает модалку без выдачи", async () => {
    completeSpy.mockRejectedValueOnce(apiError("ISSUE_TOO_EARLY", "Рано", { startDate: "x" }));
    mockState = st("s1", [item("a1", "Штатив", 2)]);
    render(<IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />);
    await markAllAndFinish();
    fireEvent.click(await screen.findByRole("button", { name: "Проверить бронь" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(completeSpy).toHaveBeenCalledTimes(1);
  });

  it("до начала аренды больше суток — жёлтая подсказка сверху", async () => {
    mockState = st("s1", [item("a1", "Штатив", 2)], {
      booking: {
        status: "CONFIRMED",
        startDate: new Date(Date.now() + 5 * DAY).toISOString(),
        endDate: new Date(Date.now() + 7 * DAY).toISOString(),
        finalAmount: "3000",
        manualFinalAmount: null,
      },
    });
    render(<IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />);
    expect(await screen.findByText(/до начала больше суток/)).toBeInTheDocument();
  });

  it("ADDON_OVER_STOCK из «Готово» подсвечивает строку и возвращает к доступному", async () => {
    completeSpy.mockRejectedValueOnce(
      apiError("ADDON_OVER_STOCK", "«Штатив»: не хватает на складе — можно добрать ещё 1", {
        bookingItemId: "a1",
        equipmentId: "eq-a1",
        name: "Штатив",
        addCap: 1,
        requested: 3,
        alreadyInBooking: 2,
      }),
    );
    mockState = st("s1", [item("a1", "Штатив", 2), item("b1", "Флаг", 1)]);
    render(<IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />);
    const plus = await screen.findByLabelText(/Увеличить количество — Штатив/);
    fireEvent.click(plus);
    fireEvent.click(plus);
    fireEvent.click(plus);
    await markAllAndFinish();

    await screen.findByText(/не хватает на складе — можно добрать ещё 1/);
    const qty = screen.getByLabelText(/Количество к выдаче — Штатив/);
    expect(qty).toHaveValue(3);
    expect(qty).toHaveAttribute("aria-invalid", "true");
    expect(qty.closest("[data-problem]")).toHaveAttribute("data-problem", "over-stock");
    expect(screen.getByLabelText(/Количество к выдаче — Флаг/)).not.toHaveAttribute("aria-invalid");
    expect(refreshSpy).toHaveBeenCalled();
  });

  it("CHECKLIST_OUTDATED → перечитать чек-лист и наложить погруженное на новые позиции", async () => {
    completeSpy.mockRejectedValueOnce(
      apiError(
        "CHECKLIST_OUTDATED",
        "Состав брони изменился, пока был открыт чек-лист — список обновлён, проверьте строки",
      ),
    );
    mockState = st("s1", [item("a1", "Штатив", 2, { equipmentId: "eq-tripod" })]);
    refreshSpy.mockImplementationOnce(async () => {
      // Руководитель пересохранил бронь: позиция получила новый id.
      mockState = st(
        "s1",
        [item("a1-new", "Штатив", 2, { equipmentId: "eq-tripod" }), item("n1", "Новая лампа", 1)],
        { itemsVersion: "v-2" },
      );
      return mockState;
    });
    const view = render(<IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />);
    fireEvent.click(await screen.findByLabelText(/Уменьшить количество — Штатив/));
    await markAllAndFinish();

    await screen.findByText(/Состав брони изменился/);
    expect(refreshSpy).toHaveBeenCalled();
    view.rerender(<IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />);

    expect(await screen.findByLabelText(/Количество к выдаче — Новая лампа/)).toHaveValue(1);
    expect(screen.getByLabelText(/Количество к выдаче — Штатив/)).toHaveValue(1);
  });

  it("все строки обнулены — «Нечего выдавать», кнопка неактивна", async () => {
    mockState = st("s1", [item("a1", "Штатив", 1)]);
    render(<IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />);
    fireEvent.click(await screen.findByLabelText(/Уменьшить количество — Штатив/));

    const btn = screen.getByRole("button", { name: /Нечего выдавать/ });
    expect(btn).toBeDisabled();
    expect(screen.getByText(/отмените её на карточке брони/)).toBeInTheDocument();
  });

  it("NOTHING_TO_ISSUE с сервера показывается как есть", async () => {
    completeSpy.mockRejectedValueOnce(
      apiError(
        "NOTHING_TO_ISSUE",
        "Нечего выдавать: все строки обнулены. Если бронь не состоялась — отмените её на карточке брони.",
      ),
    );
    mockState = st("s1", [item("a1", "Штатив", 1)]);
    render(<IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />);
    await markAllAndFinish();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Нечего выдавать: все строки обнулены/);
  });
});

describe("IssueChecklist — два устройства (DRAFT_OUTDATED)", () => {
  const otherDeviceDraft: ChecklistDraftV1 = {
    v: 1,
    issue: { rows: { a1: { qty: 0, checked: false, equipmentId: "eq-a1" } } },
  };

  it("сохранение черновика проиграло другому планшету — экран берёт его версию, «Готово» уходит от свежей ревизии", async () => {
    mockState = st("s1", [item("a1", "Штатив", 2), item("b1", "Флаг", 3)]);
    render(<IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />);
    await screen.findByLabelText(/Количество к выдаче — Штатив/);

    // Другой планшет успел сохранить раньше.
    server.revision = 4;
    server.draft = otherDeviceDraft;
    fireEvent.click(screen.getByLabelText(/Уменьшить количество — Флаг/));
    await waitFor(() => expect(saveDraftSpy).toHaveBeenCalled(), { timeout: 2000 });

    expect(await screen.findByText(/изменили на другом устройстве/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Количество к выдаче — Штатив/)).toHaveValue(0);
    expect(screen.getByLabelText(/Количество к выдаче — Флаг/)).toHaveValue(3);

    // Отметки ложатся поверх версии другого планшета (ревизия 4 → 5).
    await markAllAndFinish();
    await waitFor(() => expect(completeSpy).toHaveBeenCalledTimes(1));
    expect(server.revision).toBe(5);
    expect(server.draft?.issue?.rows.a1).toEqual({ qty: 0, checked: false, equipmentId: "eq-a1" });
    expect(lastPayload()).toMatchObject({
      draftRevision: 5,
      issuanceAdjustments: [{ bookingItemId: "a1", actualQuantity: 0 }],
    });
  });

  it("DRAFT_OUTDATED из «Готово» — экран перезасеян версией из ответа, повтор уходит от её ревизии", async () => {
    mockState = st("s1", [item("a1", "Штатив", 2), item("b1", "Флаг", 3)]);
    completeSpy
      .mockImplementationOnce(async () => {
        server.revision = 3;
        server.draft = otherDeviceDraft;
        throw apiError("DRAFT_OUTDATED", "Чек-лист изменили на другом устройстве — загружена свежая версия", {
          revision: 3,
          draft: otherDeviceDraft,
          savedAt: new Date().toISOString(),
          savedBy: "Пётр",
        });
      })
      .mockResolvedValueOnce(res());
    render(<IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />);
    await markAllAndFinish();

    expect(await screen.findByText(/нажмите «Готово» ещё раз/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Количество к выдаче — Штатив/)).toHaveValue(0);
    // Хук черновика принял ревизию из ответа — лишних сохранений нет.
    expect(saveDraftSpy).toHaveBeenCalledTimes(1);

    await markAllAndFinish();
    await waitFor(() => expect(completeSpy).toHaveBeenCalledTimes(2));
    // Отметки легли поверх ревизии 3 → ушли от 4.
    expect(lastPayload()).toMatchObject({ draftRevision: 4 });
  });
});

describe("IssueChecklist — «под ответственность» у степпера (P4)", () => {
  const holder = {
    bookingId: "b-h",
    bookingNo: "#ABC123",
    projectName: "Клип",
    from: new Date(Date.now() - DAY).toISOString(),
    to: new Date(Date.now() + 3 * DAY).toISOString(),
    freeFrom: new Date(Date.now() + 3 * DAY).toISOString(),
    clientName: "Иванов",
    holderStatus: "CONFIRMED" as const,
    issuedAt: null,
    overdue: false,
    freeForUs: 0,
    ackCap: 2,
  };

  it("упёрся в свободное — видно, у кого занято; «Добрать под ответственность» поднимает потолок", async () => {
    mockState = st("s1", [item("a1", "Сетка", 1, { addCap: 0, ackCap: 2, capHolder: holder })]);
    render(<IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />);

    const plus = await screen.findByLabelText(/Увеличить количество — Сетка/);
    expect(plus).toBeDisabled();
    expect(screen.getByText(/Занято: #ABC123 «Клип» до .* — ещё 2 под ответственность/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Добрать под ответственность — Сетка/ }));
    expect(plus).not.toBeDisabled();
    fireEvent.click(plus);
    fireEvent.click(plus);
    expect(screen.getByLabelText(/Количество к выдаче — Сетка/)).toHaveValue(3);
    expect(plus).toBeDisabled();

    await markAllAndFinish();
    await waitFor(() => expect(completeSpy).toHaveBeenCalled());
    expect(lastPayload().issuanceAdjustments).toEqual([
      { bookingItemId: "a1", actualQuantity: 3, acknowledgedConflict: true },
    ]);
  });

  it("без чужой брони подсказки нет, флаг не уходит", async () => {
    mockState = st("s1", [item("a1", "Штатив", 1, { addCap: 2, ackCap: 2 })]);
    render(<IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />);
    const plus = await screen.findByLabelText(/Увеличить количество — Штатив/);
    fireEvent.click(plus);
    fireEvent.click(plus);
    expect(plus).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Добрать под ответственность/ })).not.toBeInTheDocument();
    await markAllAndFinish();
    await waitFor(() => expect(completeSpy).toHaveBeenCalled());
    expect(lastPayload().issuanceAdjustments).toEqual([{ bookingItemId: "a1", actualQuantity: 3 }]);
  });

  it("ADDON_OVER_STOCK под ответственность: урезанное выше свободного остаётся под ответственностью, повтор уходит с флагом", async () => {
    // Взяли 3 сверх позиции под ответственность, а на складе к «Готово»
    // осталось только 2 (addCap в ответе — потолок ackCap).
    completeSpy
      .mockRejectedValueOnce(
        apiError("ADDON_OVER_STOCK", "«Сетка»: не хватает на складе — можно добрать ещё 2", {
          bookingItemId: "a1",
          equipmentId: "eq-a1",
          name: "Сетка",
          addCap: 2,
          requested: 4,
          alreadyInBooking: 1,
        }),
      )
      .mockResolvedValueOnce(res());
    mockState = st("s1", [item("a1", "Сетка", 1, { addCap: 0, ackCap: 3, capHolder: holder })]);
    render(<IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Добрать под ответственность — Сетка/ }));
    const plus = screen.getByLabelText(/Увеличить количество — Сетка/);
    fireEvent.click(plus);
    fireEvent.click(plus);
    fireEvent.click(plus);
    await markAllAndFinish();

    await screen.findByText(/можно добрать ещё 2/);
    expect(screen.getByLabelText(/Количество к выдаче — Сетка/)).toHaveValue(3);
    expect(screen.getByText("под ответственность")).toBeInTheDocument();

    // Отметки на месте — сразу «Готово».
    fireEvent.click(screen.getByRole("button", { name: /Готово, выдать/ }));
    await waitFor(() => expect(completeSpy).toHaveBeenCalledTimes(2));
    expect(lastPayload().issuanceAdjustments).toEqual([
      { bookingItemId: "a1", actualQuantity: 3, acknowledgedConflict: true },
    ]);
  });

  it("ADDON_CONFLICT из «Готово» на устаревшей строке — предложение без «ещё 0», повтор с флагом", async () => {
    // На момент открытия свободно было 2, к «Готово» их заняла чужая бронь.
    completeSpy
      .mockRejectedValueOnce(
        apiError("ADDON_CONFLICT", "«Штатив» занят на даты брони", {
          ...holder,
          ackCap: undefined,
          bookingItemId: "a1",
          equipmentId: "eq-a1",
        }),
      )
      .mockResolvedValueOnce(res());
    mockState = st("s1", [item("a1", "Штатив", 1, { addCap: 2, ackCap: 2 })]);
    render(<IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />);
    const plus = await screen.findByLabelText(/Увеличить количество — Штатив/);
    fireEvent.click(plus);
    fireEvent.click(plus);
    await markAllAndFinish();

    const offer = await screen.findByText(/Занято: #ABC123 «Клип» до .* — можно добрать под ответственность/);
    expect(offer.textContent).not.toMatch(/ещё 0/);
    fireEvent.click(screen.getByRole("button", { name: /Добрать под ответственность — Штатив/ }));

    fireEvent.click(screen.getByRole("button", { name: /Готово, выдать/ }));
    await waitFor(() => expect(completeSpy).toHaveBeenCalledTimes(2));
    expect(lastPayload().issuanceAdjustments).toEqual([
      { bookingItemId: "a1", actualQuantity: 3, acknowledgedConflict: true },
    ]);
  });

  it("«Отменить» возвращает потолок к свободному", async () => {
    mockState = st("s1", [item("a1", "Сетка", 1, { addCap: 0, ackCap: 2, capHolder: holder })]);
    render(<IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Добрать под ответственность — Сетка/ }));
    fireEvent.click(screen.getByLabelText(/Увеличить количество — Сетка/));
    fireEvent.click(screen.getByRole("button", { name: /Отменить «под ответственность» — Сетка/ }));
    expect(screen.getByLabelText(/Количество к выдаче — Сетка/)).toHaveValue(1);
  });
});

describe("IssueChecklist — финансы (P16, P22)", () => {
  it("произвольная позиция по плану: «Итого» равно «Согласовано», не 0 ₽", async () => {
    mockState = st(
      "s1",
      [
        item("a1", "Штатив", 2, { mainUnitPrice: "1000" }),
        item("g1", "Генератор 5 кВт (субаренда)", 1, {
          equipmentId: null,
          category: "Прочее",
          rentalRatePerShift: "0",
          customUnitPrice: "5000",
          mainUnitPrice: "5000",
          addCap: 0,
          ackCap: 0,
        }),
      ],
      { mainOriginalAfterDiscount: "7000" },
    );
    render(<IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />);
    await screen.findByLabelText(/Количество к выдаче — Генератор/);
    expect(screen.getByText("Прочее")).toBeInTheDocument();
    expect(screen.queryByText(/Снято на выдаче/)).not.toBeInTheDocument();
    const total = screen.getByText("Итого").parentElement as HTMLElement;
    expect(total.textContent).toMatch(/7\s?000/);

    fireEvent.click(screen.getByLabelText(/Уменьшить количество — Генератор/));
    expect(screen.getByText(/Снято на выдаче/).parentElement!.textContent).toMatch(/5\s?000/);
  });

  it("договорной итог: к оплате — договорная сумма, добор помечен предупреждением", async () => {
    mockState = st("s1", [item("a1", "Штатив", 1, { mainUnitPrice: "1000" })], {
      mainOriginalAfterDiscount: "1000",
      booking: {
        status: "CONFIRMED",
        startDate: new Date(Date.now() + 3600 * 1000).toISOString(),
        endDate: new Date(Date.now() + DAY).toISOString(),
        finalAmount: "900",
        manualFinalAmount: "900",
      },
    });
    render(<IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />);
    const due = (await screen.findByText(/К оплате — договорная сумма/)).parentElement as HTMLElement;
    expect(due.textContent).toMatch(/900/);
    expect(screen.queryByText(/сумма к оплате не изменится автоматически/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/Увеличить количество — Штатив/));
    expect(screen.getByText(/сумма к оплате не изменится автоматически/)).toBeInTheDocument();
  });
});
