import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lib/api", () => ({ apiFetch: vi.fn() }));
vi.mock("../../ToastProvider", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { apiFetch } from "../../../lib/api";
import { toast } from "../../ToastProvider";
import { ChangeClientModal } from "../ChangeClientModal";

const mockFetch = vi.mocked(apiFetch);

/** Ошибка apiFetch: как ApiFetchError — message + code + details. */
function apiError(message: string, code: string, details: unknown): Error {
  return Object.assign(new Error(message), { status: 409, code, details });
}

const base = {
  open: true,
  bookingId: "b1",
  currentClientId: "c-old",
  currentClientName: "Старый клиент",
  onClose: vi.fn(),
  onSuccess: vi.fn(),
};

beforeEach(() => {
  mockFetch.mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.info).mockReset();
});

describe("ChangeClientModal", () => {
  it("у брони с продолжениями предупреждает: клиент сменится у всей семьи", async () => {
    mockFetch.mockResolvedValue({ clients: [] });
    render(<ChangeClientModal {...base} family />);
    expect(screen.getByText(/клиент сменится у всей семьи/)).toBeInTheDocument();
  });

  it("«создать нового», а такой уже есть в другом написании — выбирается существующий, дубль не заводится", async () => {
    mockFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith("/api/clients?")) return { clients: [] } as never;
      if (path === "/api/clients" && init?.method === "POST")
        throw apiError("Клиент «Петя Куб» уже есть", "CLIENT_NAME_TAKEN", { clientId: "c-main", name: "Петя Куб" });
      if (path === "/api/bookings/b1/change-client") return { changedBookings: 3 } as never;
      throw new Error(`unexpected ${path}`);
    });
    render(<ChangeClientModal {...base} />);
    fireEvent.change(screen.getByLabelText("Выберите нового клиента"), { target: { value: "петя  куб" } });
    fireEvent.click(await screen.findByRole("button", { name: /Создать нового клиента «петя\s+куб»/ }));

    await waitFor(() => expect(toast.info).toHaveBeenCalledWith("«Петя Куб» уже есть в справочнике — выбран он"));
    fireEvent.click(screen.getByRole("button", { name: "Сменить клиента" }));
    await waitFor(() => expect(base.onSuccess).toHaveBeenCalled());
    expect(mockFetch).toHaveBeenCalledWith("/api/bookings/b1/change-client", {
      method: "POST",
      body: JSON.stringify({ clientId: "c-main" }),
    });
    expect(toast.success).toHaveBeenCalledWith("Клиент изменён у 3 броней семьи");
  });

  it("длинный проект — своя операция с ревизией", async () => {
    mockFetch.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/clients?")) return { clients: [{ id: "c-new", name: "Новый клиент" }] } as never;
      if (path === "/api/booking-projects/b1/client") return { client: { id: "c-new" } } as never;
      throw new Error(`unexpected ${path}`);
    });
    render(<ChangeClientModal {...base} projectRevision={4} />);
    expect(screen.getByText("Проект перейдёт к другому клиенту. Смена попадёт в историю проекта.")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Новый клиент" }));
    fireEvent.click(screen.getByRole("button", { name: "Сменить клиента" }));
    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith("/api/booking-projects/b1/client", {
        method: "POST",
        body: JSON.stringify({ revision: 4, clientId: "c-new" }),
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Клиент изменён");
  });
});
