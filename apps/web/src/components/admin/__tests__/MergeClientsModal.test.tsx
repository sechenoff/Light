import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lib/api", () => ({ apiFetch: vi.fn() }));
vi.mock("../../ToastProvider", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { apiFetch } from "../../../lib/api";
import { MergeClientsModal, mergeSummary, type MergeCandidate, type MergePreview } from "../MergeClientsModal";

const mockFetch = vi.mocked(apiFetch);

const DUP: MergeCandidate = { id: "dup", name: "петя куб", phone: "+7 900 111-22-33", email: null, bookingCount: 2 };
const MAIN: MergeCandidate = { id: "main", name: "Петя Куб", phone: null, email: "petya@example.com", bookingCount: 12 };

function preview(source: MergeCandidate, target: MergeCandidate): MergePreview {
  return {
    source: { ...source, hasPortal: false },
    target: { ...target, hasPortal: false },
    moves: { bookings: source.bookingCount, bills: 1, creditNotes: 0, tasks: 0 },
    contact: { phone: source.phone && !target.phone ? "fill" : "keep", email: "keep", comment: "keep", requisites: "keep" },
    portal: { outcome: "none", keptEmail: null, droppedEmail: null },
  };
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/clients/dup/similar") return { clients: [MAIN] } as never;
    if (path.startsWith("/api/clients?search=")) return { clients: [DUP, MAIN] } as never;
    if (path === "/api/clients/dup/merge-preview?into=main") return preview(DUP, MAIN) as never;
    if (path === "/api/clients/main/merge-preview?into=dup") return preview(MAIN, DUP) as never;
    if (init?.method === "POST") return { client: { id: "main" }, moved: {} } as never;
    throw new Error(`unexpected ${path}`);
  });
});

describe("MergeClientsModal", () => {
  it("предлагает похожие имена; по выбору остаётся карточка с бо́льшим числом броней", async () => {
    render(<MergeClientsModal client={DUP} onClose={vi.fn()} onMerged={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Петя Куб/ }));

    expect(await screen.findByText("К «Петя Куб» перейдут")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Петя Куб/ })).toBeChecked();
    expect(screen.getByText("2 брони — всего станет 14")).toBeInTheDocument();
    expect(screen.getByText("1 счёт на оплату")).toBeInTheDocument();
    expect(screen.getByText("Телефон +7 900 111-22-33 станет телефоном карточки")).toBeInTheDocument();
    expect(screen.getByText("Карточка «петя куб» исчезнет из справочника. Отменить объединение нельзя.")).toBeInTheDocument();
  });

  it("сменили, чьё имя остаётся, — сводка пересчитана наоборот", async () => {
    render(<MergeClientsModal client={DUP} onClose={vi.fn()} onMerged={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Петя Куб/ }));
    await screen.findByText("К «Петя Куб» перейдут");

    fireEvent.click(screen.getByRole("radio", { name: /петя куб/ }));
    expect(await screen.findByText("К «петя куб» перейдут")).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledWith("/api/clients/main/merge-preview?into=dup");
    expect(screen.getByText("Карточка «Петя Куб» исчезнет из справочника. Отменить объединение нельзя.")).toBeInTheDocument();
  });

  it("«Объединить» вливает дубль в выбранную карточку", async () => {
    const onMerged = vi.fn();
    render(<MergeClientsModal client={DUP} onClose={vi.fn()} onMerged={onMerged} />);
    fireEvent.click(await screen.findByRole("button", { name: /Петя Куб/ }));
    await screen.findByText("К «Петя Куб» перейдут");

    fireEvent.click(screen.getByRole("button", { name: "Объединить" }));
    await waitFor(() => expect(onMerged).toHaveBeenCalledWith("main"));
    expect(mockFetch).toHaveBeenCalledWith("/api/clients/dup/merge", {
      method: "POST",
      body: JSON.stringify({ intoClientId: "main" }),
    });
  });

  it("поиск — без самой карточки, с которой начали", async () => {
    render(<MergeClientsModal client={DUP} onClose={vi.fn()} onMerged={vi.fn()} />);
    await screen.findByText("Похожие имена");
    fireEvent.change(screen.getByLabelText("Другая карточка"), { target: { value: "куб" } });
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("/api/clients?search=%D0%BA%D1%83%D0%B1")));
    const options = await screen.findAllByRole("button", { name: /Петя Куб/ });
    expect(options.length).toBeGreaterThan(0);
    expect(screen.queryAllByRole("button", { name: /^петя куб/ })).toHaveLength(0);
  });
});

describe("mergeSummary", () => {
  it("расхождения контактов и кабинет — словами", () => {
    const p: MergePreview = {
      ...preview(DUP, { ...MAIN, phone: "+7 999 000-00-00" }),
      moves: { bookings: 0, bills: 0, creditNotes: 2, tasks: 1 },
      contact: { phone: "conflict", email: "keep", comment: "append", requisites: "fill" },
      portal: { outcome: "drop", keptEmail: "a@example.com", droppedEmail: "b@example.com" },
    };
    const s = mergeSummary(p);
    expect(s.moves).toEqual(["2 кредит-ноты", "1 задача"]);
    expect(s.contacts).toEqual([
      "Телефон +7 900 111-22-33 сохранится в комментарии — у карточки свой +7 999 000-00-00",
      "Реквизиты для счёта перенесутся",
    ]);
    expect(s.portal).toBe("Останется кабинет «Петя Куб» (a@example.com), кабинет «петя куб» (b@example.com) закроется");
  });
});
