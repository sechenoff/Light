import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

let mockPathname = "/day";
const mockUseCurrentUser = vi.fn(() => ({ user: null, loading: false, logout: async () => {} }));

vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("../../lib/auth", () => ({ useCurrentUser: () => mockUseCurrentUser() }));

import { AppShell } from "../AppShell";
import { isFeedbackWidgetHidden } from "../feedback/FeedbackWidget";

afterEach(() => {
  cleanup();
  mockUseCurrentUser.mockClear();
});

describe("isFeedbackWidgetHidden", () => {
  it("скрывает кнопку «Сообщить» на портале, входе, киоске и полноэкранном сканере", () => {
    for (const p of ["/lk", "/lk/login", "/lk/bookings/abc", "/login", "/warehouse/scan", "/admin/scanner", null]) {
      expect(isFeedbackWidgetHidden(p)).toBe(true);
    }
  });

  it("показывает кнопку на служебных страницах и не путает префиксы", () => {
    for (const p of ["/day", "/bookings", "/lkfoo", "/admin/scanners-log"]) {
      expect(isFeedbackWidgetHidden(p)).toBe(false);
    }
  });
});

describe("AppShell", () => {
  it("клиентский портал выводится без служебной оболочки и без запроса сессии сотрудника", () => {
    mockPathname = "/lk/debt";
    render(<AppShell><p>портал</p></AppShell>);
    expect(screen.getByText("портал")).toBeInTheDocument();
    expect(screen.queryByLabelText("Открыть меню")).not.toBeInTheDocument();
    expect(mockUseCurrentUser).not.toHaveBeenCalled();
  });

  it("служебная страница получает оболочку и запас под кнопку «Сообщить»", () => {
    mockPathname = "/day";
    const { container } = render(<AppShell><p>день</p></AppShell>);
    expect(screen.getByLabelText("Открыть меню")).toBeInTheDocument();
    expect(container.querySelector("main")?.className).toContain("pb-20");
  });

  it("на киоске склада кнопки «Сообщить» нет, и запаса под неё тоже", () => {
    mockPathname = "/warehouse/scan";
    const { container } = render(<AppShell><p>киоск</p></AppShell>);
    expect(container.querySelector("main")?.className).not.toContain("pb-20");
  });
});
