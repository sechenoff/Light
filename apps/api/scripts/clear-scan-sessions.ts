import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();

async function main() {
  const del = await p.scanSession.deleteMany({});
  console.log("Deleted sessions:", del.count);
}

main().catch(console.error).finally(() => p.$disconnect());
