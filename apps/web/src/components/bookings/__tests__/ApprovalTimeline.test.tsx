import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApprovalTimeline } from "../ApprovalTimeline";

const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn();
});
afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

function mockAuditResponse(items: Array<Partial<{ id: string; action: string; userId: string; createdAt: string; before: any; after: any; user: { username: string } }>>) {
  (global.fetch as any).mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ items, nextCursor: null }),
  });
}

describe("ApprovalTimeline", () => {
  it("renders nothing when no approval events", async () => {
    mockAuditResponse([]);
    const { container } = render(<ApprovalTimeline bookingId="b1" />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container.querySelector("details")).toBeNull();
  });

  it("renders nothing on 403 (non-SUPER_ADMIN viewer)", async () => {
    (global.fetch as any).mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({}) });
    const { container } = render(<ApprovalTimeline bookingId="b1" />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container.querySelector("details")).toBeNull();
  });

  it("filters to approval-flow actions and shows them in reverse chrono order", async () => {
    mockAuditResponse([
      { id: "a3", action: "BOOKING_APPROVED", userId: "u1", createdAt: "2026-04-15T12:00:00Z", before: { status: "PENDING_APPROVAL" }, after: { status: "CONFIRMED" }, user: { username: "boss" } },
      { id: "a2", action: "BOOKING_SUBMITTED", userId: "u2", createdAt: "2026-04-15T10:00:00Z", before: { status: "DRAFT" }, after: { status: "PENDING_APPROVAL" }, user: { username: "wh" } },
      { id: "a-other", action: "BOOKING_DELETED", userId: "u1", createdAt: "2026-04-15T11:00:00Z", before: null, after: null },
      { id: "a1", action: "BOOKING_REJECTED", userId: "u1", createdAt: "2026-04-14T15:00:00Z", before: { status: "PENDING_APPROVAL" }, after: { status: "DRAFT", rejectionReason: "не та смета" }, user: { username: "boss" } },
    ]);
    render(<ApprovalTimeline bookingId="b1" />);
    // Events appear (default-collapsed but children rendered for query)
    await waitFor(() => expect(screen.getByText(/одобрено/i)).toBeInTheDocument());
    expect(screen.getByText(/одобрено/i)).toBeInTheDocument();
    expect(screen.getByText(/отправлено на согласование/i)).toBeInTheDocument();
    expect(screen.getByText(/отклонено/i)).toBeInTheDocument();
    // Rejection reason surfaced
    expect(screen.getByText(/не та смета/)).toBeInTheDocument();
    // Other action filtered out
    expect(screen.queryByText(/BOOKING_DELETED/i)).toBeNull();
  });

  it("shows a friendly error if fetch throws", async () => {
    (global.fetch as any).mockRejectedValueOnce(new Error("network"));
    render(<ApprovalTimeline bookingId="b1" />);
    await waitFor(() => expect(screen.getByText(/не удалось загрузить/i)).toBeInTheDocument());
  });
});
