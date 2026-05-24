# Customer Portal `/lk` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a separate customer-facing portal `/lk` where rental clients (gaffers) sign in via admin-issued magic links, view their booking/estimate history, see outstanding debt, get a top-equipment + typical-kit analytic view, and access the crew calculator + external electrical-load calculator. Self-ordering deferred to a future Подпроект 3.

**Architecture:** New isolated Next.js route tree `apps/web/app/lk/*` (no `AppShell`), new Express namespace `/api/lk/*` with its own JWT cookie (`lk_session`) and `lkAuth` middleware (NOT under `apiKeyAuth`). Magic-link flow with HMAC-SHA256 tokenHash storage, single-use enforcement in transaction. Reuses existing `computeDebts`, PDF renderers, `@light-rental/shared` crew calculator. Admin invite API under existing `apiKeyAuth + rolesGuard(["SUPER_ADMIN"])`.

**Tech Stack:** Express 4 + Prisma 6 (SQLite) + Zod + nodemailer + jsonwebtoken; Next.js 14 + React 18 + Tailwind 3 (IBM Plex canon); vitest (API integration tests with isolated SQLite per file, `@testing-library/react` + jsdom for components).

**Spec:** [docs/superpowers/specs/2026-05-24-customer-portal-lk-design.md](../specs/2026-05-24-customer-portal-lk-design.md)

**Hard constraints (verify every task):**
- All UI text Russian. IBM Plex canon tokens (`ink/surface/border/accent/rose/amber/emerald/teal/indigo/slate`). No hex literals, no `slate-/blue-` literals outside finance.
- Mobile-first: design at 375px, expand to 1440px.
- No barcodes in any portal UI. No DRAFT bookings visible to clients.
- Business logic in services; routes thin; Zod on inputs; `HttpError` for errors; audit in same `$transaction` as mutation.
- `clientId` ALWAYS from `req.clientPortal.clientId` (JWT) — never from query/body.
- `apiKeyAuth` is NOT applied to `/api/lk/*`. Admin endpoints (`/api/admin/clients/:id/portal-*`) are under `apiKeyAuth + rolesGuard(["SUPER_ADMIN"])`.
- Magic-link tokens: 32 crypto-random bytes; raw token NEVER persisted; only HMAC-SHA256 hash stored.
- Booking `id` displayed as `#` + last 6 chars upper-cased (matches existing convention from warehouse-scan-redesign).

---

## Phase 0 — Foundation: schema, env, audit

### Task 0.1: Prisma schema — `ClientPortalAccount` + `ClientPortalMagicLink`

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `apps/api/src/services/audit.ts` (extend `AuditEntityType`)

- [ ] **Step 1: Append enums + models to `apps/api/prisma/schema.prisma`**

```prisma
enum ClientPortalAccountStatus {
  PENDING
  ACTIVE
  DISABLED
}

enum ClientPortalMagicLinkPurpose {
  INVITE
  LOGIN
}

model ClientPortalAccount {
  id                  String                    @id @default(cuid())
  clientId            String                    @unique
  email               String                    @unique
  status              ClientPortalAccountStatus @default(PENDING)
  invitedAt           DateTime?
  acceptedAt          DateTime?
  lastLoginAt         DateTime?
  lastLoginIp         String?
  lastLoginUa         String?
  failedLoginAttempts Int                       @default(0)
  lockedUntil         DateTime?
  invitedBy           String?
  disabledAt          DateTime?
  disabledBy          String?
  createdAt           DateTime                  @default(now())
  updatedAt           DateTime                  @updatedAt

  client     Client                  @relation(fields: [clientId], references: [id], onDelete: Cascade)
  magicLinks ClientPortalMagicLink[]

  @@index([email])
  @@index([status])
}

model ClientPortalMagicLink {
  id        String                       @id @default(cuid())
  accountId String
  tokenHash String                       @unique
  purpose   ClientPortalMagicLinkPurpose
  expiresAt DateTime
  usedAt    DateTime?
  ip        String?
  ua        String?
  createdAt DateTime                     @default(now())

  account ClientPortalAccount @relation(fields: [accountId], references: [id], onDelete: Cascade)

  @@index([accountId, purpose])
  @@index([expiresAt])
}
```

- [ ] **Step 2: Add back-relation on `Client` model**

Find `model Client { ... }` in `apps/api/prisma/schema.prisma` and add inside (before `@@index`):

```prisma
  portalAccount ClientPortalAccount?
```

- [ ] **Step 3: Extend `AuditEntityType` in `apps/api/src/services/audit.ts`**

Locate the `AuditEntityType` union (around line 9-24) and add `"ClientPortalAccount"`:

```ts
export type AuditEntityType =
  | "Booking"
  | "Payment"
  // ... existing entries ...
  | "ClientPortalAccount";
```

- [ ] **Step 4: Generate + push**

```bash
cd apps/api && npx prisma generate && npx prisma db push --accept-data-loss
```

Expected: «✔ Generated Prisma Client» + «Your database is now in sync with your Prisma schema».

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/src/services/audit.ts
git commit -m "feat(lk): add ClientPortalAccount and ClientPortalMagicLink Prisma models"
```

---

### Task 0.2: Install nodemailer + env validation

**Files:**
- Modify: `apps/api/package.json`
- Modify: `apps/api/src/app.ts` (startup validation)

- [ ] **Step 1: Install nodemailer**

```bash
cd apps/api && npm install nodemailer && npm install --save-dev @types/nodemailer
```

- [ ] **Step 2: Add env validation to `apps/api/src/app.ts`**

After existing env validations (search for `process.env.NODE_ENV === "production"`), append a block validating Customer Portal env:

```ts
// Customer Portal env validation
if (process.env.NODE_ENV === "production") {
  if (!process.env.CLIENT_PORTAL_SESSION_SECRET || process.env.CLIENT_PORTAL_SESSION_SECRET.length < 16) {
    throw new Error("CLIENT_PORTAL_SESSION_SECRET обязателен в production (минимум 16 символов)");
  }
  if (!process.env.CLIENT_PORTAL_TOKEN_SECRET || process.env.CLIENT_PORTAL_TOKEN_SECRET.length < 16) {
    throw new Error("CLIENT_PORTAL_TOKEN_SECRET обязателен в production (HMAC секрет для magic-link, минимум 16 символов)");
  }
  if (!process.env.SMTP_HOST) {
    throw new Error("SMTP_HOST обязателен в production (для отправки magic-link клиентам портала)");
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/package.json apps/api/package-lock.json apps/api/src/app.ts
git commit -m "feat(lk): install nodemailer and add portal env validation"
```

---

## Phase 1 — Auth services (session, magic-link, mailer, tenant)

### Task 1.1: Session helpers (`session.ts`)

**Files:**
- Create: `apps/api/src/services/clientPortal/session.ts`
- Test: `apps/api/src/__tests__/lkSession.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// apps/api/src/__tests__/lkSession.test.ts
import { signLkSession, verifyLkSession, LK_COOKIE_NAME } from "../services/clientPortal/session";

describe("clientPortal/session", () => {
  beforeAll(() => {
    process.env.CLIENT_PORTAL_SESSION_SECRET = "test-secret-at-least-sixteen-chars-long";
  });

  test("sign + verify roundtrip", () => {
    const token = signLkSession({ accountId: "acc1", clientId: "cli1", email: "a@b.ru" });
    const decoded = verifyLkSession(token);
    expect(decoded).toEqual(expect.objectContaining({ accountId: "acc1", clientId: "cli1", email: "a@b.ru" }));
  });

  test("rejects invalid signature", () => {
    expect(verifyLkSession("bogus")).toBeNull();
  });

  test("cookie name is lk_session", () => {
    expect(LK_COOKIE_NAME).toBe("lk_session");
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npm test --workspace=apps/api -- lkSession
```

Expected: module not found.

- [ ] **Step 3: Implement `apps/api/src/services/clientPortal/session.ts`**

```ts
import jwt from "jsonwebtoken";

export type LkSessionPayload = {
  accountId: string;
  clientId: string;
  email: string;
};

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 дней
export const LK_COOKIE_NAME = "lk_session";

function getSecret(): string {
  const secret = process.env.CLIENT_PORTAL_SESSION_SECRET;
  if (!secret || secret.length < 16) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("CLIENT_PORTAL_SESSION_SECRET обязателен в production");
    }
    return "lk-dev-secret-do-not-use-in-prod-xxxxxxxxx";
  }
  return secret;
}

export function signLkSession(payload: LkSessionPayload): string {
  return jwt.sign(payload, getSecret(), { expiresIn: SESSION_TTL_SECONDS });
}

export function verifyLkSession(token: string): LkSessionPayload | null {
  try {
    const decoded = jwt.verify(token, getSecret(), { algorithms: ["HS256"] }) as LkSessionPayload;
    if (!decoded?.accountId || !decoded?.clientId || !decoded?.email) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function lkCookieOptions() {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_TTL_SECONDS * 1000,
  };
}
```

- [ ] **Step 4: Run test — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/clientPortal/session.ts apps/api/src/__tests__/lkSession.test.ts
git commit -m "feat(lk): add session JWT helpers"
```

---

### Task 1.2: Magic-link service (`magicLink.ts`)

**Files:**
- Create: `apps/api/src/services/clientPortal/magicLink.ts`
- Test: `apps/api/src/__tests__/lkMagicLink.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// apps/api/src/__tests__/lkMagicLink.test.ts
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
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB}` },
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
```

- [ ] **Step 2: Run test — FAIL (module missing)**

- [ ] **Step 3: Implement `apps/api/src/services/clientPortal/magicLink.ts`**

```ts
import crypto from "node:crypto";
import { Prisma, PrismaClient, ClientPortalMagicLinkPurpose } from "@prisma/client";

const TOKEN_BYTES = 32;
const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const LOGIN_TTL_MS = 15 * 60 * 1000;

function getSecret(): string {
  const s = process.env.CLIENT_PORTAL_TOKEN_SECRET;
  if (!s || s.length < 16) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("CLIENT_PORTAL_TOKEN_SECRET обязателен в production");
    }
    return "lk-token-dev-secret-xxxxxxxxxxxxxxxx";
  }
  return s;
}

export function hashToken(raw: string): string {
  return crypto.createHmac("sha256", getSecret()).update(raw).digest("base64url");
}

export function generateRawToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

export async function issueMagicLink(
  client: PrismaClient | Prisma.TransactionClient,
  accountId: string,
  purpose: ClientPortalMagicLinkPurpose,
): Promise<{ rawToken: string; expiresAt: Date }> {
  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const ttl = purpose === "INVITE" ? INVITE_TTL_MS : LOGIN_TTL_MS;
  const expiresAt = new Date(Date.now() + ttl);

  await client.clientPortalMagicLink.create({
    data: { accountId, tokenHash, purpose, expiresAt },
  });

  return { rawToken, expiresAt };
}

export type ConsumeResult = {
  accountId: string;
  purpose: ClientPortalMagicLinkPurpose;
};

export async function consumeMagicLink(
  client: PrismaClient,
  rawToken: string,
  meta: { ip: string | null; ua: string | null },
): Promise<ConsumeResult | null> {
  const tokenHash = hashToken(rawToken);

  return client.$transaction(async (tx) => {
    const link = await tx.clientPortalMagicLink.findUnique({ where: { tokenHash } });
    if (!link) return null;
    if (link.usedAt) return null;
    if (link.expiresAt.getTime() < Date.now()) return null;

    // Race-safe: only one tx wins
    const updated = await tx.clientPortalMagicLink.updateMany({
      where: { id: link.id, usedAt: null },
      data: { usedAt: new Date(), ip: meta.ip ?? undefined, ua: meta.ua ?? undefined },
    });
    if (updated.count === 0) return null;

    return { accountId: link.accountId, purpose: link.purpose };
  });
}

export async function invalidateUnusedInvites(
  tx: Prisma.TransactionClient,
  accountId: string,
): Promise<void> {
  await tx.clientPortalMagicLink.updateMany({
    where: { accountId, purpose: "INVITE", usedAt: null, expiresAt: { gt: new Date() } },
    data: { expiresAt: new Date() },
  });
}
```

- [ ] **Step 4: Run test — PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/clientPortal/magicLink.ts apps/api/src/__tests__/lkMagicLink.test.ts
git commit -m "feat(lk): add magic-link issue/consume service with HMAC hashing"
```

---

### Task 1.3: Mailer (`mailer.ts`)

**Files:**
- Create: `apps/api/src/services/clientPortal/mailer.ts`

No test — mailer just delegates to nodemailer or console; integration tested implicitly through auth-route tests.

- [ ] **Step 1: Implement `apps/api/src/services/clientPortal/mailer.ts`**

```ts
import nodemailer from "nodemailer";

type Transport = ReturnType<typeof nodemailer.createTransport>;

let cachedTransport: Transport | null = null;

function getTransport(): Transport | null {
  if (cachedTransport) return cachedTransport;
  if (!process.env.SMTP_HOST) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SMTP_HOST не настроен в production");
    }
    return null;
  }
  cachedTransport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
  return cachedTransport;
}

function baseUrl(): string {
  return process.env.PUBLIC_BASE_URL || "http://localhost:3000";
}

function from(): string {
  return process.env.SMTP_FROM || '"Светобаза" <noreply@svetobazarent.ru>';
}

async function send(opts: { to: string; subject: string; html: string; text: string }) {
  const tr = getTransport();
  if (!tr) {
    // Dev fallback — log to console
    // eslint-disable-next-line no-console
    console.log("[LK MAILER dev] →", opts.to, "|", opts.subject);
    // eslint-disable-next-line no-console
    console.log(opts.text);
    return;
  }
  await tr.sendMail({ from: from(), to: opts.to, subject: opts.subject, html: opts.html, text: opts.text });
}

export async function sendInviteEmail(account: { email: string; clientName?: string | null }, rawToken: string) {
  const url = `${baseUrl()}/lk/verify?token=${encodeURIComponent(rawToken)}`;
  const greeting = account.clientName ? `Здравствуйте, ${account.clientName}!` : "Здравствуйте!";
  const text = `${greeting}

Вам открыт доступ в личный кабинет Светобазы. Откройте ссылку, чтобы войти:

${url}

Ссылка действительна 24 часа.

Если вы не ожидали это письмо — просто проигнорируйте его.
`;
  const html = `<p>${greeting}</p>
<p>Вам открыт доступ в личный кабинет Светобазы.</p>
<p><a href="${url}" style="background:#1d4ed8;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none">Войти в кабинет</a></p>
<p style="color:#666;font-size:13px">Ссылка действительна 24 часа.<br/>Если вы не ожидали это письмо — просто проигнорируйте его.</p>`;
  await send({ to: account.email, subject: "Доступ в личный кабинет — Светобаза", html, text });
}

export async function sendLoginEmail(account: { email: string }, rawToken: string) {
  const url = `${baseUrl()}/lk/verify?token=${encodeURIComponent(rawToken)}`;
  const text = `Здравствуйте!

Вход в личный кабинет Светобазы. Откройте ссылку:

${url}

Ссылка действительна 15 минут.

Если это были не вы — просто проигнорируйте письмо.
`;
  const html = `<p>Здравствуйте!</p>
<p>Откройте ссылку, чтобы войти в личный кабинет Светобазы:</p>
<p><a href="${url}" style="background:#1d4ed8;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none">Войти в кабинет</a></p>
<p style="color:#666;font-size:13px">Ссылка действительна 15 минут.<br/>Если это были не вы — просто проигнорируйте письмо.</p>`;
  await send({ to: account.email, subject: "Вход в личный кабинет — Светобаза", html, text });
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/services/clientPortal/mailer.ts
git commit -m "feat(lk): add mailer for invite/login emails with dev console fallback"
```

---

### Task 1.4: Tenant helper (`tenant.ts`)

**Files:**
- Create: `apps/api/src/services/clientPortal/tenant.ts`

- [ ] **Step 1: Implement**

```ts
import type { Request } from "express";
import { HttpError } from "../../utils/errors";

declare global {
  namespace Express {
    interface Request {
      clientPortal?: { accountId: string; clientId: string; email: string };
    }
  }
}

export function lkClientId(req: Request): string {
  const cp = req.clientPortal;
  if (!cp?.clientId) throw new HttpError(401, "Не авторизован", "UNAUTHENTICATED");
  return cp.clientId;
}

export function assertLkClientOwns<T extends { clientId: string } | null>(entity: T, req: Request): NonNullable<T> {
  if (!entity) throw new HttpError(404, "Не найдено", "NOT_FOUND");
  if (entity.clientId !== lkClientId(req)) throw new HttpError(404, "Не найдено", "NOT_FOUND");
  return entity as NonNullable<T>;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/services/clientPortal/tenant.ts
git commit -m "feat(lk): add tenant guard helpers"
```

---

### Task 1.5: `lkAuth` middleware

**Files:**
- Create: `apps/api/src/middleware/lkAuth.ts`

- [ ] **Step 1: Implement**

```ts
import type { Request, Response, NextFunction } from "express";
import { LK_COOKIE_NAME, verifyLkSession } from "../services/clientPortal/session";
import { HttpError } from "../utils/errors";

export function lkAuth(req: Request, res: Response, next: NextFunction) {
  let token: string | undefined = req.cookies?.[LK_COOKIE_NAME];
  if (!token) {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) token = auth.substring(7);
  }
  if (!token) return next(new HttpError(401, "Не авторизован", "UNAUTHENTICATED"));

  const payload = verifyLkSession(token);
  if (!payload) return next(new HttpError(401, "Не авторизован", "UNAUTHENTICATED"));

  req.clientPortal = payload;
  next();
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/middleware/lkAuth.ts
git commit -m "feat(lk): add lkAuth middleware"
```

---

## Phase 2 — Auth API

### Task 2.1: `POST /api/lk/auth/request-login`

**Files:**
- Create: `apps/api/src/routes/lk/index.ts`
- Create: `apps/api/src/routes/lk/auth.ts`
- Modify: `apps/api/src/routes/index.ts` (mount `/api/lk` BEFORE `apiKeyAuth` per app.ts wiring; actual mounting depends on middleware order — see step below)
- Test: `apps/api/src/__tests__/lkAuthRequestLogin.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// apps/api/src/__tests__/lkAuthRequestLogin.test.ts
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
    env: { ...process.env },
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
```

- [ ] **Step 2: Add `supertest` to dev deps if missing**

```bash
cd apps/api && (grep -q '"supertest"' package.json || npm install --save-dev supertest @types/supertest)
```

- [ ] **Step 3: Create `apps/api/src/routes/lk/auth.ts`**

```ts
import { Router } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { PrismaClient } from "@prisma/client";
import { issueMagicLink } from "../../services/clientPortal/magicLink";
import { sendLoginEmail } from "../../services/clientPortal/mailer";
import { HttpError } from "../../utils/errors";

const prisma = new PrismaClient();
const router = Router();

const requestLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: "RATE_LIMIT", error: "Слишком много попыток. Подождите 15 минут." },
});

const emailSchema = z.object({ email: z.string().email().toLowerCase().trim() });

router.post("/request-login", requestLoginLimiter, async (req, res, next) => {
  try {
    const parsed = emailSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Некорректный email", "INVALID_EMAIL");
    const { email } = parsed.data;

    const account = await prisma.clientPortalAccount.findUnique({ where: { email } });
    if (account && account.status === "ACTIVE") {
      // per-email lockout guard
      if (!account.lockedUntil || account.lockedUntil.getTime() < Date.now()) {
        const { rawToken } = await issueMagicLink(prisma, account.id, "LOGIN");
        await sendLoginEmail({ email: account.email }, rawToken);
      }
    }
    // Always 200 — no enumeration
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
```

- [ ] **Step 4: Create `apps/api/src/routes/lk/index.ts`**

```ts
import { Router } from "express";
import authRouter from "./auth";

const router = Router();
router.use("/auth", authRouter);

export default router;
```

- [ ] **Step 5: Mount in `apps/api/src/routes/index.ts`**

Open the routes barrel and add the LK mount BEFORE `apiKeyAuth` is applied (or as part of a separate sub-app — check existing wiring). The simplest pattern that matches the codebase: add a new line near where other routers are imported and mounted, AFTER existing routers but using `router.use("/lk", lkRouter)` — note: the LK router does NOT go through `apiKeyAuth`. Verify by inspecting `apps/api/src/app.ts`: if `apiKeyAuth` is applied globally before mounting `routes/index.ts`, we must mount `/api/lk` directly in `app.ts` BEFORE the global `apiKeyAuth`. Apply whichever variant fits.

Concrete change in `apps/api/src/app.ts`:

```ts
import lkRouter from "./routes/lk";
// ...
app.use("/api/lk", lkRouter); // ← BEFORE apiKeyAuth
app.use(apiKeyAuth);
// existing app.use("/api", indexRouter) etc.
```

- [ ] **Step 6: Run tests — expect PASS**

```bash
npm test --workspace=apps/api -- lkAuthRequestLogin
```

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/lk apps/api/src/app.ts apps/api/src/__tests__/lkAuthRequestLogin.test.ts apps/api/package.json apps/api/package-lock.json
git commit -m "feat(lk): add POST /api/lk/auth/request-login with rate limit + no-enumeration"
```

---

### Task 2.2: `POST /api/lk/auth/verify` + `POST /api/lk/auth/logout` + `GET /api/lk/me`

**Files:**
- Modify: `apps/api/src/routes/lk/auth.ts`
- Test: `apps/api/src/__tests__/lkAuthVerify.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// apps/api/src/__tests__/lkAuthVerify.test.ts
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
    env: { ...process.env },
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
    const res = await request(app).post("/api/lk/auth/verify").send({ token: "bogus" });
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
```

- [ ] **Step 2: Extend `apps/api/src/routes/lk/auth.ts`**

Add to existing file:

```ts
import { consumeMagicLink } from "../../services/clientPortal/magicLink";
import { signLkSession, LK_COOKIE_NAME, lkCookieOptions } from "../../services/clientPortal/session";
import { lkAuth } from "../../middleware/lkAuth";

const verifySchema = z.object({ token: z.string().min(10).max(128) });

router.post("/verify", async (req, res, next) => {
  try {
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Некорректный токен", "INVALID_TOKEN");

    const meta = {
      ip: (req.ip ?? null) || null,
      ua: (req.get("user-agent") ?? null) || null,
    };
    const result = await consumeMagicLink(prisma, parsed.data.token, meta);
    if (!result) throw new HttpError(401, "Ссылка недействительна или истекла", "INVALID_TOKEN");

    const account = await prisma.clientPortalAccount.findUnique({ where: { id: result.accountId } });
    if (!account || account.status === "DISABLED") {
      throw new HttpError(401, "Доступ отключён", "DISABLED");
    }

    await prisma.clientPortalAccount.update({
      where: { id: account.id },
      data: {
        status: account.status === "PENDING" ? "ACTIVE" : account.status,
        acceptedAt: account.acceptedAt ?? new Date(),
        lastLoginAt: new Date(),
        lastLoginIp: meta.ip ?? undefined,
        lastLoginUa: meta.ua ?? undefined,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    const token = signLkSession({ accountId: account.id, clientId: account.clientId, email: account.email });
    res.cookie(LK_COOKIE_NAME, token, lkCookieOptions());
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/logout", lkAuth, async (req, res) => {
  res.clearCookie(LK_COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});
```

`GET /api/lk/me` is mounted by a separate router (not under `/auth`). Update `routes/lk/index.ts`:

```ts
import { Router } from "express";
import authRouter from "./auth";
import meRouter from "./me";

const router = Router();
router.use("/auth", authRouter);
router.use("/", meRouter);

export default router;
```

Create `apps/api/src/routes/lk/me.ts`:

```ts
import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { lkAuth } from "../../middleware/lkAuth";
import { HttpError } from "../../utils/errors";

const prisma = new PrismaClient();
const router = Router();

router.get("/me", lkAuth, async (req, res, next) => {
  try {
    const account = await prisma.clientPortalAccount.findUnique({
      where: { id: req.clientPortal!.accountId },
      include: { client: { select: { id: true, name: true, phone: true, email: true } } },
    });
    if (!account) throw new HttpError(401, "Не авторизован", "UNAUTHENTICATED");
    res.json({
      account: { email: account.email, lastLoginAt: account.lastLoginAt },
      client: account.client,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
```

Remove `/me` from `auth.ts` after copying.

- [ ] **Step 3: Ensure `cookie-parser` is in the middleware chain** — verify by `grep cookieParser apps/api/src/app.ts`. If missing, install + register: `npm i cookie-parser @types/cookie-parser` and `app.use(cookieParser())` before mounting routers.

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/lk apps/api/src/__tests__/lkAuthVerify.test.ts
git commit -m "feat(lk): add verify, logout, me endpoints"
```

---

## Phase 3 — Admin Invite API

### Task 3.1: Admin invite/disable/reenable/resend endpoints

**Files:**
- Create: `apps/api/src/routes/clientPortalAdmin.ts`
- Modify: `apps/api/src/routes/index.ts` (mount under `/api/admin/clients`)
- Test: `apps/api/src/__tests__/clientPortalAdmin.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// apps/api/src/__tests__/clientPortalAdmin.test.ts
import path from "node:path";
import fs from "node:fs";
import { execSync } from "node:child_process";
import request from "supertest";

const TEST_DB = path.resolve(__dirname, `../../prisma/test-lk-admin-${process.pid}.db`);
process.env.DATABASE_URL = `file:${TEST_DB}`;
process.env.CLIENT_PORTAL_SESSION_SECRET = "test-session-secret-min-sixteen-chars";
process.env.CLIENT_PORTAL_TOKEN_SECRET = "test-token-secret-min-sixteen-chars";

let app: any;
let prisma: any;
let signSession: any;

beforeAll(async () => {
  execSync("npx prisma db push --force-reset --skip-generate", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env },
  });
  const { app: a } = await import("../app");
  const { PrismaClient } = await import("@prisma/client");
  ({ signSession } = await import("../services/session")); // adjust to actual session helper path
  app = a;
  prisma = new PrismaClient();
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(TEST_DB, { force: true });
});

beforeEach(async () => {
  await prisma.auditEntry.deleteMany();
  await prisma.clientPortalMagicLink.deleteMany();
  await prisma.clientPortalAccount.deleteMany();
  await prisma.client.deleteMany();
  await prisma.adminUser.deleteMany();
});

async function makeAdmin(role: "SUPER_ADMIN" | "WAREHOUSE" | "TECHNICIAN") {
  const u = await prisma.adminUser.create({
    data: { username: `admin-${role}-${Date.now()}`, passwordHash: "x", role },
  });
  return { user: u, token: signSession(u) };
}

describe("POST /api/admin/clients/:id/portal-invite", () => {
  test("SUPER_ADMIN creates account + issues INVITE token + writes audit", async () => {
    const { token } = await makeAdmin("SUPER_ADMIN");
    const client = await prisma.client.create({ data: { name: "Acme" } });

    const res = await request(app)
      .post(`/api/admin/clients/${client.id}/portal-invite`)
      .set("Cookie", `lr_session=${token}`)
      .send({ email: "client@x.ru" });

    expect(res.status).toBe(200);
    expect(res.body.email).toBe("client@x.ru");

    const acc = await prisma.clientPortalAccount.findUnique({ where: { clientId: client.id } });
    expect(acc?.status).toBe("PENDING");

    const link = await prisma.clientPortalMagicLink.findFirst({ where: { accountId: acc!.id, purpose: "INVITE" } });
    expect(link).toBeTruthy();

    const audit = await prisma.auditEntry.findFirst({ where: { action: "CLIENT_PORTAL_INVITE_SENT" } });
    expect(audit).toBeTruthy();
  });

  test("WAREHOUSE → 403", async () => {
    const { token } = await makeAdmin("WAREHOUSE");
    const client = await prisma.client.create({ data: { name: "Acme2" } });
    const res = await request(app)
      .post(`/api/admin/clients/${client.id}/portal-invite`)
      .set("Cookie", `lr_session=${token}`)
      .send({ email: "c@x.ru" });
    expect(res.status).toBe(403);
  });

  test("resend invalidates previous unused INVITE", async () => {
    const { token } = await makeAdmin("SUPER_ADMIN");
    const client = await prisma.client.create({ data: { name: "Acme3" } });

    await request(app)
      .post(`/api/admin/clients/${client.id}/portal-invite`)
      .set("Cookie", `lr_session=${token}`)
      .send({ email: "u@x.ru" });

    const acc = await prisma.clientPortalAccount.findUnique({ where: { clientId: client.id } });
    const before = await prisma.clientPortalMagicLink.findMany({ where: { accountId: acc!.id } });
    expect(before).toHaveLength(1);

    await request(app)
      .post(`/api/admin/clients/${client.id}/portal-account/resend`)
      .set("Cookie", `lr_session=${token}`);

    const all = await prisma.clientPortalMagicLink.findMany({ where: { accountId: acc!.id } });
    expect(all).toHaveLength(2);
    const unused = all.filter((l: any) => !l.usedAt && l.expiresAt.getTime() > Date.now());
    expect(unused).toHaveLength(1);
  });
});

describe("disable / reenable", () => {
  test("disable sets DISABLED + audit, reenable sets ACTIVE + audit", async () => {
    const { token } = await makeAdmin("SUPER_ADMIN");
    const client = await prisma.client.create({ data: { name: "Acme4" } });
    const acc = await prisma.clientPortalAccount.create({
      data: { clientId: client.id, email: "x@x.ru", status: "ACTIVE" },
    });

    const r1 = await request(app)
      .post(`/api/admin/clients/${client.id}/portal-account/disable`)
      .set("Cookie", `lr_session=${token}`);
    expect(r1.status).toBe(200);

    const after = await prisma.clientPortalAccount.findUnique({ where: { id: acc.id } });
    expect(after.status).toBe("DISABLED");

    const r2 = await request(app)
      .post(`/api/admin/clients/${client.id}/portal-account/reenable`)
      .set("Cookie", `lr_session=${token}`);
    expect(r2.status).toBe(200);

    const reen = await prisma.clientPortalAccount.findUnique({ where: { id: acc.id } });
    expect(reen.status).toBe("ACTIVE");

    const audits = await prisma.auditEntry.findMany({
      where: { action: { in: ["CLIENT_PORTAL_DISABLED", "CLIENT_PORTAL_REENABLED"] } },
    });
    expect(audits).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Create `apps/api/src/routes/clientPortalAdmin.ts`**

```ts
import { Router } from "express";
import { z } from "zod";
import { PrismaClient } from "@prisma/client";
import { rolesGuard } from "../middleware/rolesGuard";
import { issueMagicLink, invalidateUnusedInvites } from "../services/clientPortal/magicLink";
import { sendInviteEmail } from "../services/clientPortal/mailer";
import { writeAuditEntry } from "../services/audit";
import { HttpError } from "../utils/errors";

const prisma = new PrismaClient();
const router = Router({ mergeParams: true });

const inviteBody = z.object({ email: z.string().email().toLowerCase().trim() });

router.post("/portal-invite", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const parsed = inviteBody.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Некорректный email", "INVALID_EMAIL");

    const clientId = req.params.id;
    const client = await prisma.client.findUnique({ where: { id: clientId } });
    if (!client) throw new HttpError(404, "Клиент не найден", "CLIENT_NOT_FOUND");

    const result = await prisma.$transaction(async (tx) => {
      const account = await tx.clientPortalAccount.upsert({
        where: { clientId },
        update: { email: parsed.data.email, invitedAt: new Date(), invitedBy: req.adminUser!.id, status: "PENDING" },
        create: {
          clientId,
          email: parsed.data.email,
          invitedAt: new Date(),
          invitedBy: req.adminUser!.id,
          status: "PENDING",
        },
      });

      await invalidateUnusedInvites(tx, account.id);
      const { rawToken, expiresAt } = await issueMagicLink(tx, account.id, "INVITE");
      await writeAuditEntry({
        tx,
        userId: req.adminUser!.id,
        action: "CLIENT_PORTAL_INVITE_SENT",
        entityType: "ClientPortalAccount",
        entityId: account.id,
        after: { email: account.email },
      });
      return { account, rawToken, expiresAt };
    });

    await sendInviteEmail({ email: result.account.email, clientName: client.name }, result.rawToken);

    res.json({ accountId: result.account.id, email: result.account.email, expiresAt: result.expiresAt });
  } catch (err) {
    next(err);
  }
});

router.get("/portal-account", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const acc = await prisma.clientPortalAccount.findUnique({ where: { clientId: req.params.id } });
    res.json({ account: acc });
  } catch (err) {
    next(err);
  }
});

router.post("/portal-account/disable", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const acc = await prisma.clientPortalAccount.findUnique({ where: { clientId: req.params.id } });
    if (!acc) throw new HttpError(404, "Кабинет не найден", "ACCOUNT_NOT_FOUND");

    await prisma.$transaction(async (tx) => {
      await tx.clientPortalAccount.update({
        where: { id: acc.id },
        data: { status: "DISABLED", disabledAt: new Date(), disabledBy: req.adminUser!.id },
      });
      await writeAuditEntry({
        tx,
        userId: req.adminUser!.id,
        action: "CLIENT_PORTAL_DISABLED",
        entityType: "ClientPortalAccount",
        entityId: acc.id,
        before: { status: acc.status },
        after: { status: "DISABLED" },
      });
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/portal-account/reenable", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const acc = await prisma.clientPortalAccount.findUnique({ where: { clientId: req.params.id } });
    if (!acc) throw new HttpError(404, "Кабинет не найден", "ACCOUNT_NOT_FOUND");

    await prisma.$transaction(async (tx) => {
      await tx.clientPortalAccount.update({
        where: { id: acc.id },
        data: { status: "ACTIVE", disabledAt: null, disabledBy: null },
      });
      await writeAuditEntry({
        tx,
        userId: req.adminUser!.id,
        action: "CLIENT_PORTAL_REENABLED",
        entityType: "ClientPortalAccount",
        entityId: acc.id,
        before: { status: acc.status },
        after: { status: "ACTIVE" },
      });
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/portal-account/resend", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const acc = await prisma.clientPortalAccount.findUnique({
      where: { clientId: req.params.id },
      include: { client: true },
    });
    if (!acc) throw new HttpError(404, "Кабинет не найден", "ACCOUNT_NOT_FOUND");

    const result = await prisma.$transaction(async (tx) => {
      await invalidateUnusedInvites(tx, acc.id);
      const { rawToken, expiresAt } = await issueMagicLink(tx, acc.id, "INVITE");
      await writeAuditEntry({
        tx,
        userId: req.adminUser!.id,
        action: "CLIENT_PORTAL_INVITE_RESENT",
        entityType: "ClientPortalAccount",
        entityId: acc.id,
      });
      return { rawToken, expiresAt };
    });

    await sendInviteEmail({ email: acc.email, clientName: acc.client.name }, result.rawToken);

    res.json({ expiresAt: result.expiresAt });
  } catch (err) {
    next(err);
  }
});

export default router;
```

- [ ] **Step 3: Mount in `apps/api/src/routes/index.ts`**

```ts
import clientPortalAdminRouter from "./clientPortalAdmin";
// inside index router:
router.use("/admin/clients/:id", clientPortalAdminRouter);
```

- [ ] **Step 4: Run tests**

```bash
npm test --workspace=apps/api -- clientPortalAdmin
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/clientPortalAdmin.ts apps/api/src/routes/index.ts apps/api/src/__tests__/clientPortalAdmin.test.ts
git commit -m "feat(lk): admin endpoints to invite/disable/reenable/resend portal access"
```

---

## Phase 4 — Read API (bookings, estimates, debt)

### Task 4.1: `GET /api/lk/bookings` (list)

**Files:**
- Create: `apps/api/src/routes/lk/bookings.ts`
- Modify: `apps/api/src/routes/lk/index.ts`
- Test: `apps/api/src/__tests__/lkBookings.test.ts`

- [ ] **Step 1: Write failing test**

Mirror the harness from `lkAuthVerify.test.ts`. After seeding a `Client`, a few `Booking` rows (mixed statuses including DRAFT) and a foreign client's booking, hit `/api/lk/bookings` with the verified cookie. Assert:
- Returns own bookings, not foreign
- DRAFT excluded
- Sort by startDate DESC
- Cursor pagination works

```ts
// apps/api/src/__tests__/lkBookings.test.ts (skeleton)
// ... beforeAll/beforeEach harness identical to lkAuthVerify.test.ts ...

async function loginAs(account: any) {
  const { issueMagicLink } = await import("../services/clientPortal/magicLink");
  const { rawToken } = await issueMagicLink(prisma, account.id, "LOGIN");
  const verifyRes = await request(app).post("/api/lk/auth/verify").send({ token: rawToken });
  return verifyRes.headers["set-cookie"];
}

describe("GET /api/lk/bookings", () => {
  test("returns own bookings excluding DRAFT, sorted by startDate desc", async () => {
    const client = await prisma.client.create({ data: { name: "C1" } });
    const other = await prisma.client.create({ data: { name: "C2" } });

    const baseBooking = (status: string, startDate: Date, clientId: string) =>
      prisma.booking.create({
        data: {
          clientId,
          status: status as any,
          startDate,
          endDate: new Date(startDate.getTime() + 86_400_000),
          finalAmount: "1000",
          amountPaid: "0",
          shifts: 1,
        },
      });

    const b1 = await baseBooking("CONFIRMED", new Date("2026-05-10"), client.id);
    const b2 = await baseBooking("ISSUED", new Date("2026-05-20"), client.id);
    await baseBooking("DRAFT", new Date("2026-05-15"), client.id); // should be excluded
    await baseBooking("CONFIRMED", new Date("2026-05-22"), other.id); // foreign

    const acc = await prisma.clientPortalAccount.create({
      data: { clientId: client.id, email: "c1@x.ru", status: "ACTIVE" },
    });
    const cookie = await loginAs(acc);

    const res = await request(app).get("/api/lk/bookings").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.id)).toEqual([b2.id, b1.id]);
  });
});
```

- [ ] **Step 2: Implement `apps/api/src/routes/lk/bookings.ts`**

```ts
import { Router } from "express";
import { z } from "zod";
import { PrismaClient } from "@prisma/client";
import { lkAuth } from "../../middleware/lkAuth";
import { lkClientId, assertLkClientOwns } from "../../services/clientPortal/tenant";
import { HttpError } from "../../utils/errors";

const prisma = new PrismaClient();
const router = Router();

const VISIBLE_STATUSES = ["PENDING_APPROVAL", "CONFIRMED", "ISSUED", "RETURNED", "CANCELLED"] as const;

const listQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(50).default(20),
  status: z.enum(VISIBLE_STATUSES).optional(),
});

router.get("/", lkAuth, async (req, res, next) => {
  try {
    const q = listQuery.parse(req.query);
    const clientId = lkClientId(req);

    const where = {
      clientId,
      status: q.status ? q.status : { in: [...VISIBLE_STATUSES] as any },
      ...(q.cursor ? { id: { lt: q.cursor } } : {}),
    };

    const items = await prisma.booking.findMany({
      where,
      orderBy: [{ startDate: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      select: {
        id: true,
        projectName: true,
        startDate: true,
        endDate: true,
        status: true,
        finalAmount: true,
        amountPaid: true,
        _count: { select: { items: true } },
      },
    });

    const hasMore = items.length > q.limit;
    const slice = hasMore ? items.slice(0, q.limit) : items;
    const nextCursor = hasMore ? slice[slice.length - 1].id : null;

    res.json({
      items: slice.map((b) => ({
        id: b.id,
        bookingNo: `#${b.id.slice(-6).toUpperCase()}`,
        projectName: b.projectName,
        startDate: b.startDate.toISOString(),
        endDate: b.endDate.toISOString(),
        status: b.status,
        finalAmount: b.finalAmount.toString(),
        amountOutstanding: (Number(b.finalAmount) - Number(b.amountPaid)).toString(),
        itemCount: b._count.items,
      })),
      nextCursor,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", lkAuth, async (req, res, next) => {
  try {
    const clientId = lkClientId(req);
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        clientId: true,
        status: true,
        startDate: true,
        endDate: true,
        shifts: true,
        finalAmount: true,
        amountPaid: true,
        comment: true,
        optionalNote: true,
        // NB: projectName may or may not exist on Booking — verify by grep before implementation.
        // If absent, drop it from the response and from LkBookingDetail type.
        projectName: true,
        items: { select: { categorySnapshot: true, nameSnapshot: true, quantity: true, unitPrice: true, lineSum: true } },
        estimates: {
          // Snapshot fields (subtotal/discountAmount/totalAfterDiscount) live on Estimate, not Booking.
          // Prefer CONFIRMED; fall back to MAIN if no confirmed.
          select: { kind: true, subtotal: true, discountAmount: true, totalAfterDiscount: true },
        },
      },
    });
    if (!booking || booking.clientId !== clientId) throw new HttpError(404, "Не найдено", "NOT_FOUND");
    if (!VISIBLE_STATUSES.includes(booking.status as any)) throw new HttpError(404, "Не найдено", "NOT_FOUND");

    const confirmed = booking.estimates.find((e) => e.kind === "CONFIRMED");
    const snapshot = confirmed ?? booking.estimates.find((e) => e.kind === "MAIN") ?? null;
    const hasConfirmedEstimate = Boolean(confirmed);

    res.json({
      id: booking.id,
      bookingNo: `#${booking.id.slice(-6).toUpperCase()}`,
      projectName: booking.projectName ?? null,
      startDate: booking.startDate.toISOString(),
      endDate: booking.endDate.toISOString(),
      status: booking.status,
      shifts: booking.shifts,
      items: booking.items.map((it) => ({
        categorySnapshot: it.categorySnapshot,
        nameSnapshot: it.nameSnapshot,
        quantity: it.quantity,
        unitPrice: it.unitPrice.toString(),
        lineSum: it.lineSum.toString(),
      })),
      subtotal: snapshot?.subtotal.toString() ?? "0",
      discountAmount: snapshot?.discountAmount.toString() ?? "0",
      totalAfterDiscount: snapshot?.totalAfterDiscount.toString() ?? booking.finalAmount.toString(),
      finalAmount: booking.finalAmount.toString(),
      amountPaid: booking.amountPaid.toString(),
      amountOutstanding: (Number(booking.finalAmount) - Number(booking.amountPaid)).toString(),
      comment: booking.comment ?? null,
      optionalNote: booking.optionalNote ?? null,
      hasConfirmedEstimate,
      hasAct: booking.status === "RETURNED",
    });
  } catch (err) {
    next(err);
  }
});

export default router;
```

- [ ] **Step 3: Mount in `routes/lk/index.ts`**

```ts
import bookingsRouter from "./bookings";
router.use("/bookings", bookingsRouter);
```

- [ ] **Step 4: Run tests — PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/lk apps/api/src/__tests__/lkBookings.test.ts
git commit -m "feat(lk): GET /api/lk/bookings list + detail with tenant isolation"
```

---

### Task 4.2: PDF wrappers (`/api/lk/bookings/:id/estimate.pdf`, `act.pdf`)

**Files:**
- Modify: `apps/api/src/routes/lk/bookings.ts` (add 2 routes)

- [ ] **Step 1: Locate existing PDF renderer**

```bash
grep -n "estimate.pdf\|act.pdf\|renderPdf\|sendEstimate" apps/api/src/routes/bookings.ts | head
```

Note the exact helper functions exported from `apps/api/src/services/smetaExport/`. Reuse them.

- [ ] **Step 2: Add LK wrappers to `apps/api/src/routes/lk/bookings.ts`**

```ts
// at top
import { renderEstimatePdf } from "../../services/smetaExport/renderPdf"; // adjust to actual export name

router.get("/:id/estimate.pdf", lkAuth, async (req, res, next) => {
  try {
    const clientId = lkClientId(req);
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      select: { clientId: true, status: true },
    });
    if (!booking || booking.clientId !== clientId) throw new HttpError(404, "Не найдено", "NOT_FOUND");
    if (!VISIBLE_STATUSES.includes(booking.status as any)) throw new HttpError(404, "Не найдено", "NOT_FOUND");

    // Delegate to existing renderer — reuse the same logic that /api/bookings/:id/estimate.pdf uses.
    // Call the exported render function with the booking id.
    res.setHeader("Content-Type", "application/pdf");
    await renderEstimatePdf(req.params.id, res);
  } catch (err) {
    next(err);
  }
});

router.get("/:id/act.pdf", lkAuth, async (req, res, next) => {
  try {
    const clientId = lkClientId(req);
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      select: { clientId: true, status: true },
    });
    if (!booking || booking.clientId !== clientId) throw new HttpError(404, "Не найдено", "NOT_FOUND");
    if (booking.status !== "RETURNED") throw new HttpError(404, "Не найдено", "NOT_FOUND");

    res.setHeader("Content-Type", "application/pdf");
    // Same pattern — delegate to renderActPdf
    const { renderActPdf } = await import("../../services/smetaExport/renderPdf"); // adjust
    await renderActPdf(req.params.id, res);
  } catch (err) {
    next(err);
  }
});
```

(If the actual export names differ — `renderEstimatePdf` may live in `routes/bookings.ts` itself — extract the rendering logic into a service module first, then call from both admin route and lk route. Keep the change minimal: identify the existing handler, factor body into an exportable function, call it from both places.)

- [ ] **Step 3: Smoke-test manually**

```bash
curl -b "lk_session=<token>" http://localhost:4000/api/lk/bookings/<id>/estimate.pdf -o /tmp/estimate.pdf
```

Expected: valid PDF file in `/tmp/estimate.pdf`.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/lk/bookings.ts apps/api/src/services/smetaExport
git commit -m "feat(lk): GET /api/lk/bookings/:id/{estimate,act}.pdf wrappers reuse existing renderers"
```

---

### Task 4.3: `GET /api/lk/estimates` (flat list of CONFIRMED estimates)

**Files:**
- Create: `apps/api/src/routes/lk/estimates.ts`
- Modify: `apps/api/src/routes/lk/index.ts`
- Test: `apps/api/src/__tests__/lkEstimates.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// Skeleton — same harness pattern.
describe("GET /api/lk/estimates", () => {
  test("returns only CONFIRMED estimates of own bookings", async () => {
    // create client, account, booking with CONFIRMED estimate, booking with MAIN-only estimate, foreign booking
    // assert: only CONFIRMED of own client in response
  });
});
```

- [ ] **Step 2: Implement `apps/api/src/routes/lk/estimates.ts`**

```ts
import { Router } from "express";
import { z } from "zod";
import { PrismaClient } from "@prisma/client";
import { lkAuth } from "../../middleware/lkAuth";
import { lkClientId } from "../../services/clientPortal/tenant";

const prisma = new PrismaClient();
const router = Router();

const listQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(50).default(20),
});

router.get("/", lkAuth, async (req, res, next) => {
  try {
    const q = listQuery.parse(req.query);
    const clientId = lkClientId(req);

    const items = await prisma.estimate.findMany({
      where: {
        kind: "CONFIRMED",
        booking: { clientId },
        ...(q.cursor ? { id: { lt: q.cursor } } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      select: {
        id: true,
        bookingId: true,
        createdAt: true,
        totalAfterDiscount: true,
        booking: { select: { id: true, projectName: true } },
      },
    });

    const hasMore = items.length > q.limit;
    const slice = hasMore ? items.slice(0, q.limit) : items;
    const nextCursor = hasMore ? slice[slice.length - 1].id : null;

    res.json({
      items: slice.map((e) => ({
        bookingId: e.bookingId,
        bookingNo: `#${e.booking.id.slice(-6).toUpperCase()}`,
        projectName: e.booking.projectName,
        issuedAt: e.createdAt.toISOString(),
        totalAfterDiscount: e.totalAfterDiscount.toString(),
        pdfUrl: `/api/lk/bookings/${e.bookingId}/estimate.pdf`,
      })),
      nextCursor,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
```

- [ ] **Step 3: Mount**

```ts
// routes/lk/index.ts
import estimatesRouter from "./estimates";
router.use("/estimates", estimatesRouter);
```

- [ ] **Step 4: Run tests + commit**

```bash
git add apps/api/src/routes/lk apps/api/src/__tests__/lkEstimates.test.ts
git commit -m "feat(lk): GET /api/lk/estimates list of CONFIRMED estimates"
```

---

### Task 4.4: `GET /api/lk/debt`

**Files:**
- Create: `apps/api/src/routes/lk/debt.ts`
- Modify: `apps/api/src/routes/lk/index.ts`
- Test: `apps/api/src/__tests__/lkDebt.test.ts`

- [ ] **Step 1: Inspect `computeDebts()` signature**

```bash
grep -n "export.*computeDebts" apps/api/src/services/finance.ts
sed -n '/export.*computeDebts/,/^}/p' apps/api/src/services/finance.ts
```

If it accepts an optional `clientId` filter — use it. If not — extract a per-client helper inline rather than refactoring `computeDebts` (YAGNI).

- [ ] **Step 2: Implement `apps/api/src/routes/lk/debt.ts`**

```ts
import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { lkAuth } from "../../middleware/lkAuth";
import { lkClientId } from "../../services/clientPortal/tenant";

const prisma = new PrismaClient();
const router = Router();

router.get("/", lkAuth, async (req, res, next) => {
  try {
    const clientId = lkClientId(req);

    // Get invoices for this client's bookings where amountOutstanding > 0.
    const invoices = await prisma.invoice.findMany({
      where: {
        booking: { clientId },
        status: { in: ["ISSUED", "PARTIAL_PAID", "OVERDUE"] as any },
      },
      orderBy: [{ dueDate: "asc" }, { issuedAt: "asc" }],
      select: {
        id: true,
        bookingId: true,
        invoiceNumber: true,
        issuedAt: true,
        dueDate: true,
        status: true,
        amountTotal: true,
        amountPaid: true,
        booking: { select: { id: true } },
      },
    });

    const now = Date.now();
    let totalOutstanding = 0;
    let overdueCount = 0;

    const rows = invoices.map((inv) => {
      const outstanding = Number(inv.amountTotal) - Number(inv.amountPaid);
      totalOutstanding += outstanding;
      const ageDays = inv.dueDate ? Math.floor((now - inv.dueDate.getTime()) / 86_400_000) : 0;
      const isOverdue = inv.status === "OVERDUE" || (inv.dueDate ? inv.dueDate.getTime() < now && outstanding > 0 : false);
      if (isOverdue) overdueCount++;
      return {
        bookingId: inv.bookingId,
        bookingNo: `#${inv.booking.id.slice(-6).toUpperCase()}`,
        invoiceNumber: inv.invoiceNumber,
        issuedAt: inv.issuedAt.toISOString(),
        dueDate: inv.dueDate ? inv.dueDate.toISOString() : null,
        finalAmount: inv.amountTotal.toString(),
        amountPaid: inv.amountPaid.toString(),
        amountOutstanding: outstanding.toFixed(2),
        ageDays,
        isOverdue,
      };
    });

    res.json({
      totalOutstanding: totalOutstanding.toFixed(2),
      overdueCount,
      invoices: rows,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
```

- [ ] **Step 3: Mount + test + commit**

```ts
// routes/lk/index.ts
import debtRouter from "./debt";
router.use("/debt", debtRouter);
```

```bash
git add apps/api/src/routes/lk apps/api/src/__tests__/lkDebt.test.ts
git commit -m "feat(lk): GET /api/lk/debt with per-client invoice breakdown"
```

---

## Phase 5 — Stats API

### Task 5.1: `GET /api/lk/stats` — topEquipment + typicalKit

**Files:**
- Create: `apps/api/src/services/clientPortal/statsService.ts`
- Create: `apps/api/src/routes/lk/stats.ts`
- Modify: `apps/api/src/routes/lk/index.ts`
- Test: `apps/api/src/__tests__/lkStats.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// apps/api/src/__tests__/lkStats.test.ts (skeleton)
// Set up: 5 bookings for clientA, 3 with equipmentE1 + E2, 2 with E1 only.
// typicalKit with sampleSize=5: E1 frequency=1.0 (in all 5), E2 frequency=0.6 → both pass 0.4 threshold.

describe("GET /api/lk/stats", () => {
  test("returns topEquipment ranked by bookingsCount", async () => {
    /* ... */
  });

  test("typicalKit empty for clients with <3 bookings", async () => {
    /* ... */
  });

  test("typicalKit returns items with frequency >= 0.4", async () => {
    /* ... */
  });
});
```

- [ ] **Step 2: Implement `apps/api/src/services/clientPortal/statsService.ts`**

```ts
import { PrismaClient } from "@prisma/client";

const QUALIFYING_STATUSES = ["CONFIRMED", "ISSUED", "RETURNED"] as const;
const TYPICAL_KIT_SAMPLE = 10;
const TYPICAL_KIT_THRESHOLD = 0.4;
const TOP_LIMIT = 20;

type StatsPeriod = "180d" | "365d" | "all";

function periodToFrom(period: StatsPeriod): Date | null {
  if (period === "all") return null;
  const days = period === "180d" ? 180 : 365;
  return new Date(Date.now() - days * 86_400_000);
}

export async function computeLkStats(prisma: PrismaClient, clientId: string, period: StatsPeriod) {
  const from = periodToFrom(period);

  const baseWhere = {
    clientId,
    status: { in: [...QUALIFYING_STATUSES] as any },
    ...(from ? { startDate: { gte: from } } : {}),
  };

  // ----- topEquipment -----
  const items = await prisma.bookingItem.findMany({
    where: { booking: baseWhere, equipmentId: { not: null } },
    select: {
      equipmentId: true,
      quantity: true,
      lineSum: true,
      bookingId: true,
      equipment: { select: { name: true, category: true } },
    },
  });

  const agg = new Map<
    string,
    { name: string; category: string; bookingIds: Set<string>; totalQty: number; totalSpent: number }
  >();

  for (const it of items) {
    if (!it.equipmentId || !it.equipment) continue;
    const cur = agg.get(it.equipmentId) ?? {
      name: it.equipment.name,
      category: it.equipment.category,
      bookingIds: new Set<string>(),
      totalQty: 0,
      totalSpent: 0,
    };
    cur.bookingIds.add(it.bookingId);
    cur.totalQty += it.quantity;
    cur.totalSpent += Number(it.lineSum);
    agg.set(it.equipmentId, cur);
  }

  const topEquipment = [...agg.entries()]
    .map(([equipmentId, v]) => ({
      equipmentId,
      name: v.name,
      category: v.category,
      bookingsCount: v.bookingIds.size,
      totalQuantityRented: v.totalQty,
      totalSpentRub: v.totalSpent.toFixed(2),
    }))
    .sort((a, b) => b.bookingsCount - a.bookingsCount || Number(b.totalSpentRub) - Number(a.totalSpentRub))
    .slice(0, TOP_LIMIT);

  // ----- typicalKit -----
  const recentBookings = await prisma.booking.findMany({
    where: { clientId, status: { in: [...QUALIFYING_STATUSES] as any } },
    orderBy: { startDate: "desc" },
    take: TYPICAL_KIT_SAMPLE,
    select: { id: true, items: { select: { equipmentId: true } } },
  });

  const sampleSize = recentBookings.length;
  let typicalKit: Array<{ equipmentId: string; name: string; category: string; frequency: number }> = [];

  if (sampleSize >= 3) {
    const freq = new Map<string, number>();
    for (const b of recentBookings) {
      const ids = new Set(b.items.map((i) => i.equipmentId).filter(Boolean) as string[]);
      for (const id of ids) freq.set(id, (freq.get(id) ?? 0) + 1);
    }
    const ids = [...freq.keys()].filter((id) => freq.get(id)! / sampleSize >= TYPICAL_KIT_THRESHOLD);
    const eq = await prisma.equipment.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, category: true },
    });
    typicalKit = eq
      .map((e) => ({
        equipmentId: e.id,
        name: e.name,
        category: e.category,
        frequency: freq.get(e.id)! / sampleSize,
      }))
      .sort((a, b) => b.frequency - a.frequency || a.name.localeCompare(b.name));
  }

  return {
    period,
    rangeFrom: from ? from.toISOString() : null,
    rangeTo: new Date().toISOString(),
    topEquipment,
    typicalKit,
    typicalKitSampleSize: sampleSize,
  };
}
```

- [ ] **Step 3: Implement `apps/api/src/routes/lk/stats.ts`**

```ts
import { Router } from "express";
import { z } from "zod";
import { PrismaClient } from "@prisma/client";
import { lkAuth } from "../../middleware/lkAuth";
import { lkClientId } from "../../services/clientPortal/tenant";
import { computeLkStats } from "../../services/clientPortal/statsService";

const prisma = new PrismaClient();
const router = Router();

const querySchema = z.object({ period: z.enum(["180d", "365d", "all"]).default("365d") });

router.get("/", lkAuth, async (req, res, next) => {
  try {
    const q = querySchema.parse(req.query);
    const stats = await computeLkStats(prisma, lkClientId(req), q.period);
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

export default router;
```

- [ ] **Step 4: Mount + run tests + commit**

```ts
// routes/lk/index.ts
import statsRouter from "./stats";
router.use("/stats", statsRouter);
```

```bash
git add apps/api/src/routes/lk apps/api/src/services/clientPortal/statsService.ts apps/api/src/__tests__/lkStats.test.ts
git commit -m "feat(lk): GET /api/lk/stats with topEquipment + typicalKit algorithms"
```

---

## Phase 6 — Frontend foundation

### Task 6.1: API client + session helpers + types

**Files:**
- Create: `apps/web/src/lib/lkApi.ts`
- Create: `apps/web/src/hooks/useLkSession.ts`
- Create: `apps/web/src/lib/lkTypes.ts`

- [ ] **Step 1: Create `apps/web/src/lib/lkTypes.ts`**

```ts
export type LkBookingStatus = "PENDING_APPROVAL" | "CONFIRMED" | "ISSUED" | "RETURNED" | "CANCELLED";

export type LkBookingListItem = {
  id: string;
  bookingNo: string;
  projectName: string | null;
  startDate: string;
  endDate: string;
  status: LkBookingStatus;
  finalAmount: string;
  amountOutstanding: string;
  itemCount: number;
};

export type LkBookingDetail = {
  id: string;
  bookingNo: string;
  projectName: string | null;
  startDate: string;
  endDate: string;
  status: LkBookingStatus;
  shifts: number;
  items: { categorySnapshot: string; nameSnapshot: string; quantity: number; unitPrice: string; lineSum: string }[];
  subtotal: string;
  discountAmount: string;
  totalAfterDiscount: string;
  finalAmount: string;
  amountPaid: string;
  amountOutstanding: string;
  comment: string | null;
  optionalNote: string | null;
  hasConfirmedEstimate: boolean;
  hasAct: boolean;
};

export type LkEstimateListItem = {
  bookingId: string;
  bookingNo: string;
  projectName: string | null;
  issuedAt: string;
  totalAfterDiscount: string;
  pdfUrl: string;
};

export type LkDebtRow = {
  bookingId: string;
  bookingNo: string;
  invoiceNumber: string | null;
  issuedAt: string;
  dueDate: string | null;
  finalAmount: string;
  amountPaid: string;
  amountOutstanding: string;
  ageDays: number;
  isOverdue: boolean;
};

export type LkDebtResponse = {
  totalOutstanding: string;
  overdueCount: number;
  invoices: LkDebtRow[];
};

export type LkStatsResponse = {
  period: "180d" | "365d" | "all";
  rangeFrom: string | null;
  rangeTo: string;
  topEquipment: { equipmentId: string; name: string; category: string; bookingsCount: number; totalQuantityRented: number; totalSpentRub: string }[];
  typicalKit: { equipmentId: string; name: string; category: string; frequency: number }[];
  typicalKitSampleSize: number;
};

export type LkMe = {
  account: { email: string; lastLoginAt: string | null };
  client: { id: string; name: string; phone: string | null; email: string | null };
};
```

- [ ] **Step 2: Create `apps/web/src/lib/lkApi.ts`**

```ts
async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", ...init, headers: { "Content-Type": "application/json", ...(init?.headers || {}) } });
  if (res.status === 401) {
    if (typeof window !== "undefined") window.location.href = "/lk/login";
    throw new Error("UNAUTHENTICATED");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || body.code || `HTTP ${res.status}`);
  }
  return res.json();
}

export const lkApi = {
  me: () => fetchJson<import("./lkTypes").LkMe>("/api/lk/me"),
  bookings: (cursor?: string, status?: string) => fetchJson<{ items: import("./lkTypes").LkBookingListItem[]; nextCursor: string | null }>(
    `/api/lk/bookings?${new URLSearchParams({ ...(cursor ? { cursor } : {}), ...(status ? { status } : {}) }).toString()}`,
  ),
  booking: (id: string) => fetchJson<import("./lkTypes").LkBookingDetail>(`/api/lk/bookings/${id}`),
  estimates: (cursor?: string) => fetchJson<{ items: import("./lkTypes").LkEstimateListItem[]; nextCursor: string | null }>(
    `/api/lk/estimates${cursor ? `?cursor=${cursor}` : ""}`,
  ),
  debt: () => fetchJson<import("./lkTypes").LkDebtResponse>("/api/lk/debt"),
  stats: (period: "180d" | "365d" | "all" = "365d") =>
    fetchJson<import("./lkTypes").LkStatsResponse>(`/api/lk/stats?period=${period}`),
  requestLogin: (email: string) =>
    fetchJson<{ ok: true }>("/api/lk/auth/request-login", { method: "POST", body: JSON.stringify({ email }) }),
  verify: (token: string) =>
    fetchJson<{ ok: true }>("/api/lk/auth/verify", { method: "POST", body: JSON.stringify({ token }) }),
  logout: () => fetchJson<{ ok: true }>("/api/lk/auth/logout", { method: "POST" }),
};
```

- [ ] **Step 3: Create `apps/web/src/hooks/useLkSession.ts`**

```ts
"use client";
import { useEffect, useState } from "react";
import { lkApi } from "../lib/lkApi";
import type { LkMe } from "../lib/lkTypes";

export function useLkSession() {
  const [me, setMe] = useState<LkMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await lkApi.me();
        if (!cancelled) setMe(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { me, loading, error };
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/lkApi.ts apps/web/src/lib/lkTypes.ts apps/web/src/hooks/useLkSession.ts
git commit -m "feat(lk-web): API client + session hook + shared types"
```

---

### Task 6.2: `/lk` layout + LkShell + LkNav

**Files:**
- Create: `apps/web/app/lk/layout.tsx`
- Create: `apps/web/src/components/lk/LkShell.tsx`
- Create: `apps/web/src/components/lk/LkNav.tsx`

- [ ] **Step 1: Create `apps/web/src/components/lk/LkNav.tsx`**

```tsx
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { href: "/lk", label: "Дашборд" },
  { href: "/lk/bookings", label: "Заказы" },
  { href: "/lk/estimates", label: "Сметы" },
  { href: "/lk/debt", label: "Долг" },
  { href: "/lk/stats", label: "Статистика" },
  { href: "/lk/crew-calculator", label: "Команда" },
  { href: "/lk/tools", label: "Инструменты" },
];

export function LkNav() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-wrap gap-x-1 gap-y-2 overflow-x-auto" aria-label="Меню кабинета">
      {items.map((it) => {
        const active = pathname === it.href || (it.href !== "/lk" && pathname?.startsWith(it.href));
        return (
          <Link
            key={it.href}
            href={it.href}
            className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
              active ? "bg-accent-bright text-surface" : "text-ink-2 hover:bg-surface-2"
            }`}
          >
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 2: Create `apps/web/src/components/lk/LkShell.tsx`**

```tsx
"use client";
import { ReactNode } from "react";
import Link from "next/link";
import { useLkSession } from "../../hooks/useLkSession";
import { lkApi } from "../../lib/lkApi";
import { LkNav } from "./LkNav";

export function LkShell({ children }: { children: ReactNode }) {
  const { me, loading } = useLkSession();

  if (loading) {
    return <div className="min-h-screen bg-surface flex items-center justify-center text-ink-2">Загрузка…</div>;
  }

  if (!me) {
    if (typeof window !== "undefined") window.location.href = "/lk/login";
    return null;
  }

  return (
    <div className="min-h-screen bg-surface text-ink">
      <header className="bg-ink text-surface">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <Link href="/lk" className="font-medium tracking-tight">
            Светобаза · Личный кабинет
          </Link>
          <div className="flex items-center gap-3 text-sm text-surface/80">
            <span className="hidden sm:inline">{me.client.name}</span>
            <button
              onClick={async () => {
                await lkApi.logout();
                window.location.href = "/lk/login";
              }}
              className="px-3 py-1 rounded-md border border-surface/30 hover:bg-surface/10"
            >
              Выйти
            </button>
          </div>
        </div>
        <div className="max-w-6xl mx-auto px-4 pb-3">
          <LkNav />
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-4 py-6">{children}</main>
    </div>
  );
}
```

- [ ] **Step 3: Create `apps/web/app/lk/layout.tsx`**

```tsx
import { ReactNode } from "react";
import { LkShell } from "../../src/components/lk/LkShell";

export default function LkLayout({ children }: { children: ReactNode }) {
  // Login/verify pages handle their own chrome — they live in subroutes that opt-out.
  // We keep LkShell here; login pages can render `null` for shell via a passthrough wrapper if needed.
  // Simpler: login/verify pages will use a separate layout segment (route group) — implemented in next task.
  return <LkShell>{children}</LkShell>;
}
```

- [ ] **Step 4: Add route group for unauthenticated pages**

Move login/verify to a route group to bypass LkShell:

```bash
mkdir -p apps/web/app/lk/\(auth\)
```

Create `apps/web/app/lk/(auth)/layout.tsx`:

```tsx
import { ReactNode } from "react";

export default function LkAuthLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-surface text-ink flex items-center justify-center px-4">{children}</div>;
}
```

Pages `/lk/login`, `/lk/login/sent`, `/lk/verify` will be created inside `(auth)` group in next tasks.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/lk apps/web/src/components/lk
git commit -m "feat(lk-web): layout + shell + nav for portal"
```

---

### Task 6.3: Login / verify pages

**Files:**
- Create: `apps/web/app/lk/(auth)/login/page.tsx`
- Create: `apps/web/app/lk/(auth)/login/sent/page.tsx`
- Create: `apps/web/app/lk/(auth)/verify/page.tsx`

- [ ] **Step 1: `apps/web/app/lk/(auth)/login/page.tsx`**

```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { lkApi } from "../../../../src/lib/lkApi";

export default function LkLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await lkApi.requestLogin(email.trim());
      router.push("/lk/login/sent");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="w-full max-w-[360px] bg-surface-2 border border-border rounded-xl p-6 space-y-4">
      <h1 className="text-xl font-medium">Вход в личный кабинет</h1>
      <p className="text-sm text-ink-2">Введите email, и мы пришлём ссылку для входа.</p>
      <input
        type="email"
        required
        autoFocus
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="email@example.ru"
        className="w-full px-3 py-2 border border-border rounded-md bg-surface"
      />
      {error && <div className="text-sm text-rose">{error}</div>}
      <button
        disabled={submitting || !email}
        className="w-full px-4 py-2 bg-accent-bright text-surface rounded-md disabled:opacity-50"
      >
        {submitting ? "Отправляем…" : "Получить ссылку"}
      </button>
    </form>
  );
}
```

- [ ] **Step 2: `apps/web/app/lk/(auth)/login/sent/page.tsx`**

```tsx
import Link from "next/link";

export default function LkLoginSentPage() {
  return (
    <div className="w-full max-w-[420px] text-center space-y-4">
      <h1 className="text-xl font-medium">Проверьте почту</h1>
      <p className="text-ink-2">
        Если этот email есть в нашей системе — мы отправили ссылку для входа. Она действительна 15 минут.
      </p>
      <Link href="/lk/login" className="text-accent-bright text-sm underline">
        Отправить ещё раз
      </Link>
    </div>
  );
}
```

- [ ] **Step 3: `apps/web/app/lk/(auth)/verify/page.tsx`**

```tsx
"use client";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { lkApi } from "../../../../src/lib/lkApi";

export default function LkVerifyPage() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = params.get("token");
    if (!token) {
      router.replace("/lk/login");
      return;
    }
    (async () => {
      try {
        await lkApi.verify(token);
        router.replace("/lk");
      } catch (err) {
        setError("Ссылка недействительна или истекла");
      }
    })();
  }, [params, router]);

  return (
    <div className="text-center">
      {error ? (
        <>
          <p className="text-rose mb-3">{error}</p>
          <a href="/lk/login" className="text-accent-bright underline">
            Запросить новую ссылку
          </a>
        </>
      ) : (
        <p className="text-ink-2">Проверяем ссылку…</p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add "apps/web/app/lk/(auth)"
git commit -m "feat(lk-web): login + sent + verify pages"
```

---

## Phase 7 — Portal pages

### Task 7.1: Dashboard `/lk`

**Files:**
- Create: `apps/web/app/lk/page.tsx`

- [ ] **Step 1: Implement**

```tsx
"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useLkSession } from "../../src/hooks/useLkSession";
import { lkApi } from "../../src/lib/lkApi";
import type { LkBookingListItem } from "../../src/lib/lkTypes";
import { formatRub } from "../../src/lib/format";

function greeting(): string {
  const h = new Date().getHours();
  if (h < 6) return "доброй ночи";
  if (h < 12) return "доброе утро";
  if (h < 18) return "добрый день";
  return "добрый вечер";
}

export default function LkDashboardPage() {
  const { me } = useLkSession();
  const [recent, setRecent] = useState<LkBookingListItem[] | null>(null);
  const [debtTotal, setDebtTotal] = useState<string | null>(null);
  const [overdueCount, setOverdueCount] = useState(0);
  const [activeCount, setActiveCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [b, d] = await Promise.all([lkApi.bookings(), lkApi.debt()]);
        if (cancelled) return;
        setRecent(b.items.slice(0, 5));
        setActiveCount(b.items.filter((i) => i.status === "ISSUED").length);
        setDebtTotal(d.totalOutstanding);
        setOverdueCount(d.overdueCount);
      } catch (e) {
        // useLkSession redirected if 401
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-6">
      <header>
        <p className="eyebrow">{me ? `${greeting()},` : ""}</p>
        <h1 className="text-2xl font-medium">{me ? `${me.client.name} 👋` : "Личный кабинет"}</h1>
      </header>

      <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Link href="/lk/debt" className="bg-surface-2 border border-border rounded-lg p-4 hover:border-border-bright">
          <p className="eyebrow">Долг</p>
          <p className="mono-num text-2xl mt-1">{debtTotal ? formatRub(Number(debtTotal)) : "—"}</p>
          {overdueCount > 0 && <p className="text-sm text-rose mt-1">{overdueCount} просрочено</p>}
        </Link>
        <Link href="/lk/bookings?status=ISSUED" className="bg-surface-2 border border-border rounded-lg p-4 hover:border-border-bright">
          <p className="eyebrow">Активные брони</p>
          <p className="mono-num text-2xl mt-1">{activeCount}</p>
        </Link>
        <Link href="/lk/stats" className="bg-surface-2 border border-border rounded-lg p-4 hover:border-border-bright">
          <p className="eyebrow">Статистика</p>
          <p className="text-sm text-ink-2 mt-1">Топ оборудования + твой типовой набор</p>
        </Link>
      </section>

      <section>
        <h2 className="text-lg font-medium mb-3">Последние заказы</h2>
        {!recent ? (
          <p className="text-ink-2">Загрузка…</p>
        ) : recent.length === 0 ? (
          <p className="text-ink-2">Заказов пока нет.</p>
        ) : (
          <ul className="divide-y divide-border bg-surface-2 border border-border rounded-lg">
            {recent.map((b) => (
              <li key={b.id}>
                <Link href={`/lk/bookings/${b.id}`} className="block p-3 hover:bg-surface">
                  <div className="flex justify-between items-baseline">
                    <span className="font-medium">{b.projectName || b.bookingNo}</span>
                    <span className="mono-num text-sm">{formatRub(Number(b.finalAmount))}</span>
                  </div>
                  <p className="text-xs text-ink-2 mt-1">
                    {new Date(b.startDate).toLocaleDateString("ru-RU")} · {b.status} · {b.itemCount} поз.
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/app/lk/page.tsx
git commit -m "feat(lk-web): dashboard at /lk"
```

---

### Task 7.2: Bookings list `/lk/bookings`

**Files:**
- Create: `apps/web/app/lk/bookings/page.tsx`

- [ ] **Step 1: Implement**

```tsx
"use client";
import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { lkApi } from "../../../src/lib/lkApi";
import type { LkBookingListItem, LkBookingStatus } from "../../../src/lib/lkTypes";
import { formatRub } from "../../../src/lib/format";

const FILTERS: { label: string; value: LkBookingStatus | "ALL" }[] = [
  { label: "Все", value: "ALL" },
  { label: "Активные", value: "ISSUED" },
  { label: "Подтверждённые", value: "CONFIRMED" },
  { label: "Возвращённые", value: "RETURNED" },
  { label: "Отменённые", value: "CANCELLED" },
];

const STATUS_LABEL: Record<LkBookingStatus, string> = {
  PENDING_APPROVAL: "На согласовании",
  CONFIRMED: "Подтверждена",
  ISSUED: "В работе",
  RETURNED: "Возвращена",
  CANCELLED: "Отменена",
};

function BookingsView() {
  const params = useSearchParams();
  const router = useRouter();
  const status = (params.get("status") as LkBookingStatus | null) || "ALL";
  const [items, setItems] = useState<LkBookingListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setItems([]);
    setCursor(null);
    setLoading(true);
    (async () => {
      const r = await lkApi.bookings(undefined, status === "ALL" ? undefined : status);
      setItems(r.items);
      setCursor(r.nextCursor);
      setLoading(false);
    })();
  }, [status]);

  function setFilter(v: string) {
    const sp = new URLSearchParams(params.toString());
    if (v === "ALL") sp.delete("status");
    else sp.set("status", v);
    router.replace(`/lk/bookings?${sp.toString()}`);
  }

  return (
    <div className="space-y-4">
      <header className="flex justify-between items-baseline">
        <h1 className="text-2xl font-medium">Заказы</h1>
      </header>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={`px-3 py-1.5 text-sm rounded-md border ${
              status === f.value ? "bg-accent-bright text-surface border-accent-bright" : "border-border hover:bg-surface-2"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-ink-2">Загрузка…</p>
      ) : items.length === 0 ? (
        <p className="text-ink-2">Нет заказов в этой категории.</p>
      ) : (
        <div className="bg-surface-2 border border-border rounded-lg divide-y divide-border">
          {items.map((b) => (
            <Link key={b.id} href={`/lk/bookings/${b.id}`} className="block p-4 hover:bg-surface">
              <div className="flex justify-between items-baseline flex-wrap gap-2">
                <div>
                  <p className="font-medium">{b.projectName || b.bookingNo}</p>
                  <p className="text-xs text-ink-2 mt-1">
                    {new Date(b.startDate).toLocaleDateString("ru-RU")} →{" "}
                    {new Date(b.endDate).toLocaleDateString("ru-RU")} · {STATUS_LABEL[b.status]} · {b.itemCount} поз.
                  </p>
                </div>
                <div className="text-right">
                  <p className="mono-num font-medium">{formatRub(Number(b.finalAmount))}</p>
                  {Number(b.amountOutstanding) > 0 && (
                    <p className="text-xs text-rose mt-1">долг {formatRub(Number(b.amountOutstanding))}</p>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {cursor && (
        <button
          onClick={async () => {
            const r = await lkApi.bookings(cursor, status === "ALL" ? undefined : status);
            setItems((it) => [...it, ...r.items]);
            setCursor(r.nextCursor);
          }}
          className="px-4 py-2 border border-border rounded-md hover:bg-surface-2"
        >
          Загрузить ещё
        </button>
      )}
    </div>
  );
}

export default function LkBookingsPage() {
  return (
    <Suspense fallback={<p className="text-ink-2">Загрузка…</p>}>
      <BookingsView />
    </Suspense>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/app/lk/bookings/page.tsx
git commit -m "feat(lk-web): bookings list with filter pills + cursor pagination"
```

---

### Task 7.3: Booking detail `/lk/bookings/[id]`

**Files:**
- Create: `apps/web/app/lk/bookings/[id]/page.tsx`

- [ ] **Step 1: Implement**

```tsx
"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { lkApi } from "../../../../src/lib/lkApi";
import type { LkBookingDetail } from "../../../../src/lib/lkTypes";
import { formatRub } from "../../../../src/lib/format";

export default function LkBookingDetailPage() {
  const params = useParams<{ id: string }>();
  const [b, setB] = useState<LkBookingDetail | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await lkApi.booking(params.id);
        if (!cancelled) setB(r);
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, [params.id]);

  if (!b) return <p className="text-ink-2">Загрузка…</p>;

  return (
    <div className="space-y-6">
      <header>
        <p className="eyebrow">Заказ {b.bookingNo}</p>
        <h1 className="text-2xl font-medium">{b.projectName || "Без названия"}</h1>
        <p className="text-sm text-ink-2 mt-1">
          {new Date(b.startDate).toLocaleDateString("ru-RU")} → {new Date(b.endDate).toLocaleDateString("ru-RU")} · {b.shifts} смен
        </p>
      </header>

      <section className="bg-surface-2 border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border eyebrow">Позиции</div>
        <table className="w-full text-sm">
          <thead className="text-left text-ink-2">
            <tr>
              <th className="px-4 py-2">Категория</th>
              <th className="px-4 py-2">Название</th>
              <th className="px-4 py-2 text-right">Кол-во</th>
              <th className="px-4 py-2 text-right">Цена</th>
              <th className="px-4 py-2 text-right">Сумма</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {b.items.map((it, i) => (
              <tr key={i}>
                <td className="px-4 py-2">{it.categorySnapshot}</td>
                <td className="px-4 py-2">{it.nameSnapshot}</td>
                <td className="px-4 py-2 text-right mono-num">{it.quantity}</td>
                <td className="px-4 py-2 text-right mono-num">{formatRub(Number(it.unitPrice))}</td>
                <td className="px-4 py-2 text-right mono-num">{formatRub(Number(it.lineSum))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-surface-2 border border-border rounded-lg p-3">
          <p className="eyebrow">Итого</p>
          <p className="mono-num text-lg mt-1">{formatRub(Number(b.totalAfterDiscount))}</p>
        </div>
        <div className="bg-surface-2 border border-border rounded-lg p-3">
          <p className="eyebrow">Скидка</p>
          <p className="mono-num text-lg mt-1">{formatRub(Number(b.discountAmount))}</p>
        </div>
        <div className="bg-surface-2 border border-border rounded-lg p-3">
          <p className="eyebrow">Оплачено</p>
          <p className="mono-num text-lg mt-1">{formatRub(Number(b.amountPaid))}</p>
        </div>
        <div className="bg-surface-2 border border-border rounded-lg p-3">
          <p className="eyebrow">Остаток</p>
          <p className={`mono-num text-lg mt-1 ${Number(b.amountOutstanding) > 0 ? "text-rose" : ""}`}>
            {formatRub(Number(b.amountOutstanding))}
          </p>
        </div>
      </section>

      <section className="flex flex-wrap gap-2">
        {b.hasConfirmedEstimate && (
          <a
            href={`/api/lk/bookings/${b.id}/estimate.pdf`}
            target="_blank"
            rel="noopener noreferrer"
            className="px-4 py-2 border border-border rounded-md hover:bg-surface-2"
          >
            Скачать смету PDF
          </a>
        )}
        {b.hasAct && (
          <a
            href={`/api/lk/bookings/${b.id}/act.pdf`}
            target="_blank"
            rel="noopener noreferrer"
            className="px-4 py-2 border border-border rounded-md hover:bg-surface-2"
          >
            Скачать акт PDF
          </a>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/app/lk/bookings/\[id\]/page.tsx
git commit -m "feat(lk-web): booking detail page with PDF download buttons"
```

---

### Task 7.4: Estimates page `/lk/estimates`

**Files:**
- Create: `apps/web/app/lk/estimates/page.tsx`

- [ ] **Step 1: Implement**

```tsx
"use client";
import { useEffect, useState } from "react";
import { lkApi } from "../../../src/lib/lkApi";
import type { LkEstimateListItem } from "../../../src/lib/lkTypes";
import { formatRub } from "../../../src/lib/format";

export default function LkEstimatesPage() {
  const [items, setItems] = useState<LkEstimateListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const r = await lkApi.estimates();
      setItems(r.items);
      setCursor(r.nextCursor);
      setLoading(false);
    })();
  }, []);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-medium">Сметы</h1>
      {loading ? (
        <p className="text-ink-2">Загрузка…</p>
      ) : items.length === 0 ? (
        <p className="text-ink-2">Подтверждённых смет пока нет.</p>
      ) : (
        <div className="bg-surface-2 border border-border rounded-lg divide-y divide-border">
          {items.map((e) => (
            <div key={e.bookingId} className="p-4 flex justify-between items-baseline gap-4">
              <div>
                <p className="font-medium">{e.projectName || e.bookingNo}</p>
                <p className="text-xs text-ink-2 mt-1">{new Date(e.issuedAt).toLocaleDateString("ru-RU")}</p>
              </div>
              <div className="text-right">
                <p className="mono-num">{formatRub(Number(e.totalAfterDiscount))}</p>
                <a href={e.pdfUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-accent-bright underline">
                  Скачать PDF
                </a>
              </div>
            </div>
          ))}
        </div>
      )}
      {cursor && (
        <button
          onClick={async () => {
            const r = await lkApi.estimates(cursor);
            setItems((it) => [...it, ...r.items]);
            setCursor(r.nextCursor);
          }}
          className="px-4 py-2 border border-border rounded-md hover:bg-surface-2"
        >
          Загрузить ещё
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/app/lk/estimates/page.tsx
git commit -m "feat(lk-web): estimates list with PDF download"
```

---

### Task 7.5: Debt page `/lk/debt`

**Files:**
- Create: `apps/web/app/lk/debt/page.tsx`

- [ ] **Step 1: Implement**

```tsx
"use client";
import { useEffect, useState } from "react";
import { lkApi } from "../../../src/lib/lkApi";
import type { LkDebtResponse } from "../../../src/lib/lkTypes";
import { formatRub } from "../../../src/lib/format";

export default function LkDebtPage() {
  const [data, setData] = useState<LkDebtResponse | null>(null);

  useEffect(() => {
    (async () => setData(await lkApi.debt()))();
  }, []);

  if (!data) return <p className="text-ink-2">Загрузка…</p>;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-medium">Долг</h1>
      </header>

      <section className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="bg-surface-2 border border-border rounded-lg p-4">
          <p className="eyebrow">Общий долг</p>
          <p className="mono-num text-2xl mt-1">{formatRub(Number(data.totalOutstanding))}</p>
        </div>
        <div className="bg-surface-2 border border-border rounded-lg p-4">
          <p className="eyebrow">Просрочено</p>
          <p className={`mono-num text-2xl mt-1 ${data.overdueCount > 0 ? "text-rose" : ""}`}>{data.overdueCount}</p>
        </div>
      </section>

      <section className="bg-surface-2 border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-left text-ink-2">
            <tr>
              <th className="px-4 py-2">Бронь</th>
              <th className="px-4 py-2">Счёт</th>
              <th className="px-4 py-2">Срок</th>
              <th className="px-4 py-2 text-right">Сумма</th>
              <th className="px-4 py-2 text-right">Оплачено</th>
              <th className="px-4 py-2 text-right">Остаток</th>
              <th className="px-4 py-2 text-right">Возраст</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.invoices.map((r) => (
              <tr key={`${r.bookingId}-${r.invoiceNumber}`} className={r.isOverdue ? "bg-rose-soft" : ""}>
                <td className="px-4 py-2">{r.bookingNo}</td>
                <td className="px-4 py-2 mono-num">{r.invoiceNumber || "—"}</td>
                <td className="px-4 py-2">{r.dueDate ? new Date(r.dueDate).toLocaleDateString("ru-RU") : "—"}</td>
                <td className="px-4 py-2 text-right mono-num">{formatRub(Number(r.finalAmount))}</td>
                <td className="px-4 py-2 text-right mono-num">{formatRub(Number(r.amountPaid))}</td>
                <td className={`px-4 py-2 text-right mono-num ${Number(r.amountOutstanding) > 0 ? "text-rose" : ""}`}>
                  {formatRub(Number(r.amountOutstanding))}
                </td>
                <td className="px-4 py-2 text-right">{r.isOverdue ? `${r.ageDays} дн.` : "—"}</td>
              </tr>
            ))}
            {data.invoices.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-ink-2">
                  Долгов нет 👍
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/app/lk/debt/page.tsx
git commit -m "feat(lk-web): debt page with invoice breakdown"
```

---

### Task 7.6: Stats page `/lk/stats`

**Files:**
- Create: `apps/web/app/lk/stats/page.tsx`
- Create: `apps/web/src/components/lk/StatsTopTable.tsx`
- Create: `apps/web/src/components/lk/TypicalKitGrid.tsx`

- [ ] **Step 1: Create components**

`apps/web/src/components/lk/StatsTopTable.tsx`:

```tsx
"use client";
import { useState } from "react";
import { formatRub } from "../../lib/format";
import type { LkStatsResponse } from "../../lib/lkTypes";

type SortKey = "bookingsCount" | "totalQuantityRented" | "totalSpentRub" | "name";

export function StatsTopTable({ items }: { items: LkStatsResponse["topEquipment"] }) {
  const [sortKey, setSortKey] = useState<SortKey>("bookingsCount");
  const sorted = [...items].sort((a, b) => {
    if (sortKey === "name") return a.name.localeCompare(b.name);
    if (sortKey === "totalSpentRub") return Number(b.totalSpentRub) - Number(a.totalSpentRub);
    return (b[sortKey] as number) - (a[sortKey] as number);
  });

  function header(key: SortKey, label: string, right = false) {
    return (
      <th
        onClick={() => setSortKey(key)}
        className={`px-4 py-2 cursor-pointer hover:text-ink ${right ? "text-right" : "text-left"} ${
          sortKey === key ? "text-ink font-medium" : "text-ink-2"
        }`}
      >
        {label}
      </th>
    );
  }

  return (
    <div className="bg-surface-2 border border-border rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr>
            {header("name", "Название")}
            {header("name", "Категория")}
            {header("bookingsCount", "Заказов", true)}
            {header("totalQuantityRented", "Раз арендовано", true)}
            {header("totalSpentRub", "Сумма", true)}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {sorted.map((r) => (
            <tr key={r.equipmentId}>
              <td className="px-4 py-2">{r.name}</td>
              <td className="px-4 py-2 text-ink-2">{r.category}</td>
              <td className="px-4 py-2 text-right mono-num">{r.bookingsCount}</td>
              <td className="px-4 py-2 text-right mono-num">{r.totalQuantityRented}</td>
              <td className="px-4 py-2 text-right mono-num">{formatRub(Number(r.totalSpentRub))}</td>
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-6 text-center text-ink-2">
                Данных за выбранный период нет.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
```

`apps/web/src/components/lk/TypicalKitGrid.tsx`:

```tsx
import type { LkStatsResponse } from "../../lib/lkTypes";

export function TypicalKitGrid({ items, sampleSize }: { items: LkStatsResponse["typicalKit"]; sampleSize: number }) {
  if (sampleSize < 3) {
    return (
      <p className="text-ink-2">
        «Типовой набор» появится после нескольких заказов — пока в выборке {sampleSize} {sampleSize === 1 ? "бронь" : "брони"}.
      </p>
    );
  }
  if (items.length === 0) {
    return <p className="text-ink-2">Пока нет позиций, которые встречаются достаточно часто.</p>;
  }

  const byCat = new Map<string, typeof items>();
  for (const it of items) {
    const arr = byCat.get(it.category) ?? [];
    arr.push(it);
    byCat.set(it.category, arr);
  }

  return (
    <div className="space-y-3">
      {[...byCat.entries()].map(([cat, list]) => (
        <div key={cat}>
          <p className="eyebrow mb-2">{cat}</p>
          <div className="flex flex-wrap gap-2">
            {list.map((it) => (
              <span
                key={it.equipmentId}
                className="px-3 py-1.5 text-sm rounded-md bg-accent-soft text-accent border border-accent-border"
                title={`${Math.round(it.frequency * 100)}% последних броней`}
              >
                {it.name} <span className="opacity-70">· {Math.round(it.frequency * 100)}%</span>
              </span>
            ))}
          </div>
        </div>
      ))}
      <p className="text-xs text-ink-3">Выборка: {sampleSize} последних заказов.</p>
    </div>
  );
}
```

- [ ] **Step 2: Create `apps/web/app/lk/stats/page.tsx`**

```tsx
"use client";
import { useEffect, useState } from "react";
import { lkApi } from "../../../src/lib/lkApi";
import type { LkStatsResponse } from "../../../src/lib/lkTypes";
import { StatsTopTable } from "../../../src/components/lk/StatsTopTable";
import { TypicalKitGrid } from "../../../src/components/lk/TypicalKitGrid";

const PERIODS: { label: string; value: "180d" | "365d" | "all" }[] = [
  { label: "Полгода", value: "180d" },
  { label: "Год", value: "365d" },
  { label: "Всё время", value: "all" },
];

export default function LkStatsPage() {
  const [period, setPeriod] = useState<"180d" | "365d" | "all">("365d");
  const [data, setData] = useState<LkStatsResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await lkApi.stats(period);
      if (!cancelled) setData(r);
    })();
    return () => {
      cancelled = true;
    };
  }, [period]);

  return (
    <div className="space-y-6">
      <header className="flex justify-between items-baseline flex-wrap gap-3">
        <h1 className="text-2xl font-medium">Статистика</h1>
        <div className="flex gap-1">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              onClick={() => setPeriod(p.value)}
              className={`px-3 py-1 text-sm rounded-md border ${
                period === p.value ? "bg-accent-bright text-surface border-accent-bright" : "border-border hover:bg-surface-2"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </header>

      {!data ? (
        <p className="text-ink-2">Загрузка…</p>
      ) : (
        <>
          <section className="space-y-3">
            <h2 className="text-lg font-medium">Топ оборудования</h2>
            <StatsTopTable items={data.topEquipment} />
          </section>
          <section className="space-y-3">
            <h2 className="text-lg font-medium">Твой типовой набор</h2>
            <TypicalKitGrid items={data.typicalKit} sampleSize={data.typicalKitSampleSize} />
          </section>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/lk/stats apps/web/src/components/lk/StatsTopTable.tsx apps/web/src/components/lk/TypicalKitGrid.tsx
git commit -m "feat(lk-web): stats page with topEquipment table + typicalKit grid"
```

---

### Task 7.7: Crew calculator port `/lk/crew-calculator`

**Files:**
- Create: `apps/web/app/lk/crew-calculator/page.tsx`

- [ ] **Step 1: Inspect existing page**

```bash
wc -l apps/web/app/gaffer/crew-calculator/page.tsx
head -40 apps/web/app/gaffer/crew-calculator/page.tsx
```

- [ ] **Step 2: Port logic**

Copy contents of `apps/web/app/gaffer/crew-calculator/page.tsx` to `apps/web/app/lk/crew-calculator/page.tsx`. Adjustments:
- Remove any Gaffer-CRM-specific dependencies (e.g. references to `gafferContact`, payment methods, saved rate cards from CRM). Use defaults from `@light-rental/shared` `crewRates.ts`.
- Keep URL-state for shareable links.
- Use the same shared calculator import: `import { calculateCrewCost } from "@light-rental/shared"` (or whatever the existing entry is — verify with `grep`).
- Strip the `useRequireRole` or Gaffer-session hooks; this page lives behind `LkShell` which already gates `lk_session`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/lk/crew-calculator/page.tsx
git commit -m "feat(lk-web): port crew calculator from /gaffer/crew-calculator"
```

---

### Task 7.8: Tools page `/lk/tools`

**Files:**
- Create: `apps/web/app/lk/tools/page.tsx`

- [ ] **Step 1: Implement**

```tsx
export default function LkToolsPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-medium">Инструменты</h1>

      <section className="bg-surface-2 border border-border rounded-lg p-4 max-w-xl">
        <p className="eyebrow">Калькулятор электрической нагрузки</p>
        <p className="text-ink-2 mt-1 mb-3 text-sm">
          Внешний инструмент Светобазы: расчёт потребления (W) и тока (A), режимы 1 фаза / 3 фазы.
        </p>
        <a
          href="https://calc.svetobazarent.ru/"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block px-4 py-2 bg-accent-bright text-surface rounded-md"
        >
          Открыть калькулятор ↗
        </a>
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/app/lk/tools/page.tsx
git commit -m "feat(lk-web): tools page with external electrical calculator link"
```

---

## Phase 8 — Admin UI: invite management

### Task 8.1: `ClientPortalAccessCard` component + integration into admin

**Files:**
- Create: `apps/web/src/components/admin/ClientPortalAccessCard.tsx`
- Modify: existing client management surface (decision below)

- [ ] **Step 1: Integration point — inline в `/bookings/[id]`**

Решение: ставим `ClientPortalAccessCard` inline в `/bookings/[id]` рядом с информацией о клиенте — это даёт админу управлять доступом из контекста, где он уже работает с этим клиентом, и не требует новой `/admin/clients` страницы или новых эндпоинтов списка клиентов.

```bash
# Locate where the client block is rendered in booking detail:
grep -n "client\.\|Клиент\|booking\.client" apps/web/app/bookings/\[id\]/page.tsx | head
```

We'll insert the card right after the existing client info block, gated by current-user role.

- [ ] **Step 2: Create `ClientPortalAccessCard.tsx`**

```tsx
"use client";
import { useEffect, useState } from "react";

type PortalAccount = {
  id: string;
  email: string;
  status: "PENDING" | "ACTIVE" | "DISABLED";
  invitedAt: string | null;
  acceptedAt: string | null;
  lastLoginAt: string | null;
};

export function ClientPortalAccessCard({ clientId, defaultEmail }: { clientId: string; defaultEmail: string | null }) {
  const [account, setAccount] = useState<PortalAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState(defaultEmail ?? "");
  const [msg, setMsg] = useState<string | null>(null);

  async function refresh() {
    const r = await fetch(`/api/admin/clients/${clientId}/portal-account`, { credentials: "include" });
    const body = await r.json();
    setAccount(body.account);
    setLoading(false);
  }
  useEffect(() => {
    refresh();
  }, [clientId]);

  async function invite() {
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/clients/${clientId}/portal-invite`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!r.ok) throw new Error((await r.json()).error || "Ошибка");
      setMsg("Приглашение отправлено");
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Ошибка");
    } finally {
      setBusy(false);
    }
  }

  async function action(path: string, label: string) {
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/clients/${clientId}/portal-account/${path}`, {
        method: "POST",
        credentials: "include",
      });
      if (!r.ok) throw new Error((await r.json()).error || "Ошибка");
      setMsg(`${label} ✓`);
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Ошибка");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="text-ink-2 text-sm">Загрузка доступа…</div>;

  if (!account) {
    return (
      <div className="bg-surface-2 border border-border rounded-lg p-4 space-y-3 max-w-md">
        <p className="eyebrow">Доступ в кабинет</p>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="email@example.ru"
          className="w-full px-3 py-2 border border-border rounded-md bg-surface"
        />
        <button
          onClick={invite}
          disabled={busy || !email}
          className="px-4 py-2 bg-accent-bright text-surface rounded-md disabled:opacity-50"
        >
          Выдать доступ
        </button>
        {msg && <p className="text-sm text-ink-2">{msg}</p>}
      </div>
    );
  }

  return (
    <div className="bg-surface-2 border border-border rounded-lg p-4 space-y-3 max-w-md">
      <p className="eyebrow">Доступ в кабинет</p>
      <div className="text-sm">
        <p>{account.email}</p>
        <p className="text-ink-2 mt-1">
          {account.status === "PENDING" && "Приглашение отправлено, не активирован"}
          {account.status === "ACTIVE" && `Активен · последний вход ${account.lastLoginAt ? new Date(account.lastLoginAt).toLocaleString("ru-RU") : "—"}`}
          {account.status === "DISABLED" && "Доступ отключён"}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {(account.status === "PENDING" || account.status === "ACTIVE") && (
          <button onClick={() => action("resend", "Ссылка отправлена")} disabled={busy} className="px-3 py-1.5 text-sm border border-border rounded-md hover:bg-surface">
            Переслать ссылку
          </button>
        )}
        {account.status !== "DISABLED" && (
          <button onClick={() => action("disable", "Доступ отключён")} disabled={busy} className="px-3 py-1.5 text-sm border border-rose-border text-rose rounded-md hover:bg-rose-soft">
            Отключить
          </button>
        )}
        {account.status === "DISABLED" && (
          <button onClick={() => action("reenable", "Доступ восстановлен")} disabled={busy} className="px-3 py-1.5 text-sm border border-border rounded-md hover:bg-surface">
            Восстановить
          </button>
        )}
      </div>
      {msg && <p className="text-sm text-ink-2">{msg}</p>}
    </div>
  );
}
```

- [ ] **Step 3: Mount inside `/bookings/[id]` page**

Open `apps/web/app/bookings/[id]/page.tsx`, find the section that renders the booking's client info (typically near the top, e.g. `booking.client?.name`). Insert the card immediately below:

```tsx
import { ClientPortalAccessCard } from "../../../src/components/admin/ClientPortalAccessCard";
import { useCurrentUser } from "../../../src/hooks/useCurrentUser";

// ... inside the component ...
const me = useCurrentUser();
const canManagePortal = me?.role === "SUPER_ADMIN";

// ... where the client info block ends:
{canManagePortal && booking.client && (
  <div className="mt-4">
    <ClientPortalAccessCard clientId={booking.client.id} defaultEmail={booking.client.email ?? null} />
  </div>
)}
```

(If `booking.client` doesn't include `email`, extend the existing fetch query to include it.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/admin/ClientPortalAccessCard.tsx apps/web/app/bookings/\[id\]/page.tsx
git commit -m "feat(lk-admin): inline ClientPortalAccessCard in /bookings/[id] for SUPER_ADMIN"
```

---

## Phase 9 — Docs

### Task 9.1: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Append a new section after «Tasks Feature (Sprint 3)»**

```markdown
## Customer Portal `/lk` (Подпроект 1+2)

Отдельный клиентский портал для гафферов — vot rental clients (НЕ Gaffer CRM `/gaffer`). Magic-link auth по приглашению админа, 1:1 с `Client`.

### Auth и модели

- `ClientPortalAccount` (1:1 с `Client`) + `ClientPortalMagicLink` (HMAC-SHA256 tokenHash, single-use, INVITE TTL 24h / LOGIN TTL 15m).
- JWT cookie `lk_session`, secret `CLIENT_PORTAL_SESSION_SECRET`, отдельная цепочка `lkAuth` (НЕ `apiKeyAuth`).
- Token HMAC secret `CLIENT_PORTAL_TOKEN_SECRET`.
- Email через nodemailer; в dev — console-fallback при отсутствии `SMTP_HOST`.

### Маршруты

- `/lk` — dashboard, `/lk/bookings`, `/lk/bookings/[id]`, `/lk/estimates`, `/lk/debt`, `/lk/stats`, `/lk/crew-calculator`, `/lk/tools`.
- Login flow в route group `apps/web/app/lk/(auth)/`: `/lk/login`, `/lk/login/sent`, `/lk/verify`.
- API под `/api/lk/*` — НЕ под `apiKeyAuth`. Admin endpoints `/api/admin/clients/:id/portal-{invite,account,...}` под `apiKeyAuth + rolesGuard(["SUPER_ADMIN"])`.

### Алгоритмы статистики

- `topEquipment`: за 180/365 дней или всё время, по `bookingsCount DESC, totalSpentRub DESC`, top 20.
- `typicalKit`: последние 10 броней клиента (sampleSize), позиции с `frequency >= 0.4`. При `sampleSize < 3` — `[]` + placeholder.

### Конвенции

- `clientId` ВСЕГДА из `req.clientPortal.clientId` (JWT). Никогда из query/body.
- `assertLkClientOwns()` на каждом read-endpoint.
- DRAFT брони не возвращаются клиенту. Видимые статусы: `PENDING_APPROVAL | CONFIRMED | ISSUED | RETURNED | CANCELLED`.
- Estimate видны только `kind=CONFIRMED`.
- Audit: admin-actions → обычный `AuditEntry`. Portal-login события → `ClientPortalMagicLink.usedAt/ip/ua` + `ClientPortalAccount.failedLoginAttempts/lockedUntil` (НЕ AuditEntry).
- Внешний электро-калькулятор: ссылка на https://calc.svetobazarent.ru/ (вкладка `/lk/tools`).

### Out of scope (Подпроект 3, отдельная спека)

- Самозаказ: корзина, «Заказать набор», self-create Booking.
- Email-дайджесты, нотификации.
- Multi-tenant Client (1 аккаунт → много Client).
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(lk): document Customer Portal patterns and conventions in CLAUDE.md"
```

---

## Phase 10 — Final verification

### Task 10.1: Run full suite

- [ ] **Step 1: API tests**

```bash
npm test --workspace=apps/api 2>&1 | tail -30
```

Expected: 0 failures. Existing tests + new `lk*` tests pass.

- [ ] **Step 2: Type-check + build**

```bash
npx --workspace=apps/api tsc --noEmit
cd apps/web && npx next lint --dir app/lk --dir src/components/lk --dir src/lib
```

- [ ] **Step 3: Manual smoke**

In two terminals:

```bash
# Terminal A
npm run dev:no-bot

# Terminal B — create test data + dev mailer
cd apps/api
sqlite3 prisma/dev.db "INSERT INTO Client (id, name, createdAt, updatedAt) VALUES ('cli-test-001', 'Test Gaffer', datetime('now'), datetime('now'));"
# Then invite via admin (curl):
curl -X POST http://localhost:4000/api/admin/clients/cli-test-001/portal-invite \
  -H "Cookie: lr_session=<SUPER_ADMIN-token>" \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.ru"}'
# Watch API console for the magic link printed by mailer fallback.
```

Open the printed URL in a browser → should land on `/lk` dashboard.

- [ ] **Step 4: Mobile + desktop fidelity check**

For each portal page (`/lk`, `/lk/bookings`, `/lk/bookings/[id]`, `/lk/estimates`, `/lk/debt`, `/lk/stats`, `/lk/crew-calculator`, `/lk/tools`):
- 375px width screenshot
- 1440px width screenshot
- Verify no horizontal overflow, all text Russian, IBM Plex tokens (no hex/blue-/slate- outside finance).

- [ ] **Step 5: Open PR (use existing `/pr` skill or manual)**

```bash
git push -u origin HEAD
gh pr create --title "feat: Customer Portal /lk (Подпроект 1+2)" --body-file - <<'EOF'
## Summary
- Magic-link auth for rental clients via admin invite
- 1:1 ClientPortalAccount ↔ Client; isolated lk_session cookie
- 10 portal pages (dashboard, bookings, estimates, debt, stats, crew calc, tools)
- Stats: topEquipment + typicalKit (frequency ≥ 40% of last 10 bookings)
- Admin UI: invite / disable / reenable / resend
- External link to calc.svetobazarent.ru for electrical load calculator

## Spec
docs/superpowers/specs/2026-05-24-customer-portal-lk-design.md

## Test plan
- [x] API integration tests pass
- [x] tsc --noEmit clean
- [x] Manual flow: invite → verify → view bookings → download PDF
- [x] Mobile (375) + desktop (1440) fidelity on all pages
EOF
```

---

## Self-Review Coverage Map

| Spec section | Plan task |
|--------------|-----------|
| §1 Access and routing | Task 6.2 (layout + nav), Task 6.3 (login pages), route groups |
| §2 Data model | Task 0.1 (Prisma) |
| §3.1 Magic-link issue (admin) | Task 3.1 |
| §3.2 Login flow | Task 2.1 |
| §3.3 Verify flow | Task 2.2 |
| §3.4 Email transport | Task 1.3 |
| §3.5 Session model | Task 1.1 |
| §3.6 Tenant helper | Task 1.4 |
| §4.1 Auth endpoints | Tasks 2.1, 2.2 |
| §4.2 Read endpoints (bookings, estimates, debt, stats, PDF) | Tasks 4.1, 4.2, 4.3, 4.4, 5.1 |
| §4.3 Admin endpoints | Task 3.1 |
| §5.1–5.3 login/sent/dashboard pages | Tasks 6.3, 7.1 |
| §5.4 bookings list | Task 7.2 |
| §5.5 booking detail | Task 7.3 |
| §5.6 estimates | Task 7.4 |
| §5.7 stats | Task 7.6 |
| §5.8 debt | Task 7.5 |
| §5.9 crew calculator | Task 7.7 |
| §5.10 tools | Task 7.8 |
| §6 Admin UI | Task 8.1 |
| §7 Security checklist | Embedded in Tasks 1.2 (token hash), 2.1 (rate-limit, no-enum), 2.2 (single-use, lockout), all read tasks (tenant assertion) |
| §8 Audit + login history | Task 0.1 (AuditEntityType), Task 2.2 (success/fail bookkeeping on account), Task 3.1 (admin audits in tx) |
| §9 Files list | Each task creates files per spec §9 |
| §10 Testing strategy | Tasks 1.1, 1.2, 2.1, 2.2, 3.1, 4.1, 4.3, 4.4, 5.1 (API integration); Task 10.1 (e2e smoke) |
| §11 Open questions | Q1 (admin UI location) resolved in Task 8.1; Q2 (branding) deferred to default; Q3 (SMTP) deferred to env; Q4 (resend) implemented Task 3.1 |
| §12 Future work | Explicitly out of scope |
| §13 Design canon | Applied across all UI tasks (tokens, IBM Plex, mobile-first) |
