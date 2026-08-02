/**
 * Deep-link tests for the warehouse-scan kiosk page (workstation v2):
 * `/warehouse/scan?booking=<id>` (кнопка «Начать сканирование» на карточке
 * брони) должен после авторизации сразу открыть чек-лист этой брони,
 * минуя стартовый экран «Смена» и выбор брони.
 *
 * Mocks: next/navigation (router + searchParams), useCurrentUser
 * (main-session SUPER_ADMIN → login step is skipped), scanApi, toast,
 * ShiftHome и оба checklist-компонента (placeholder'ы — их внутренности
 * тестируются отдельно).
 */
import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BookingSummary } from "../types";

const h = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  search: "booking=bk-1",
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: h.push, replace: h.replace }),
  useSearchParams: () => new URLSearchParams(h.search),
}));

vi.mock("../../../lib/auth", () => ({
  useCurrentUser: () => ({
    user: { role: "SUPER_ADMIN", username: "sechenoff" },
    loading: false,
  }),
}));

const toastError = vi.fn();
vi.mock("../../ToastProvider", () => ({
  toast: {
    success: vi.fn(),
    error: (m: string) => toastError(m),
    info: vi.fn(),
  },
}));

const listBookings = vi.fn();
const createSession = vi.fn();
const getState = vi.fn();
const getShift = vi.fn();
vi.mock("../api", () => ({
  scanApi: {
    listBookings: (op: string) => listBookings(op),
    createSession: (id: string, op: string) => createSession(id, op),
    getState: (id: string) => getState(id),
    getShift: () => getShift(),
    clearWarehouseToken: vi.fn(),
  },
}));

// Экран «Смена» тестируется отдельно — здесь только маркер, что мы на нём.
vi.mock("../ShiftHome", () => ({
  ShiftHome: () => <div>SHIFT-HOME</div>,
  shiftHeaderTitle: (name: string) => `Смена — ${name}`,
  shiftHeaderEyebrow: () => "Склад · Смена",
}));

/** Пустая смена — питает бейджи навигации, содержимое экрана замокано. */
const EMPTY_SHIFT = {
  date: "2026-07-03",
  timeline: [],
  overdue: [],
  counters: {
    issuesDone: 0,
    issuesPlanned: 0,
    returnsDone: 0,
    returnsPlanned: 0,
    overdue: 0,
    inWork: 0,
  },
  myShift: {
    workerName: "sechenoff",
    sessions: 0,
    items: 0,
    firstAt: null,
    avgMinutes: null,
  },
};

vi.mock("../IssueChecklist", () => ({
  IssueChecklist: ({ projectName }: { projectName: string }) => (
    <div>ISSUE-CHECKLIST {projectName}</div>
  ),
}));
vi.mock("../ReturnChecklist", () => ({
  ReturnChecklist: ({ projectName }: { projectName: string }) => (
    <div>RETURN-CHECKLIST {projectName}</div>
  ),
}));

import WarehouseScanPage from "../../../../app/warehouse/scan/page";

const BOOKING: BookingSummary = {
  id: "bk-1",
  projectName: "Проект Тест",
  client: { id: "c1", name: "Клиент Тестов" },
  startDate: "2026-07-03T09:00:00.000Z",
  endDate: "2026-07-05T18:00:00.000Z",
  status: "CONFIRMED",
  items: [{ id: "i1" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.search = "booking=bk-1";
  getState.mockResolvedValue({
    sessionId: "sess-1",
    bookingId: "bk-1",
    operation: "ISSUE",
    items: [],
    progress: { checkedItems: 0, totalItems: 0 },
  });
  createSession.mockResolvedValue({ id: "sess-1" });
  getShift.mockResolvedValue(EMPTY_SHIFT);
});

describe("WarehouseScanPage ?booking= deep-link", () => {
  it("бронь из списка выдач → сразу создаёт ISSUE-сессию и открывает чек-лист", async () => {
    listBookings.mockImplementation(async (op: string) =>
      op === "ISSUE" ? [BOOKING] : [],
    );

    render(<WarehouseScanPage />);

    // сессия создана именно для брони из deep-link, операция определена сама
    await waitFor(() =>
      expect(createSession).toHaveBeenCalledWith("bk-1", "ISSUE"),
    );
    // чек-лист открыт, стартовый экран «Смена» пропущен
    expect(
      await screen.findByText("ISSUE-CHECKLIST Проект Тест"),
    ).toBeInTheDocument();
    expect(screen.queryByText("SHIFT-HOME")).not.toBeInTheDocument();
    // query-параметр расходуется один раз — URL чистится
    await waitFor(() =>
      expect(h.replace).toHaveBeenCalledWith("/warehouse/scan"),
    );
  });

  it("бронь из списка возвратов → RETURN-сессия и чек-лист приёмки", async () => {
    getState.mockResolvedValue({
      sessionId: "sess-1",
      bookingId: "bk-1",
      operation: "RETURN",
      items: [],
      progress: { checkedItems: 0, totalItems: 0 },
    });
    listBookings.mockImplementation(async (op: string) =>
      op === "RETURN" ? [{ ...BOOKING, status: "ISSUED" }] : [],
    );

    render(<WarehouseScanPage />);

    await waitFor(() =>
      expect(createSession).toHaveBeenCalledWith("bk-1", "RETURN"),
    );
    expect(
      await screen.findByText("RETURN-CHECKLIST Проект Тест"),
    ).toBeInTheDocument();
  });

  it("бронь не найдена ни в одном списке → toast и стартовый экран «Смена»", async () => {
    listBookings.mockResolvedValue([]);

    render(<WarehouseScanPage />);

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Бронь недоступна для сканирования",
      ),
    );
    expect(createSession).not.toHaveBeenCalled();
    expect(await screen.findByText("SHIFT-HOME")).toBeInTheDocument();
  });

  it("без ?booking= — предвыбор не запускается, сразу экран «Смена»", async () => {
    h.search = "";
    listBookings.mockResolvedValue([]);

    render(<WarehouseScanPage />);

    expect(await screen.findByText("SHIFT-HOME")).toBeInTheDocument();
    expect(listBookings).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();
  });
});
