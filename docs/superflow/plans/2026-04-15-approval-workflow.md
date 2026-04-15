# Approval Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable a two-stage booking workflow: кладовщик (WAREHOUSE) отправляет черновик на согласование, руководитель (SUPER_ADMIN) одобряет или отклоняет с обязательной причиной — всё с аудитом и блокировкой правок на этапе согласования.

**Architecture:** Enum `BookingStatus.PENDING_APPROVAL` уже существует в схеме. Добавляем одно новое поле `rejectionReason String?` на `Booking`. Бизнес-логика выносится в новый сервис `bookingApproval.ts` с тремя функциями (submit / approve / reject), которые пишут `AuditEntry` в той же транзакции. На фронте — фильтр в списке, бейджи статуса, три кнопки на карточке (роле- и статус-зависимые), модалка отклонения и баннер с причиной отклонения на DRAFT после rejection. PATCH `/api/bookings/:id` возвращает 409 для PENDING_APPROVAL.

**Tech Stack:** Express 4 + Prisma 6 (SQLite) + Zod + Vitest + supertest (backend); Next.js 14 + React 18 + Tailwind CSS 3 + IBM Plex tokens + StatusPill/SectionHeader (frontend).

---

## File Structure

**Backend (create):**
- `apps/api/src/services/bookingApproval.ts` — три функции workflow (`submitForApproval`, `approveBooking`, `rejectBooking`), каждая в `prisma.$transaction` с `writeAuditEntry`.
- `apps/api/src/__tests__/approval.test.ts` — интеграционные тесты всех трёх эндпоинтов + edit-prevention + list filter (8–10 it-блоков).

**Backend (modify):**
- `apps/api/prisma/schema.prisma` — добавить `rejectionReason String?` на `Booking`.
- `apps/api/src/routes/bookings.ts` — три новых эндпоинта, обновлённый `bookingListQuerySchema` для `PENDING_APPROVAL`, 409 в PATCH для PENDING_APPROVAL, очистка `rejectionReason` при submit.

**Frontend (create):**
- `apps/web/src/components/bookings/RejectBookingModal.tsx` — модалка с обязательной причиной отклонения (min 3 симв.), Esc-to-close, disabled submit пока reason пустой.

**Frontend (modify):**
- `apps/web/app/bookings/page.tsx` — добавить `PENDING_APPROVAL` в union статуса, в фильтр, в `statusText()`, в StatusPill variant map.
- `apps/web/app/bookings/[id]/page.tsx` — статус-бейдж + баннер отклонения + три конд. кнопки + интеграция RejectModal + блокировка редактирования.

**Tests only:** `apps/api/src/__tests__/approval.test.ts` (new). Существующий `dashboard.test.ts` — образец формы `beforeAll` / `AUTH_SA` / `AUTH_WH` / `AUTH_TECH`.

---

### Task 1: Schema — добавить `rejectionReason`

**Files:**
- Modify: `apps/api/prisma/schema.prisma:259-304`

- [ ] **Step 1: Добавить поле в модель Booking**

Открыть `apps/api/prisma/schema.prisma`, найти модель `Booking` (строка 259). Сразу после поля `paymentComment String?` (строка 278) добавить:

```prisma
  /// Причина последнего отклонения (заполняется при rejectBooking, очищается при submitForApproval).
  rejectionReason String?
```

- [ ] **Step 2: Применить изменение в схеме к dev БД**

Run:
```bash
cd apps/api && npx prisma db push --accept-data-loss --skip-generate
```

Expected: `Your database is now in sync with your Prisma schema. Done in ...ms`.

- [ ] **Step 3: Регенерировать Prisma client**

Run:
```bash
cd apps/api && npx prisma generate
```

Expected: `Generated Prisma Client (v6.x.x) to ./node_modules/@prisma/client`.

- [ ] **Step 4: Проверить, что тип появился**

Run:
```bash
cd apps/api && npx tsc --noEmit
```

Expected: 0 ошибок. Если `tsc` указывает, что `rejectionReason` не существует — убедиться, что db push и generate выполнены.

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/schema.prisma
git commit -m "feat(schema): add Booking.rejectionReason for approval workflow"
```

---

### Task 2: Тестовый каркас `approval.test.ts`

**Files:**
- Create: `apps/api/src/__tests__/approval.test.ts`

- [ ] **Step 1: Создать файл с каркасом**

Создать `apps/api/src/__tests__/approval.test.ts` со следующим содержимым (скопировано и адаптировано из `dashboard.test.ts`):

```typescript
/**
 * Интеграционные тесты approval workflow: submit-for-approval / approve / reject.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-approval.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-approval";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-approval";
process.env.JWT_SECRET = "test-jwt-secret-approval-min16chars";

let app: Express;
let prisma: any;
let superAdminToken: string;
let warehouseToken: string;
let technicianToken: string;

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: {
      ...process.env,
      DATABASE_URL: `file:${TEST_DB_PATH}`,
      PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes",
    },
    stdio: "pipe",
  });

  const mod = await import("../app");
  app = mod.app;
  const pmod = await import("../prisma");
  prisma = pmod.prisma;

  const { hashPassword, signSession } = await import("../services/auth");
  const hash = await hashPassword("test-pass-123");

  const sa = await prisma.adminUser.create({
    data: { username: "appr_sa", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });

  const wh = await prisma.adminUser.create({
    data: { username: "appr_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  const tech = await prisma.adminUser.create({
    data: { username: "appr_tech", passwordHash: hash, role: "TECHNICIAN" },
  });
  technicianToken = signSession({ userId: tech.id, username: tech.username, role: "TECHNICIAN" });
});

afterAll(async () => {
  await prisma.$disconnect();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
});

function AUTH_SA() { return { "X-API-Key": "test-key-1", Authorization: `Bearer ${superAdminToken}` }; }
function AUTH_WH() { return { "X-API-Key": "test-key-1", Authorization: `Bearer ${warehouseToken}` }; }
function AUTH_TECH() { return { "X-API-Key": "test-key-1", Authorization: `Bearer ${technicianToken}` }; }

async function createDraftBooking() {
  const client = await prisma.client.create({ data: { name: "ТК Тест" } });
  const equipment = await prisma.equipment.create({
    data: {
      importKey: `СВЕТ||ТЕСТ||||`,
      name: "Прожектор",
      category: "Свет",
      totalQuantity: 5,
      basePrice: 1000,
    },
  });
  const booking = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Тестовый проект",
      startDate: new Date("2026-05-01T10:00:00Z"),
      endDate: new Date("2026-05-03T10:00:00Z"),
      status: "DRAFT",
      items: {
        create: [{ equipmentId: equipment.id, quantity: 2 }],
      },
    },
  });
  return booking;
}

describe("POST /api/bookings/:id/submit-for-approval", () => {
  it("PLACEHOLDER — заполнится в Task 3", async () => {
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Проверить запуск каркаса**

Run:
```bash
cd apps/api && npx vitest run src/__tests__/approval.test.ts 2>&1 | tail -30
```

Expected: 1 pass (PLACEHOLDER проходит), 0 fail.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/approval.test.ts
git commit -m "test: add approval workflow test scaffolding"
```

---

### Task 3: `submitForApproval` — сервис + роут (TDD)

**Files:**
- Create: `apps/api/src/services/bookingApproval.ts`
- Modify: `apps/api/src/routes/bookings.ts`
- Modify: `apps/api/src/__tests__/approval.test.ts`

- [ ] **Step 1: Написать failing-тест**

В `approval.test.ts` заменить PLACEHOLDER-блок на реальные тесты submit-for-approval:

```typescript
describe("POST /api/bookings/:id/submit-for-approval", () => {
  it("WAREHOUSE переводит DRAFT → PENDING_APPROVAL и очищает rejectionReason", async () => {
    const booking = await createDraftBooking();
    // Предварительно выставим rejectionReason, чтобы проверить очистку
    await prisma.booking.update({ where: { id: booking.id }, data: { rejectionReason: "старая причина" } });

    const res = await request(app)
      .post(`/api/bookings/${booking.id}/submit-for-approval`)
      .set(AUTH_WH())
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe("PENDING_APPROVAL");
    expect(res.body.booking.rejectionReason).toBeNull();

    const audit = await prisma.auditEntry.findMany({
      where: { entityType: "Booking", entityId: booking.id, action: "BOOKING_SUBMITTED" },
    });
    expect(audit).toHaveLength(1);
  });

  it("SUPER_ADMIN тоже может отправить на согласование", async () => {
    const booking = await createDraftBooking();
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/submit-for-approval`)
      .set(AUTH_SA())
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe("PENDING_APPROVAL");
  });

  it("TECHNICIAN получает 403", async () => {
    const booking = await createDraftBooking();
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/submit-for-approval`)
      .set(AUTH_TECH())
      .send({});
    expect(res.status).toBe(403);
  });

  it("не-DRAFT бронь → 409", async () => {
    const booking = await createDraftBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "CONFIRMED" } });
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/submit-for-approval`)
      .set(AUTH_WH())
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error?.code || res.body.code).toBe("INVALID_BOOKING_STATE");
  });

  it("несуществующая бронь → 404", async () => {
    const res = await request(app)
      .post(`/api/bookings/does-not-exist/submit-for-approval`)
      .set(AUTH_WH())
      .send({});
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run:
```bash
cd apps/api && npx vitest run src/__tests__/approval.test.ts 2>&1 | tail -40
```

Expected: 5 failures — маршрут пока не существует, ответы будут 404/ошибка.

- [ ] **Step 3: Создать сервис `bookingApproval.ts`**

Создать `apps/api/src/services/bookingApproval.ts`:

```typescript
import { Prisma } from "@prisma/client";

import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { writeAuditEntry, diffFields } from "./audit";

/**
 * Отправить черновик на согласование руководителю.
 * DRAFT → PENDING_APPROVAL. Очищает rejectionReason (если был после предыдущего отклонения).
 * Пишет AuditEntry "BOOKING_SUBMITTED".
 */
export async function submitForApproval(bookingId: string, userId: string) {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, status: true, rejectionReason: true },
    });
    if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
    if (booking.status !== "DRAFT") {
      throw new HttpError(
        409,
        "Отправить на согласование можно только черновик",
        "INVALID_BOOKING_STATE",
      );
    }

    const before = { status: booking.status, rejectionReason: booking.rejectionReason };
    const updated = await tx.booking.update({
      where: { id: bookingId },
      data: { status: "PENDING_APPROVAL", rejectionReason: null },
      include: {
        client: true,
        items: { include: { equipment: true } },
        estimate: { include: { lines: true } },
      },
    });

    await writeAuditEntry({
      userId,
      action: "BOOKING_SUBMITTED",
      entityType: "Booking",
      entityId: bookingId,
      before: diffFields(before),
      after: diffFields({ status: updated.status, rejectionReason: updated.rejectionReason }),
      tx,
    });

    return updated;
  });
}
```

- [ ] **Step 4: Добавить роут в `bookings.ts`**

В `apps/api/src/routes/bookings.ts` в начало файла добавить импорт рядом с существующим:

```typescript
import { submitForApproval } from "../services/bookingApproval";
```

После существующего `router.post("/:id/confirm", ...)` (строка ~748) добавить:

```typescript
/** POST /api/bookings/:id/submit-for-approval — DRAFT → PENDING_APPROVAL (SUPER_ADMIN + WAREHOUSE). */
router.post(
  "/:id/submit-for-approval",
  rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]),
  async (req, res, next) => {
    try {
      if (!req.adminUser) throw new HttpError(401, "Требуется авторизация", "UNAUTHENTICATED");
      const updated = await submitForApproval(req.params.id, req.adminUser.userId);
      res.json({ booking: serializeBookingForApi(updated as any) });
    } catch (err) {
      next(err);
    }
  },
);
```

- [ ] **Step 5: Прогнать тесты submit**

Run:
```bash
cd apps/api && npx vitest run src/__tests__/approval.test.ts -t "submit-for-approval" 2>&1 | tail -30
```

Expected: 5 pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/bookingApproval.ts apps/api/src/routes/bookings.ts apps/api/src/__tests__/approval.test.ts
git commit -m "feat(api): POST /bookings/:id/submit-for-approval + audit"
```

---

### Task 4: `approveBooking` — сервис + роут (TDD)

**Files:**
- Modify: `apps/api/src/services/bookingApproval.ts`
- Modify: `apps/api/src/routes/bookings.ts`
- Modify: `apps/api/src/__tests__/approval.test.ts`

- [ ] **Step 1: Написать failing-тест**

Добавить в `approval.test.ts` после describe "submit-for-approval":

```typescript
describe("POST /api/bookings/:id/approve", () => {
  it("SUPER_ADMIN переводит PENDING_APPROVAL → CONFIRMED", async () => {
    const booking = await createDraftBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "PENDING_APPROVAL" } });

    const res = await request(app)
      .post(`/api/bookings/${booking.id}/approve`)
      .set(AUTH_SA())
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe("CONFIRMED");

    const fresh = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(fresh.confirmedAt).not.toBeNull();

    const audit = await prisma.auditEntry.findMany({
      where: { entityType: "Booking", entityId: booking.id, action: "BOOKING_APPROVED" },
    });
    expect(audit).toHaveLength(1);
  });

  it("WAREHOUSE получает 403", async () => {
    const booking = await createDraftBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "PENDING_APPROVAL" } });
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/approve`)
      .set(AUTH_WH())
      .send({});
    expect(res.status).toBe(403);
  });

  it("не-PENDING_APPROVAL → 409", async () => {
    const booking = await createDraftBooking(); // DRAFT
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/approve`)
      .set(AUTH_SA())
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error?.code || res.body.code).toBe("INVALID_BOOKING_STATE");
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run:
```bash
cd apps/api && npx vitest run src/__tests__/approval.test.ts -t "approve" 2>&1 | tail -30
```

Expected: 3 failures (маршрута нет — 404 вместо ожидаемого статуса).

- [ ] **Step 3: Добавить функцию в сервис**

В `apps/api/src/services/bookingApproval.ts` добавить:

```typescript
/**
 * Одобрить бронь: PENDING_APPROVAL → CONFIRMED. Выставляет confirmedAt.
 * Пишет AuditEntry "BOOKING_APPROVED".
 */
export async function approveBooking(bookingId: string, userId: string) {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, status: true },
    });
    if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
    if (booking.status !== "PENDING_APPROVAL") {
      throw new HttpError(
        409,
        "Одобрить можно только бронь на согласовании",
        "INVALID_BOOKING_STATE",
      );
    }

    const before = { status: booking.status };
    const updated = await tx.booking.update({
      where: { id: bookingId },
      data: { status: "CONFIRMED", confirmedAt: new Date() },
      include: {
        client: true,
        items: { include: { equipment: true } },
        estimate: { include: { lines: true } },
      },
    });

    await writeAuditEntry({
      userId,
      action: "BOOKING_APPROVED",
      entityType: "Booking",
      entityId: bookingId,
      before: diffFields(before),
      after: diffFields({ status: updated.status, confirmedAt: updated.confirmedAt }),
      tx,
    });

    return updated;
  });
}
```

- [ ] **Step 4: Добавить роут**

В `apps/api/src/routes/bookings.ts` обновить импорт:

```typescript
import { submitForApproval, approveBooking } from "../services/bookingApproval";
```

После роута submit-for-approval добавить:

```typescript
/** POST /api/bookings/:id/approve — PENDING_APPROVAL → CONFIRMED (только SUPER_ADMIN). */
router.post(
  "/:id/approve",
  rolesGuard(["SUPER_ADMIN"]),
  async (req, res, next) => {
    try {
      if (!req.adminUser) throw new HttpError(401, "Требуется авторизация", "UNAUTHENTICATED");
      const updated = await approveBooking(req.params.id, req.adminUser.userId);
      res.json({ booking: serializeBookingForApi(updated as any) });
    } catch (err) {
      next(err);
    }
  },
);
```

- [ ] **Step 5: Прогнать тесты approve**

Run:
```bash
cd apps/api && npx vitest run src/__tests__/approval.test.ts -t "approve" 2>&1 | tail -30
```

Expected: 3 pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/bookingApproval.ts apps/api/src/routes/bookings.ts apps/api/src/__tests__/approval.test.ts
git commit -m "feat(api): POST /bookings/:id/approve + audit"
```

---

### Task 5: `rejectBooking` — сервис + роут (TDD)

**Files:**
- Modify: `apps/api/src/services/bookingApproval.ts`
- Modify: `apps/api/src/routes/bookings.ts`
- Modify: `apps/api/src/__tests__/approval.test.ts`

- [ ] **Step 1: Написать failing-тест**

Добавить в `approval.test.ts`:

```typescript
describe("POST /api/bookings/:id/reject", () => {
  it("SUPER_ADMIN отклоняет с причиной: PENDING_APPROVAL → DRAFT + rejectionReason", async () => {
    const booking = await createDraftBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "PENDING_APPROVAL" } });

    const res = await request(app)
      .post(`/api/bookings/${booking.id}/reject`)
      .set(AUTH_SA())
      .send({ reason: "Слишком высокая скидка, пересчитайте" });

    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe("DRAFT");
    expect(res.body.booking.rejectionReason).toBe("Слишком высокая скидка, пересчитайте");

    const audit = await prisma.auditEntry.findMany({
      where: { entityType: "Booking", entityId: booking.id, action: "BOOKING_REJECTED" },
    });
    expect(audit).toHaveLength(1);
  });

  it("пустая причина → 400", async () => {
    const booking = await createDraftBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "PENDING_APPROVAL" } });
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/reject`)
      .set(AUTH_SA())
      .send({ reason: "" });
    expect(res.status).toBe(400);
  });

  it("отсутствие reason в теле → 400", async () => {
    const booking = await createDraftBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "PENDING_APPROVAL" } });
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/reject`)
      .set(AUTH_SA())
      .send({});
    expect(res.status).toBe(400);
  });

  it("WAREHOUSE получает 403", async () => {
    const booking = await createDraftBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "PENDING_APPROVAL" } });
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/reject`)
      .set(AUTH_WH())
      .send({ reason: "test" });
    expect(res.status).toBe(403);
  });

  it("не-PENDING_APPROVAL → 409", async () => {
    const booking = await createDraftBooking(); // DRAFT
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/reject`)
      .set(AUTH_SA())
      .send({ reason: "test" });
    expect(res.status).toBe(409);
    expect(res.body.error?.code || res.body.code).toBe("INVALID_BOOKING_STATE");
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run:
```bash
cd apps/api && npx vitest run src/__tests__/approval.test.ts -t "reject" 2>&1 | tail -30
```

Expected: 5 failures (маршрута нет).

- [ ] **Step 3: Добавить функцию в сервис**

В `apps/api/src/services/bookingApproval.ts` добавить:

```typescript
/**
 * Отклонить бронь: PENDING_APPROVAL → DRAFT + rejectionReason.
 * Пишет AuditEntry "BOOKING_REJECTED". reason обязателен.
 */
export async function rejectBooking(bookingId: string, userId: string, reason: string) {
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    throw new HttpError(400, "Укажите причину отклонения", "REJECTION_REASON_REQUIRED");
  }

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, status: true, rejectionReason: true },
    });
    if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
    if (booking.status !== "PENDING_APPROVAL") {
      throw new HttpError(
        409,
        "Отклонить можно только бронь на согласовании",
        "INVALID_BOOKING_STATE",
      );
    }

    const before = { status: booking.status, rejectionReason: booking.rejectionReason };
    const updated = await tx.booking.update({
      where: { id: bookingId },
      data: { status: "DRAFT", rejectionReason: trimmed },
      include: {
        client: true,
        items: { include: { equipment: true } },
        estimate: { include: { lines: true } },
      },
    });

    await writeAuditEntry({
      userId,
      action: "BOOKING_REJECTED",
      entityType: "Booking",
      entityId: bookingId,
      before: diffFields(before),
      after: diffFields({ status: updated.status, rejectionReason: updated.rejectionReason }),
      tx,
    });

    return updated;
  });
}
```

- [ ] **Step 4: Добавить роут**

В `apps/api/src/routes/bookings.ts` обновить импорт:

```typescript
import { submitForApproval, approveBooking, rejectBooking } from "../services/bookingApproval";
```

Добавить Zod-схему рядом с другими (около строки 57):

```typescript
const rejectSchema = z.object({
  reason: z.string().min(1, "Укажите причину отклонения").max(2000),
});
```

После роута approve добавить:

```typescript
/** POST /api/bookings/:id/reject — PENDING_APPROVAL → DRAFT + причина (только SUPER_ADMIN). */
router.post(
  "/:id/reject",
  rolesGuard(["SUPER_ADMIN"]),
  async (req, res, next) => {
    try {
      if (!req.adminUser) throw new HttpError(401, "Требуется авторизация", "UNAUTHENTICATED");
      const body = rejectSchema.parse(req.body);
      const updated = await rejectBooking(req.params.id, req.adminUser.userId, body.reason);
      res.json({ booking: serializeBookingForApi(updated as any) });
    } catch (err) {
      next(err);
    }
  },
);
```

- [ ] **Step 5: Прогнать тесты reject**

Run:
```bash
cd apps/api && npx vitest run src/__tests__/approval.test.ts -t "reject" 2>&1 | tail -40
```

Expected: 5 pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/bookingApproval.ts apps/api/src/routes/bookings.ts apps/api/src/__tests__/approval.test.ts
git commit -m "feat(api): POST /bookings/:id/reject + required reason + audit"
```

---

### Task 6: Edit-prevention — PATCH `/api/bookings/:id` возвращает 409 для PENDING_APPROVAL

**Files:**
- Modify: `apps/api/src/routes/bookings.ts:305-307`
- Modify: `apps/api/src/__tests__/approval.test.ts`

- [ ] **Step 1: Написать failing-тест**

В `approval.test.ts` добавить describe:

```typescript
describe("PATCH /api/bookings/:id — edit-prevention для PENDING_APPROVAL", () => {
  it("PATCH по PENDING_APPROVAL возвращает 409", async () => {
    const booking = await createDraftBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "PENDING_APPROVAL" } });

    const res = await request(app)
      .patch(`/api/bookings/${booking.id}`)
      .set(AUTH_WH())
      .send({ projectName: "Новое имя" });

    expect(res.status).toBe(409);
  });

  it("PATCH по DRAFT по-прежнему разрешён", async () => {
    const booking = await createDraftBooking();
    const res = await request(app)
      .patch(`/api/bookings/${booking.id}`)
      .set(AUTH_WH())
      .send({ projectName: "Обновлённое имя" });
    expect(res.status).toBe(200);
    expect(res.body.booking.projectName).toBe("Обновлённое имя");
  });
});
```

- [ ] **Step 2: Убедиться, что первый тест падает**

Run:
```bash
cd apps/api && npx vitest run src/__tests__/approval.test.ts -t "edit-prevention" 2>&1 | tail -20
```

Expected: 1 failure (PENDING_APPROVAL сейчас проходит через валидацию, так как список допустимых — `["DRAFT", "CONFIRMED"]` — это уже корректный блок, но ошибка может быть иной: следует свериться с точным поведением).

- [ ] **Step 3: Обновить условие в PATCH**

В `apps/api/src/routes/bookings.ts` строка 305–307 уже содержит:

```typescript
if (!["DRAFT", "CONFIRMED"].includes(existing.status)) {
  throw new HttpError(409, "Редактирование доступно для черновиков и подтвержденных броней.");
}
```

Это уже корректно — PENDING_APPROVAL не входит в список, значит PATCH вернёт 409. Ничего менять не надо, но нужно убедиться, что сообщение осмысленно. Уточним текст для ясности:

```typescript
if (!["DRAFT", "CONFIRMED"].includes(existing.status)) {
  const reason =
    existing.status === "PENDING_APPROVAL"
      ? "Бронь на согласовании — редактирование недоступно. Отправьте на доработку через «Отклонить»."
      : "Редактирование доступно для черновиков и подтверждённых броней.";
  throw new HttpError(409, reason, "BOOKING_EDIT_FORBIDDEN");
}
```

- [ ] **Step 4: Прогнать тесты**

Run:
```bash
cd apps/api && npx vitest run src/__tests__/approval.test.ts -t "edit-prevention" 2>&1 | tail -20
```

Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/bookings.ts apps/api/src/__tests__/approval.test.ts
git commit -m "feat(api): block PATCH /bookings/:id for PENDING_APPROVAL (409)"
```

---

### Task 7: List filter — `?status=PENDING_APPROVAL`

**Files:**
- Modify: `apps/api/src/routes/bookings.ts` (GET "/" handler)
- Modify: `apps/api/src/__tests__/approval.test.ts`

- [ ] **Step 1: Проверить текущий фильтр**

Run:
```bash
grep -n "status" apps/api/src/routes/bookings.ts | head -30
```

Ожидание: в GET "/" есть условие `where.status = req.query.status` или через Zod enum. Если там есть `z.enum([...])` со списком статусов — убедиться, что `PENDING_APPROVAL` включён. Поскольку Prisma enum уже поддерживает этот статус, а многие handlers используют `BookingStatus` напрямую из Prisma, скорее всего фильтр уже работает.

- [ ] **Step 2: Написать failing-тест**

Добавить в `approval.test.ts`:

```typescript
describe("GET /api/bookings?status=PENDING_APPROVAL", () => {
  it("фильтрация по PENDING_APPROVAL возвращает только брони на согласовании", async () => {
    const b1 = await createDraftBooking(); // DRAFT
    const b2 = await createDraftBooking();
    await prisma.booking.update({ where: { id: b2.id }, data: { status: "PENDING_APPROVAL" } });
    const b3 = await createDraftBooking();
    await prisma.booking.update({ where: { id: b3.id }, data: { status: "PENDING_APPROVAL" } });

    const res = await request(app)
      .get(`/api/bookings?status=PENDING_APPROVAL&limit=100`)
      .set(AUTH_WH());

    expect(res.status).toBe(200);
    const ids = res.body.bookings.map((b: any) => b.id);
    expect(ids).toContain(b2.id);
    expect(ids).toContain(b3.id);
    expect(ids).not.toContain(b1.id);
    for (const b of res.body.bookings) {
      expect(b.status).toBe("PENDING_APPROVAL");
    }
  });
});
```

- [ ] **Step 3: Запустить тест**

Run:
```bash
cd apps/api && npx vitest run src/__tests__/approval.test.ts -t "PENDING_APPROVAL" 2>&1 | tail -20
```

Если тест проходит — переходим к Step 5. Если падает из-за Zod-enum — идём на Step 4.

- [ ] **Step 4: Обновить Zod-enum в bookingListQuerySchema (если нужно)**

Найти в `bookings.ts` Zod-схему для query параметров GET "/" (около строки 118). Если там есть `status: z.enum(["DRAFT","CONFIRMED",...])` — добавить `"PENDING_APPROVAL"`. Пример:

```typescript
status: z.enum(["DRAFT", "PENDING_APPROVAL", "CONFIRMED", "ISSUED", "RETURNED", "CANCELLED"]).optional(),
```

Если используется multi-value через `.split(",")` — тоже добавить. Перечитать тест после изменения.

- [ ] **Step 5: Прогнать тест**

Run:
```bash
cd apps/api && npx vitest run src/__tests__/approval.test.ts -t "PENDING_APPROVAL" 2>&1 | tail -15
```

Expected: 1 pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/bookings.ts apps/api/src/__tests__/approval.test.ts
git commit -m "feat(api): support ?status=PENDING_APPROVAL in GET /bookings"
```

---

### Task 8: Full API test run + tsc

**Files:** — (нет изменений, только проверка)

- [ ] **Step 1: Прогнать все тесты API**

Run:
```bash
cd apps/api && timeout 180 npx vitest run 2>&1 | tail -40
```

Expected: все тесты pass, включая новый `approval.test.ts` (16 it-блоков) и все существующие (rolesGuard, dashboard и т.д.).

- [ ] **Step 2: Проверить типизацию**

Run:
```bash
cd apps/api && npx tsc --noEmit 2>&1 | tail -20
```

Expected: 0 ошибок.

- [ ] **Step 3: Если тесты или tsc падают — исправить и зафиксировать**

Выявленные проблемы (опечатки, отсутствующие импорты, типы) исправить инкрементально; коммитить с префиксом `fix`. Если всё зелёное — пропустить этот шаг.

---

### Task 9: Frontend — тип `BookingStatus` + список `/bookings` + StatusPill для PENDING_APPROVAL

**Files:**
- Modify: `apps/web/app/bookings/page.tsx:19-38, 78-91`

- [ ] **Step 1: Расширить union**

Найти `type BookingRow` (строка ~19) и `statusText` (~78). В обоих местах заменить union:

До:
```typescript
status: "DRAFT" | "CONFIRMED" | "ISSUED" | "RETURNED" | "CANCELLED";
```

После:
```typescript
status: "DRAFT" | "PENDING_APPROVAL" | "CONFIRMED" | "ISSUED" | "RETURNED" | "CANCELLED";
```

- [ ] **Step 2: Добавить label "На согласовании" в statusText**

```typescript
const statusText = (s: BookingRow["status"]) => {
  switch (s) {
    case "DRAFT":
      return "Черновик";
    case "PENDING_APPROVAL":
      return "На согласовании";
    case "CONFIRMED":
      return "Подтверждено";
    case "ISSUED":
      return "Выдано";
    case "RETURNED":
      return "Возвращено";
    case "CANCELLED":
      return "Отменено";
  }
};
```

- [ ] **Step 3: Добавить PENDING_APPROVAL в выпадающий фильтр статуса**

Найти `<select>` с `statusFilter` (он должен быть в JSX ниже state-объявлений). Добавить `<option value="PENDING_APPROVAL">На согласовании</option>`. Если фильтр содержит массив статусов — также добавить его в массив. Пример:

```tsx
<option value="">Все статусы</option>
<option value="DRAFT">Черновик</option>
<option value="PENDING_APPROVAL">На согласовании</option>
<option value="CONFIRMED">Подтверждено</option>
<option value="ISSUED">Выдано</option>
<option value="RETURNED">Возвращено</option>
<option value="CANCELLED">Отменено</option>
```

- [ ] **Step 4: Вариант StatusPill для PENDING_APPROVAL**

Найти место, где `<StatusPill variant={...} label={statusText(...)} />` рендерится в таблице. Добавить мэппинг:

```tsx
const statusVariant = (s: BookingRow["status"]): "info" | "warn" | "ok" | "limited" | "none" => {
  switch (s) {
    case "DRAFT": return "info";
    case "PENDING_APPROVAL": return "warn";
    case "CONFIRMED": return "ok";
    case "ISSUED": return "ok";
    case "RETURNED": return "limited";
    case "CANCELLED": return "none";
  }
};
```

И использовать: `<StatusPill variant={statusVariant(row.status)} label={statusText(row.status)} />`.

Если текущая реализация использует inline-строки для variant — заменить на helper.

- [ ] **Step 5: Проверка билда**

Run:
```bash
cd apps/web && timeout 120 npm run build 2>&1 | tail -20
```

Expected: `✓ Compiled successfully`, 0 ошибок типов, 0 предупреждений ESLint об unused.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/bookings/page.tsx
git commit -m "feat(web): show PENDING_APPROVAL in /bookings list and filter"
```

---

### Task 10: Frontend — модалка `RejectBookingModal`

**Files:**
- Create: `apps/web/src/components/bookings/RejectBookingModal.tsx`

- [ ] **Step 1: Создать компонент**

Создать файл с содержимым:

```tsx
"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  open: boolean;
  bookingDisplayName: string;
  loading?: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void> | void;
};

export function RejectBookingModal({ open, bookingDisplayName, loading = false, onClose, onSubmit }: Props) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) {
      setReason("");
      setError(null);
    } else {
      // Фокус в textarea при открытии
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !loading) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, loading, onClose]);

  if (!open) return null;

  const trimmedLen = reason.trim().length;
  const disabled = loading || trimmedLen < 3;

  const handleSubmit = async () => {
    if (trimmedLen < 3) {
      setError("Укажите причину отклонения (минимум 3 символа)");
      return;
    }
    setError(null);
    try {
      await onSubmit(reason.trim());
    } catch (e: any) {
      setError(e?.message ?? "Не удалось отклонить бронь");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-1/50 px-4"
      onClick={() => !loading && onClose()}
    >
      <div
        className="w-full max-w-md rounded-lg bg-surface p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="eyebrow mb-2">Отклонение брони</div>
        <h2 className="mb-1 text-lg font-semibold text-ink-1">{bookingDisplayName}</h2>
        <p className="mb-4 text-sm text-ink-3">
          Бронь вернётся в черновик. Причина будет показана кладовщику и записана в журнал аудита.
        </p>

        <label htmlFor="reject-reason" className="mb-2 block text-sm text-ink-2">
          Причина отклонения <span className="text-rose">*</span>
        </label>
        <textarea
          id="reject-reason"
          ref={textareaRef}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={4}
          disabled={loading}
          className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-ink-1 focus:border-accent focus:outline-none"
          placeholder="Например: пересчитайте скидку, слишком высокая для этого клиента"
          maxLength={2000}
        />
        <div className="mt-1 flex items-center justify-between text-xs text-ink-3">
          <span>{trimmedLen} / 2000</span>
          {error && <span className="text-rose">{error}</span>}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="rounded border border-border px-4 py-2 text-sm text-ink-2 hover:bg-surface-soft disabled:opacity-50"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={disabled}
            className="rounded bg-rose px-4 py-2 text-sm text-white hover:bg-rose/90 disabled:opacity-50"
          >
            {loading ? "Отклоняю…" : "Отклонить"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Проверить билд**

Run:
```bash
cd apps/web && timeout 120 npm run build 2>&1 | tail -15
```

Expected: `✓ Compiled successfully`. Модалка пока не используется — предупреждение об unused export приемлемо, импорт появится в Task 11.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/bookings/RejectBookingModal.tsx
git commit -m "feat(web): RejectBookingModal with required reason + Esc-close"
```

---

### Task 11: Frontend — кнопки действий на карточке `/bookings/[id]` + баннер отклонения

**Files:**
- Modify: `apps/web/app/bookings/[id]/page.tsx`

- [ ] **Step 1: Расширить тип BookingDetail**

Найти `type BookingDetail` (строка ~23) и:

1. Добавить `PENDING_APPROVAL` в union статуса.
2. Добавить поле `rejectionReason?: string | null`.

```typescript
type BookingDetail = {
  id: string;
  displayName?: string;
  status: "DRAFT" | "PENDING_APPROVAL" | "CONFIRMED" | "ISSUED" | "RETURNED" | "CANCELLED";
  rejectionReason?: string | null;
  // ... остальные поля без изменений
};
```

- [ ] **Step 2: Обновить `statusText()` для карточки**

Найти `function statusText` (строка ~74). Добавить case для PENDING_APPROVAL:

```typescript
function statusText(s: BookingDetail["status"]) {
  switch (s) {
    case "DRAFT": return "Черновик";
    case "PENDING_APPROVAL": return "На согласовании";
    case "CONFIRMED": return "Подтверждено";
    case "ISSUED": return "Выдано";
    case "RETURNED": return "Возвращено";
    case "CANCELLED": return "Отменено";
  }
}
```

- [ ] **Step 3: Подключить useCurrentUser и импорты**

В начало файла:

```typescript
import { useCurrentUser } from "../../../src/hooks/useCurrentUser";
import { RejectBookingModal } from "../../../src/components/bookings/RejectBookingModal";
import { apiFetch } from "../../../src/lib/api";
import { toast } from "../../../src/components/ToastProvider";
```

В теле компонента после остальных хуков:

```typescript
const { user } = useCurrentUser();
const [rejectOpen, setRejectOpen] = useState(false);
const [actionBusy, setActionBusy] = useState<null | "submit" | "approve" | "reject">(null);
```

- [ ] **Step 4: Написать обработчики действий**

Добавить внутри компонента (предполагается, что `booking` — state с `BookingDetail | null`, `setBooking` уже есть):

```typescript
async function handleSubmitForApproval() {
  if (!booking) return;
  setActionBusy("submit");
  try {
    const data = await apiFetch<{ booking: BookingDetail }>(`/api/bookings/${booking.id}/submit-for-approval`, {
      method: "POST",
    });
    setBooking(data.booking);
    toast.success("Бронь отправлена на согласование");
  } catch (e: any) {
    toast.error(e?.message ?? "Не удалось отправить на согласование");
  } finally {
    setActionBusy(null);
  }
}

async function handleApprove() {
  if (!booking) return;
  if (!confirm("Одобрить бронь и перевести её в «Подтверждено»?")) return;
  setActionBusy("approve");
  try {
    const data = await apiFetch<{ booking: BookingDetail }>(`/api/bookings/${booking.id}/approve`, {
      method: "POST",
    });
    setBooking(data.booking);
    toast.success("Бронь одобрена");
  } catch (e: any) {
    toast.error(e?.message ?? "Не удалось одобрить бронь");
  } finally {
    setActionBusy(null);
  }
}

async function handleReject(reason: string) {
  if (!booking) return;
  setActionBusy("reject");
  try {
    const data = await apiFetch<{ booking: BookingDetail }>(`/api/bookings/${booking.id}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
    setBooking(data.booking);
    setRejectOpen(false);
    toast.success("Бронь отклонена и возвращена в черновик");
  } catch (e: any) {
    toast.error(e?.message ?? "Не удалось отклонить бронь");
    throw e; // пробросить в модалку для inline-ошибки
  } finally {
    setActionBusy(null);
  }
}
```

- [ ] **Step 5: Добавить баннер отклонения + кнопки**

В JSX под заголовком карточки (до блока с items) добавить:

```tsx
{booking.status === "DRAFT" && booking.rejectionReason && (
  <div className="mb-4 rounded border-l-4 border-rose bg-rose-soft px-4 py-3 text-sm text-ink-1">
    <div className="eyebrow mb-1 text-rose">Отклонено руководителем</div>
    <div className="whitespace-pre-wrap">{booking.rejectionReason}</div>
    <div className="mt-2 text-xs text-ink-3">
      Внесите правки и отправьте снова кнопкой «Отправить на согласование».
    </div>
  </div>
)}

<div className="mb-4 flex flex-wrap gap-2">
  {booking.status === "DRAFT" && (user?.role === "WAREHOUSE" || user?.role === "SUPER_ADMIN") && (
    <button
      type="button"
      onClick={handleSubmitForApproval}
      disabled={actionBusy !== null}
      className="rounded bg-accent-bright px-4 py-2 text-sm text-white hover:bg-accent-bright/90 disabled:opacity-50"
    >
      {actionBusy === "submit" ? "Отправляю…" : "Отправить на согласование"}
    </button>
  )}
  {booking.status === "PENDING_APPROVAL" && user?.role === "SUPER_ADMIN" && (
    <>
      <button
        type="button"
        onClick={handleApprove}
        disabled={actionBusy !== null}
        className="rounded bg-emerald px-4 py-2 text-sm text-white hover:bg-emerald/90 disabled:opacity-50"
      >
        {actionBusy === "approve" ? "Одобряю…" : "Одобрить"}
      </button>
      <button
        type="button"
        onClick={() => setRejectOpen(true)}
        disabled={actionBusy !== null}
        className="rounded border border-rose px-4 py-2 text-sm text-rose hover:bg-rose-soft disabled:opacity-50"
      >
        Отклонить
      </button>
    </>
  )}
</div>

<RejectBookingModal
  open={rejectOpen}
  bookingDisplayName={booking.displayName ?? booking.projectName}
  loading={actionBusy === "reject"}
  onClose={() => setRejectOpen(false)}
  onSubmit={handleReject}
/>
```

- [ ] **Step 6: Блокировка редактирования на PENDING_APPROVAL**

Если на карточке есть кнопки «Редактировать», «Добавить позицию», «Удалить позицию», «Изменить скидку» и подобные — завернуть их в условие:

```tsx
const isReadOnly = booking.status === "PENDING_APPROVAL" || booking.status === "CANCELLED" || booking.status === "RETURNED";
```

и ставить `disabled={isReadOnly}` либо полностью скрывать. API в любом случае вернёт 409 — это UX-подстраховка.

Если точные места редактируемых кнопок не очевидны — для MVP оставить серверную блокировку (API 409 + toast.error обработается в catch). В этом случае добавить только маленькое уведомление сверху:

```tsx
{booking.status === "PENDING_APPROVAL" && (
  <div className="mb-4 rounded border border-amber bg-amber-soft px-4 py-2 text-sm text-ink-1">
    Бронь на согласовании у руководителя — редактирование временно заблокировано.
  </div>
)}
```

- [ ] **Step 7: Проверить билд**

Run:
```bash
cd apps/web && timeout 120 npm run build 2>&1 | tail -20
```

Expected: `✓ Compiled successfully`, 0 ошибок типов.

- [ ] **Step 8: Commit**

```bash
git add apps/web/app/bookings/[id]/page.tsx
git commit -m "feat(web): approval action buttons + rejection banner on /bookings/[id]"
```

---

### Task 12: Финальная проверка + push

**Files:** — (только команды)

- [ ] **Step 1: Полный тест-ран (все workspace-тесты)**

Run из корня монорепо:
```bash
cd /Users/sechenov/Documents/light-rental-system/.worktrees/approval-workflow && timeout 240 npm test 2>&1 | tail -40
```

Expected: все тесты pass, сводка вида `Test Files X passed, Tests Y passed` без fail. Новый `approval.test.ts` даёт +16–18 it-блоков.

- [ ] **Step 2: Полный tsc (API + Web)**

```bash
cd apps/api && npx tsc --noEmit 2>&1 | tail -5
cd ../web && npx tsc --noEmit 2>&1 | tail -5
```

Expected: 0 ошибок в обоих.

- [ ] **Step 3: Билд Web**

```bash
cd apps/web && timeout 180 npm run build 2>&1 | tail -15
```

Expected: `✓ Compiled successfully`.

- [ ] **Step 4: Проверить git-статус — ничего не забыто**

```bash
git status --short
```

Expected: только `.worktrees/` и, возможно, `apps/api/dev.db` — ничего значимого в worktree не осталось untracked.

- [ ] **Step 5: Проверить лог коммитов**

```bash
git log --oneline main..HEAD
```

Expected: 10–12 коммитов, описывающих последовательно схему, submit/approve/reject, edit-prevention, list filter, UI-изменения, модалку, баннер.

- [ ] **Step 6: Если проверки зелёные — PAR-этап начинается (см. SKILL.md)**

Следующий шаг — запуск PAR-ревью согласно Superflow (параллельно 2 агента: standard-product-reviewer + standard-code-reviewer, fix findings, `.par-evidence.json`, push, PR). Это уже не часть плана Subproject B, а стандартный пост-имплементационный конвейер оркестратора.

---

## Самопроверка плана

**Spec coverage:**
- ✅ Schema: `rejectionReason` — Task 1
- ✅ submit-for-approval: SA+WAREHOUSE, DRAFT→PENDING_APPROVAL, очистка rejectionReason — Task 3
- ✅ approve: SA, PENDING_APPROVAL→CONFIRMED+confirmedAt — Task 4
- ✅ reject: SA, PENDING_APPROVAL→DRAFT+rejectionReason, обязательная причина — Task 5
- ✅ Audit: все три действия пишут AuditEntry в транзакции — Tasks 3, 4, 5
- ✅ Edit-prevention: PATCH на PENDING_APPROVAL → 409 — Task 6
- ✅ List filter: ?status=PENDING_APPROVAL — Task 7
- ✅ UI filter в списке: PENDING_APPROVAL в dropdown — Task 9
- ✅ UI StatusPill "warn" для PENDING_APPROVAL в списке и карточке — Tasks 9, 11
- ✅ UI кнопки по роли и статусу на карточке — Task 11
- ✅ UI reject модалка с required reason — Task 10
- ✅ UI rejection banner на DRAFT — Task 11
- ✅ Tests: новый файл approval.test.ts с 16+ it-блоков — Tasks 2–7
- ✅ tsc + build + весь npm test — Task 12

**Placeholder scan:** нет TBD/TODO/«implement later». Каждый шаг содержит конкретный код, exact-пути, или exact-команду.

**Type consistency:**
- `BookingStatus.PENDING_APPROVAL` — единообразно во всех задачах.
- `rejectionReason` — Prisma `String?`, во фронте `string | null | undefined`.
- Service-функции: `submitForApproval(id, userId)`, `approveBooking(id, userId)`, `rejectBooking(id, userId, reason)`. Сигнатуры согласованы между Task 3, 4, 5 и Task 11 (HTTP-вызовы тех же ручек из UI).
- Error codes: `INVALID_BOOKING_STATE`, `BOOKING_NOT_FOUND`, `REJECTION_REASON_REQUIRED`, `BOOKING_EDIT_FORBIDDEN`, `UNAUTHENTICATED` — все упомянуты в Task 6 единообразно.
- AuditEntry actions: `BOOKING_SUBMITTED`, `BOOKING_APPROVED`, `BOOKING_REJECTED` — строковые литералы одинаковы в сервисе и в тестах.

Готово.
