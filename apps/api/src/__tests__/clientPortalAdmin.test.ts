/**
 * Интеграционные тесты admin portal endpoints:
 *   POST   /api/admin/clients/:id/portal-invite
 *   GET    /api/admin/clients/:id/portal-account
 *   POST   /api/admin/clients/:id/portal-account/disable
 *   POST   /api/admin/clients/:id/portal-account/reenable
 *   POST   /api/admin/clients/:id/portal-account/resend
 */

import path from "node:path";
import fs from "node:fs";
import { execSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";

// Мокаем mailer, чтобы в отдельных тестах имитировать провал SMTP.
// По умолчанию — реальная реализация (в test-окружении это dev-fallback в консоль).
vi.mock("../services/clientPortal/mailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/clientPortal/mailer")>();
  return {
    ...actual,
    sendInviteEmail: vi.fn(actual.sendInviteEmail),
  };
});

const TEST_DB = path.resolve(__dirname, `../../prisma/test-lk-admin-${process.pid}.db`);
process.env.DATABASE_URL = `file:${TEST_DB}`;
process.env.CLIENT_PORTAL_SESSION_SECRET = "test-session-secret-min-sixteen-chars";
process.env.CLIENT_PORTAL_TOKEN_SECRET = "test-token-secret-min-sixteen-chars";
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-admin,openclaw-test-bot";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-admin-min16chars!!";
process.env.BARCODE_SECRET = "test-barcode-secret-admin";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-admin";

let app: Express;
let prisma: any;
let signSession: (payload: { userId: string; username: string; role: string }) => string;

let superAdminToken: string;
let warehouseToken: string;
let technicianToken: string;
let adminUserId: string;

beforeAll(async () => {
  execSync("npx prisma db push --force-reset --skip-generate", {
    cwd: path.resolve(__dirname, "../.."),
    env: {
      ...process.env,
      DATABASE_URL: `file:${TEST_DB}`,
      PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes",
    },
    stdio: "pipe",
  });

  const mod = await import("../app");
  app = mod.app as Express;
  const pmod = await import("../prisma");
  prisma = pmod.prisma;

  const { hashPassword, signSession: ss } = await import("../services/auth");
  signSession = ss;
  const hash = await hashPassword("test-pass-lk-admin");

  const sa = await prisma.adminUser.create({
    data: { username: `lk_sa_${process.pid}`, passwordHash: hash, role: "SUPER_ADMIN" },
  });
  adminUserId = sa.id;
  superAdminToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });

  const wh = await prisma.adminUser.create({
    data: { username: `lk_wh_${process.pid}`, passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  const tech = await prisma.adminUser.create({
    data: { username: `lk_tech_${process.pid}`, passwordHash: hash, role: "TECHNICIAN" },
  });
  technicianToken = signSession({ userId: tech.id, username: tech.username, role: "TECHNICIAN" });
});

afterAll(async () => {
  await prisma.$disconnect();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
});

beforeEach(async () => {
  await prisma.auditEntry.deleteMany();
  await prisma.clientPortalMagicLink.deleteMany();
  await prisma.clientPortalAccount.deleteMany();
  await prisma.client.deleteMany();
});

function AUTH_SA() {
  return { "X-API-Key": "test-key-admin", Authorization: `Bearer ${superAdminToken}` };
}
function AUTH_WH() {
  return { "X-API-Key": "test-key-admin", Authorization: `Bearer ${warehouseToken}` };
}
function AUTH_TECH() {
  return { "X-API-Key": "test-key-admin", Authorization: `Bearer ${technicianToken}` };
}

// ─── POST /portal-invite ─────────────────────────────────────────────────────

describe("POST /api/admin/clients/:id/portal-invite", () => {
  it("SUPER_ADMIN creates account + INVITE token + writes audit", async () => {
    const client = await prisma.client.create({ data: { name: "Acme Corp" } });

    const res = await request(app)
      .post(`/api/admin/clients/${client.id}/portal-invite`)
      .set(AUTH_SA())
      .send({ email: "client@acme.ru" });

    expect(res.status).toBe(200);
    expect(res.body.email).toBe("client@acme.ru");
    expect(res.body.accountId).toBeTruthy();
    expect(res.body.expiresAt).toBeTruthy();
    // Письмо ушло (dev-fallback в тестах) + ссылка-приглашение возвращается всегда
    expect(res.body.emailSent).toBe(true);
    expect(res.body.inviteUrl).toContain("/lk/verify?token=");

    // Аккаунт создан в статусе PENDING
    const acc = await prisma.clientPortalAccount.findUnique({ where: { clientId: client.id } });
    expect(acc).toBeTruthy();
    expect(acc!.status).toBe("PENDING");
    expect(acc!.email).toBe("client@acme.ru");

    // INVITE-ссылка создана
    const link = await prisma.clientPortalMagicLink.findFirst({
      where: { accountId: acc!.id, purpose: "INVITE" },
    });
    expect(link).toBeTruthy();

    // Аудит записан
    const audit = await prisma.auditEntry.findFirst({
      where: { action: "CLIENT_PORTAL_INVITE_SENT" },
    });
    expect(audit).toBeTruthy();
    expect(audit!.entityType).toBe("ClientPortalAccount");
    expect(audit!.entityId).toBe(acc!.id);
  });

  it("повторный invite обновляет email и инвалидирует старый INVITE токен", async () => {
    const client = await prisma.client.create({ data: { name: "Repeat Corp" } });

    // Первый invite
    await request(app)
      .post(`/api/admin/clients/${client.id}/portal-invite`)
      .set(AUTH_SA())
      .send({ email: "old@acme.ru" });

    const acc = await prisma.clientPortalAccount.findUnique({ where: { clientId: client.id } });
    const oldLink = await prisma.clientPortalMagicLink.findFirst({
      where: { accountId: acc!.id, purpose: "INVITE" },
    });
    expect(oldLink).toBeTruthy();

    // Второй invite
    const res2 = await request(app)
      .post(`/api/admin/clients/${client.id}/portal-invite`)
      .set(AUTH_SA())
      .send({ email: "new@acme.ru" });

    expect(res2.status).toBe(200);
    expect(res2.body.email).toBe("new@acme.ru");

    // Старый токен инвалидирован (expiresAt = теперь в прошлом или настоящем)
    const oldLinkRefreshed = await prisma.clientPortalMagicLink.findUnique({
      where: { id: oldLink!.id },
    });
    expect(oldLinkRefreshed!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    // Новый токен создан
    const allLinks = await prisma.clientPortalMagicLink.findMany({
      where: { accountId: acc!.id, purpose: "INVITE" },
    });
    expect(allLinks.length).toBe(2);
  });

  it("WAREHOUSE → 403", async () => {
    const client = await prisma.client.create({ data: { name: "WH Test" } });
    const res = await request(app)
      .post(`/api/admin/clients/${client.id}/portal-invite`)
      .set(AUTH_WH())
      .send({ email: "wh@test.ru" });
    expect(res.status).toBe(403);
  });

  it("TECHNICIAN → 403", async () => {
    const client = await prisma.client.create({ data: { name: "Tech Test" } });
    const res = await request(app)
      .post(`/api/admin/clients/${client.id}/portal-invite`)
      .set(AUTH_TECH())
      .send({ email: "tech@test.ru" });
    expect(res.status).toBe(403);
  });

  it("несуществующий clientId → 404", async () => {
    const res = await request(app)
      .post("/api/admin/clients/nonexistent-client-id/portal-invite")
      .set(AUTH_SA())
      .send({ email: "nobody@test.ru" });
    expect(res.status).toBe(404);
  });

  it("некорректный email → 400", async () => {
    const client = await prisma.client.create({ data: { name: "Bad Email" } });
    const res = await request(app)
      .post(`/api/admin/clients/${client.id}/portal-invite`)
      .set(AUTH_SA())
      .send({ email: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("провал SMTP → 200 + emailSent:false + inviteUrl (аккаунт создан)", async () => {
    const mailer = await import("../services/clientPortal/mailer");
    vi.mocked(mailer.sendInviteEmail).mockRejectedValueOnce(new Error("SMTP down"));

    const client = await prisma.client.create({ data: { name: "SMTP Fail Corp" } });
    const res = await request(app)
      .post(`/api/admin/clients/${client.id}/portal-invite`)
      .set(AUTH_SA())
      .send({ email: "smtp.fail@acme.ru" });

    // HTTP всё ещё 200 — аккаунт и токен созданы, только письмо не ушло
    expect(res.status).toBe(200);
    expect(res.body.emailSent).toBe(false);
    expect(res.body.inviteUrl).toContain("/lk/verify?token=");

    // Аккаунт создан несмотря на провал письма
    const acc = await prisma.clientPortalAccount.findUnique({ where: { clientId: client.id } });
    expect(acc).toBeTruthy();
    expect(acc!.status).toBe("PENDING");

    // INVITE-токен создан — ссылка из ответа рабочая
    const link = await prisma.clientPortalMagicLink.findFirst({
      where: { accountId: acc!.id, purpose: "INVITE" },
    });
    expect(link).toBeTruthy();
  });
});

// ─── GET /portal-account ──────────────────────────────────────────────────────

describe("GET /api/admin/clients/:id/portal-account", () => {
  it("возвращает null, если аккаунт не создан", async () => {
    const client = await prisma.client.create({ data: { name: "No Account" } });
    const res = await request(app)
      .get(`/api/admin/clients/${client.id}/portal-account`)
      .set(AUTH_SA());
    expect(res.status).toBe(200);
    expect(res.body.account).toBeNull();
  });

  it("возвращает аккаунт, если он существует", async () => {
    const client = await prisma.client.create({ data: { name: "Has Account" } });
    const acc = await prisma.clientPortalAccount.create({
      data: { clientId: client.id, email: "exists@test.ru", status: "ACTIVE" },
    });

    const res = await request(app)
      .get(`/api/admin/clients/${client.id}/portal-account`)
      .set(AUTH_SA());
    expect(res.status).toBe(200);
    expect(res.body.account).toBeTruthy();
    expect(res.body.account.id).toBe(acc.id);
    expect(res.body.account.email).toBe("exists@test.ru");
    expect(res.body.account.status).toBe("ACTIVE");
  });

  it("WAREHOUSE → 403", async () => {
    const client = await prisma.client.create({ data: { name: "WH Guard Test" } });
    const res = await request(app)
      .get(`/api/admin/clients/${client.id}/portal-account`)
      .set(AUTH_WH());
    expect(res.status).toBe(403);
  });
});

// ─── disable / reenable ───────────────────────────────────────────────────────

describe("disable и reenable", () => {
  it("disable устанавливает DISABLED + аудит, reenable устанавливает ACTIVE + аудит", async () => {
    const client = await prisma.client.create({ data: { name: "Toggle Corp" } });
    await prisma.clientPortalAccount.create({
      data: { clientId: client.id, email: "toggle@test.ru", status: "ACTIVE" },
    });

    // disable
    const disRes = await request(app)
      .post(`/api/admin/clients/${client.id}/portal-account/disable`)
      .set(AUTH_SA());
    expect(disRes.status).toBe(200);
    expect(disRes.body.account.status).toBe("DISABLED");
    expect(disRes.body.account.disabledAt).toBeTruthy();
    expect(disRes.body.account.disabledBy).toBe(adminUserId);

    const disAudit = await prisma.auditEntry.findFirst({
      where: { action: "CLIENT_PORTAL_DISABLED" },
    });
    expect(disAudit).toBeTruthy();

    // reenable
    const reenRes = await request(app)
      .post(`/api/admin/clients/${client.id}/portal-account/reenable`)
      .set(AUTH_SA());
    expect(reenRes.status).toBe(200);
    expect(reenRes.body.account.status).toBe("ACTIVE");
    expect(reenRes.body.account.disabledAt).toBeNull();

    const reenAudit = await prisma.auditEntry.findFirst({
      where: { action: "CLIENT_PORTAL_REENABLED" },
    });
    expect(reenAudit).toBeTruthy();
  });

  it("disable несуществующего аккаунта → 404", async () => {
    const client = await prisma.client.create({ data: { name: "No Acc Disable" } });
    const res = await request(app)
      .post(`/api/admin/clients/${client.id}/portal-account/disable`)
      .set(AUTH_SA());
    expect(res.status).toBe(404);
  });

  it("reenable несуществующего аккаунта → 404", async () => {
    const client = await prisma.client.create({ data: { name: "No Acc Reenable" } });
    const res = await request(app)
      .post(`/api/admin/clients/${client.id}/portal-account/reenable`)
      .set(AUTH_SA());
    expect(res.status).toBe(404);
  });

  it("WAREHOUSE → 403 на disable", async () => {
    const client = await prisma.client.create({ data: { name: "WH Disable" } });
    await prisma.clientPortalAccount.create({
      data: { clientId: client.id, email: "wh.disable@test.ru", status: "ACTIVE" },
    });
    const res = await request(app)
      .post(`/api/admin/clients/${client.id}/portal-account/disable`)
      .set(AUTH_WH());
    expect(res.status).toBe(403);
  });
});

// ─── resend ───────────────────────────────────────────────────────────────────

describe("POST /portal-account/resend", () => {
  it("инвалидирует предыдущий INVITE и создаёт новый + аудит", async () => {
    const client = await prisma.client.create({ data: { name: "Resend Corp" } });
    const acc = await prisma.clientPortalAccount.create({
      data: { clientId: client.id, email: "resend@test.ru", status: "PENDING" },
    });

    // Создаём первый invite-токен вручную (имитируем предыдущий invite)
    const oldLink = await prisma.clientPortalMagicLink.create({
      data: {
        accountId: acc.id,
        tokenHash: "old-hash-resend-test",
        purpose: "INVITE",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    const res = await request(app)
      .post(`/api/admin/clients/${client.id}/portal-account/resend`)
      .set(AUTH_SA());

    expect(res.status).toBe(200);
    expect(res.body.expiresAt).toBeTruthy();
    expect(res.body.emailSent).toBe(true);
    expect(res.body.inviteUrl).toContain("/lk/verify?token=");

    // Старый токен инвалидирован
    const oldLinkNow = await prisma.clientPortalMagicLink.findUnique({ where: { id: oldLink.id } });
    expect(oldLinkNow!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    // Новый токен создан
    const links = await prisma.clientPortalMagicLink.findMany({
      where: { accountId: acc.id, purpose: "INVITE" },
    });
    expect(links.length).toBe(2);

    // Аудит записан
    const audit = await prisma.auditEntry.findFirst({ where: { action: "CLIENT_PORTAL_INVITE_RESENT" } });
    expect(audit).toBeTruthy();
  });

  it("resend при провале SMTP → 200 + emailSent:false + inviteUrl", async () => {
    const mailer = await import("../services/clientPortal/mailer");
    vi.mocked(mailer.sendInviteEmail).mockRejectedValueOnce(new Error("SMTP down"));

    const client = await prisma.client.create({ data: { name: "Resend SMTP Fail" } });
    const acc = await prisma.clientPortalAccount.create({
      data: { clientId: client.id, email: "resend.fail@test.ru", status: "PENDING" },
    });

    const res = await request(app)
      .post(`/api/admin/clients/${client.id}/portal-account/resend`)
      .set(AUTH_SA());

    expect(res.status).toBe(200);
    expect(res.body.emailSent).toBe(false);
    expect(res.body.inviteUrl).toContain("/lk/verify?token=");

    // Токен всё равно переиздан — ссылка из ответа рабочая
    const links = await prisma.clientPortalMagicLink.findMany({
      where: { accountId: acc.id, purpose: "INVITE" },
    });
    expect(links.length).toBe(1);
  });

  it("resend для DISABLED аккаунта → 409", async () => {
    const client = await prisma.client.create({ data: { name: "Disabled Resend" } });
    await prisma.clientPortalAccount.create({
      data: { clientId: client.id, email: "disabled.resend@test.ru", status: "DISABLED" },
    });

    const res = await request(app)
      .post(`/api/admin/clients/${client.id}/portal-account/resend`)
      .set(AUTH_SA());
    expect(res.status).toBe(409);
  });

  it("resend несуществующего аккаунта → 404", async () => {
    const client = await prisma.client.create({ data: { name: "No Acc Resend" } });
    const res = await request(app)
      .post(`/api/admin/clients/${client.id}/portal-account/resend`)
      .set(AUTH_SA());
    expect(res.status).toBe(404);
  });

  it("WAREHOUSE → 403 на resend", async () => {
    const client = await prisma.client.create({ data: { name: "WH Resend" } });
    await prisma.clientPortalAccount.create({
      data: { clientId: client.id, email: "wh.resend@test.ru", status: "PENDING" },
    });
    const res = await request(app)
      .post(`/api/admin/clients/${client.id}/portal-account/resend`)
      .set(AUTH_WH());
    expect(res.status).toBe(403);
  });
});
