import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lib/api", () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from "../../../lib/api";
import { TaskBookingPicker } from "../TaskBookingPicker";
import type { RelatedBookingRef } from "../groupTasks";

const mockFetch = vi.mocked(apiFetch);

const BK: RelatedBookingRef = {
  id: "bk1",
  projectName: "Съёмка рекламы",
  clientId: "cl1",
  clientName: "Мосфильм",
};

beforeEach(() => {
  mockFetch.mockReset();
});

describe("TaskBookingPicker", () => {
  it("searches after typing ≥2 chars and lists results", async () => {
    mockFetch.mockResolvedValueOnce({ bookings: [BK] });

    render(<TaskBookingPicker value={null} onChange={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/Найти бронь/), {
      target: { value: "мос" },
    });

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(String(mockFetch.mock.calls[0][0])).toContain("/api/tasks/booking-search?q=");
    expect(await screen.findByText("Съёмка рекламы")).toBeInTheDocument();
  });

  it("does not search for queries shorter than 2 chars", async () => {
    render(<TaskBookingPicker value={null} onChange={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/Найти бронь/), {
      target: { value: "м" },
    });
    // Give the debounce a beat; no fetch should fire
    await new Promise((r) => setTimeout(r, 350));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("calls onChange with the picked booking on click", async () => {
    mockFetch.mockResolvedValueOnce({ bookings: [BK] });
    const onChange = vi.fn();

    render(<TaskBookingPicker value={null} onChange={onChange} />);
    fireEvent.change(screen.getByPlaceholderText(/Найти бронь/), {
      target: { value: "рекл" },
    });

    const option = await screen.findByText("Съёмка рекламы");
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith(BK);
  });

  it("shows the selected booking as a chip and clears via ✕", () => {
    const onChange = vi.fn();
    render(<TaskBookingPicker value={BK} onChange={onChange} />);

    expect(screen.getByText(/Съёмка рекламы · Мосфильм/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Снять привязку/ }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
