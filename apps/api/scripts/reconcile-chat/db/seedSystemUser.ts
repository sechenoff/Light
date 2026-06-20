import type { PrismaClient } from "@prisma/client";
import crypto from "crypto";
import { SYSTEM_USER_ID } from "../types";

/**
 * Idempotent: creates the synthetic AdminUser used as `userId` for reconcile AuditEntry rows.
 * Login under this user is impossible — passwordHash is random and discarded.
 */
export async function ensureSystemReconcileUser(prisma: PrismaClient): Promise<void> {
  const existing = await prisma.adminUser.findUnique({ where: { id: SYSTEM_USER_ID } });
  if (existing) return;
  const disabledHash = "$2a$10$" + crypto.randomBytes(48).toString("base64").slice(0, 53);
  await prisma.adminUser.create({
    data: {
      id: SYSTEM_USER_ID,
      username: SYSTEM_USER_ID,
      passwordHash: disabledHash,
      role: "SUPER_ADMIN",
    },
  });
}
