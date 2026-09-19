import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, it, expect, vi } from "vitest";
import AuditPage from "../../../../app/admin/audit/page";
const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  params: new URLSearchParams(),
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => mocks.params }));
vi.mock("@/hooks/useRequireRole", () => ({
  useRequireRole: () => ({ authorized: true, loading: false }),
}));
vi.mock("@/components/admin/AdminShell", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => mocks.fetch(...args),
}));
beforeEach(() => {
  mocks.params = new URLSearchParams();
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (url: string) =>
    url === "/api/admin-users"
      ? { users: [{ id: "u1", username: "ivan" }] }
      : { items: [], nextCursor: null },
  );
});
describe("фильтры журнала", () => {
  it("передаёт действие и аккаунт на сервер, даты трактует по Москве включительно", async () => {
    render(<AuditPage />);
    await screen.findByRole("option", { name: "ivan" });
    fireEvent.change(screen.getByLabelText("Кто изменил"), {
      target: { value: "u1" },
    });
    fireEvent.change(screen.getByLabelText("Действие"), {
      target: { value: "BOOKING_UPDATE" },
    });
    const day = new Date().toISOString().slice(0, 10);
    fireEvent.change(screen.getByLabelText("С даты и времени (МСК)"), {
      target: { value: `${day}T12:00` },
    });
    fireEvent.change(screen.getByLabelText("По дату и время (МСК)"), {
      target: { value: `${day}T13:00` },
    });
    fireEvent.click(screen.getByRole("button", { name: "Применить" }));
    await waitFor(() => {
      const queries = mocks.fetch.mock.calls.map(
        (c) => new URL(String(c[0]), "http://test").searchParams,
      );
      expect(
        queries.some(
          (q) =>
            q.get("action") === "BOOKING_UPDATE" &&
            q.get("userId") === "u1" &&
            q.get("from") === `${day}T09:00:00.000Z` &&
            q.get("to") === `${day}T10:00:59.999Z`,
        ),
      ).toBe(true);
    });
  });
  it("ссылка на изменения аккаунта фильтрует объект, а не автора", async () => {
    mocks.params = new URLSearchParams("entityType=AdminUser&entityId=u1");
    render(<AuditPage />);
    await waitFor(() =>
      expect(
        mocks.fetch.mock.calls.some(
          (c) =>
            String(c[0]).includes("entityId=u1") &&
            !String(c[0]).includes("userId=u1"),
        ),
      ).toBe(true),
    );
    expect(screen.getByText("Изменения аккаунта")).toBeInTheDocument();
  });
});
