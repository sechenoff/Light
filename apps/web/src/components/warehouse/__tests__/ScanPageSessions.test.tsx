/**
 * Страница киоска /warehouse/scan и сессии чек-листов (P6, P7, P18, P25).
 *
 *  - смена раздела размонтирует чек-лист, но количества возвращаются из
 *    черновика на сервере (прежде терялись — F2 аудита);
 *  - следующая бронь в левом списке получает свежий экземпляр чек-листа, а не
 *    итог предыдущей (`key={sessionId}` — F3);
 *  - PIN-киоск после перезагрузки с живым токеном не требует входа (F7);
 *  - «←» и выбор другой брони прерывают пустую сессию (`EMPTY_LEAVE`), а
 *    сессию с работой не трогают;
 *  - закрытая сессия: «К списку броней» закрывает чек-лист и обновляет списки.
 *
 * Чек-лист здесь — заглушка на настоящих `useScanSession` и
 * `useChecklistDraft`, а `scanApi` — маленький сервер в памяти: так
 * проверяется вся цепочка «правка → досылка при размонтировании → /state».
 */
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useEffect, useState, type MutableRefObject } from "react";
import type { ChecklistDraftV1, ChecklistState, ScanSessionInfo } from "../types";

const h = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn(),
  search: "tab=issue",
  user: { role: "WAREHOUSE", username: "rental" } as null | { role: string; username: string },
  mounts: 0,
  auth: null as null | { token: string; workerName: string | null; expiresAt: string | null },
  drafts: new Map<string, { draft: ChecklistDraftV1; revision: number }>(),
  listVersions: [] as number[],
  selectInfo: {} as Record<string, ScanSessionInfo | undefined>,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: h.push, replace: h.replace }),
  useSearchParams: () => new URLSearchParams(h.search),
}));
vi.mock("../../../lib/auth", () => ({
  useCurrentUser: () => ({ user: h.user, loading: false }),
}));
vi.mock("../../ToastProvider", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("../ProjectWarehouseOperations", () => ({
  ProjectWarehouseOperations: () => null,
}));

const EMPTY_SHIFT = {
  date: "2026-09-28",
  timeline: [],
  overdue: [],
  readyForPickup: [],
  counters: { issuesDone: 0, issuesPlanned: 0, returnsDone: 0, returnsPlanned: 0, overdue: 0, inWork: 0 },
  myShift: { workerName: "rental", sessions: 0, items: 0, firstAt: null, avgMinutes: null },
};

function stateOf(sessionId: string): ChecklistState {
  const saved = h.drafts.get(sessionId);
  return {
    sessionId,
    bookingId: `bk-${sessionId}`,
    operation: "ISSUE",
    items: [],
    progress: { checkedItems: 0, totalItems: 0 },
    shifts: 1,
    discountPercent: "0",
    mainOriginalAfterDiscount: "0",
    draft: saved?.draft ?? null,
    draftRevision: saved?.revision ?? 0,
    draftSavedAt: null,
    draftSavedBy: null,
    itemsVersion: "v1",
  };
}

const api = vi.hoisted(() => ({
  listBookings: vi.fn(async () => []),
  createSession: vi.fn(),
  getState: vi.fn(),
  saveDraft: vi.fn(),
  cancel: vi.fn(),
  getShift: vi.fn(),
  getActiveStockCount: vi.fn(async () => null),
  clearWarehouseToken: vi.fn(),
  getWarehouseAuth: vi.fn(() => h.auth),
}));
vi.mock("../api", () => ({ scanApi: api }));

vi.mock("../ShiftHome", () => ({
  ShiftHome: () => <div>SHIFT-HOME</div>,
  shiftHeaderTitle: (name: string) => `Смена — ${name}`,
  shiftHeaderEyebrow: () => "Склад · Смена",
}));
vi.mock("../LoginStep", () => ({
  LoginStep: () => <div>LOGIN-STEP</div>,
}));

const BK = (id: string) => ({
  id,
  projectName: `Проект ${id}`,
  client: { id: "c", name: "Клиент" },
  startDate: "2026-09-28T09:00:00.000Z",
  endDate: "2026-09-29T09:00:00.000Z",
  status: "CONFIRMED",
  items: [{ id: "i" }],
});
vi.mock("../BookingList", () => ({
  BookingList: ({
    onSelect,
    version,
  }: {
    onSelect: (sid: string, b: unknown, info?: ScanSessionInfo) => void;
    version: number;
  }) => {
    h.listVersions.push(version);
    return (
      <div>
        <span>{`LIST v=${version}`}</span>
        <button type="button" onClick={() => onSelect("sess-A", BK("A"), h.selectInfo["sess-A"])}>
          pick-A
        </button>
        <button type="button" onClick={() => onSelect("sess-B", BK("B"), h.selectInfo["sess-B"])}>
          pick-B
        </button>
      </div>
    );
  },
}));

// Чек-лист-заглушка на настоящих хуках сессии и черновика.
vi.mock("../IssueChecklist", async () => {
  const { useScanSession } = await import("../useScanSession");
  const { useChecklistDraft } = await import("../useChecklistDraft");

  function DraftChecklist(props: {
    sessionId: string;
    projectName: string;
    onBack: () => void;
    onComplete?: () => void;
    resumed?: ScanSessionInfo | null;
    leaveRef?: MutableRefObject<(() => void) | null>;
    onSessionClosed?: () => void;
  }) {
    const { state, openSession } = useScanSession();
    const [count, setCount] = useState<number | null>(null);
    const [done, setDone] = useState(false);
    const [mountId] = useState(() => ++h.mounts);
    const draft = useChecklistDraft({
      sessionId: props.sessionId,
      serverRevision: state?.draftRevision,
      serverDraft: state?.draft,
      leaveRef: props.leaveRef,
    });

    useEffect(() => {
      void openSession(props.sessionId, "ISSUE");
    }, [openSession, props.sessionId]);

    useEffect(() => {
      if (state && count === null) setCount(state.draft?.issue?.rows.bi1?.qty ?? 0);
    }, [state, count]);

    function bump() {
      const next = (count ?? 0) + 1;
      setCount(next);
      draft.schedule({ v: 1, issue: { rows: { bi1: { qty: next, checked: false, equipmentId: null } } } });
    }

    return (
      <div>
        <span>
          {`CHECKLIST sess=${props.sessionId} project=${props.projectName} count=${count ?? "…"} mount=${mountId}`}
        </span>
        {props.resumed && <span>{`RESUMED by ${props.resumed.workerName}`}</span>}
        {done && <span>RESULT-SCREEN</span>}
        <button type="button" onClick={bump}>
          bump
        </button>
        <button type="button" onClick={() => setDone(true)}>
          finish
        </button>
        <button type="button" onClick={() => props.onComplete?.()}>
          result-done
        </button>
        <button type="button" onClick={() => props.onSessionClosed?.()}>
          closed-back
        </button>
      </div>
    );
  }
  return { IssueChecklist: DraftChecklist };
});
vi.mock("../ReturnChecklist", () => ({ ReturnChecklist: () => <div>RETURN-CHECKLIST</div> }));

import WarehouseScanPage from "../../../../app/warehouse/scan/page";
import { _resetChecklistDraftsForTests } from "../useChecklistDraft";

beforeEach(() => {
  vi.clearAllMocks();
  _resetChecklistDraftsForTests();
  h.search = "tab=issue";
  h.user = { role: "WAREHOUSE", username: "rental" };
  h.mounts = 0;
  h.auth = null;
  h.drafts = new Map();
  h.listVersions = [];
  h.selectInfo = {};
  window.sessionStorage.clear();

  api.getShift.mockResolvedValue(EMPTY_SHIFT);
  api.getState.mockImplementation(async (sid: string) => stateOf(sid));
  api.saveDraft.mockImplementation(async (sid: string, revision: number, draft: ChecklistDraftV1) => {
    const current = h.drafts.get(sid)?.revision ?? 0;
    if (revision !== current) {
      throw { status: 409, code: "DRAFT_OUTDATED", message: "Чек-лист изменили на другом устройстве", details: null };
    }
    h.drafts.set(sid, { draft, revision: current + 1 });
    return { revision: current + 1, savedAt: new Date().toISOString() };
  });
  // Сервер прерывает только сессию без работы (onlyIfEmpty).
  api.cancel.mockImplementation(async (sid: string) => ({
    id: sid,
    bookingId: `bk-${sid}`,
    operation: "ISSUE",
    status: h.drafts.has(sid) ? "ACTIVE" : "CANCELLED",
    cancelled: !h.drafts.has(sid),
  }));
});

const EMPTY_LEAVE = { onlyIfEmpty: true, reason: "EMPTY_LEAVE", keepalive: true };

describe("страница киоска: чек-лист и сессия", () => {
  it("смена раздела: чек-лист размонтирован, но количества возвращаются из черновика", async () => {
    render(<WarehouseScanPage />);
    fireEvent.click(await screen.findByText("pick-A"));
    await screen.findByText(/sess=sess-A .* count=0 mount=1/);
    fireEvent.click(screen.getByText("bump"));
    fireEvent.click(screen.getByText("bump"));
    expect(screen.getByText(/count=2 mount=1/)).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: /Смена/ })[0]);
    expect(await screen.findByText("SHIFT-HOME")).toBeInTheDocument();
    // Досылка при размонтировании — не дожидаясь 800 мс.
    await waitFor(() => expect(h.drafts.get("sess-A")?.draft.issue?.rows.bi1?.qty).toBe(2));

    fireEvent.click(screen.getAllByRole("button", { name: /Выдача/ })[0]);
    expect(await screen.findByText(/sess=sess-A .* count=2 mount=2/)).toBeInTheDocument();
    // Уход в «Смену» — не уход с брони: сессию не прерывали.
    expect(api.cancel).not.toHaveBeenCalled();
  });

  it("после итога брони A выбор брони B открывает свежий чек-лист B, без итога A", async () => {
    render(<WarehouseScanPage />);
    fireEvent.click(await screen.findByText("pick-A"));
    fireEvent.click(await screen.findByText("finish"));
    expect(screen.getByText("RESULT-SCREEN")).toBeInTheDocument();

    fireEvent.click(screen.getByText("pick-B"));
    await waitFor(() => expect(screen.getByText(/sess=sess-B project=Проект B/)).toBeInTheDocument());
    expect(screen.getByText(/sess=sess-B .* mount=2/)).toBeInTheDocument();
    expect(screen.queryByText("RESULT-SCREEN")).not.toBeInTheDocument();
  });

  it("PIN-киоск: после перезагрузки с живым токеном входа заново не требуется, имя из токена", async () => {
    h.user = null; // главной сессии нет — вход только по PIN
    h.auth = { token: "t", workerName: "Иван Кладовщик", expiresAt: "2099-01-01T00:00:00.000Z" };
    render(<WarehouseScanPage />);

    expect(await screen.findByText("Иван Кладовщик")).toBeInTheDocument();
    expect(screen.queryByText("LOGIN-STEP")).not.toBeInTheDocument();
    expect(screen.queryByText("Вход на склад")).not.toBeInTheDocument();
  });

  it("PIN-киоск без живого токена — экран входа", async () => {
    h.user = null;
    h.auth = null;
    render(<WarehouseScanPage />);
    expect(await screen.findByText("LOGIN-STEP")).toBeInTheDocument();
  });

  it("«←» с нетронутого чек-листа прерывает пустую сессию (EMPTY_LEAVE)", async () => {
    render(<WarehouseScanPage />);
    fireEvent.click(await screen.findByText("pick-A"));
    await screen.findByText(/sess=sess-A .* count=0/);

    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    await waitFor(() => expect(api.cancel).toHaveBeenCalledWith("sess-A", EMPTY_LEAVE));
    expect(screen.queryByText(/CHECKLIST/)).not.toBeInTheDocument();
  });

  it("«←» после правок: черновик досылается, сессия остаётся", async () => {
    render(<WarehouseScanPage />);
    fireEvent.click(await screen.findByText("pick-A"));
    await screen.findByText(/sess=sess-A .* count=0/);
    fireEvent.click(screen.getByText("bump"));

    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    await waitFor(() => expect(h.drafts.get("sess-A")?.draft.issue?.rows.bi1?.qty).toBe(1));
    expect(api.cancel).not.toHaveBeenCalled();
  });

  it("выбор другой брони — уход с прежней: пустая сессия A прерывается", async () => {
    render(<WarehouseScanPage />);
    fireEvent.click(await screen.findByText("pick-A"));
    await screen.findByText(/sess=sess-A .* count=0/);

    fireEvent.click(screen.getByText("pick-B"));
    await screen.findByText(/sess=sess-B/);
    await waitFor(() => expect(api.cancel).toHaveBeenCalledWith("sess-A", EMPTY_LEAVE));
    expect(api.cancel).not.toHaveBeenCalledWith("sess-B", expect.anything());
  });

  it("«Готово» на итоге закрывает чек-лист без прерывания сессии", async () => {
    render(<WarehouseScanPage />);
    fireEvent.click(await screen.findByText("pick-A"));
    await screen.findByText(/sess=sess-A .* count=0/);

    fireEvent.click(screen.getByText("result-done"));
    await waitFor(() => expect(screen.queryByText(/CHECKLIST/)).not.toBeInTheDocument());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(api.cancel).not.toHaveBeenCalled();
  });

  it("сессию закрыли: «К списку броней» закрывает чек-лист и перечитывает список", async () => {
    render(<WarehouseScanPage />);
    fireEvent.click(await screen.findByText("pick-A"));
    await screen.findByText(/sess=sess-A/);
    const before = Math.max(...h.listVersions);

    fireEvent.click(screen.getByText("closed-back"));
    await waitFor(() => expect(screen.queryByText(/CHECKLIST/)).not.toBeInTheDocument());
    expect(screen.getByText(`LIST v=${before + 1}`)).toBeInTheDocument();
    expect(api.cancel).not.toHaveBeenCalled();
  });

  it("продолженная сессия: чек-лист получает resumed (плашку рисует он)", async () => {
    h.selectInfo["sess-A"] = {
      id: "sess-A",
      bookingId: "A",
      operation: "ISSUE",
      status: "ACTIVE",
      resumed: true,
      workerName: "Пётр",
      startedAt: "2026-09-28T08:00:00.000Z",
    };
    render(<WarehouseScanPage />);
    fireEvent.click(await screen.findByText("pick-A"));
    expect(await screen.findByText("RESUMED by Пётр")).toBeInTheDocument();
    // Страница свою плашку больше не рисует — только чек-лист.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("pick-B"));
    await screen.findByText(/sess=sess-B/);
    expect(screen.queryByText(/RESUMED/)).not.toBeInTheDocument();
  });
});
