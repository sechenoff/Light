/**
 * Главная кнопка реестра и киоск.
 *
 * Раньше «Выдать» / «Принять возврат» молча уводили в киоск, если по брони
 * когда-либо была сессия, — и сама загрузка киоска создавала новую сессию,
 * которая потом висела и блокировала «+ Добор». Теперь в киоск ведёт только
 * живая (идущая) сессия, а подпись кнопки говорит об этом прямо.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { BookingRegisterRow } from "@light-rental/shared";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  useSearchParams: () => ({ get: () => null, toString: () => "" }),
  usePathname: () => "/bookings",
}));
const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("../../../ToastProvider", () => ({ toast: toastMock }));

import { useRegisterActions } from "../useRegisterActions";
import { hasLiveKioskSession } from "../model";

type Row = BookingRegisterRow & { liveScanSession?: boolean };

const now = new Date().toISOString();
function row(over: Partial<Row> = {}): Row {
  return {
    id: "b1",
    docNumber: "Б-1",
    mode: "STANDARD",
    status: "CONFIRMED",
    projectName: "Съёмка",
    client: { id: "c1", name: "Клиент" },
    startDate: now,
    endDate: now,
    createdAt: now,
    updatedAt: now,
    expectedPaymentDate: null,
    confirmedAt: now,
    issuedAt: null,
    finalAmount: "1000",
    amountPaid: "0",
    amountOutstanding: "1000",
    writeOffAmount: "0",
    paymentStatus: "NOT_PAID",
    paymentForm: "CASH",
    legacyFinance: false,
    hasScanSessions: false,
    lastScanOperation: null,
    lastScanStatus: null,
    financeState: "UNPAID",
    overdueAmount: "0",
    overdueDays: 0,
    creditAmount: "0",
    completed: false,
    returnOverdue: false,
    openProblems: 0,
    needsReview: false,
    actions: [],
    onHand: 0,
    projectSummary: null,
    ...over,
  };
}

function Harness({ rows, refresh }: { rows: Row[]; refresh: () => void }) {
  const a = useRegisterActions(rows, { role: "SUPER_ADMIN" } as never, refresh);
  return (
    <>
      {rows.map((r) => (
        <button key={r.id} type="button" onClick={() => a.primary(r)}>
          {a.primaryLabel(r)}
        </button>
      ))}
      {a.modals}
    </>
  );
}

beforeEach(() => {
  push.mockReset();
  apiFetchMock.mockReset();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
  toastMock.info.mockReset();
});

describe("реестр: главная кнопка и киоск", () => {
  it("прошлая (закрытая) сессия больше не уводит в киоск — кнопка спрашивает подтверждение", () => {
    render(
      <Harness
        rows={[row({ hasScanSessions: true, lastScanStatus: "COMPLETED", liveScanSession: false })]}
        refresh={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Выдать" }));
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Выдать" })).toBeInTheDocument();
  });

  it("идёт выдача в киоске — «Продолжить выдачу» открывает киоск", () => {
    render(<Harness rows={[row({ hasScanSessions: true, liveScanSession: true })]} refresh={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Продолжить выдачу" }));
    expect(push).toHaveBeenCalledWith("/warehouse/scan?booking=b1");
  });

  it("идёт приёмка в киоске — «Продолжить приёмку»", () => {
    render(
      <Harness rows={[row({ status: "ISSUED", hasScanSessions: true, liveScanSession: true })]} refresh={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Продолжить приёмку" })).toBeInTheDocument();
  });

  it("выдача кнопкой: предупреждение сервера и закрытые сессии видны сотруднику", async () => {
    apiFetchMock.mockResolvedValue({
      booking: { id: "b1", status: "RETURNED" },
      warning: "Пробег машин не записан — внесите его в карточке машины",
      closedScanSessions: 1,
    });
    const refresh = vi.fn();
    render(<Harness rows={[row({ status: "ISSUED" })]} refresh={refresh} />);
    fireEvent.click(screen.getByRole("button", { name: "Принять возврат" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Принять возврат" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/bookings/b1/status",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "return" }) }),
    );
    expect(toastMock.info).toHaveBeenCalledWith(
      "Пробег машин не записан — внесите его в карточке машины",
      expect.anything(),
    );
    expect(toastMock.info).toHaveBeenCalledWith(expect.stringContaining("сессия киоска"));
  });

  it("бронь уже изменили — понятный текст, окно закрыто, список перечитан", async () => {
    apiFetchMock.mockRejectedValue(
      Object.assign(new Error("Бронь уже выдана — обновите страницу"), {
        status: 409,
        code: "INVALID_BOOKING_STATE",
      }),
    );
    const refresh = vi.fn();
    render(<Harness rows={[row()]} refresh={refresh} />);
    fireEvent.click(screen.getByRole("button", { name: "Выдать" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Выдать" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(toastMock.error).toHaveBeenCalledWith("Бронь уже выдана. Список обновлён");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("hasLiveKioskSession", () => {
  it("только явный liveScanSession: true; старый ответ без поля — нет", () => {
    expect(hasLiveKioskSession({ id: "x", liveScanSession: true })).toBe(true);
    expect(hasLiveKioskSession({ id: "x", liveScanSession: false })).toBe(false);
    expect(hasLiveKioskSession({ id: "x" })).toBe(false);
  });
});
