/**
 * Tests for /finance/invoices page (InvoicesPage component).
 *
 * The page uses Next.js navigation hooks (useSearchParams, useRouter),
 * useCurrentUser, and global fetch. We mock all of them at the module level.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- Module mocks must come before the import of the page ---

vi.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: () => null, toString: () => "" }),
  useRouter: () => ({ replace: vi.fn() }),
}));

vi.mock("../../../hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: { role: "SUPER_ADMIN", name: "Test Admin" }, loading: false }),
}));

vi.mock("../../../hooks/useRequireRole", () => ({
  useRequireRole: () => ({ user: { role: "SUPER_ADMIN" }, loading: false, authorized: true }),
}));

// Stub FinanceTabNav to avoid nested router dependency
vi.mock("../../finance/FinanceTabNav", () => ({
  FinanceTabNav: () => <nav data-testid="finance-tab-nav" />,
}));

// Stub CreateInvoiceModal and VoidInvoiceModal
vi.mock("../../finance/CreateInvoiceModal", () => ({
  CreateInvoiceModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="create-invoice-modal" /> : null,
}));
vi.mock("../../finance/VoidInvoiceModal", () => ({
  VoidInvoiceModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="void-invoice-modal" /> : null,
}));

// Stub RecordPaymentModal, capturing props — проверяем привязку платежа к счёту
const recordPaymentModalProps: Array<Record<string, unknown>> = [];
vi.mock("../../finance/RecordPaymentModal", () => ({
  RecordPaymentModal: (props: { open: boolean } & Record<string, unknown>) => {
    recordPaymentModalProps.push(props);
    return props.open ? <div data-testid="record-payment-modal" /> : null;
  },
}));

// Stub ToastProvider
vi.mock("../../ToastProvider", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// Import after mocks
// The page is an app router page — it exports default with Suspense wrapper
// We import the file directly and rely on the mocked useSearchParams returning an empty object
import InvoicesPageDefault from "../../../../app/finance/invoices/page";

const ORIGINAL_FETCH = global.fetch;

const SAMPLE_INVOICES: Array<Record<string, unknown>> = [
  {
    id: "inv-1",
    number: "INV-001",
    kind: "FULL",
    status: "DRAFT",
    total: "50000",
    paidAmount: "0",
    dueDate: "2026-05-15T00:00:00Z",
    createdAt: "2026-04-01T00:00:00Z",
    booking: {
      id: "booking-001",
      projectName: "Съёмки апрель",
      client: { id: "client-1", name: "Ромашка Продакшн" },
    },
  },
  {
    id: "inv-2",
    number: "INV-002",
    kind: "DEPOSIT",
    status: "ISSUED",
    total: "20000",
    paidAmount: "0",
    dueDate: "2026-04-20T00:00:00Z",
    createdAt: "2026-04-02T00:00:00Z",
    booking: {
      id: "booking-002",
      projectName: "Рекламная съёмка",
      client: { id: "client-2", name: "ООО Свет" },
    },
  },
];

beforeEach(() => {
  global.fetch = vi.fn();
  vi.clearAllMocks();
});
afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

function mockInvoicesResponse(items = SAMPLE_INVOICES) {
  (global.fetch as any).mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ items, total: items.length }),
  });
}

describe("InvoicesPage", () => {
  it("renders invoice table rows with client and project name", async () => {
    mockInvoicesResponse();
    render(<InvoicesPageDefault />);

    await waitFor(() => {
      // Both desktop table and mobile cards render the same data — use getAllByText
      expect(screen.getAllByText("Ромашка Продакшн").length).toBeGreaterThan(0);
      expect(screen.getAllByText("ООО Свет").length).toBeGreaterThan(0);
    });

    expect(screen.getAllByText("Съёмки апрель").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Рекламная съёмка").length).toBeGreaterThan(0);
  });

  it("renders all status filter tabs with unified FINANCE_TERMS labels", async () => {
    mockInvoicesResponse([]);
    render(<InvoicesPageDefault />);

    // Лейбл таба = лейбл пилюли (FINANCE_TERMS): «Черновик», не «К выставлению»
    expect(screen.getByRole("button", { name: "Все" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Черновик" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Выставлено" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Частично оплачено" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Оплачено" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Просрочено" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Аннулирован" })).toBeInTheDocument();
    // Старый лейбл ушёл
    expect(screen.queryByText(/выставлению/i)).toBeNull();
    // FIN-09: мёртвая кнопка «Экспорт XLSX» (без onClick) убрана
    expect(screen.queryByText(/Экспорт XLSX/)).toBeNull();
  });

  it("показывает derived OVERDUE (displayStatus) сразу, не дожидаясь ночного cron", async () => {
    // stored status ISSUED, но сервер отдаёт displayStatus=OVERDUE (dueDate в прошлом)
    mockInvoicesResponse([
      {
        ...SAMPLE_INVOICES[1],
        status: "ISSUED",
        displayStatus: "OVERDUE",
        dueDate: "2026-04-20T00:00:00Z",
      },
    ]);
    render(<InvoicesPageDefault />);

    await waitFor(() => {
      expect(screen.getAllByText("ООО Свет").length).toBeGreaterThan(0);
    });

    // Пилюля статуса в строке (desktop + mobile) — «Просрочено», не «Выставлено»
    expect(screen.getAllByText("Просрочено").length).toBeGreaterThanOrEqual(2);
  });

  it("shows bulk-issue bar when a DRAFT invoice is selected", async () => {
    mockInvoicesResponse();
    render(<InvoicesPageDefault />);

    // Wait for invoices to load
    await waitFor(() => {
      expect(screen.getAllByText("Ромашка Продакшн").length).toBeGreaterThan(0);
    });

    // Find the checkbox for the DRAFT invoice (inv-1) and click it
    const checkboxes = screen.getAllByRole("checkbox");
    // First checkbox is the select-all header checkbox; second is for inv-1 (DRAFT)
    fireEvent.click(checkboxes[1]);

    // Bulk bar should now appear
    await waitFor(() => {
      expect(screen.getByText(/выбрано/i)).toBeInTheDocument();
      // Button label is "Выставить выбранные" in the mockup design
      expect(screen.getByRole("button", { name: /выставить выбранные/i })).toBeInTheDocument();
    });
  });

  it("кнопка ₽ на строке счёта открывает RecordPaymentModal с legacyFinance=false и предвыбранным счётом", async () => {
    mockInvoicesResponse();
    recordPaymentModalProps.length = 0;
    render(<InvoicesPageDefault />);

    await waitFor(() => {
      expect(screen.getAllByText("ООО Свет").length).toBeGreaterThan(0);
    });

    // ₽-кнопка есть только у ISSUED/PARTIAL_PAID/OVERDUE (inv-2, booking-002)
    const payButtons = screen.getAllByRole("button", { name: "Записать платёж" });
    fireEvent.click(payButtons[0]);

    await waitFor(() => {
      expect(screen.getByTestId("record-payment-modal")).toBeInTheDocument();
    });

    const openProps = recordPaymentModalProps.find((p) => p.open === true);
    expect(openProps).toBeDefined();
    // Платёж должен уходить с invoiceId → recomputeInvoiceStatus закроет счёт
    expect(openProps).toMatchObject({
      defaultBookingId: "booking-002",
      defaultInvoiceId: "inv-2",
      legacyFinance: false,
    });
  });
});
