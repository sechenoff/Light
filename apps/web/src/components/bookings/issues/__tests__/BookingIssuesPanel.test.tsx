import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BookingIssuesResponse } from "@light-rental/shared";
const api = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/api", () => ({ apiFetch: api }));
vi.mock("../../../repair/AddRepairModal", () => ({ AddRepairModal: ({ sourceBooking, onClose, onCreated }: any) => <div role="dialog" aria-label="Новая поломка">{sourceBooking.id} · {sourceBooking.name}<button onClick={onClose}>Закрыть форму</button><button onClick={onCreated}>Сохранить поломку</button></div> }));
import { BookingIssuesPanel } from "../BookingIssuesPanel";
import { RentalState } from "../../register/RegisterCells";
const data: BookingIssuesResponse = {
  booking: { id: "b1", projectName: "Сериал", clientName: "Клиент", archived: false },
  summary: { openCases: 2, missingCases: 1, missingQuantity: 3, damageCases: 1, damageQuantity: 1, waitingCases: 1, overdueCases: 1, closedCases: 1 },
  items: [
    { id: "p1", kind: "missing", equipmentName: "Кабель", quantity: 3, title: "Осталось на площадке", description: "Привезут завтра", statusLabel: "Ожидаем возврат", open: true, overdue: true, expectedAt: "2026-09-17T00:00:00Z", createdAt: "2026-09-16T10:00:00Z", createdBy: "Иван", assignedTo: null, closedAt: null, closedBy: null, resolution: null, nextStep: "Подтвердить досдачу", photos: [], href: "/warehouse/problems?bookingId=b1" },
    { id: "r1", kind: "damage", equipmentName: "Прибор", quantity: 1, title: "Повреждение", description: "Разъём сломан", statusLabel: "В ремонте", open: true, overdue: false, expectedAt: null, createdAt: "2026-09-16T10:00:00Z", createdBy: "Иван", assignedTo: "Пётр", closedAt: null, closedBy: null, resolution: "Заказали деталь", nextStep: "Проверить срок", photos: [{ id: "photo1", url: "/api/repairs/r1/photos/photo1" }], href: "/repair/r1" },
    { id: "old", kind: "missing", equipmentName: "Старая стойка", quantity: 1, title: "Потеряно", description: "Нашлась", statusLabel: "Найдено", open: false, overdue: false, expectedAt: null, createdAt: "2026-09-01T10:00:00Z", createdBy: "Иван", assignedTo: null, closedAt: "2026-09-02T10:00:00Z", closedBy: "Иван", resolution: "Вернули", nextStep: "Завершено", photos: [], href: "/warehouse/problems?bookingId=b1" },
  ],
};
beforeEach(() => {
  vi.clearAllMocks(); api.mockResolvedValue(data);
  HTMLDialogElement.prototype.showModal = function() { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function() { this.removeAttribute("open"); };
});
describe("Booking problems panel", () => {
  it("opens project-specific details, links and authenticated photos, with history separately", async () => {
    render(<BookingIssuesPanel bookingId="b1" close={vi.fn()} />);
    expect(await screen.findByText("Кабель", { exact: false })).toBeVisible();
    expect(api).toHaveBeenCalledWith("/api/bookings/b1/issues", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.queryByText("Старая стойка", { exact: false })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Разобрать недостачу →" })).toHaveAttribute("href", "/warehouse/problems?bookingId=b1");
    expect(screen.getByRole("link", { name: "Открыть ремонт →" })).toHaveAttribute("href", "/repair/r1");
    expect(screen.getByRole("img")).toHaveAttribute("src", "/api/repairs/r1/photos/photo1");
    fireEvent.click(screen.getByRole("button", { name: "История · 1" }));
    expect(screen.getByText("Старая стойка", { exact: false })).toBeVisible();
    expect(screen.queryByText("Кабель", { exact: false })).not.toBeInTheDocument();
  });
  it("opens the existing repair form with the correct booking and restores the panel afterwards", async () => {
    render(<BookingIssuesPanel bookingId="b1" close={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "+ Зафиксировать проблему" }));
    fireEvent.click(screen.getByRole("button", { name: "Зафиксировать повреждение" }));
    expect(within(screen.getByRole("dialog", { name: "Новая поломка" })).getByText("b1 · Сериал")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Сохранить поломку" }));
    await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("dialog", { name: "Новая поломка" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть форму" }));
    expect(screen.getByRole("dialog", { name: "Проблемы и ремонты" })).toBeVisible();
  });
  it("handles failed loads and retry without showing a false empty state", async () => {
    api.mockRejectedValueOnce(new Error("Сеть недоступна"));
    render(<BookingIssuesPanel bookingId="b1" close={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Сеть недоступна");
    expect(screen.queryByText("Открытых проблем нет")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку" }));
    expect(await screen.findByText("Кабель", { exact: false })).toBeVisible();
  });
  it("keeps archived bookings read-only", async () => {
    api.mockResolvedValue({ ...data, booking: { ...data.booking, archived: true } });
    render(<BookingIssuesPanel bookingId="b1" close={vi.fn()} />);
    await screen.findByText("Кабель", { exact: false });
    expect(screen.queryByRole("button", { name: "+ Зафиксировать проблему" })).not.toBeInTheDocument();
  });
  it("uses the project badge as a real action, and suppresses generic review text when a repair explains it", () => {
    const open = vi.fn();
    render(<RentalState row={{ id: "b1", projectName: "Сериал", status: "RETURNED", issues: data.summary, needsReview: true, openProblems: 1, onHand: 0 } as any} onIssues={open} />);
    fireEvent.click(screen.getByRole("button", { name: "Повреждения: 1 шт. · Сериал" }));
    expect(open).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Недостача: 3 шт. · Сериал" })).toBeVisible();
    expect(screen.queryByText("Нужна проверка")).not.toBeInTheDocument();
  });
});
