import { describe, it, expect } from "vitest";
import { matchBookingForEntry, BookingCandidate } from "./bookingMatcher";

const dbBookings: BookingCandidate[] = [
  { id: "b1", clientName: "Гена Белых", startDateMs: Date.UTC(2026, 0, 15), finalAmount: 85_000, paymentStatus: "OVERDUE" },
  { id: "b2", clientName: "Петя Куб",   startDateMs: Date.UTC(2026, 0, 17), finalAmount: 4_500,  paymentStatus: "PAID" },
  { id: "b3", clientName: "Петя Куб",   startDateMs: Date.UTC(2026, 0, 17), finalAmount: 10_000, paymentStatus: "OVERDUE" },
];

describe("matchBookingForEntry — PAIR/XLSX_ONLY", () => {
  it("SKIP_NEEDS_UPDATE_REVIEW on OVERDUE match", () => {
    const r = matchBookingForEntry(
      { kind: "PAIR", clientName: "Гена Белых", shootDate: "2026-01-16", totalRub: 85_590 },
      dbBookings
    );
    expect(r.action).toBe("SKIP_NEEDS_UPDATE_REVIEW");
    expect(r.candidates).toEqual(["b1"]);
  });

  it("SKIP_PROTECTED on PAID", () => {
    const r = matchBookingForEntry(
      { kind: "PAIR", clientName: "Петя Куб", shootDate: "2026-01-17", totalRub: 4_500 },
      dbBookings
    );
    expect(r.action).toBe("SKIP_PROTECTED");
  });

  it("INSERT when no candidates", () => {
    const r = matchBookingForEntry(
      { kind: "PAIR", clientName: "Новый Клиент", shootDate: "2026-04-01", totalRub: 1234 },
      dbBookings
    );
    expect(r.action).toBe("INSERT");
    expect(r.candidates).toHaveLength(0);
  });
});

describe("matchBookingForEntry — REQUEST_ONLY", () => {
  it("SKIP_DUP when (date, client) matches any existing booking", () => {
    const r = matchBookingForEntry(
      { kind: "REQUEST_ONLY", clientName: "Гена Белых", shootDate: "2026-01-15", totalRub: 0 },
      dbBookings
    );
    expect(r.action).toBe("SKIP_DUP");
  });
  it("INSERT (DRAFT) when no (date, client) match", () => {
    const r = matchBookingForEntry(
      { kind: "REQUEST_ONLY", clientName: "Гена Белых", shootDate: "2026-04-01", totalRub: 0 },
      dbBookings
    );
    expect(r.action).toBe("INSERT");
  });
});
