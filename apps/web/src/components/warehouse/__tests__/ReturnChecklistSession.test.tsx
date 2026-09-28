/**
 * Приёмка в киоске: черновик на сервере, закрытая сессия, «Прервать» (P6, P3, P14, P1).
 *
 * Здесь настоящие `useScanSession` и `useChecklistDraft`; замокан только
 * сетевой слой — маленький «сервер» в памяти держит черновик с ревизией так
 * же, как `PUT /sessions/:id/draft`.
 */
import { render, screen, waitFor, fireEvent, within, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChecklistDraftV1, ChecklistItem, ChecklistState, CompleteResult } from "../types";

vi.mock("../../ToastProvider", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// ── «Сервер» ─────────────────────────────────────────────────────────────────

interface FakeServer {
  /** Машины брони для «Пробег машин» и задержка ответа, мс. */
  vehicles: unknown[];
  vehiclesDelayMs: number;
  items: ChecklistItem[];
  itemsVersion: string;
  draft: ChecklistDraftV1 | null;
  revision: number;
  savedAt: string | null;
}

const server: FakeServer = {
  vehicles: [],
  vehiclesDelayMs: 0,
  items: [],
  itemsVersion: "v1",
  draft: null,
  revision: 0,
  savedAt: null,
};

function apiError(status: number, code: string, message: string, details: unknown = null) {
  return { status, code, message, details };
}

const getStateSpy = vi.fn(async (sessionId: string): Promise<ChecklistState> => ({
  sessionId,
  bookingId: "b1",
  operation: "RETURN",
  items: server.items,
  progress: { checkedItems: 0, totalItems: server.items.length },
  shifts: 1,
  discountPercent: "0",
  mainOriginalAfterDiscount: "0",
  session: {
    status: "ACTIVE",
    operation: "RETURN",
    workerName: "Иван",
    startedAt: new Date(Date.now() - 3_600_000).toISOString(),
  },
  draft: server.draft,
  draftRevision: server.revision,
  draftSavedAt: server.savedAt,
  draftSavedBy: server.draft ? "Иван" : null,
  itemsVersion: server.itemsVersion,
}));

const saveDraftSpy = vi.fn(async (_sid: string, revision: number, draft: ChecklistDraftV1) => {
  if (revision !== server.revision) {
    throw apiError(409, "DRAFT_OUTDATED", "Чек-лист изменили на другом устройстве — загружена свежая версия", {
      revision: server.revision,
      draft: server.draft,
      savedAt: server.savedAt,
      savedBy: "Пётр",
    });
  }
  server.revision += 1;
  server.draft = draft;
  server.savedAt = new Date().toISOString();
  return { revision: server.revision, savedAt: server.savedAt };
});

const completeSpy = vi.fn();
const cancelSpy = vi.fn(async () => ({
  id: "s1",
  bookingId: "b1",
  operation: "RETURN",
  status: "CANCELLED",
  cancelled: true,
}));

vi.mock("../api", () => ({
  scanApi: {
    getState: (sid: string) => getStateSpy(sid),
    saveDraft: (sid: string, revision: number, draft: ChecklistDraftV1) =>
      saveDraftSpy(sid, revision, draft),
    complete: (...args: unknown[]) => completeSpy(...args),
    cancel: (...args: unknown[]) => cancelSpy(...(args as [])),
    check: vi.fn(async () => ({ alreadyChecked: false })),
    uncheck: vi.fn(async () => ({ wasChecked: true })),
    listSessionVehicles: async () => {
      if (server.vehiclesDelayMs > 0) {
        await new Promise((r) => setTimeout(r, server.vehiclesDelayMs));
      }
      return server.vehicles;
    },
    getWarehouseToken: () => null,
  },
}));

import { ReturnChecklist } from "../ReturnChecklist";
import { _resetChecklistDraftsForTests } from "../useChecklistDraft";

function countItem(id: string, name: string, quantity: number, equipmentId = `eq-${id}`): ChecklistItem {
  return {
    bookingItemId: id,
    equipmentId,
    equipmentName: name,
    category: "Грип",
    quantity,
    checkedQty: 0,
    trackingMode: "COUNT",
    isExtra: false,
    rentalRatePerShift: "0",
    originalQuantity: quantity,
    addCap: 0,
  };
}

function okResult(over: Partial<CompleteResult> = {}): CompleteResult {
  return {
    sessionId: "s1",
    operation: "RETURN",
    scannedCount: 0,
    expectedCount: 0,
    missingItems: [],
    substitutedItems: [],
    reservedButUnavailable: [],
    createdRepairIds: [],
    failedBrokenUnits: [],
    createdProblemItemIds: [],
    failedProblemUnits: [],
    mainAfterDiscount: "0",
    mainOriginalAfterDiscount: "0",
    addonAfterDiscount: "0",
    finalAmount: "0",
    paymentStatus: "NOT_PAID",
    amountPaid: "0",
    ...over,
  };
}

/** «Принять всё разом» асинхронная (ждёт отметок единиц) — дожидаемся её. */
async function acceptEverything() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Принять всё разом/ }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

const chip = (name: string, index: number, status: string) =>
  screen.getByRole("button", { name: new RegExp(`«${name}» юнит #${index} — ${status}`) });

async function renderChecklist(props: Partial<Parameters<typeof ReturnChecklist>[0]> = {}) {
  const utils = render(
    <ReturnChecklist sessionId="s1" projectName="Проект" onBack={() => {}} {...props} />,
  );
  await screen.findByRole("button", { name: /Завершить приёмку/ });
  return utils;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetChecklistDraftsForTests();
  server.items = [countItem("bi-a", "Сендбэг", 3), countItem("bi-b", "Трубы 3м", 2)];
  server.vehicles = [];
  server.vehiclesDelayMs = 0;
  server.itemsVersion = "v1";
  server.draft = null;
  server.revision = 0;
  server.savedAt = null;
  completeSpy.mockResolvedValue(okResult());
});

describe("ReturnChecklist: черновик приёмки", () => {
  it("исходы и комментарии переживают размонтирование: уход с экрана досылает черновик, повторное открытие восстанавливает", async () => {
    const first = await renderChecklist();

    fireEvent.click(screen.getByRole("button", { name: /Принять все 2 шт «Трубы 3м»/ }));
    fireEvent.click(chip("Сендбэг", 1, "ожидает"));
    fireEvent.click(chip("Сендбэг", 2, "ожидает"));
    fireEvent.click(chip("Сендбэг", 2, "принят"));
    fireEvent.change(screen.getByLabelText(/Комментарий ремонта — юнит #2 «Сендбэг»/), {
      target: { value: "Порван шов" },
    });

    // Смена раздела / «←»: чек-лист размонтируется — правка уходит сразу.
    first.unmount();
    await waitFor(() => expect(saveDraftSpy).toHaveBeenCalled());
    expect(server.draft?.return?.grids["bi-b"].slots.map((s) => s.status)).toEqual([
      "ACCEPTED",
      "ACCEPTED",
    ]);

    await renderChecklist();
    await waitFor(() => expect(chip("Сендбэг", 2, "в ремонт")).toBeInTheDocument());
    expect(chip("Сендбэг", 1, "принят")).toBeInTheDocument();
    expect(chip("Сендбэг", 3, "ожидает")).toBeInTheDocument();
    expect(chip("Трубы 3м", 1, "принят")).toBeInTheDocument();
    expect(
      (screen.getByLabelText(/Комментарий ремонта — юнит #2 «Сендбэг»/) as HTMLTextAreaElement).value,
    ).toBe("Порван шов");
  });

  it("правка уходит на сервер сама через задержку, подпись «Сохранено ЧЧ:ММ»", async () => {
    await renderChecklist();
    fireEvent.click(screen.getByRole("button", { name: /Принять все 3 шт «Сендбэг»/ }));
    await waitFor(() => expect(saveDraftSpy).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(saveDraftSpy.mock.calls[0][1]).toBe(0);
    expect(await screen.findByText(/Сохранено \d{2}:\d{2}/)).toBeInTheDocument();
  });

  it("количество строки изменилось — отметки строки сброшены, жёлтая пометка", async () => {
    server.revision = 3;
    server.draft = {
      v: 1,
      return: {
        units: {},
        grids: {
          "bi-a": {
            equipmentId: "eq-bi-a",
            slots: [
              { status: "ACCEPTED", repairComment: "", problem: { reason: null, comment: "", expectedBackDate: null } },
              { status: "ACCEPTED", repairComment: "", problem: { reason: null, comment: "", expectedBackDate: null } },
            ],
          },
        },
      },
    };
    await renderChecklist();
    expect(await screen.findByText(/отметки по этой строке сброшены/)).toBeInTheDocument();
    expect(chip("Сендбэг", 1, "ожидает")).toBeInTheDocument();
  });

  it("продолженная сессия: плашка честно пишет, что отметки восстановлены", async () => {
    server.revision = 1;
    server.savedAt = new Date().toISOString();
    server.draft = {
      v: 1,
      return: {
        units: {},
        grids: {
          "bi-b": {
            equipmentId: "eq-bi-b",
            slots: [
              { status: "ACCEPTED", repairComment: "", problem: { reason: null, comment: "", expectedBackDate: null } },
              { status: "ACCEPTED", repairComment: "", problem: { reason: null, comment: "", expectedBackDate: null } },
            ],
          },
        },
      },
    };
    await renderChecklist({
      resumed: {
        id: "s1",
        bookingId: "b1",
        operation: "RETURN",
        status: "ACTIVE",
        resumed: true,
        startedAt: new Date().toISOString(),
        workerName: "Иван",
      },
    });
    expect(await screen.findByText(/Продолжена приёмка/)).toBeInTheDocument();
    expect(screen.getByText(/Отметки приёмки восстановлены/)).toBeInTheDocument();
  });

  it("«Завершить» шлёт отпечаток состава и ревизию черновика", async () => {
    await renderChecklist();
    await acceptEverything();
    fireEvent.click(screen.getByRole("button", { name: /Завершить приёмку/ }));
    await waitFor(() => expect(completeSpy).toHaveBeenCalledTimes(1));
    const [, payload] = completeSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.itemsVersion).toBe("v1");
    // Перед «Завершить» черновик досылается — ревизия уже после сохранения.
    expect(payload.draftRevision).toBe(server.revision);
    expect(await screen.findByText("Приёмка завершена")).toBeInTheDocument();
  });

  it("CHECKLIST_OUTDATED: чек-лист перечитан, отметки перенесены на новый состав, новая строка ждёт отметки", async () => {
    await renderChecklist();
    await acceptEverything();

    completeSpy.mockRejectedValueOnce(
      apiError(409, "CHECKLIST_OUTDATED", "Состав брони изменился, пока был открыт чек-лист — список обновлён, проверьте строки"),
    );
    // Пока чек-лист был открыт, «Трубы» пересоздали правкой брони, добавили «Флаг».
    server.items = [
      countItem("bi-a", "Сендбэг", 3),
      countItem("bi-b2", "Трубы 3м", 2, "eq-bi-b"),
      countItem("bi-c", "Флаг 4×4", 1),
    ];
    server.itemsVersion = "v2";

    fireEvent.click(screen.getByRole("button", { name: /Завершить приёмку/ }));
    expect(await screen.findByText(/Состав брони изменился/)).toBeInTheDocument();
    await waitFor(() => expect(chip("Флаг 4×4", 1, "ожидает")).toBeInTheDocument());
    expect(chip("Сендбэг", 3, "принят")).toBeInTheDocument();
    expect(chip("Трубы 3м", 2, "принят")).toBeInTheDocument();

    // Новую строку не отметили — завершать рано.
    fireEvent.click(screen.getByRole("button", { name: /Завершить приёмку/ }));
    await waitFor(() => expect(screen.getAllByText(/Помечьте все 1 шт/).length).toBeGreaterThan(0));
    expect(completeSpy).toHaveBeenCalledTimes(1);

    fireEvent.click(chip("Флаг 4×4", 1, "ожидает"));
    fireEvent.click(screen.getByRole("button", { name: /Завершить приёмку/ }));
    await waitFor(() => expect(completeSpy).toHaveBeenCalledTimes(2));
    const [, payload] = completeSpy.mock.calls[1] as [string, Record<string, unknown>];
    expect(payload.itemsVersion).toBe("v2");
  });

  it("DRAFT_OUTDATED на «Завершить»: показана версия с другого планшета, повтор уходит с её ревизией", async () => {
    await renderChecklist();
    await acceptEverything();
    await waitFor(() => expect(saveDraftSpy).toHaveBeenCalled(), { timeout: 3000 });

    // Второй планшет отметил ремонт по «Сендбэг» #1 и сохранил позже.
    const other: ChecklistDraftV1 = {
      v: 1,
      return: {
        units: {},
        grids: {
          "bi-a": {
            equipmentId: "eq-bi-a",
            slots: [
              { status: "REPAIR", repairComment: "С другого планшета", problem: { reason: null, comment: "", expectedBackDate: null } },
              { status: "ACCEPTED", repairComment: "", problem: { reason: null, comment: "", expectedBackDate: null } },
              { status: "ACCEPTED", repairComment: "", problem: { reason: null, comment: "", expectedBackDate: null } },
            ],
          },
          "bi-b": {
            equipmentId: "eq-bi-b",
            slots: [
              { status: "ACCEPTED", repairComment: "", problem: { reason: null, comment: "", expectedBackDate: null } },
              { status: "ACCEPTED", repairComment: "", problem: { reason: null, comment: "", expectedBackDate: null } },
            ],
          },
        },
      },
    };
    server.revision += 1;
    server.draft = other;
    completeSpy.mockRejectedValueOnce(
      apiError(409, "DRAFT_OUTDATED", "Чек-лист изменили на другом устройстве — загружена свежая версия", {
        revision: server.revision,
        draft: other,
        savedAt: new Date().toISOString(),
        savedBy: "Пётр",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /Завершить приёмку/ }));
    expect(await screen.findByText(/изменили на другом устройстве/)).toBeInTheDocument();
    await waitFor(() => expect(chip("Сендбэг", 1, "в ремонт")).toBeInTheDocument());
    expect(
      (screen.getByLabelText(/Комментарий ремонта — юнит #1 «Сендбэг»/) as HTMLTextAreaElement).value,
    ).toBe("С другого планшета");

    // Правка поверх загруженной версии сохраняется, а не проигрывает снова.
    fireEvent.change(screen.getByLabelText(/Комментарий ремонта — юнит #1 «Сендбэг»/), {
      target: { value: "С другого планшета, проверено" },
    });
    await waitFor(
      () =>
        expect(server.draft?.return?.grids["bi-a"].slots[0].repairComment).toBe(
          "С другого планшета, проверено",
        ),
      { timeout: 4000 },
    );

    fireEvent.click(screen.getByRole("button", { name: /Завершить приёмку/ }));
    await waitFor(() => expect(completeSpy).toHaveBeenCalledTimes(2));
    const [, payload] = completeSpy.mock.calls[1] as [string, Record<string, unknown>];
    expect(payload.draftRevision).toBe(server.revision);
    expect(payload.repairUnits).toEqual([
      { bookingItemId: "bi-a", quantity: 1, comment: "С другого планшета, проверено" },
    ]);
  });
});

describe("ReturnChecklist: DRAFT_OUTDATED без правок", () => {
  it("повторное «Завершить» сразу после загрузки чужой версии уходит с её ревизией, а не упирается в конфликт снова", async () => {
    await renderChecklist();
    await acceptEverything();
    await waitFor(() => expect(saveDraftSpy).toHaveBeenCalled(), { timeout: 3000 });

    const other: ChecklistDraftV1 = {
      v: 1,
      return: {
        units: {},
        grids: {
          "bi-a": {
            equipmentId: "eq-bi-a",
            slots: [0, 1, 2].map(() => ({
              status: "ACCEPTED" as const,
              repairComment: "",
              problem: { reason: null, comment: "", expectedBackDate: null },
            })),
          },
          "bi-b": {
            equipmentId: "eq-bi-b",
            slots: [0, 1].map(() => ({
              status: "ACCEPTED" as const,
              repairComment: "",
              problem: { reason: null, comment: "", expectedBackDate: null },
            })),
          },
        },
      },
    };
    server.revision += 1;
    server.draft = other;
    completeSpy.mockImplementation(async (_sid: string, payload: { draftRevision?: number }) => {
      if (payload.draftRevision !== server.revision) {
        throw apiError(409, "DRAFT_OUTDATED", "Чек-лист изменили на другом устройстве — загружена свежая версия", {
          revision: server.revision,
          draft: server.draft,
          savedAt: new Date().toISOString(),
          savedBy: "Пётр",
        });
      }
      return okResult();
    });

    fireEvent.click(screen.getByRole("button", { name: /Завершить приёмку/ }));
    expect(await screen.findByText(/изменили на другом устройстве/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Завершить приёмку/ }));
    expect(await screen.findByText("Приёмка завершена")).toBeInTheDocument();
    expect(completeSpy).toHaveBeenCalledTimes(2);
  });
});

describe("ReturnChecklist: закрытая сессия и «Прервать»", () => {
  it("повторное «Завершить» (SESSION_ALREADY_COMPLETED) — уведомление вместо чек-листа и выход к списку", async () => {
    const onSessionClosed = vi.fn();
    await renderChecklist({ onSessionClosed });
    await acceptEverything();
    completeSpy.mockRejectedValueOnce(
      apiError(409, "SESSION_ALREADY_COMPLETED", "Приёмка по этой брони уже завершена", {
        sessionId: "s1",
        operation: "RETURN",
        completedAt: new Date().toISOString(),
        completedBy: "Пётр",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Завершить приёмку/ }));

    expect(await screen.findByText("Приёмка уже завершена")).toBeInTheDocument();
    expect(screen.getByText(/Пётр/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Завершить приёмку/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /К списку броней/ }));
    expect(onSessionClosed).toHaveBeenCalledTimes(1);
  });

  it("сессию закрыли, пока чек-лист был закрыт: /state отвечает SESSION_STALE — уведомление", async () => {
    getStateSpy.mockRejectedValueOnce(
      apiError(409, "SESSION_STALE", "Бронь уже принята на карточке — чек-лист закрыт, изменения из него не применены", {
        sessionId: "s1",
        operation: "RETURN",
        bookingStatus: "RETURNED",
      }),
    );
    render(<ReturnChecklist sessionId="s1" projectName="Проект" onBack={() => {}} />);
    expect(await screen.findByText(/Бронь уже принята на карточке/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /К списку броней/ })).toBeInTheDocument();
  });

  it("«Прервать приёмку»: подтверждение → cancel(KIOSK_ABORT) → чек-лист закрыт", async () => {
    const onSessionClosed = vi.fn();
    await renderChecklist({ onSessionClosed });
    fireEvent.click(screen.getByRole("button", { name: "Прервать приёмку" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/бронь останется «Выдана»/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Прервать приёмку" }));
    });
    await waitFor(() => expect(onSessionClosed).toHaveBeenCalledTimes(1));
    expect(cancelSpy).toHaveBeenCalledWith("s1", { reason: "KIOSK_ABORT" });
    expect(completeSpy).not.toHaveBeenCalled();
  });
});

describe("ReturnChecklist: пробег машин в черновике", () => {
  const gazel = { id: "bv1", vehicleId: "v1", vehicle: { id: "v1", name: "Газель", currentMileage: 1000 } };
  const savedWithMileage = (km: number): ChecklistDraftV1 => ({
    v: 1,
    return: { units: {}, grids: {}, mileages: { v1: km } },
  });

  it("открытие с сохранённым пробегом черновик не переписывает: подстановка — не правка", async () => {
    server.vehicles = [gazel];
    server.vehiclesDelayMs = 30;
    server.revision = 2;
    server.savedAt = new Date().toISOString();
    server.draft = savedWithMileage(1500);

    await renderChecklist();
    const input = (await screen.findByLabelText("Пробег для Газель")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("1500"));
    // Дольше задержки сохранения (800 мс): лишняя запись подняла бы ревизию и
    // выбила бы несохранённую правку второго планшета.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1200));
    });
    expect(saveDraftSpy).not.toHaveBeenCalled();
    expect(server.revision).toBe(2);
  });

  it("правка отметок, пока машины грузятся, не теряет восстановленный пробег", async () => {
    server.vehicles = [gazel];
    server.vehiclesDelayMs = 2500;
    server.revision = 1;
    server.draft = savedWithMileage(1500);

    await renderChecklist();
    fireEvent.click(screen.getByRole("button", { name: /Принять все 2 шт «Трубы 3м»/ }));
    await waitFor(() => expect(saveDraftSpy).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(server.draft?.return?.mileages).toEqual({ v1: 1500 });
    expect(server.draft?.return?.grids["bi-b"]).toBeDefined();
  });

  it("пробег, набранный руками, уходит в черновик", async () => {
    server.vehicles = [gazel];
    await renderChecklist();
    const input = (await screen.findByLabelText("Пробег для Газель")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1720" } });
    await waitFor(() => expect(server.draft?.return?.mileages).toEqual({ v1: 1720 }), {
      timeout: 3000,
    });
  });
});
