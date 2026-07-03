import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { QuickAvailabilityCheck } from "../QuickAvailabilityCheck";

function localDatetimeValue(daysFromToday: number, hour: number): string {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  d.setDate(d.getDate() + daysFromToday);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  return `${y}-${m}-${day}T${h}:00`;
}

describe("QuickAvailabilityCheck — дефолтный период (MD-5)", () => {
  it("начало = сегодня 10:00, конец = завтра 10:00 (не послезавтра)", () => {
    render(<QuickAvailabilityCheck />);

    const startInput = screen.getByLabelText("Начало") as HTMLInputElement;
    const endInput = screen.getByLabelText("Конец") as HTMLInputElement;

    expect(startInput.value).toBe(localDatetimeValue(0, 10));
    // Регрессия: раньше двойной сдвиг (setHours(34) + setDate(+1)) давал +2 суток.
    expect(endInput.value).toBe(localDatetimeValue(1, 10));
  });
});
