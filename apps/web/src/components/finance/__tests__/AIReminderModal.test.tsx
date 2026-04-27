import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AIReminderModal } from "../AIReminderModal";

const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn();
  vi.clearAllMocks();
});
afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

function mockDraftFetch(data: unknown, status = 200) {
  (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok: status < 400,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
    headers: { get: () => "application/json" },
  });
}

function mockMarkRemindedFetch(status = 200) {
  (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok: status < 400,
    status,
    json: async () => ({ ok: true }),
    text: async () => '{"ok":true}',
    headers: { get: () => "application/json" },
  });
}

const DEFAULT_PROPS = {
  open: true,
  onClose: vi.fn(),
  clientId: "client-1",
  clientName: "ООО Рога и Копыта",
  totalOutstanding: "50 000 ₽",
  onReminded: vi.fn(),
};

const MOCK_REMINDER = {
  subject: "Напоминание об оплате",
  body: "Уважаемый клиент,\n\nПросим оплатить задолженность.",
  generatedBy: "gemini" as const,
};

describe("AIReminderModal", () => {
  it("renders loading state on mount when open", () => {
    // Pending fetch - never resolves
    (global.fetch as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    render(<AIReminderModal {...DEFAULT_PROPS} />);
    expect(screen.getByText(/готовлю напоминание/i)).toBeInTheDocument();
  });

  it("renders subject and body after fetch resolves", async () => {
    mockDraftFetch(MOCK_REMINDER);
    render(<AIReminderModal {...DEFAULT_PROPS} />);
    await waitFor(() => {
      expect(screen.getByDisplayValue("Напоминание об оплате")).toBeInTheDocument();
    });
    expect(screen.getByText(/уважаемый клиент/i)).toBeInTheDocument();
    expect(screen.getByText(/✨/)).toBeInTheDocument();
  });

  it("'Скопировать' calls clipboard and shows nothing crashing", async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: writeTextMock } });

    mockDraftFetch(MOCK_REMINDER);
    render(<AIReminderModal {...DEFAULT_PROPS} />);
    await waitFor(() => {
      expect(screen.getByDisplayValue("Напоминание об оплате")).toBeInTheDocument();
    });

    const copyBtn = screen.getByRole("button", { name: /скопировать/i });
    fireEvent.click(copyBtn);
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledOnce();
    });
    expect(writeTextMock).toHaveBeenCalledWith(
      expect.stringContaining("Напоминание об оплате")
    );
  });

  it("'Отметить как отправлено' calls mark-reminded and triggers onReminded", async () => {
    mockDraftFetch(MOCK_REMINDER);
    mockMarkRemindedFetch();
    const onReminded = vi.fn();
    render(<AIReminderModal {...DEFAULT_PROPS} onReminded={onReminded} />);
    await waitFor(() => {
      expect(screen.getByDisplayValue("Напоминание об оплате")).toBeInTheDocument();
    });

    const markBtn = screen.getByRole("button", { name: /отметить как отправлено/i });
    fireEvent.click(markBtn);
    await waitFor(() => {
      expect(onReminded).toHaveBeenCalledOnce();
    });
  });
});
