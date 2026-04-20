/**
 * Obligations aggregation service for Gaffer CRM (Task 3.1).
 * Lists every IN + OUT obligation for the signed-in Gaffer user
 * across all OPEN projects.
 */

import type { Request } from "express";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "../../prisma";
import { gafferWhere } from "./tenant";

export type GafferObligationView = {
  id: string;                    // synthetic: "project:${projectId}" or "member:${contactId}:${projectId}"
  direction: "IN" | "OUT";
  category: "client" | "crew" | "rental";
  counterpartyId: string;        // clientId for IN, contactId for OUT
  counterpartyName: string;
  projectId: string;
  projectCode: string;           // "G-" + projectId.slice(0,8).toUpperCase()
  projectTitle: string;
  sum: string;                   // decimal string — planned total
  paid: string;                  // decimal string — amount paid so far
  remaining: string;             // decimal string — max(0, sum - paid)
  dueAt: string | null;          // ISO date or null
  overdueDays: number | null;    // integer days past due when dueAt < now AND remaining > 0, else null
  status: "open" | "partial" | "paid" | "overdue";
};

export type GafferObligationsFilter = {
  direction?: "IN" | "OUT";
  category?: "client" | "crew" | "rental";
  status?: "open" | "partial" | "paid" | "overdue" | "active";
  sort?: "dueAt" | "remaining" | "overdueDays";
};

function deriveProjectCode(projectId: string): string {
  return "G-" + projectId.slice(0, 8).toUpperCase();
}

function deriveStatus(
  paid: Decimal,
  remaining: Decimal,
  dueAt: Date | null,
  now: Date,
): "open" | "partial" | "paid" | "overdue" {
  if (remaining.eq(0)) return "paid";
  if (dueAt && dueAt < now && remaining.gt(0)) return "overdue";
  if (paid.gt(0) && remaining.gt(0)) return "partial";
  return "open";
}

function deriveOverdueDays(
  dueAt: Date | null,
  remaining: Decimal,
  now: Date,
  status: "open" | "partial" | "paid" | "overdue",
): number | null {
  if (status !== "overdue") return null;
  if (!dueAt || !remaining.gt(0)) return null;
  return Math.floor((now.getTime() - dueAt.getTime()) / (1000 * 60 * 60 * 24));
}

export async function listObligations(
  req: Request,
  filters: GafferObligationsFilter = {},
): Promise<{ items: GafferObligationView[] }> {
  const { gafferUserId } = gafferWhere(req);
  const ZERO = new Decimal(0);
  const now = new Date();

  const openProjects = await prisma.gafferProject.findMany({
    where: { gafferUserId, status: "OPEN" },
    include: {
      client: true,
      members: {
        include: { contact: true },
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
  });

  const obligations: GafferObligationView[] = [];

  for (const project of openProjects) {
    const projectCode = deriveProjectCode(project.id);
    const clientDueAt = project.clientDueAt as Date | null;

    // ── IN row (client obligation) ─────────────────────────────────────────

    const clientSum = new Decimal(project.clientPlanAmount);
    if (clientSum.gt(ZERO)) {
      const clientPaid = project.payments
        .filter((p) => p.direction === "IN")
        .reduce((acc, p) => acc.plus(p.amount), ZERO);
      const rawRem = clientSum.minus(clientPaid);
      const clientRem = rawRem.gt(ZERO) ? rawRem : ZERO;

      const status = deriveStatus(clientPaid, clientRem, clientDueAt, now);
      const overdueDays = deriveOverdueDays(clientDueAt, clientRem, now, status);

      obligations.push({
        id: `project:${project.id}`,
        direction: "IN",
        category: "client",
        counterpartyId: project.clientId,
        counterpartyName: project.client.name,
        projectId: project.id,
        projectCode,
        projectTitle: project.title,
        sum: clientSum.toString(),
        paid: clientPaid.toString(),
        remaining: clientRem.toString(),
        dueAt: clientDueAt ? clientDueAt.toISOString() : null,
        overdueDays,
        status,
      });
    }

    // ── OUT rows (member obligations) ──────────────────────────────────────

    for (const member of project.members) {
      const contactType = member.contact?.type;
      if (contactType !== "TEAM_MEMBER" && contactType !== "VENDOR") continue;

      const memberSum = new Decimal(member.plannedAmount);
      if (!memberSum.gt(ZERO)) continue;

      // GafferPayment.memberId === GafferContact.id (not member row id)
      const memberPaid = project.payments
        .filter((p) => p.direction === "OUT" && p.memberId === member.contactId)
        .reduce((acc, p) => acc.plus(p.amount), ZERO);

      const rawRem = memberSum.minus(memberPaid);
      const memberRem = rawRem.gt(ZERO) ? rawRem : ZERO;

      const memberDueAt = (member as unknown as { dueAt?: Date | null }).dueAt ?? null;
      const category: "crew" | "rental" = contactType === "VENDOR" ? "rental" : "crew";

      const status = deriveStatus(memberPaid, memberRem, memberDueAt, now);
      const overdueDays = deriveOverdueDays(memberDueAt, memberRem, now, status);

      obligations.push({
        id: `member:${member.contactId}:${project.id}`,
        direction: "OUT",
        category,
        counterpartyId: member.contactId,
        counterpartyName: member.contact?.name ?? "",
        projectId: project.id,
        projectCode,
        projectTitle: project.title,
        sum: memberSum.toString(),
        paid: memberPaid.toString(),
        remaining: memberRem.toString(),
        dueAt: memberDueAt ? memberDueAt.toISOString() : null,
        overdueDays,
        status,
      });
    }
  }

  // ── Apply filters ──────────────────────────────────────────────────────────

  let filtered = obligations;

  if (filters.direction) {
    filtered = filtered.filter((o) => o.direction === filters.direction);
  }

  if (filters.category) {
    filtered = filtered.filter((o) => o.category === filters.category);
  }

  if (filters.status) {
    if (filters.status === "active") {
      // synthetic: open | partial | overdue
      filtered = filtered.filter((o) => o.status !== "paid");
    } else {
      filtered = filtered.filter((o) => o.status === filters.status);
    }
  }

  // ── Sort ───────────────────────────────────────────────────────────────────

  const sort = filters.sort ?? "dueAt";

  if (sort === "dueAt") {
    // asc, nulls last
    filtered.sort((a, b) => {
      if (a.dueAt === null && b.dueAt === null) return 0;
      if (a.dueAt === null) return 1;
      if (b.dueAt === null) return -1;
      return new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
    });
  } else if (sort === "remaining") {
    filtered.sort((a, b) => parseFloat(b.remaining) - parseFloat(a.remaining));
  } else if (sort === "overdueDays") {
    filtered.sort((a, b) => {
      const aDays = a.overdueDays ?? -1;
      const bDays = b.overdueDays ?? -1;
      return bDays - aDays;
    });
  }

  return { items: filtered };
}
