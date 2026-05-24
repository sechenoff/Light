import path from "node:path";
import fs from "node:fs";
import { execSync } from "node:child_process";
import request from "supertest";

const TEST_DB = path.resolve(__dirname, `../../prisma/test-lk-verify-${process.pid}.db`);
process.env.DATABASE_URL = `file:${TEST_DB}`;
process.env.CLIENT_PORTAL_SESSION_SECRET = "test-session-secret-min-sixteen-chars";
process.env.CLIENT_PORTAL_TOKEN_SECRET = "test-token-secret-min-sixteen-chars";

let app: any;
let prisma: any;
let issueMagicLink: any;

beforeAll(async () => {
  execSync("npx prisma db push --force-reset --skip-generate", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });
  const { app: a } = await import("../app");
  const { PrismaClient } = await import("@prisma/client");
  ({ issueMagicLink } = await import("../services/clientPortal/magicLink"));
  app = a;
  prisma = new PrismaClient();
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(TEST_DB, { force: true });
});

beforeEach(async () => {
  await prisma.clientPortalMagicLink.deleteMany();
  await prisma.clientPortalAccount.deleteMany();
  await prisma.client.deleteMany();
});

async function makeAccountWithToken(purpose: "INVITE" | "LOGIN") {
  const client = await prisma.client.create({ data: { name: `Cl-${Date.now()}` } });
  const acc = await prisma.clientPortalAccount.create({
    data: { clientId: client.id, email: `u${Date.now()}@x.ru`, status: purpose === "INVITE" ? "PENDING" : "ACTIVE" },
  });
  const { rawToken } = await issueMagicLink(prisma, acc.id, purpose);
  return { acc, client, rawToken };
}

describe("POST /api/lk/auth/verify", () => {
  test("INVITE token activates PENDING account, sets cookie", async () => {
    const { rawToken, acc } = await makeAccountWithToken("INVITE");
    const res = await request(app).post("/api/lk/auth/verify").send({ token: rawToken });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers["set-cookie"]?.[0]).toMatch(/lk_session=/);

    const after = await prisma.clientPortalAccount.findUnique({ where: { id: acc.id } });
    expect(after.status).toBe("ACTIVE");
    expect(after.acceptedAt).toBeTruthy();
  });

  test("LOGIN token returns 200 + cookie, increments lastLoginAt", async () => {
    const { rawToken, acc } = await makeAccountWithToken("LOGIN");
    const res = await request(app).post("/api/lk/auth/verify").send({ token: rawToken });
    expect(res.status).toBe(200);

    const after = await prisma.clientPortalAccount.findUnique({ where: { id: acc.id } });
    expect(after.lastLoginAt).toBeTruthy();
  });

  test("reuse same token → 401", async () => {
    const { rawToken } = await makeAccountWithToken("LOGIN");
    await request(app).post("/api/lk/auth/verify").send({ token: rawToken });
    const res2 = await request(app).post("/api/lk/auth/verify").send({ token: rawToken });
    expect(res2.status).toBe(401);
  });

  test("invalid token → 401", async () => {
    const res = await request(app).post("/api/lk/auth/verify").send({ token: "bogus-but-long-enough-token-bogus-but-long-enough" });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/lk/me", () => {
  test("returns account info with valid cookie", async () => {
    const { rawToken, acc, client } = await makeAccountWithToken("LOGIN");
    const verifyRes = await request(app).post("/api/lk/auth/verify").send({ token: rawToken });
    const cookie = verifyRes.headers["set-cookie"];

    const res = await request(app).get("/api/lk/me").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.client.id).toBe(client.id);
    expect(res.body.account.email).toBe(acc.email);
  });

  test("401 without cookie", async () => {
    const res = await request(app).get("/api/lk/me");
    expect(res.status).toBe(401);
  });
});

describe("POST /api/lk/auth/logout", () => {
  test("clears cookie", async () => {
    const { rawToken } = await makeAccountWithToken("LOGIN");
    const verifyRes = await request(app).post("/api/lk/auth/verify").send({ token: rawToken });
    const cookie = verifyRes.headers["set-cookie"];

    const res = await request(app).post("/api/lk/auth/logout").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]?.[0]).toMatch(/lk_session=;/);
  });
});
