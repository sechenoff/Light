import path from "node:path";
import fs from "node:fs";
import { execSync } from "node:child_process";
import request from "supertest";

const TEST_DB = path.resolve(__dirname, `../../prisma/test-lk-req-${process.pid}.db`);
process.env.DATABASE_URL = `file:${TEST_DB}`;
process.env.CLIENT_PORTAL_SESSION_SECRET = "test-session-secret-min-sixteen-chars";
process.env.CLIENT_PORTAL_TOKEN_SECRET = "test-token-secret-min-sixteen-chars";

let app: any;
let prisma: any;

beforeAll(async () => {
  execSync("npx prisma db push --force-reset --skip-generate", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });
  const { app: a } = await import("../app");
  const { PrismaClient } = await import("@prisma/client");
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

describe("POST /api/lk/auth/request-login", () => {
  test("always returns 200 even when account doesn't exist", async () => {
    const res = await request(app).post("/api/lk/auth/request-login").send({ email: "nobody@x.ru" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test("creates LOGIN magic-link for ACTIVE account", async () => {
    const client = await prisma.client.create({ data: { name: "Acme" } });
    const acc = await prisma.clientPortalAccount.create({
      data: { clientId: client.id, email: "user@x.ru", status: "ACTIVE" },
    });

    const res = await request(app).post("/api/lk/auth/request-login").send({ email: "user@x.ru" });
    expect(res.status).toBe(200);

    const link = await prisma.clientPortalMagicLink.findFirst({ where: { accountId: acc.id, purpose: "LOGIN" } });
    expect(link).toBeTruthy();
  });

  test("skips link creation for DISABLED account", async () => {
    const client = await prisma.client.create({ data: { name: "Acme2" } });
    const acc = await prisma.clientPortalAccount.create({
      data: { clientId: client.id, email: "off@x.ru", status: "DISABLED" },
    });

    const res = await request(app).post("/api/lk/auth/request-login").send({ email: "off@x.ru" });
    expect(res.status).toBe(200);

    const link = await prisma.clientPortalMagicLink.findFirst({ where: { accountId: acc.id } });
    expect(link).toBeNull();
  });

  test("rejects bad email format with 400", async () => {
    const res = await request(app).post("/api/lk/auth/request-login").send({ email: "not-an-email" });
    expect(res.status).toBe(400);
  });
});
