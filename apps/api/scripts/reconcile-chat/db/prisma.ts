import { PrismaClient } from "@prisma/client";
import path from "path";

/**
 * Returns a PrismaClient bound to the given SQLite file path.
 * Use for the reconcile working-copy without polluting global env.
 */
export function dbAt(dbPath: string): PrismaClient {
  const absUrl = "file:" + path.resolve(dbPath);
  return new PrismaClient({ datasourceUrl: absUrl });
}

export async function withDb<T>(dbPath: string, fn: (prisma: PrismaClient) => Promise<T>): Promise<T> {
  const client = dbAt(dbPath);
  try {
    return await fn(client);
  } finally {
    await client.$disconnect();
  }
}
