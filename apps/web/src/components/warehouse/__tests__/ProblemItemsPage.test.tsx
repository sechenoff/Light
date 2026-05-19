/**
 * Behavioral tests for ProblemItemsPage (manager-facing «Потеряшки» registry).
 *
 * Mocks: useRequireRole (authorized SUPER_ADMIN), ToastProvider, and the
 * JWT web client `apiFetch` (../../lib/api). We assert the rendered Russian
 * labels, NO barcode, status-filter refetch with ?status=, resolve-button
 * visibility by status, the resolve modal note ≥ 3 gate + endpoint payload,
 * cursor pagination append, and 409 closed handling (RU message + refetch).
 */
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Module mocks must come before importing the component ---

vi.mock("../../../hooks/useRequireRole", () => ({
  useRequireRole: () => ({
    user: { role: "SUPER_ADMIN" },
    loading: false,
    authorized: true,
  }),
}));

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

import { ProblemItemsPage } from "../ProblemItemsPage";

// --- Fixtures ---

const OPEN_ITEM = {
  id: "pi-open",
  equipmentUnitId: "eu-1",
  sourceBookingId: "ckbooking000123ABCDEF",
  reason: "LOST" as const,
  comment: "Не вернули со смены",
  expectedBackDate: null,
  status: "SEARCHING" as const,
  createdBy: "sechenoff",
  createdAt: "2026-05-10T08:00:00.000Z",
  resolvedAt: null,
  resolvedBy: null,
  resolutionNote: null,
  equipmentUnit: {
    id: "eu-1",
    equipment: { name: "Aputure 600d", category: "Свет" },
  },
};

const CLOSED_ITEM = {
  id: "pi-closed",
  equipmentUnitId: "eu-2",
  sourceBookingId: null,
  reason: "LEFT_ON_SITE" as const,
  comment: "Остался на локации",
  expectedBackDate: "2026-05-22T00:00:00.000Z",
  status: "FOUND" as const,
  createdBy: "ivan",
  createdAt: "2026-05-09T08:00:00.000Z",
  resolvedAt: "2026-05-12T09:00:00.000Z",
  resolvedBy: "sechenoff",
  resolutionNote: "Нашёлся на складе",
  equipmentUnit: {
    id: "eu-2",
    equipment: { name: "Tripod Manfrotto", category: "Опоры" },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ProblemItemsPage", () => {
  it("renders rows with equipment name + RU reason/status labels and NO barcode", async () => {
    apiFetch.mockResolvedValueOnce({
      items: [OPEN_ITEM, CLOSED_ITEM],
      nextCursor: null,
    });

    const { container } = render(<ProblemItemsPage />);

    await waitFor(() =>
      expect(screen.getAllByText("Aputure 600d").length).toBeGreaterThan(0),
    );

    // RU human-readable labels, never raw ENUM
    expect(screen.getAllByText("Потерян").length).toBeGreaterThan(0);
    expect(screen.getAllByText("На поиске").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Остался на площадке").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Найдено").length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(/SEARCHING|LOST|LEFT_ON_SITE|FOUND/);

    // booking ref = #last6 upper, or — when null
    expect(screen.getAllByText("#ABCDEF").length).toBeGreaterThan(0);

    // NO barcode anywhere (LR-XXX-NNN pattern)
    expect(container.textContent || "").not.toMatch(/LR-[A-Z0-9]+-\d+/);

    // first fetch hits the endpoint without a status filter
    expect(apiFetch.mock.calls[0][0]).toMatch(/^\/api\/problem-items\?/);
    expect(apiFetch.mock.calls[0][0]).not.toMatch(/status=/);
  });

  it("status filter pill refetches with ?status=", async () => {
    apiFetch.mockResolvedValueOnce({ items: [OPEN_ITEM], nextCursor: null });
    render(<ProblemItemsPage />);
    await waitFor(() =>
      expect(screen.getAllByText("Aputure 600d").length).toBeGreaterThan(0),
    );

    apiFetch.mockResolvedValueOnce({ items: [], nextCursor: null });
    // The status filter pill (group) — not the row resolve buttons.
    const filterGroup = screen.getByRole("group", {
      name: "Фильтр по статусу",
    });
    fireEvent.click(
      within(filterGroup).getByRole("button", { name: "Не найдено" }),
    );

    await waitFor(() =>
      expect(
        apiFetch.mock.calls.some((c) =>
          String(c[0]).includes("status=NOT_FOUND"),
        ),
      ).toBe(true),
    );
  });

  it("OPEN item shows resolve buttons; closed item shows resolution info, no buttons", async () => {
    apiFetch.mockResolvedValueOnce({
      items: [OPEN_ITEM, CLOSED_ITEM],
      nextCursor: null,
    });
    render(<ProblemItemsPage />);
    await waitFor(() =>
      expect(screen.getAllByText("Aputure 600d").length).toBeGreaterThan(0),
    );

    // OPEN row → resolve action buttons present (desktop + mobile copies)
    expect(
      screen.getAllByRole("button", { name: "Отметить «Найдено»" }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("button", { name: "Отметить «Не найдено»" }).length,
    ).toBeGreaterThan(0);

    // Closed row → resolution note + resolvedBy shown, no action buttons there
    expect(screen.getAllByText("Нашёлся на складе").length).toBeGreaterThan(0);
  });

  it("resolve modal blocks submit until note ≥ 3 chars, then POSTs {outcome,note} and reflects new status", async () => {
    apiFetch.mockResolvedValueOnce({ items: [OPEN_ITEM], nextCursor: null });
    render(<ProblemItemsPage />);
    await waitFor(() =>
      expect(screen.getAllByText("Aputure 600d").length).toBeGreaterThan(0),
    );

    // Open the FOUND resolve modal
    fireEvent.click(
      screen.getAllByRole("button", { name: "Отметить «Найдено»" })[0],
    );
    const dialog = await screen.findByRole("dialog");
    const submitBtn = within(dialog).getByRole("button", {
      name: "Подтвердить «Найдено»",
    });

    // Empty note → submit blocked (button disabled), no resolve API call
    expect(submitBtn).toBeDisabled();

    // Too-short note (2 chars) → still blocked, no resolve API call
    fireEvent.change(within(dialog).getByLabelText(/Заметка/), {
      target: { value: "ok" },
    });
    expect(submitBtn).toBeDisabled();
    fireEvent.click(submitBtn);
    expect(apiFetch).toHaveBeenCalledTimes(1); // only the initial list load

    // Valid note → resolve endpoint called with {outcome, note}
    apiFetch.mockResolvedValueOnce({
      item: { ...OPEN_ITEM, status: "FOUND", resolvedBy: "sechenoff" },
    });
    fireEvent.change(within(dialog).getByLabelText(/Заметка/), {
      target: { value: "нашёлся на складе" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Подтвердить «Найдено»" }),
    );

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "/api/problem-items/pi-open/resolve",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const body = JSON.parse(
      (apiFetch.mock.calls.find(
        (c) => c[0] === "/api/problem-items/pi-open/resolve",
      )![1] as RequestInit).body as string,
    );
    expect(body).toEqual({ outcome: "FOUND", note: "нашёлся на складе" });

    // Status flipped in the row, modal closed, success toast.
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    // Row status pill now reads «Найдено» (desktop + mobile copies). The
    // filter-pill bar always renders «На поиске» as a button — exclude it
    // and assert no SEARCHING status pill remains in the list.
    expect(screen.getAllByText("Найдено").length).toBeGreaterThan(0);
    const remainingSearching = screen
      .queryAllByText("На поиске")
      .filter((el) => el.tagName.toLowerCase() !== "button");
    expect(remainingSearching.length).toBe(0);
    expect(toastSuccess).toHaveBeenCalled();
  });

  it("renders dates with the year (DD.MM.YYYY) — registry spans year boundaries", async () => {
    apiFetch.mockResolvedValueOnce({
      items: [OPEN_ITEM, CLOSED_ITEM],
      nextCursor: null,
    });
    render(<ProblemItemsPage />);
    await waitFor(() =>
      expect(screen.getAllByText("Aputure 600d").length).toBeGreaterThan(0),
    );

    // createdAt 2026-05-10T08:00Z → «10.05.2026» (year-bearing canon,
    // same approach as /admin/audit). Daytime-UTC fixtures → no TZ-boundary
    // flake on the year/day.
    expect(screen.getAllByText(/\b10\.05\.2026\b/).length).toBeGreaterThan(0);
    // resolvedAt 2026-05-12T09:00Z shown in resolution info with the year.
    expect(screen.getAllByText(/\b12\.05\.2026\b/).length).toBeGreaterThan(0);
    // The year must always be present — no bare DD.MM rendered anywhere.
    const txt = document.body.textContent || "";
    expect(txt).not.toMatch(/(?<!\d)\d{2}\.\d{2}(?!\.\d{4})(?!\d)/);
  });

  it("resolving a row out of the active status filter removes it (reconciles with filter)", async () => {
    // Initial unfiltered list with a SEARCHING row.
    apiFetch.mockResolvedValueOnce({ items: [OPEN_ITEM], nextCursor: null });
    render(<ProblemItemsPage />);
    await waitFor(() =>
      expect(screen.getAllByText("Aputure 600d").length).toBeGreaterThan(0),
    );

    // Activate the «На поиске» (SEARCHING) status filter → refetch returns
    // the still-SEARCHING row (matches the active filter).
    apiFetch.mockResolvedValueOnce({ items: [OPEN_ITEM], nextCursor: null });
    const filterGroup = screen.getByRole("group", {
      name: "Фильтр по статусу",
    });
    fireEvent.click(
      within(filterGroup).getByRole("button", { name: "На поиске" }),
    );
    await waitFor(() =>
      expect(
        apiFetch.mock.calls.some((c) =>
          String(c[0]).includes("status=SEARCHING"),
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(screen.getAllByText("Aputure 600d").length).toBeGreaterThan(0),
    );

    // Resolve the visible SEARCHING row as FOUND.
    fireEvent.click(
      screen.getAllByRole("button", { name: "Отметить «Найдено»" })[0],
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Заметка/), {
      target: { value: "нашёлся на складе" },
    });

    // resolve POST succeeds → server now returns FOUND for this row.
    apiFetch.mockResolvedValueOnce({
      item: { ...OPEN_ITEM, status: "FOUND", resolvedBy: "sechenoff" },
    });
    // Reconcile refetch with the SEARCHING filter still active → the row
    // no longer matches, so the list comes back empty.
    apiFetch.mockResolvedValueOnce({ items: [], nextCursor: null });

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Подтвердить «Найдено»" }),
    );

    // Resolve POST carried the right payload.
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "/api/problem-items/pi-open/resolve",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const body = JSON.parse(
      (apiFetch.mock.calls.find(
        (c) => c[0] === "/api/problem-items/pi-open/resolve",
      )![1] as RequestInit).body as string,
    );
    expect(body).toEqual({ outcome: "FOUND", note: "нашёлся на складе" });

    // Modal closed, success toast, and a reconcile refetch was issued
    // because a status filter is active.
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(toastSuccess).toHaveBeenCalled();
    await waitFor(() =>
      expect(
        apiFetch.mock.calls.filter((c) =>
          String(c[0]).includes("status=SEARCHING"),
        ).length,
      ).toBeGreaterThanOrEqual(2),
    );

    // The resolved-out-of-filter row is REMOVED from the list — the list
    // reconciles with the active «На поиске» filter (only the filter pill
    // bar still renders that label as a button).
    await waitFor(() =>
      expect(screen.queryByText("Aputure 600d")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Потеряшек нет")).toBeInTheDocument();
  });

  it("«Загрузить ещё» appends the next page using nextCursor", async () => {
    apiFetch.mockResolvedValueOnce({
      items: [OPEN_ITEM],
      nextCursor: "cursor-1",
    });
    render(<ProblemItemsPage />);
    await waitFor(() =>
      expect(screen.getAllByText("Aputure 600d").length).toBeGreaterThan(0),
    );

    apiFetch.mockResolvedValueOnce({
      items: [{ ...CLOSED_ITEM, id: "pi-2" }],
      nextCursor: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "Загрузить ещё" }));

    await waitFor(() =>
      expect(
        apiFetch.mock.calls.some((c) =>
          String(c[0]).includes("cursor=cursor-1"),
        ),
      ).toBe(true),
    );
    // Both pages now present (append, not replace)
    await waitFor(() => {
      expect(screen.getAllByText("Aputure 600d").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Tripod Manfrotto").length).toBeGreaterThan(0);
    });
  });

  it("handles 409 PROBLEM_ITEM_CLOSED with a RU message and refetch", async () => {
    apiFetch.mockResolvedValueOnce({ items: [OPEN_ITEM], nextCursor: null });
    render(<ProblemItemsPage />);
    await waitFor(() =>
      expect(screen.getAllByText("Aputure 600d").length).toBeGreaterThan(0),
    );

    fireEvent.click(
      screen.getAllByRole("button", { name: "Отметить «Не найдено»" })[0],
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Заметка/), {
      target: { value: "клиент не отвечает" },
    });

    // resolve → 409 closed (ApiFetchError shape: { status, details })
    apiFetch.mockRejectedValueOnce(
      Object.assign(new Error("Запись уже закрыта"), {
        status: 409,
        details: "PROBLEM_ITEM_CLOSED",
      }),
    );
    // subsequent refetch
    apiFetch.mockResolvedValueOnce({
      items: [{ ...OPEN_ITEM, status: "NOT_FOUND" }],
      nextCursor: null,
    });

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Подтвердить «Не найдено»" }),
    );

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Карточка уже разобрана другим пользователем",
      ),
    );
    // modal closed + a refetch was issued after the 409
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(apiFetch).toHaveBeenCalledTimes(3); // list, resolve(409), refetch
  });
});
