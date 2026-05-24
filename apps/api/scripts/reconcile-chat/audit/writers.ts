import type { Prisma, PrismaClient } from "@prisma/client";
import { SYSTEM_USER_ID } from "../types";

type TxClient = Pick<PrismaClient, "auditEntry"> | Prisma.TransactionClient;

export interface ReconcileAuditArgs {
  action:
    | "BOOKING_RECONCILE_INSERT"
    | "BOOKING_RECONCILE_UPDATE"
    | "CLIENT_MERGE"
    | "SLANG_RECONCILE_INSERT"
    | "SLANG_RECONCILE_BUGFIX";
  entityType: "Booking" | "Client" | "SlangAlias";
  entityId: string;
  metadata: Record<string, unknown>;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

const MAX_JSON_BYTES = 10_000;

function truncateJson(value: Record<string, unknown>): string {
  const s = JSON.stringify(value);
  return s.length > MAX_JSON_BYTES ? s.slice(0, MAX_JSON_BYTES) : s;
}

export async function writeReconcileAudit(tx: TxClient, args: ReconcileAuditArgs): Promise<void> {
  await tx.auditEntry.create({
    data: {
      userId: SYSTEM_USER_ID,
      action: args.action,
      entityType: args.entityType,
      entityId: args.entityId,
      before: args.before ? truncateJson(args.before) : null,
      after: truncateJson({ ...(args.after ?? {}), _meta: args.metadata }),
    },
  });
}
