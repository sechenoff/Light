import { PrismaClient } from "@prisma/client";
import { execSync } from "node:child_process";
import path from "node:path";
import { issueMagicLink, consumeMagicLink, hashToken } from "../services/clientPortal/magicLink";

const TEST_DB = path.resolve(__dirname, `../../prisma/test-lk-magic-${process.pid}.db`);
process.env.DATABASE_URL = `file:${TEST_DB}`;
process.env.CLIENT_PORTAL_TOKEN_SECRET = "test-token-secret-sixteen-chars-min";

const prisma = new PrismaClient();

beforeAll(() => {
  execSync(`npx prisma db push --force-reset --skip-generate`, {
    cwd: path.resolve(__dirname, "../.."),
    env: {
      ...process.env,
      DATABASE_URL: `file:${TEST_DB}`,
      PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes",
    },
    stdio: "pipe",
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  require("fs").rmSync(TEST_DB, { force: true });
});

beforeEach(async () => {
  await prisma.clientPortalMagicLink.deleteMany();
  await prisma.clientPortalAccount.deleteMany();
  await prisma.client.deleteMany();
});

async function makeAccount() {
  const client = await prisma.client.create({ data: { name: `Client-${Date.now()}` } });
  return prisma.clientPortalAccount.create({
    data: { clientId: client.id, email: `u${Date.now()}@x.ru`, status: "PENDING" },
  });
}

describe("magicLink", () => {
  test("hashToken returns deterministic HMAC for same input", () => {
    const a = hashToken("abc");
    const b = hashToken("abc");
    expect(a).toBe(b);
    expect(a).not.toBe("abc");
    expect(a.length).toBeGreaterThanOrEqual(43);
  });

  test("issueMagicLink stores hash, returns raw token", async () => {
    const acc = await makeAccount();
    const { rawToken, expiresAt } = await issueMagicLink(prisma, acc.id, "INVITE");
    expect(rawToken.length).toBeGreaterThanOrEqual(43);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);

    const stored = await prisma.clientPortalMagicLink.findFirst({ where: { accountId: acc.id } });
    expect(stored?.tokenHash).toBe(hashToken(rawToken));
  });

  test("consumeMagicLink succeeds once, fails on replay", async () => {
    const acc = await makeAccount();
    const { rawToken } = await issueMagicLink(prisma, acc.id, "LOGIN");

    const r1 = await consumeMagicLink(prisma, rawToken, { ip: "1.1.1.1", ua: "test" });
    expect(r1?.accountId).toBe(acc.id);
    expect(r1?.purpose).toBe("LOGIN");

    const r2 = await consumeMagicLink(prisma, rawToken, { ip: "1.1.1.1", ua: "test" });
    expect(r2).toBeNull();
  });

  test("consumeMagicLink rejects expired token", async () => {
    const acc = await makeAccount();
    const { rawToken } = await issueMagicLink(prisma, acc.id, "LOGIN");
    // Force-expire
    await prisma.clientPortalMagicLink.updateMany({
      where: { accountId: acc.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await consumeMagicLink(prisma, rawToken, { ip: null, ua: null })).toBeNull();
  });
});
