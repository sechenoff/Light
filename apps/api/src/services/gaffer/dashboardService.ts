/**
 * Сервис дашборда Gaffer CRM.
 * Агрегирует долги заказчиков и команды по всем OPEN-проектам.
 */

import type { Request } from "express";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "../../prisma";
import { gafferWhere } from "./tenant";
import { computeProjectDebts } from "./projectService";

export interface DashboardKpi {
  owedToMe: string;
  iOwe: string;
  owedToMeProjectCount: number;
  owedToMeClientCount: number;
  iOweProjectCount: number;
  iOweMemberCount: number;
  iOweVendorCount: number;
  // Extended fields (Task 1.4)
  overdueIncomingSum: string;
  dueSoonIncomingSum: string;
  dueSoonOutgoingSum: string;
  freeCash: string;
  cashGap14d: string;
  openObligationCount: number;
  overdueProjectCount: number;
}

export interface DashboardClientDebt {
  id: string;
  name: string;
  remaining: string;
  projectCount: number;
  lastPaymentAt: string | null;
}

export interface DashboardTeamDebt {
  id: string;
  name: string;
  roleLabel: string | null;
  remaining: string;
  projectCount: number;
}

export interface DashboardVendorDebt {
  id: string;
  name: string;
  roleLabel: string | null;
  remaining: string;
  projectCount: number;
  lastPaymentAt: string | null;
}

export interface DashboardMeta {
  activeProjects: number;
  archivedProjects: number;
  lastActivityAt: string | null;
}

export interface OverdueIncomingRow {
  projectId: string;
  projectCode: string;
  projectTitle: string;
  clientId: string;
  clientName: string;
  remaining: string;
  overdueDays: number;
}

export interface UpcomingObligationRow {
  kind: "IN" | "OUT";
  projectId: string;
  projectCode: string;
  projectTitle: string;
  /** contactId for OUT rows, clientId for IN rows */
  contactId: string;
  contactName: string;
  remaining: string;
  dueAt: string;
}

export interface AtRiskProjectRow {
  projectId: string;
  projectCode: string;
  projectTitle: string;
  clientId: string;
  clientName: string;
  /** Total IN payments received */
  received: string;
  /** Total OUT payments made */
  paid: string;
  /** Client remaining (IN obligation remaining) */
  remaining: string;
  /** clientPlanAmount */
  total: string;
  /** Alias for remaining (client side) — used in BalanceBar */
  remainingIn: string;
}

export interface DashboardDebtStructure {
  vendorOutSum: string;
  teamOutSum: string;
  closedProjectCount: number;
  inProgressProjectCount: number;
  overdueProjectCount: number;
}

export interface GafferDashboardData {
  kpi: DashboardKpi;
  clientsWithDebt: DashboardClientDebt[];
  teamWithDebt: DashboardTeamDebt[];
  vendorsWithDebt: DashboardVendorDebt[];
  meta: DashboardMeta;
  // Extended arrays (Task 1.4)
  overdueIncoming: OverdueIncomingRow[];
  upcomingObligations: UpcomingObligationRow[];
  atRiskProjects: AtRiskProjectRow[];
  debtStructure: DashboardDebtStructure;
}

/** Derive a short project code from the project id */
function deriveProjectCode(projectId: string): string {
  return "G-" + projectId.slice(0, 8).toUpperCase();
}

export async function getDashboard(req: Request): Promise<GafferDashboardData> {
  const { gafferUserId } = gafferWhere(req);
  const ZERO = new Decimal(0);
  const now = new Date();
  const in14d = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  // Загружаем все OPEN проекты с полными данными
  const openProjects = await prisma.gafferProject.findMany({
    where: { gafferUserId, status: "OPEN" },
    include: {
      client: true,
      members: {
        include: { contact: true },
        orderBy: { createdAt: "desc" },
      },
      payments: {
        select: {
          direction: true,
          amount: true,
          memberId: true,
          createdAt: true,
        },
      },
    },
    orderBy: { shootDate: "desc" },
  });

  // Считаем кол-во архивных проектов
  const archivedCount = await prisma.gafferProject.count({
    where: { gafferUserId, status: "ARCHIVED" },
  });

  // ── KPI ──────────────────────────────────────────────────────────────────────

  let totalOwedToMe = ZERO;
  let totalIOwe = ZERO;
  let owedToMeProjectCount = 0;
  const owedToMeClientIds = new Set<string>();
  let iOweProjectCount = 0;
  const iOweMemberContactIds = new Set<string>();
  const iOweVendorContactIds = new Set<string>();

  // Extended KPI accumulators
  let totalIn = ZERO;
  let totalOut = ZERO;
  let overdueIncomingSum = ZERO;
  let dueSoonIncomingSum = ZERO;
  let dueSoonOutgoingSum = ZERO;
  let openObligationCount = 0;
  let overdueProjectCount = 0;

  // Для clientsWithDebt
  const clientDebtMap = new Map<
    string,
    { name: string; remaining: Decimal; projectCount: number; lastPaymentAt: Date | null }
  >();

  // Для teamWithDebt: contactId (TEAM_MEMBER) → { name, roleLabel, remaining, projectCount }
  const teamDebtMap = new Map<
    string,
    { name: string; roleLabel: string | null; remaining: Decimal; projectCount: number }
  >();

  // Для vendorsWithDebt: contactId (VENDOR) → { name, roleLabel, remaining, projectCount, lastPaymentAt }
  const vendorDebtMap = new Map<
    string,
    {
      name: string;
      roleLabel: string | null;
      remaining: Decimal;
      projectCount: number;
      lastPaymentAt: Date | null;
    }
  >();

  // Extended: for vendor/team debt structure
  let vendorOutSum = ZERO;
  let teamOutSum = ZERO;

  // Extended: accumulate rows
  const overdueIncomingRows: OverdueIncomingRow[] = [];
  const upcomingObligationsRaw: UpcomingObligationRow[] = [];
  const atRiskProjectsRaw: AtRiskProjectRow[] = [];

  let lastActivityAt: Date | null = null;

  for (const project of openProjects) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const debts = computeProjectDebts(project as any);

    const clientRem = new Decimal(debts.clientRemaining);
    const teamRem = new Decimal(debts.teamRemaining);
    const vendorRem = new Decimal(debts.vendorRemaining);
    const projectIOwe = teamRem.plus(vendorRem);

    totalOwedToMe = totalOwedToMe.plus(clientRem);
    totalIOwe = totalIOwe.plus(projectIOwe);

    // freeCash accumulators
    for (const p of project.payments) {
      if (p.direction === "IN") {
        totalIn = totalIn.plus(p.amount);
      } else {
        totalOut = totalOut.plus(p.amount);
      }
    }

    if (clientRem.gt(ZERO)) {
      owedToMeProjectCount++;
      owedToMeClientIds.add(project.clientId);

      // Last IN payment for this project
      const lastIn = project.payments
        .filter((p) => p.direction === "IN")
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

      const existing = clientDebtMap.get(project.clientId);
      if (existing) {
        existing.remaining = existing.remaining.plus(clientRem);
        existing.projectCount++;
        if (lastIn && (!existing.lastPaymentAt || lastIn.createdAt > existing.lastPaymentAt)) {
          existing.lastPaymentAt = lastIn.createdAt;
        }
      } else {
        clientDebtMap.set(project.clientId, {
          name: project.client.name,
          remaining: clientRem,
          projectCount: 1,
          lastPaymentAt: lastIn?.createdAt ?? null,
        });
      }
    }

    // ── Extended: overdueIncoming & dueSoon for client side ─────────────────

    const clientDueAt = (project as unknown as { clientDueAt: Date | null }).clientDueAt;

    if (clientRem.gt(ZERO) && clientDueAt) {
      if (clientDueAt < now) {
        // Overdue
        overdueIncomingSum = overdueIncomingSum.plus(clientRem);
        const overdueDays = Math.floor((now.getTime() - clientDueAt.getTime()) / (1000 * 60 * 60 * 24));
        overdueIncomingRows.push({
          projectId: project.id,
          projectCode: deriveProjectCode(project.id),
          projectTitle: project.title,
          clientId: project.clientId,
          clientName: project.client.name,
          remaining: clientRem.toString(),
          overdueDays,
        });
      } else if (clientDueAt >= now && clientDueAt <= in14d) {
        // Due soon (incoming)
        dueSoonIncomingSum = dueSoonIncomingSum.plus(clientRem);
        upcomingObligationsRaw.push({
          kind: "IN",
          projectId: project.id,
          projectCode: deriveProjectCode(project.id),
          projectTitle: project.title,
          contactId: project.clientId,
          contactName: project.client.name,
          remaining: clientRem.toString(),
          dueAt: clientDueAt.toISOString(),
        });
      }
    }

    // openObligationCount: projects with client remaining > 0
    if (clientRem.gt(ZERO)) {
      openObligationCount++;
    }

    // Track last activity
    for (const p of project.payments) {
      if (!lastActivityAt || p.createdAt > lastActivityAt) {
        lastActivityAt = p.createdAt;
      }
    }

    // Per-member debt (TEAM_MEMBER + VENDOR, partitioned by contact.type)
    if (projectIOwe.gt(ZERO)) {
      iOweProjectCount++;

      for (const member of project.members) {
        const type = member.contact?.type;
        if (type !== "TEAM_MEMBER" && type !== "VENDOR") continue;

        const memberPayments = project.payments.filter(
          (p) => p.direction === "OUT" && p.memberId === member.contactId,
        );
        const paid = memberPayments.reduce((acc, p) => acc.plus(p.amount), ZERO);
        const planned = new Decimal(member.plannedAmount);
        const rawRem = planned.minus(paid);
        const memberRem = rawRem.gt(ZERO) ? rawRem : ZERO;

        if (type === "TEAM_MEMBER") {
          iOweMemberContactIds.add(member.contactId);
          const ex = teamDebtMap.get(member.contactId);
          if (ex) {
            ex.remaining = ex.remaining.plus(memberRem);
            ex.projectCount++;
          } else {
            teamDebtMap.set(member.contactId, {
              name: member.contact.name,
              roleLabel: member.roleLabel,
              remaining: memberRem,
              projectCount: 1,
            });
          }
          if (memberRem.gt(ZERO)) {
            teamOutSum = teamOutSum.plus(memberRem);
            // openObligationCount: members with remaining > 0
            openObligationCount++;
          }
        } else {
          iOweVendorContactIds.add(member.contactId);
          const lastOut = memberPayments.sort(
            (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
          )[0];
          const ex = vendorDebtMap.get(member.contactId);
          if (ex) {
            ex.remaining = ex.remaining.plus(memberRem);
            ex.projectCount++;
            if (lastOut && (!ex.lastPaymentAt || lastOut.createdAt > ex.lastPaymentAt)) {
              ex.lastPaymentAt = lastOut.createdAt;
            }
          } else {
            vendorDebtMap.set(member.contactId, {
              name: member.contact.name,
              roleLabel: member.roleLabel,
              remaining: memberRem,
              projectCount: 1,
              lastPaymentAt: lastOut?.createdAt ?? null,
            });
          }
          if (memberRem.gt(ZERO)) {
            vendorOutSum = vendorOutSum.plus(memberRem);
            // openObligationCount: members with remaining > 0
            openObligationCount++;
          }
        }

        // ── Extended: dueSoon for outgoing obligations ─────────────────────
        if (memberRem.gt(ZERO)) {
          const memberDueAt = (member as unknown as { dueAt: Date | null }).dueAt;
          if (memberDueAt && memberDueAt >= now && memberDueAt <= in14d) {
            dueSoonOutgoingSum = dueSoonOutgoingSum.plus(memberRem);
            upcomingObligationsRaw.push({
              kind: "OUT",
              projectId: project.id,
              projectCode: deriveProjectCode(project.id),
              projectTitle: project.title,
              contactId: member.contactId,
              contactName: member.contact.name,
              remaining: memberRem.toString(),
              dueAt: memberDueAt.toISOString(),
            });
          }
        }
      }
    }

    // ── Extended: overdueProjectCount & atRiskProjects ──────────────────────

    let projectIsOverdue = false;

    // Check overdue incoming
    if (clientRem.gt(ZERO) && clientDueAt && clientDueAt < now) {
      projectIsOverdue = true;
    }

    // Check overdue outgoing
    if (!projectIsOverdue) {
      for (const member of project.members) {
        const memberDueAt = (member as unknown as { dueAt: Date | null }).dueAt;
        if (!memberDueAt) continue;
        const memberPayments = project.payments.filter(
          (p) => p.direction === "OUT" && p.memberId === member.contactId,
        );
        const paid = memberPayments.reduce((acc, p) => acc.plus(p.amount), ZERO);
        const planned = new Decimal(member.plannedAmount);
        const rawRem = planned.minus(paid);
        const memberRem = rawRem.gt(ZERO) ? rawRem : ZERO;
        if (memberRem.gt(ZERO) && memberDueAt < now) {
          projectIsOverdue = true;
          break;
        }
      }
    }

    if (projectIsOverdue) {
      overdueProjectCount++;

      // Build atRisk row (we'll sort & limit later)
      const clientReceived = new Decimal(debts.clientReceived);
      const allOut = project.payments
        .filter((p) => p.direction === "OUT")
        .reduce((acc, p) => acc.plus(p.amount), ZERO);

      atRiskProjectsRaw.push({
        projectId: project.id,
        projectCode: deriveProjectCode(project.id),
        projectTitle: project.title,
        clientId: project.clientId,
        clientName: project.client.name,
        received: clientReceived.toString(),
        paid: allOut.toString(),
        remaining: clientRem.toString(),
        total: new Decimal(project.clientPlanAmount).toString(),
        remainingIn: clientRem.toString(),
      });
    }
  }

  // ── freeCash & cashGap14d ─────────────────────────────────────────────────

  const freeCash = totalIn.minus(totalOut);
  const cashGap14d = freeCash.plus(dueSoonIncomingSum).minus(dueSoonOutgoingSum);

  // ── Build sorted arrays ───────────────────────────────────────────────────────

  const clientsWithDebt: DashboardClientDebt[] = Array.from(clientDebtMap.entries())
    .map(([id, v]) => ({
      id,
      name: v.name,
      remaining: v.remaining.toString(),
      projectCount: v.projectCount,
      lastPaymentAt: v.lastPaymentAt ? v.lastPaymentAt.toISOString() : null,
    }))
    .sort((a, b) => new Decimal(b.remaining).comparedTo(new Decimal(a.remaining)));

  const teamWithDebt: DashboardTeamDebt[] = Array.from(teamDebtMap.entries())
    .map(([id, v]) => ({
      id,
      name: v.name,
      roleLabel: v.roleLabel,
      remaining: v.remaining.toString(),
      projectCount: v.projectCount,
    }))
    .sort((a, b) => new Decimal(b.remaining).comparedTo(new Decimal(a.remaining)));

  const vendorsWithDebt: DashboardVendorDebt[] = Array.from(vendorDebtMap.entries())
    .map(([id, v]) => ({
      id,
      name: v.name,
      roleLabel: v.roleLabel,
      remaining: v.remaining.toString(),
      projectCount: v.projectCount,
      lastPaymentAt: v.lastPaymentAt ? v.lastPaymentAt.toISOString() : null,
    }))
    .sort((a, b) => new Decimal(b.remaining).comparedTo(new Decimal(a.remaining)));

  // Also check project.updatedAt for lastActivityAt
  for (const p of openProjects) {
    if (!lastActivityAt || p.updatedAt > lastActivityAt) {
      lastActivityAt = p.updatedAt;
    }
  }

  // ── Sort & limit extended arrays ─────────────────────────────────────────────

  // overdueIncoming: sort by overdueDays desc (oldest first), limit 10
  overdueIncomingRows.sort((a, b) => b.overdueDays - a.overdueDays);
  const overdueIncoming = overdueIncomingRows.slice(0, 10);

  // upcomingObligations: sort by dueAt asc, limit 6
  upcomingObligationsRaw.sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());
  const upcomingObligations = upcomingObligationsRaw.slice(0, 6);

  // atRiskProjects: sort by remainingIn desc, limit 4
  atRiskProjectsRaw.sort(
    (a, b) => new Decimal(b.remainingIn).comparedTo(new Decimal(a.remainingIn)),
  );
  const atRiskProjects = atRiskProjectsRaw.slice(0, 4);

  return {
    kpi: {
      owedToMe: totalOwedToMe.toString(),
      iOwe: totalIOwe.toString(),
      owedToMeProjectCount,
      owedToMeClientCount: owedToMeClientIds.size,
      iOweProjectCount,
      iOweMemberCount: iOweMemberContactIds.size,
      iOweVendorCount: iOweVendorContactIds.size,
      // Extended
      overdueIncomingSum: overdueIncomingSum.toString(),
      dueSoonIncomingSum: dueSoonIncomingSum.toString(),
      dueSoonOutgoingSum: dueSoonOutgoingSum.toString(),
      freeCash: freeCash.toString(),
      cashGap14d: cashGap14d.toString(),
      openObligationCount,
      overdueProjectCount,
    },
    clientsWithDebt,
    teamWithDebt,
    vendorsWithDebt,
    meta: {
      activeProjects: openProjects.length,
      archivedProjects: archivedCount,
      lastActivityAt: lastActivityAt ? lastActivityAt.toISOString() : null,
    },
    overdueIncoming,
    upcomingObligations,
    atRiskProjects,
    debtStructure: {
      vendorOutSum: vendorOutSum.toString(),
      teamOutSum: teamOutSum.toString(),
      closedProjectCount: archivedCount,
      inProgressProjectCount: openProjects.length,
      overdueProjectCount,
    },
  };
}
