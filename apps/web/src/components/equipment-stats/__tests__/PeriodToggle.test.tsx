import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PeriodToggle } from "../PeriodToggle";

const replaceMock = vi.fn();
const searchParamsMock = { get: vi.fn(), toString: vi.fn(() => "") };

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => "/admin/equipment-stats",
  useSearchParams: () => searchParamsMock,
}));

describe("PeriodToggle", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    searchParamsMock.get.mockReset();
    searchParamsMock.toString.mockReset();
    searchParamsMock.toString.mockReturnValue("");
  });

  it("defaults active pill to 90 when no period param is set", () => {
    searchParamsMock.get.mockReturnValue(null);
    render(<PeriodToggle />);
    const active = screen.getByRole("button", { name: "90 дней" });
    expect(active.getAttribute("aria-pressed")).toBe("true");
  });

  it("marks active pill based on ?period= query value", () => {
    searchParamsMock.get.mockReturnValue("30");
    render(<PeriodToggle />);
    expect(screen.getByRole("button", { name: "30 дней" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "90 дней" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("calls router.replace with the new period when a pill is clicked", () => {
    searchParamsMock.get.mockReturnValue("90");
    render(<PeriodToggle />);
    fireEvent.click(screen.getByRole("button", { name: "Год" }));
    expect(replaceMock).toHaveBeenCalledTimes(1);
    expect(replaceMock.mock.calls[0][0]).toContain("period=365");
  });
});
