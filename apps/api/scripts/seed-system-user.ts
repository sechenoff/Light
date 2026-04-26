#!/usr/bin/env tsx
/**
 * T3 — Seed system AdminUser for cron audit entries.
 *
 * AuditEntry has a FK to AdminUser (Restrict), so system-generated audit rows
 * (e.g., INVOICE_STATUS_OVERDUE from cron) need a real AdminUser row.
 * This script upserts a fixed "_system_" AdminUser with SUPER_ADMIN role.
 *
 * Idempotent: safe to run multiple times.
 *
 * Usage:
 *   npx tsx apps/api/scripts/seed-system-user.ts
 *
 * Called from deploy.sh before starting services (add manually if not present).
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.adminUser.upsert({
    where: { id: "_system_" },
    create: {
      id: "_system_",
      username: "_system_",
      passwordHash: "!disabled",   // non-usable password hash
      role: "SUPER_ADMIN",
    },
    update: {}, // no updates needed if already exists
  });
  console.log("[seed-system-user] AdminUser upserted:", user.id, user.username);
}

main()
  .catch((err) => {
    console.error("[seed-system-user] Error:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
