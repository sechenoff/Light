import { PrismaClient } from "@prisma/client";
import { execSync } from "node:child_process";
import path from "node:path";
import { issueMagicLink, consumeMagicLink, hashToken, invalidateUnusedInvites } from "../services/clientPortal/magicLink";

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

  test("invalidateUnusedInvites expires active INVITE tokens for the account, does not touch LOGIN or other accounts", async () => {
    const acc1 = await makeAccount();
    const acc2 = await makeAccount();

    // Issue two INVITE tokens for acc1
    await issueMagicLink(prisma, acc1.id, "INVITE");
    await issueMagicLink(prisma, acc1.id, "INVITE");

    // Issue a LOGIN token for acc1 (should NOT be touched)
    await issueMagicLink(prisma, acc1.id, "LOGIN");

    // Issue an INVITE for acc2 (should NOT be touched)
    await issueMagicLink(prisma, acc2.id, "INVITE");

    const before = Date.now();
    await prisma.$transaction((tx) => invalidateUnusedInvites(tx, acc1.id));

    // Both INVITE tokens for acc1 must now be expired (expiresAt <= now)
    const acc1Invites = await prisma.clientPortalMagicLink.findMany({
      where: { accountId: acc1.id, purpose: "INVITE" },
    });
    expect(acc1Invites).toHaveLength(2);
    for (const link of acc1Invites) {
      expect(link.expiresAt.getTime()).toBeLessThanOrEqual(before + 100); // small buffer for test timing
    }

    // LOGIN token for acc1 must be unaffected (expiresAt still in the future)
    const acc1Login = await prisma.clientPortalMagicLink.findFirst({
      where: { accountId: acc1.id, purpose: "LOGIN" },
    });
    expect(acc1Login).not.toBeNull();
    expect(acc1Login!.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // INVITE for acc2 must be unaffected (expiresAt still in the future)
    const acc2Invite = await prisma.clientPortalMagicLink.findFirst({
      where: { accountId: acc2.id, purpose: "INVITE" },
    });
    expect(acc2Invite).not.toBeNull();
    expect(acc2Invite!.expiresAt.getTime()).toBeGreaterThan(Date.now());
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
