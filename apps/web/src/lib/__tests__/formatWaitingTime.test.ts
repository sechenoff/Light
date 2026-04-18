import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { formatWaitingTime } from "../format";

describe("formatWaitingTime", () => {
  beforeEach(() => {
    // Fix "now" to 2026-04-16T12:00:00Z
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-16T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null when submittedAt and createdAt are null/undefined", () => {
    expect(formatWaitingTime(null, null)).toBeNull();
  });

  it("returns { text: 'сегодня', className: 'text-ink-3' } when submitted today", () => {
    const result = formatWaitingTime("2026-04-16T08:00:00Z", "2026-04-15T10:00:00Z");
    expect(result).toEqual({ text: "сегодня", className: "text-ink-3" });
  });

  it("returns { text: '1 день', className: 'text-amber font-medium' } when submitted 1 day ago", () => {
    const result = formatWaitingTime("2026-04-15T08:00:00Z", "2026-04-14T10:00:00Z");
    expect(result).toEqual({ text: "1 день", className: "text-amber font-medium" });
  });

  it("returns red variant with day count when submitted 2+ days ago", () => {
    const result = formatWaitingTime("2026-04-14T08:00:00Z", "2026-04-13T10:00:00Z");
    expect(result).toEqual({ text: "2 дня", className: "text-rose font-medium" });
  });

  it("uses createdAt fallback when submittedAt is null", () => {
    const result = formatWaitingTime(null, "2026-04-16T08:00:00Z");
    expect(result).toEqual({ text: "сегодня", className: "text-ink-3" });
  });

  it("pluralizes correctly for 5 days", () => {
    const result = formatWaitingTime("2026-04-11T08:00:00Z", "2026-04-10T10:00:00Z");
    expect(result?.text).toBe("5 дней");
  });
});
