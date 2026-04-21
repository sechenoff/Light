import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import {
  ClientsWithDebtPanel,
  TeamWithDebtPanel,
} from "../components/gaffer/dashboard/DebtorPanels";
import type {
  GafferDashboardClientDebt,
  GafferDashboardTeamDebt,
  GafferDashboardVendorDebt,
} from "../lib/gafferApi";

function makeClient(overrides: Partial<GafferDashboardClientDebt> = {}): GafferDashboardClientDebt {
  return {
    id: "c1",
    name: "Ромашка Продакшн",
    remaining: "180000",
    projectCount: 2,
    lastPaymentAt: "2026-04-02T00:00:00Z",
    ...overrides,
  };
}

function makeTeam(overrides: Partial<GafferDashboardTeamDebt> = {}): GafferDashboardTeamDebt {
  return {
    id: "t1",
    name: "Сергей Петров",
    roleLabel: "Осветитель",
    remaining: "60000",
    projectCount: 3,
    ...overrides,
  };
}

function makeVendor(overrides: Partial<GafferDashboardVendorDebt> = {}): GafferDashboardVendorDebt {
  return {
    id: "v1",
    name: "Рентал Плюс",
    roleLabel: "Рентал",
    remaining: "100000",
    projectCount: 1,
    lastPaymentAt: null,
    ...overrides,
  };
}

// T1: ClientsWithDebtPanel renders rows with name, project count + date, amount; each row is a link
describe("ClientsWithDebtPanel", () => {
  it("T1: renders row with name, secondary line, amount as a link", () => {
    render(<ClientsWithDebtPanel rows={[makeClient()]} />);
    expect(screen.getByText("Ромашка Продакшн")).toBeInTheDocument();
    // project count + last payment
    expect(screen.getByText(/2 проекта/)).toBeInTheDocument();
    expect(screen.getByText(/последний платёж/)).toBeInTheDocument();
    // amount
    expect(screen.getByText(/180/)).toBeInTheDocument();
    // link to contact
    const link = screen.getByRole("link", { name: /Ромашка Продакшн/ });
    expect(link).toHaveAttribute("href", "/gaffer/contacts/c1");
  });

  // T2: empty state
  it("T2: shows empty state when rows is empty", () => {
    render(<ClientsWithDebtPanel rows={[]} />);
    expect(screen.getByText("Нет долгов по клиентам")).toBeInTheDocument();
  });

  // T3: null lastPaymentAt shows "без платежей"
  it("T3: shows 'без платежей' when lastPaymentAt is null", () => {
    render(<ClientsWithDebtPanel rows={[makeClient({ lastPaymentAt: null })]} />);
    expect(screen.getByText(/без платежей/)).toBeInTheDocument();
  });
});

// T4: TeamWithDebtPanel merges team + vendor and sorts by amount desc
describe("TeamWithDebtPanel", () => {
  it("T4: combines team + vendor and sorts by remaining desc", () => {
    const team = [makeTeam({ id: "t1", name: "Сергей Петров", remaining: "50000" })];
    const vendors = [makeVendor({ id: "v1", name: "Рентал Плюс", remaining: "100000" })];
    render(<TeamWithDebtPanel team={team} vendors={vendors} />);
    const links = screen.getAllByRole("link");
    // vendor (100k) should appear before team (50k)
    const names = links.map((l) => l.textContent ?? "");
    const vendorIdx = names.findIndex((n) => n.includes("Рентал Плюс"));
    const teamIdx = names.findIndex((n) => n.includes("Сергей Петров"));
    expect(vendorIdx).toBeLessThan(teamIdx);
  });

  // T5: header shows "N человек" pluralized
  it("T5: header shows combined count pluralized", () => {
    const team = [makeTeam(), makeTeam({ id: "t2", name: "Анна" })];
    const vendors = [makeVendor()];
    render(<TeamWithDebtPanel team={team} vendors={vendors} />);
    // 3 total → "3 человека" (few)
    expect(screen.getByText(/3 человека/)).toBeInTheDocument();
  });

  // T6: empty state when both arrays empty
  it("T6: shows empty state when both arrays are empty", () => {
    render(<TeamWithDebtPanel team={[]} vendors={[]} />);
    expect(screen.getByText("Нет долгов по команде")).toBeInTheDocument();
  });
});
