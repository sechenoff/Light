import { PrismaClient } from "@prisma/client";

// PrismaClient should be a singleton in dev to avoid exhausting connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.PRISMA_LOG === "true" ? ["query", "error", "warn"] : ["error", "warn"],
  });

if (!globalForPrisma.prisma) globalForPrisma.prisma = prisma;

