import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BookingList } from "../BookingList";
import { scanApi } from "../api";
import type { BookingSummary } from "../types";
import {
  moscowTodayStart,
  toMoscowDateString,
  addDays,
} from "../../../lib/moscowDate";

// ISO timestamp at Moscow-noon for a given Moscow offset-in-days from today.
function isoForOffset(days: number): string {
  const ymd = toMoscowDateString(addDays(moscowTodayStart(), days));
  return `${ymd}T09:00:00.000Z`; // 12:00 MSK
}

function booking(
  id: string,
  offsetDays: number,
  projectName: string,
  clientName: string,
  itemCount: number,
): BookingSummary {
  return {
    id,
    projectName,
    client: { id: `c-${id}`, name: clientName },
    startDate: isoForOffset(offsetDays),
    endDate: isoForOffset(offsetDays + 2),
    status: "CONFIRMED",
    items: Array.from({ length: itemCount }, (_, i) => ({ id: `${id}-i${i}` })),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("BookingList", () => {
  it("groups by Moscow date into Сегодня / Завтра / Позже and sorts deterministically", async () => {
    // Intentionally unsorted; expect startDate asc then id asc.
    const data: BookingSummary[] = [
      booking("zzzzzlater01", 4, "Фотосет каталог", "Петров П.", 6),
      booking("bbbbbbtoday2", 0, "Реклама Орбита", "ООО Кинопроба", 24),
      booking("aaaaaatoday1", 0, "Клип Альфа", "Сидоров С.", 3),
      booking("ccccctomorr1", 1, "Клип Север", "Иванов И.", 11),
    ];
    vi.spyOn(scanApi, "listBookings").mockResolvedValue(data);

    const { container } = render(
      <BookingList operation="ISSUE" onUnauth={() => {}} onSelect={() => {}} />,
    );

    await waitFor(() =>
      expect(screen.getByText(/Сегодня ·/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/Завтра ·/)).toBeInTheDocument();
    expect(screen.getByText("Позже")).toBeInTheDocument();

    // Display id = "#" + last 6 chars UPPERCASED — never a barcode.
    // "aaaaaatoday1".slice(-6) = "today1" → #TODAY1
    // "bbbbbbtoday2".slice(-6) = "today2" → #TODAY2
    // "ccccctomorr1".slice(-6) = "tomorr1"? → "omorr1" (last 6) → #OMORR1
    // "zzzzzlater01".slice(-6) = "ater01" → #ATER01
    expect(screen.getByText(/#TODAY1/)).toBeInTheDocument();
    expect(screen.getByText(/#TODAY2/)).toBeInTheDocument();
    expect(screen.getByText(/#OMORR1/)).toBeInTheDocument();

    // Item count via pluralize.
    expect(screen.getByText(/24 единицы/)).toBeInTheDocument();
    expect(screen.getByText(/11 единиц/)).toBeInTheDocument();
    expect(screen.getByText(/3 единицы/)).toBeInTheDocument();
    expect(screen.getByText(/6 единиц/)).toBeInTheDocument();

    // Within "Сегодня": aaaaaatoday1 (#TODAY1) sorts before bbbbbbtoday2.
    const buttons = [...container.querySelectorAll("button")];
    const labels = buttons.map((b) => b.getAttribute("aria-label") || "");
    const idxToday1 = labels.findIndex((l) => l.includes("#TODAY1"));
    const idxToday2 = labels.findIndex((l) => l.includes("#TODAY2"));
    const idxTomorrow = labels.findIndex((l) => l.includes("#OMORR1"));
    const idxLater = labels.findIndex((l) => l.includes("#ATER01"));
    expect(idxToday1).toBeGreaterThanOrEqual(0);
    expect(idxToday1).toBeLessThan(idxToday2);
    expect(idxToday2).toBeLessThan(idxTomorrow);
    expect(idxTomorrow).toBeLessThan(idxLater);

    // Colored left border by bucket (semantic tokens, not raw hex).
    const allClasses = container.innerHTML;
    expect(allClasses).toContain("border-l-accent-bright"); // today
    expect(allClasses).toContain("border-l-indigo"); // tomorrow
    expect(allClasses).toContain("border-l-slate"); // later

    // No barcode-looking text (LR-XXX-NNN) anywhere.
    expect(container.textContent || "").not.toMatch(/LR-[A-Z0-9]+-\d+/);
  });

  it("calls createSession and onSelect when a card is tapped", async () => {
    const data = [booking("tap00today1", 0, "Тап-проект", "Клиент", 2)];
    vi.spyOn(scanApi, "listBookings").mockResolvedValue(data);
    const createSpy = vi
      .spyOn(scanApi, "createSession")
      .mockResolvedValue({
        id: "sess-1",
        bookingId: "tap00today1",
        operation: "ISSUE",
        status: "ACTIVE",
      });
    const onSelect = vi.fn();

    render(
      <BookingList
        operation="ISSUE"
        onUnauth={() => {}}
        onSelect={onSelect}
      />,
    );

    const card = await screen.findByRole("button", {
      name: /Тап-проект/,
    });
    card.click();

    await waitFor(() =>
      expect(createSpy).toHaveBeenCalledWith("tap00today1", "ISSUE"),
    );
    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith("sess-1", data[0]),
    );
  });

  it("invokes onUnauth on a 401 from listBookings", async () => {
    vi.spyOn(scanApi, "listBookings").mockRejectedValue({
      status: 401,
      code: "UNAUTHENTICATED",
      message: "no",
      details: null,
    });
    const onUnauth = vi.fn();
    render(
      <BookingList
        operation="ISSUE"
        onUnauth={onUnauth}
        onSelect={() => {}}
      />,
    );
    await waitFor(() => expect(onUnauth).toHaveBeenCalled());
  });

  it("re-fetches listBookings when the `version` prop changes (post-complete refresh)", async () => {
    const listSpy = vi
      .spyOn(scanApi, "listBookings")
      .mockResolvedValue([]);

    const { rerender } = render(
      <BookingList
        operation="ISSUE"
        version={0}
        onUnauth={() => {}}
        onSelect={() => {}}
      />,
    );

    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(1));

    // Bump version — page does this after a successful complete to evict
    // the stale just-completed booking from the current operation's list.
    rerender(
      <BookingList
        operation="ISSUE"
        version={1}
        onUnauth={() => {}}
        onSelect={() => {}}
      />,
    );

    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(2));
    expect(listSpy).toHaveBeenLastCalledWith("ISSUE");
  });
});
