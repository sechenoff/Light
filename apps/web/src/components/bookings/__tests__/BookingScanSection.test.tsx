/**
 * Карточка «Киоск склада» на странице брони.
 *
 * Брошенную в киоске выдачу или приёмку раньше нельзя было закрыть ничем, и
 * она блокировала «+ Добор» до конца аренды. Теперь у открытой сессии есть
 * «Прервать» (руководитель и кладовщик), устаревшая сессия подписана как
 * «Устарела», а у завершённой и прерванной видно, кто и почему.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("../../ToastProvider", () => ({ toast: toastMock }));

import { BookingScanSection, type ScanSessionSummary } from "../BookingScanSection";

const HOUR = 3600_000;
const startedAt = new Date(Date.now() - 2 * HOUR).toISOString();

function session(over: Partial<ScanSessionSummary> = {}): ScanSessionSummary {
  return {
    id: "s-1",
    operation: "ISSUE",
    status: "ACTIVE",
    workerName: "Иван",
    createdAt: startedAt,
    completedAt: null,
    _count: { scanRecords: 0 },
    stale: false,
    hasDraft: false,
    completedBy: null,
    cancelReason: null,
    cancelledAt: null,
    ...over,
  };
}

function apiError(message: string, code: string, status = 409) {
  return Object.assign(new Error(message), { status, code });
}

beforeEach(() => {
  apiFetchMock.mockReset();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
  toastMock.info.mockReset();
});

describe("BookingScanSection", () => {
  it("не показывается у черновика и отменённой брони", () => {
    const { container } = render(
      <BookingScanSection bookingId="b1" bookingStatus="DRAFT" scanSessions={[session()]} userRole="SUPER_ADMIN" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("живая выдача: «Прервать» спрашивает подтверждение, шлёт CARD_ABORT и обновляет карточку", async () => {
    apiFetchMock.mockResolvedValue({ id: "s-1", status: "CANCELLED", cancelled: true });
    const onChanged = vi.fn();
    render(
      <BookingScanSection
        bookingId="b1"
        bookingStatus="CONFIRMED"
        scanSessions={[session({ hasDraft: true })]}
        userRole="WAREHOUSE"
        onChanged={onChanged}
      />,
    );
    expect(screen.getByText("Идёт")).toBeInTheDocument();
    expect(screen.getByText(/сохранённые отметки/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Прервать выдачу в киоске" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("останется «Подтверждена»");
    expect(dialog).toHaveTextContent("пропадут");
    expect(apiFetchMock).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Прервать выдачу" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/warehouse/sessions/s-1/cancel",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ reason: "CARD_ABORT" }) }),
    );
    expect(toastMock.success).toHaveBeenCalledWith(expect.stringContaining("Выдача в киоске прервана"));
  });

  it("приёмку прервать: в тексте — бронь останется «Выдана»", () => {
    render(
      <BookingScanSection
        bookingId="b1"
        bookingStatus="ISSUED"
        scanSessions={[session({ operation: "RETURN" })]}
        userRole="SUPER_ADMIN"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Прервать приёмку в киоске" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("останется «Выдана»");
  });

  it("сессию уже завершили — сообщение сервера и перечитывание карточки", async () => {
    apiFetchMock.mockRejectedValue(apiError("Приёмка по этой брони уже завершена", "SESSION_ALREADY_COMPLETED"));
    const onChanged = vi.fn();
    render(
      <BookingScanSection
        bookingId="b1"
        bookingStatus="ISSUED"
        scanSessions={[session({ operation: "RETURN" })]}
        userRole="SUPER_ADMIN"
        onChanged={onChanged}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Прервать приёмку в киоске" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Прервать приёмку" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(toastMock.info).toHaveBeenCalledWith("Приёмка по этой брони уже завершена");
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("устаревшая сессия подписана «Устарела», закрывается без подтверждения", async () => {
    apiFetchMock.mockResolvedValue({ id: "s-1", status: "CANCELLED", cancelled: true });
    const onChanged = vi.fn();
    render(
      <BookingScanSection
        bookingId="b1"
        bookingStatus="RETURNED"
        scanSessions={[session({ operation: "RETURN", stale: true })]}
        userRole="SUPER_ADMIN"
        onChanged={onChanged}
      />,
    );
    expect(screen.getByText("Устарела")).toBeInTheDocument();
    expect(screen.getByText(/ничего не блокирует/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть устаревшую сессию" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/warehouse/sessions/s-1/cancel",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("старый ответ API без поля stale: сессия выдачи на выданной брони считается устаревшей", () => {
    const legacy = session();
    delete legacy.stale;
    render(
      <BookingScanSection bookingId="b1" bookingStatus="ISSUED" scanSessions={[legacy]} userRole="SUPER_ADMIN" />,
    );
    expect(screen.getByText("Устарела")).toBeInTheDocument();
  });

  it("техник видит сессии, но прервать не может", () => {
    render(
      <BookingScanSection bookingId="b1" bookingStatus="CONFIRMED" scanSessions={[session()]} userRole="TECHNICIAN" />,
    );
    expect(screen.getByText("Идёт")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Прервать/ })).not.toBeInTheDocument();
    // Без черновика «отметок нет» не утверждаем: добор на месте в hasDraft не входит.
    expect(screen.queryByText(/отмет/i)).not.toBeInTheDocument();
  });

  it("у завершённой — кто завершил, у прерванной — почему", () => {
    render(
      <BookingScanSection
        bookingId="b1"
        bookingStatus="RETURNED"
        userRole="SUPER_ADMIN"
        scanSessions={[
          session({
            id: "done",
            status: "COMPLETED",
            completedBy: "Пётр",
            completedAt: new Date(Date.now() - HOUR).toISOString(),
          }),
          session({
            id: "cancelled",
            operation: "RETURN",
            status: "CANCELLED",
            cancelReason: "BOOKING_RETURNED_MANUALLY",
            cancelledAt: new Date(Date.now() - HOUR).toISOString(),
          }),
        ]}
      />,
    );
    expect(screen.getByText(/Завершил Пётр/)).toBeInTheDocument();
    expect(screen.getByText(/Возврат отмечен кнопкой на карточке/)).toBeInTheDocument();
    expect(screen.getByText("Прервана")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Прервать|Закрыть/ })).not.toBeInTheDocument();
  });

  it("ссылка в киоск: «Продолжить», если выдача уже идёт; без сессии — «Выдать через киоск»", () => {
    const { rerender } = render(
      <BookingScanSection bookingId="b1" bookingStatus="CONFIRMED" scanSessions={[session()]} userRole="SUPER_ADMIN" />,
    );
    expect(screen.getByRole("link", { name: /Продолжить в киоске/ })).toHaveAttribute(
      "href",
      "/warehouse/scan?booking=b1",
    );
    rerender(<BookingScanSection bookingId="b1" bookingStatus="CONFIRMED" scanSessions={[]} userRole="SUPER_ADMIN" />);
    expect(screen.getByRole("link", { name: /Выдать через киоск/ })).toBeInTheDocument();
    rerender(<BookingScanSection bookingId="b1" bookingStatus="ISSUED" scanSessions={[]} userRole="SUPER_ADMIN" />);
    expect(screen.getByRole("link", { name: /Принять через киоск/ })).toBeInTheDocument();
    rerender(
      <BookingScanSection bookingId="b1" bookingStatus="ISSUED" scanSessions={[]} userRole="SUPER_ADMIN" archived />,
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
