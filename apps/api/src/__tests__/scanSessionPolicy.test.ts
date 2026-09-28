/**
 * Политика складских сессий киоска — `services/scanSessionPolicy.ts`.
 *
 * Чистые правила (какая сессия живая, тексты, гард ранней выдачи, версия
 * состава) проверяются без базы. Всё, что пишет в базу, — на изолированной
 * SQLite: закрытие сессий вместе с аудитом в одной транзакции, «блокирующая»
 * сессия (только живая и с работой), разбор состояния сессии перед записью и
 * системный автор аудита на базе, где `_system_` ещё нет.
 */

import path from "path";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-scan-session-policy.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.NODE_ENV = "test";

type Policy = typeof import("../services/scanSessionPolicy");

let policy: Policy;
let prisma: any;
let saId: string;
let clientId: string;
let equipmentId: string;
let unitSeq = 0;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB_PATH}`, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });
  prisma = (await import("../prisma")).prisma;
  policy = await import("../services/scanSessionPolicy");

  const sa = await prisma.adminUser.create({
    data: { username: "policy_sa", passwordHash: "x", role: "SUPER_ADMIN" },
  });
  saId = sa.id;
  const client = await prisma.client.create({ data: { name: "Клиент политики сессий" } });
  clientId = client.id;
  const eq = await prisma.equipment.create({
    data: { importKey: "policy-eq-1", category: "Свет", name: "Прибор политики", rentalRatePerShift: 1000, totalQuantity: 5 },
  });
  equipmentId = eq.id;
});

afterAll(async () => {
  await prisma?.$disconnect?.();
});

async function makeBooking(status: string, opts: { deletedAt?: Date | null; startInMs?: number } = {}) {
  const start = new Date(Date.now() + (opts.startInMs ?? DAY));
  return prisma.booking.create({
    data: {
      clientId,
      projectName: `Проект ${status}`,
      startDate: start,
      endDate: new Date(start.getTime() + 2 * DAY),
      status,
      deletedAt: opts.deletedAt ?? null,
      items: { create: [{ equipmentId, quantity: 2 }] },
    },
    include: { items: true },
  });
}

async function makeSession(
  bookingId: string,
  operation: "ISSUE" | "RETURN",
  data: Record<string, unknown> = {},
) {
  return prisma.scanSession.create({
    data: { bookingId, operation, workerName: "Иван Кладовщик", status: "ACTIVE", ...data },
  });
}

async function expectHttpError(p: Promise<unknown>, status: number, code: string) {
  try {
    await p;
  } catch (err: any) {
    expect(err.status).toBe(status);
    expect(err.code).toBe(code);
    return err;
  }
  throw new Error(`ожидалась ошибка ${status} ${code}, а вызов прошёл`);
}

async function cancelAudits(bookingId: string) {
  return prisma.auditEntry.findMany({
    where: { action: "SCAN_SESSION_CANCELLED", entityType: "Booking", entityId: bookingId },
    orderBy: { createdAt: "asc" },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Чистые правила
// ─────────────────────────────────────────────────────────────────────────────

describe("isSessionLive — какая сессия живая", () => {
  it("выдача живая только на подтверждённой брони вне архива", () => {
    expect(policy.isSessionLive("ISSUE", { status: "CONFIRMED", deletedAt: null })).toBe(true);
    expect(policy.isSessionLive("ISSUE", { status: "CONFIRMED", deletedAt: new Date() })).toBe(false);
    for (const status of ["DRAFT", "PENDING_APPROVAL", "ISSUED", "RETURNED", "CANCELLED"] as const) {
      expect(policy.isSessionLive("ISSUE", { status, deletedAt: null })).toBe(false);
    }
  });

  it("приёмка живая только на выданной брони", () => {
    expect(policy.isSessionLive("RETURN", { status: "ISSUED", deletedAt: null })).toBe(true);
    for (const status of ["DRAFT", "PENDING_APPROVAL", "CONFIRMED", "RETURNED", "CANCELLED"] as const) {
      expect(policy.isSessionLive("RETURN", { status, deletedAt: null })).toBe(false);
    }
  });
});

describe("staleMessage — почему сессия устарела", () => {
  it("называет причину по статусу брони", () => {
    expect(policy.staleMessage("ISSUE", "ISSUED", null)).toBe(
      "Бронь уже выдана на карточке — чек-лист закрыт, изменения из него не применены",
    );
    expect(policy.staleMessage("RETURN", "RETURNED", null)).toBe(
      "Бронь уже принята на карточке — чек-лист закрыт, изменения из него не применены",
    );
    expect(policy.staleMessage("ISSUE", "PENDING_APPROVAL", null)).toBe(
      "Бронь вернули на согласование — выдавать пока нельзя",
    );
    expect(policy.staleMessage("ISSUE", "CANCELLED", null)).toMatch(/^Бронь отменена/);
    expect(policy.staleMessage("ISSUE", "CONFIRMED", new Date())).toMatch(/^Бронь в архиве/);
  });

  it("не бывает пустым и не пишет статус ENUM-стилем", () => {
    const statuses = ["DRAFT", "PENDING_APPROVAL", "CONFIRMED", "ISSUED", "RETURNED", "CANCELLED"] as const;
    for (const op of ["ISSUE", "RETURN"] as const) {
      for (const status of statuses) {
        const text = policy.staleMessage(op, status, null);
        expect(text.length).toBeGreaterThan(10);
        expect(text).not.toMatch(/[A-Z]{4,}/);
      }
    }
  });
});

describe("assertIssueNotTooEarly — выдача раньше срока", () => {
  const now = new Date("2026-10-10T09:00:00.000Z");

  it("больше суток до начала → 409 ISSUE_TOO_EARLY с датой начала по Москве", () => {
    const start = new Date(now.getTime() + 25 * HOUR);
    let caught: any;
    try {
      policy.assertIssueNotTooEarly(start, false, now);
    } catch (err) {
      caught = err;
    }
    expect(caught?.status).toBe(409);
    expect(caught?.code).toBe("ISSUE_TOO_EARLY");
    expect(caught?.details).toEqual({ startDate: start.toISOString() });
    expect(caught?.message).toContain("Аренда начинается 11.10.2026 — до начала больше суток");
  });

  it("ровно сутки и меньше — выдаём без вопросов", () => {
    expect(() => policy.assertIssueNotTooEarly(new Date(now.getTime() + DAY), false, now)).not.toThrow();
    expect(() => policy.assertIssueNotTooEarly(new Date(now.getTime() - 3 * DAY), false, now)).not.toThrow();
  });

  it("force — осознанная ранняя выдача проходит", () => {
    expect(() => policy.assertIssueNotTooEarly(new Date(now.getTime() + 14 * DAY), true, now)).not.toThrow();
  });

  it("по умолчанию считает от текущего момента", () => {
    expect(() => policy.assertIssueNotTooEarly(new Date(Date.now() + 3 * DAY), false)).toThrow();
    expect(() => policy.assertIssueNotTooEarly(new Date(Date.now() + HOUR), false)).not.toThrow();
  });
});

describe("computeItemsVersion — версия состава брони", () => {
  const items = [
    { id: "b-item", quantity: 2 },
    { id: "a-item", quantity: 5 },
  ];

  it("16 hex-символов и не зависит от порядка строк", () => {
    const v = policy.computeItemsVersion(items);
    expect(v).toMatch(/^[0-9a-f]{16}$/);
    expect(policy.computeItemsVersion([...items].reverse())).toBe(v);
  });

  it("меняется при смене количества, новой и удалённой строке", () => {
    const v = policy.computeItemsVersion(items);
    expect(policy.computeItemsVersion([{ id: "b-item", quantity: 3 }, items[1]])).not.toBe(v);
    expect(policy.computeItemsVersion([...items, { id: "c-item", quantity: 1 }])).not.toBe(v);
    expect(policy.computeItemsVersion([items[0]])).not.toBe(v);
  });
});

describe("тексты ошибок", () => {
  it("SCAN_ERR содержит все коды контракта", () => {
    for (const code of [
      "SESSION_NOT_FOUND",
      "SESSION_ALREADY_COMPLETED",
      "SESSION_CANCELLED",
      "SESSION_STALE",
      "CHECKLIST_OUTDATED",
      "DRAFT_OUTDATED",
      "DRAFT_TOO_LARGE",
      "NOTHING_TO_ISSUE",
      "ISSUE_TOO_EARLY",
      "ADDON_ONLY_ON_ISSUE",
      "ADDON_OVER_STOCK",
      "ADDON_CONFLICT",
      "SCAN_SESSION_ACTIVE",
      "INVALID_BOOKING_STATE",
      "NOT_ENOUGH_UNITS",
      "BOOKING_WRONG_STATUS",
    ]) {
      expect((policy.SCAN_ERR as Record<string, string>)[code]).toBe(code);
    }
  });

  it("SCAN_SESSION_ACTIVE называет кладовщика и время начала по Москве", () => {
    const startedAt = new Date("2026-09-24T05:42:00.000Z"); // 08:42 МСК
    const err = policy.scanSessionActiveError({
      id: "s1",
      operation: "RETURN",
      workerName: "rental",
      startedAt,
      hasDraft: true,
    });
    expect(err.status).toBe(409);
    expect(err.code).toBe("SCAN_SESSION_ACTIVE");
    expect(err.message).toBe(
      "На складе идёт приёмка по этой брони (rental, с 24.09 08:42) — завершите её в киоске или прервите.",
    );
    expect(err.details).toEqual({
      sessionId: "s1",
      operation: "RETURN",
      workerName: "rental",
      startedAt: startedAt.toISOString(),
      hasDraft: true,
    });
    const issue = policy.scanSessionActiveError({ id: "s2", operation: "ISSUE", workerName: "Иван", startedAt, hasDraft: false });
    expect(issue.message).toBe(
      "На складе открыта выдача по этой брони (Иван, с 24.09 08:42) — добавьте позицию в чек-листе киоска или прервите выдачу.",
    );
  });

  it("BOOKING_WRONG_STATUS подсказывает, что делать с уже выданной бронью", () => {
    expect(policy.bookingWrongStatusMessage("ISSUE", "ISSUED")).toBe(
      "Бронь уже выдана — выдачу в киоске не открыть. Довезти позиции можно кнопкой «+ Добор» на карточке брони",
    );
    expect(policy.bookingWrongStatusMessage("ISSUE", "DRAFT")).toBe("Выдать можно только подтверждённую бронь");
    expect(policy.bookingWrongStatusMessage("RETURN", "CONFIRMED")).toBe("Принять можно только выданную бронь");
  });

  it("INVALID_BOOKING_STATE — по паре статус × действие", () => {
    expect(policy.invalidBookingStateMessage("ISSUED", "issue")).toBe("Бронь уже выдана — обновите страницу");
    expect(policy.invalidBookingStateMessage("RETURNED", "return")).toBe("Бронь уже принята — обновите страницу");
    expect(policy.invalidBookingStateMessage("CANCELLED", "issue")).toBe("Бронь отменена — обновите страницу");
    expect(policy.invalidBookingStateMessage("DRAFT", "issue")).toBe("Черновик нельзя выдать — сначала подтвердите бронь");
    expect(policy.invalidBookingStateMessage("PENDING_APPROVAL", "issue")).toBe(
      "Бронь на согласовании — выдать можно после подтверждения",
    );
    expect(policy.invalidBookingStateMessage("CONFIRMED", "return")).toBe("Бронь ещё не выдана — сначала отметьте выдачу");
    expect(policy.invalidBookingStateMessage("ISSUED", "cancel")).toBe(
      "Выданную бронь нельзя отменить — сначала примите возврат",
    );
    expect(policy.invalidBookingStateMessage("RETURNED", "cancel")).toBe("Принятую бронь нельзя отменить");
    expect(policy.invalidBookingStateMessage("CONFIRMED", "issue")).toBe("Бронь уже изменили — обновите страницу");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Системный автор аудита
// ─────────────────────────────────────────────────────────────────────────────

describe("ensureSystemAuditUser — системный автор аудита", () => {
  beforeEach(async () => {
    // Каждый сценарий начинается с базы без `_system_` и с чистым кешем модуля.
    await prisma.auditEntry.deleteMany({ where: { userId: "_system_" } });
    await prisma.adminUser.deleteMany({ where: { id: "_system_" } });
    policy._resetSystemAuditUserCacheForTests();
  });

  it("создаёт `_system_` на базе, где его нет, и он не может войти и не считается руководителем", async () => {
    await expect(policy.ensureSystemAuditUser(prisma)).resolves.toBe("_system_");
    const user = await prisma.adminUser.findUnique({ where: { id: "_system_" } });
    expect(user).toMatchObject({ username: "_system_", passwordHash: "!disabled", isActive: false });
    // Повтор — без ошибок и без второй строки.
    await expect(policy.ensureSystemAuditUser(prisma)).resolves.toBe("_system_");
    expect(await prisma.adminUser.count({ where: { username: "_system_" } })).toBe(1);
  });

  it("откаченная транзакция не оставляет ложной отметки «пользователь есть»", async () => {
    await expect(
      prisma.$transaction(async (tx: any) => {
        await policy.ensureSystemAuditUser(tx);
        // Второй вызов в той же транзакции видит свою же незакоммиченную строку.
        await policy.ensureSystemAuditUser(tx);
        throw new Error("откат");
      }),
    ).rejects.toThrow("откат");
    expect(await prisma.adminUser.findUnique({ where: { id: "_system_" } })).toBeNull();

    // Следующая запись аудита всё равно проходит: пользователь создаётся заново.
    const booking = await makeBooking("CONFIRMED");
    await makeSession(booking.id, "ISSUE");
    await prisma.$transaction((tx: any) =>
      policy.closeActiveScanSessions(tx, booking.id, { reason: "STALE" }),
    );
    const audits = await cancelAudits(booking.id);
    expect(audits).toHaveLength(1);
    expect(audits[0].userId).toBe("_system_");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// closeActiveScanSessions
// ─────────────────────────────────────────────────────────────────────────────

describe("closeActiveScanSessions — закрыть сессии брони", () => {
  it("закрывает все ACTIVE-сессии брони, не трогая завершённые и чужие; аудит на каждую", async () => {
    const booking = await makeBooking("CONFIRMED");
    const other = await makeBooking("CONFIRMED");
    const issue = await makeSession(booking.id, "ISSUE");
    const ret = await makeSession(booking.id, "RETURN");
    const done = await makeSession(booking.id, "ISSUE", { status: "COMPLETED", completedAt: new Date() });
    const foreign = await makeSession(other.id, "ISSUE");

    const closed = await prisma.$transaction((tx: any) =>
      policy.closeActiveScanSessions(tx, booking.id, { reason: "BOOKING_ISSUED_MANUALLY", actorUserId: saId }),
    );
    expect(closed.map((s: any) => s.id).sort()).toEqual([issue.id, ret.id].sort());
    expect(closed.find((s: any) => s.id === ret.id)?.operation).toBe("RETURN");

    for (const id of [issue.id, ret.id]) {
      const s = await prisma.scanSession.findUnique({ where: { id } });
      expect(s.status).toBe("CANCELLED");
      expect(s.cancelReason).toBe("BOOKING_ISSUED_MANUALLY");
      expect(s.cancelledAt).toBeInstanceOf(Date);
      expect(s.cancelledBy).toBe("policy_sa");
    }
    expect((await prisma.scanSession.findUnique({ where: { id: done.id } })).status).toBe("COMPLETED");
    expect((await prisma.scanSession.findUnique({ where: { id: foreign.id } })).status).toBe("ACTIVE");

    const audits = await cancelAudits(booking.id);
    expect(audits).toHaveLength(2);
    expect(audits.every((a: any) => a.userId === saId)).toBe(true);
    const after = JSON.parse(audits.find((a: any) => JSON.parse(a.after).sessionId === issue.id).after);
    expect(after).toMatchObject({
      sessionId: issue.id,
      operation: "ISSUE",
      reason: "BOOKING_ISSUED_MANUALLY",
      startedBy: "Иван Кладовщик",
      cancelledBy: "policy_sa",
    });
    expect(after.workerName).toBeUndefined();

    // Повтор — ничего не закрывает и аудит не дублирует.
    const again = await prisma.$transaction((tx: any) =>
      policy.closeActiveScanSessions(tx, booking.id, { reason: "BOOKING_ISSUED_MANUALLY", actorUserId: saId }),
    );
    expect(again).toEqual([]);
    expect(await cancelAudits(booking.id)).toHaveLength(2);
  });

  it("onlyIds закрывает только перечисленные сессии", async () => {
    const booking = await makeBooking("CONFIRMED");
    const a = await makeSession(booking.id, "ISSUE");
    const b = await makeSession(booking.id, "RETURN");
    const closed = await prisma.$transaction((tx: any) =>
      policy.closeActiveScanSessions(tx, booking.id, { reason: "KIOSK_ABORT", onlyIds: [a.id] }),
    );
    expect(closed).toEqual([{ id: a.id, operation: "ISSUE" }]);
    expect((await prisma.scanSession.findUnique({ where: { id: b.id } })).status).toBe("ACTIVE");
    const none = await prisma.$transaction((tx: any) =>
      policy.closeActiveScanSessions(tx, booking.id, { reason: "KIOSK_ABORT", onlyIds: [] }),
    );
    expect(none).toEqual([]);
  });

  it("кладовщик по PIN: автор аудита `_system_`, имя кладовщика — в записи", async () => {
    const booking = await makeBooking("CONFIRMED");
    await makeSession(booking.id, "ISSUE");
    await prisma.$transaction((tx: any) =>
      policy.closeActiveScanSessions(tx, booking.id, { reason: "KIOSK_ABORT", actorName: "Пётр Склад" }),
    );
    const [audit] = await cancelAudits(booking.id);
    expect(audit.userId).toBe("_system_");
    expect(JSON.parse(audit.after)).toMatchObject({ workerName: "Пётр Склад", cancelledBy: "Пётр Склад", reason: "KIOSK_ABORT" });
    const session = await prisma.scanSession.findFirst({ where: { bookingId: booking.id } });
    expect(session.cancelledBy).toBe("Пётр Склад");
  });

  it("автор, которого нет среди пользователей (канал бота), не роняет транзакцию", async () => {
    const booking = await makeBooking("CONFIRMED");
    await makeSession(booking.id, "ISSUE");
    const closed = await prisma.$transaction((tx: any) =>
      policy.closeActiveScanSessions(tx, booking.id, { reason: "BOOKING_CANCELLED", actorUserId: "system" }),
    );
    expect(closed).toHaveLength(1);
    const [audit] = await cancelAudits(booking.id);
    expect(audit.userId).toBe("_system_");
  });

  it("закрытие и аудит откатываются вместе с транзакцией", async () => {
    const booking = await makeBooking("CONFIRMED");
    const s = await makeSession(booking.id, "ISSUE");
    await expect(
      prisma.$transaction(async (tx: any) => {
        await policy.closeActiveScanSessions(tx, booking.id, { reason: "BOOKING_CANCELLED", actorUserId: saId });
        throw new Error("откат");
      }),
    ).rejects.toThrow("откат");
    expect((await prisma.scanSession.findUnique({ where: { id: s.id } })).status).toBe("ACTIVE");
    expect(await cancelAudits(booking.id)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// findBlockingScanSession
// ─────────────────────────────────────────────────────────────────────────────

describe("findBlockingScanSession — блокирует только живая сессия с работой", () => {
  it("«открыл и посмотрел» не блокирует", async () => {
    const booking = await makeBooking("CONFIRMED");
    await makeSession(booking.id, "ISSUE");
    expect(await policy.findBlockingScanSession(prisma, booking.id)).toBeNull();
  });

  it("живая сессия с черновиком блокирует и сообщает о черновике", async () => {
    const booking = await makeBooking("CONFIRMED");
    const s = await makeSession(booking.id, "ISSUE", { draftJson: JSON.stringify({ v: 1 }) });
    const found = await policy.findBlockingScanSession(prisma, booking.id);
    expect(found).toEqual({
      id: s.id,
      operation: "ISSUE",
      workerName: "Иван Кладовщик",
      startedAt: s.startedAt,
      hasDraft: true,
    });
  });

  it("добор этой сессии — тоже работа", async () => {
    const booking = await makeBooking("CONFIRMED");
    const s = await makeSession(booking.id, "ISSUE");
    await prisma.addonRecord.create({
      data: { bookingId: booking.id, sessionId: s.id, bookingItemId: booking.items[0].id, equipmentId, quantity: 1, createdBy: "Иван" },
    });
    expect(await policy.findBlockingScanSession(prisma, booking.id)).toMatchObject({ id: s.id, hasDraft: false });
  });

  it("скан в приёмке выданной брони блокирует", async () => {
    const booking = await makeBooking("ISSUED");
    const s = await makeSession(booking.id, "RETURN");
    const unit = await prisma.equipmentUnit.create({
      data: { equipmentId, barcode: `LR-POL-${++unitSeq}`, status: "ISSUED" },
    });
    await prisma.scanRecord.create({ data: { sessionId: s.id, equipmentUnitId: unit.id } });
    expect(await policy.findBlockingScanSession(prisma, booking.id)).toMatchObject({ id: s.id, operation: "RETURN" });
  });

  it("устаревшая сессия с черновиком ничего не блокирует (выдача на уже принятой брони)", async () => {
    const booking = await makeBooking("RETURNED");
    await makeSession(booking.id, "ISSUE", { draftJson: "{}" });
    await makeSession(booking.id, "RETURN", { draftJson: "{}" });
    expect(await policy.findBlockingScanSession(prisma, booking.id)).toBeNull();
  });

  it("выдача в архивной брони не блокирует; несуществующая бронь — null", async () => {
    const booking = await makeBooking("CONFIRMED", { deletedAt: new Date() });
    await makeSession(booking.id, "ISSUE", { draftJson: "{}" });
    expect(await policy.findBlockingScanSession(prisma, booking.id)).toBeNull();
    expect(await policy.findBlockingScanSession(prisma, "нет-такой-брони")).toBeNull();
  });

  it("завершённая и прерванная сессии не блокируют", async () => {
    const booking = await makeBooking("CONFIRMED");
    await makeSession(booking.id, "ISSUE", { status: "COMPLETED", draftJson: "{}" });
    await makeSession(booking.id, "ISSUE", { status: "CANCELLED", draftJson: "{}" });
    expect(await policy.findBlockingScanSession(prisma, booking.id)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// assertSessionWritable
// ─────────────────────────────────────────────────────────────────────────────

describe("assertSessionWritable — можно ли писать в сессию", () => {
  it("нет сессии → 404 SESSION_NOT_FOUND", async () => {
    const err = await expectHttpError(policy.assertSessionWritable(prisma, "нет-такой"), 404, "SESSION_NOT_FOUND");
    expect(err.message).toBe("Сессия склада не найдена");
  });

  it("живая сессия → сессия и бронь", async () => {
    const booking = await makeBooking("CONFIRMED");
    const s = await makeSession(booking.id, "ISSUE");
    const { session, booking: b } = await policy.assertSessionWritable(prisma, s.id);
    expect(session.id).toBe(s.id);
    expect(session.status).toBe("ACTIVE");
    expect(b.id).toBe(booking.id);
    expect(b.status).toBe("CONFIRMED");
    expect((session as any).booking).toBeUndefined();
  });

  it("завершённая → 409 SESSION_ALREADY_COMPLETED с автором и временем", async () => {
    const booking = await makeBooking("ISSUED");
    const completedAt = new Date(Date.now() - HOUR);
    const s = await makeSession(booking.id, "ISSUE", {
      status: "COMPLETED",
      completedAt,
      completedBy: "Пётр Склад",
    });
    const err = await expectHttpError(policy.assertSessionWritable(prisma, s.id), 409, "SESSION_ALREADY_COMPLETED");
    expect(err.message).toBe("Выдача по этой брони уже оформлена");
    expect(err.details).toEqual({
      sessionId: s.id,
      operation: "ISSUE",
      completedAt: completedAt.toISOString(),
      completedBy: "Пётр Склад",
    });

    const ret = await makeSession(booking.id, "RETURN", { status: "COMPLETED", completedAt });
    const err2 = await expectHttpError(policy.assertSessionWritable(prisma, ret.id), 409, "SESSION_ALREADY_COMPLETED");
    expect(err2.message).toBe("Приёмка по этой брони уже завершена");
    // Старые сессии без completedBy: автор — тот, кто открыл.
    expect(err2.details.completedBy).toBe("Иван Кладовщик");
  });

  it("прерванная → 409 SESSION_CANCELLED с причиной", async () => {
    const booking = await makeBooking("CONFIRMED");
    const cancelledAt = new Date(Date.now() - HOUR);
    const s = await makeSession(booking.id, "ISSUE", {
      status: "CANCELLED",
      cancelledAt,
      cancelReason: "CARD_ABORT",
      cancelledBy: "policy_sa",
    });
    const err = await expectHttpError(policy.assertSessionWritable(prisma, s.id), 409, "SESSION_CANCELLED");
    expect(err.message).toBe("Сессию склада прервали — откройте бронь заново");
    expect(err.details).toEqual({
      sessionId: s.id,
      operation: "ISSUE",
      cancelReason: "CARD_ABORT",
      cancelledAt: cancelledAt.toISOString(),
      cancelledBy: "policy_sa",
    });
  });

  it("устаревшая вне транзакции → 409 SESSION_STALE, сессия закрыта с причиной STALE и аудитом", async () => {
    const booking = await makeBooking("RETURNED");
    const s = await makeSession(booking.id, "ISSUE", { draftJson: "{}" });
    const err = await expectHttpError(policy.assertSessionWritable(prisma, s.id), 409, "SESSION_STALE");
    expect(err.message).toBe("Бронь уже принята на карточке — чек-лист закрыт, изменения из него не применены");
    expect(err.details).toEqual({ sessionId: s.id, operation: "ISSUE", bookingStatus: "RETURNED" });

    const after = await prisma.scanSession.findUnique({ where: { id: s.id } });
    expect(after.status).toBe("CANCELLED");
    expect(after.cancelReason).toBe("STALE");
    expect(after.cancelledBy).toBeNull();
    // Бронь не тронута.
    expect((await prisma.booking.findUnique({ where: { id: booking.id } })).status).toBe("RETURNED");
    const audits = await cancelAudits(booking.id);
    expect(audits).toHaveLength(1);
    expect(audits[0].userId).toBe("_system_");
    expect(JSON.parse(audits[0].after)).toMatchObject({ sessionId: s.id, reason: "STALE" });

    // Повтор — уже «прервана», а не «устарела».
    await expectHttpError(policy.assertSessionWritable(prisma, s.id), 409, "SESSION_CANCELLED");
  });

  it("устаревшая в транзакции только бросает — закрывает вызывающий", async () => {
    const booking = await makeBooking("ISSUED");
    const s = await makeSession(booking.id, "ISSUE");
    await expectHttpError(
      prisma.$transaction((tx: any) => policy.assertSessionWritable(tx, s.id, { inTx: true })),
      409,
      "SESSION_STALE",
    );
    expect((await prisma.scanSession.findUnique({ where: { id: s.id } })).status).toBe("ACTIVE");
    expect(await cancelAudits(booking.id)).toHaveLength(0);
  });

  it("транзакционный клиент распознаётся и без явного inTx", async () => {
    const booking = await makeBooking("CANCELLED");
    const s = await makeSession(booking.id, "ISSUE");
    const err = await expectHttpError(
      prisma.$transaction((tx: any) => policy.assertSessionWritable(tx, s.id)),
      409,
      "SESSION_STALE",
    );
    expect(err.message).toMatch(/^Бронь отменена/);
    expect((await prisma.scanSession.findUnique({ where: { id: s.id } })).status).toBe("ACTIVE");
  });

  it("выдача в архивной брони — устаревшая", async () => {
    const booking = await makeBooking("CONFIRMED", { deletedAt: new Date() });
    const s = await makeSession(booking.id, "ISSUE");
    const err = await expectHttpError(policy.assertSessionWritable(prisma, s.id), 409, "SESSION_STALE");
    expect(err.message).toMatch(/^Бронь в архиве/);
  });
});
