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

export interface GafferDashboardData {
  kpi: DashboardKpi;
  clientsWithDebt: DashboardClientDebt[];
  teamWithDebt: DashboardTeamDebt[];
  vendorsWithDebt: DashboardVendorDebt[];
  meta: DashboardMeta;
}

export async function getDashboard(req: Request): Promise<GafferDashboardData> {
  const { gafferUserId } = gafferWhere(req);
  const ZERO = new Decimal(0);

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
        if (memberRem.lte(ZERO)) continue;

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
        }
      }
    }
  }

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

  return {
    kpi: {
      owedToMe: totalOwedToMe.toString(),
      iOwe: totalIOwe.toString(),
      owedToMeProjectCount,
      owedToMeClientCount: owedToMeClientIds.size,
      iOweProjectCount,
      iOweMemberCount: iOweMemberContactIds.size,
      iOweVendorCount: iOweVendorContactIds.size,
    },
    clientsWithDebt,
    teamWithDebt,
    vendorsWithDebt,
    meta: {
      activeProjects: openProjects.length,
      archivedProjects: archivedCount,
      lastActivityAt: lastActivityAt ? lastActivityAt.toISOString() : null,
    },
  };
}
