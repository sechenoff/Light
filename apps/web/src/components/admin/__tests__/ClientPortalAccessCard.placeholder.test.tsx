import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClientPortalAccessCard } from "../ClientPortalAccessCard";

function mockAccount(email: string) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ account: { email, status: "ACTIVE", lastLoginAt: null, invitedAt: null } }),
  }) as unknown as typeof fetch;
}

describe("ClientPortalAccessCard: служебный домен", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("предупреждает, когда вместо почты служебный логин", async () => {
    mockAccount("petya-kub@svetobazarent.lk");
    render(<ClientPortalAccessCard clientId="c1" defaultEmail={null} />);
    expect(await screen.findByText(/служебный логин, а не почта/i)).toBeInTheDocument();
  });

  it("молчит, когда адрес настоящий", async () => {
    mockAccount("petya@example.com");
    render(<ClientPortalAccessCard clientId="c1" defaultEmail={null} />);
    await screen.findByText("petya@example.com");
    expect(screen.queryByText(/служебный логин/i)).not.toBeInTheDocument();
  });
});
