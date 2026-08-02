/**
 * InWorkList — cards listing active (ISSUED) bookings (v2: фильтры-пилюли,
 * «просрочен на N дней», инлайн-кнопка «Принять возврат»).
 *
 * Verifies:
 *  - Renders cards with proper overdue badge styling (+ дефолтный фильтр «Просрочено»)
 *  - Click handler propagates bookingId
 *  - «Принять возврат» calls onAcceptBack
 *  - Empty state when no bookings
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { InWorkList } from "../InWorkList";
import { scanApi } from "../api";

vi.mock("../api", () => ({
  scanApi: {
    listInWork: vi.fn(),
  },
}));

beforeEach(() => {
  vi.mocked(scanApi.listInWork).mockReset();
});

describe("InWorkList", () => {
  it("renders booking cards with overdue badge in red", async () => {
    vi.mocked(scanApi.listInWork).mockResolvedValue({
      bookings: [
        {
          bookingId: "b1",
          displayNo: "#ABCDEF",
          projectName: "Ювелирка",
          clientName: "Виталий",
          issuedAt: "2026-05-19T10:00:00Z",
          expectedReturnAt: "2026-05-21T10:00:00Z",
          itemsCount: 17,
          finalAmount: "5000",
          isOverdue: true,
          overdueDays: 1,
        },
      ],
    });
    const onSelect = vi.fn();
    render(<InWorkList onSelect={onSelect} />);
    await screen.findByText(/Ювелирка/);
    expect(screen.getByText(/просрочен на 1 день/)).toBeInTheDocument();
    expect(screen.getByText(/Виталий/)).toBeInTheDocument();
    expect(screen.getByText(/17 позиций/)).toBeInTheDocument();
    // При наличии просрочки список стартует с фильтра «Просрочено»
    expect(screen.getByRole("tab", { name: "Просрочено 1" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("renders non-overdue cards with «плановый возврат» label", async () => {
    vi.mocked(scanApi.listInWork).mockResolvedValue({
      bookings: [
        {
          bookingId: "b2",
          displayNo: "#XYZ123",
          projectName: "Активная",
          clientName: "Гена",
          issuedAt: null,
          expectedReturnAt: "2026-06-01T00:00:00Z",
          itemsCount: 3,
          finalAmount: "100",
          isOverdue: false,
          overdueDays: 0,
        },
      ],
    });
    render(<InWorkList onSelect={vi.fn()} />);
    await screen.findByText(/Активная/);
    expect(screen.getByText(/плановый возврат/)).toBeInTheDocument();
    expect(screen.queryByText(/просрочен на/)).not.toBeInTheDocument();
  });

  it("clicking a card calls onSelect with bookingId", async () => {
    vi.mocked(scanApi.listInWork).mockResolvedValue({
      bookings: [
        {
          bookingId: "b1",
          displayNo: "#ABCDEF",
          projectName: "P1",
          clientName: "C1",
          issuedAt: null,
          expectedReturnAt: "2026-06-01T00:00:00Z",
          itemsCount: 3,
          finalAmount: "100",
          isOverdue: false,
          overdueDays: 0,
        },
      ],
    });
    const onSelect = vi.fn();
    render(<InWorkList onSelect={onSelect} />);
    // v2 рендерит «Клиент · Проект» одной строкой
    await screen.findByText(/P1/);
    fireEvent.click(screen.getByText(/P1/));
    expect(onSelect).toHaveBeenCalledWith("b1");
  });

  it("«Принять возврат» calls onAcceptBack without triggering onSelect", async () => {
    vi.mocked(scanApi.listInWork).mockResolvedValue({
      bookings: [
        {
          bookingId: "b3",
          displayNo: "#RET001",
          projectName: "Возвратный",
          clientName: "Клиент",
          issuedAt: null,
          expectedReturnAt: "2026-06-01T00:00:00Z",
          itemsCount: 1,
          finalAmount: "100",
          isOverdue: false,
          overdueDays: 0,
        },
      ],
    });
    const onSelect = vi.fn();
    const onAcceptBack = vi.fn();
    render(<InWorkList onSelect={onSelect} onAcceptBack={onAcceptBack} />);
    await screen.findByText(/Возвратный/);
    fireEvent.click(screen.getByRole("button", { name: /Принять возврат/ }));
    expect(onAcceptBack).toHaveBeenCalledWith("b3");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shows empty state when no bookings", async () => {
    vi.mocked(scanApi.listInWork).mockResolvedValue({ bookings: [] });
    render(<InWorkList onSelect={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByText(/нет активных выдач/i)).toBeInTheDocument(),
    );
  });

  it("shows error alert when listInWork rejects", async () => {
    vi.mocked(scanApi.listInWork).mockRejectedValue({
      name: "ScanApiError",
      status: 500,
      message: "Server boom",
    });
    render(<InWorkList onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText(/Server boom/)).toBeInTheDocument();
  });
});
