import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { botScopeGuard } from "../../middleware/botScopeGuard";

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(botScopeGuard);

  // Тестовые роуты для проверки прохождения middleware
  app.get("/api/bookings", (_req, res) => res.json({ ok: true }));
  app.get("/api/bookings/:id", (_req, res) => res.json({ ok: true }));
  app.post("/api/bookings/draft", (_req, res) => res.json({ ok: true }));
  app.post("/api/bookings/:id/confirm", (_req, res) => res.json({ ok: true }));
  app.get("/api/finance/debts", (_req, res) => res.json({ ok: true }));
  app.post("/api/users", (_req, res) => res.json({ ok: true }));
  app.delete("/api/bookings/:id", (_req, res) => res.json({ ok: true }));
  app.post("/api/warehouse/auth", (_req, res) => res.json({ ok: true }));
  app.get("/api/test", (_req, res) => res.json({ ok: true }));

  return app;
}

describe("botScopeGuard", () => {
  let app: express.Express;

  beforeEach(() => {
    app = buildApp();
  });

  // ── Ключ отсутствует — пропускаем ─────────────────────────────────────────

  it("пропускает запрос без API-ключа", async () => {
    const res = await request(app).get("/api/test");
    expect(res.status).toBe(200);
  });

  // ── Web-ключ (не openclaw-) — пропускаем ──────────────────────────────────

  it("пропускает запрос с web-admin- ключом", async () => {
    const res = await request(app)
      .get("/api/test")
      .set("X-API-Key", "web-admin-xxxyyy");
    expect(res.status).toBe(200);
  });

  it("пропускает запрос с обычным ключом", async () => {
    const res = await request(app)
      .delete("/api/bookings/some-id")
      .set("X-API-Key", "regular-key-12345");
    // Не бот-ключ → botScopeGuard пропускает, роут отвечает 200
    expect(res.status).toBe(200);
  });

  // ── openclaw-ключ + DELETE → 403 ──────────────────────────────────────────

  it("отклоняет DELETE /api/bookings/:id с openclaw-ключом → 403", async () => {
    const res = await request(app)
      .delete("/api/bookings/some-id")
      .set("X-API-Key", "openclaw-test-key-abc123");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("BOT_SCOPE_FORBIDDEN");
    expect(res.body.message).toMatch(/not allowed to delete/i);
  });

  // ── openclaw-ключ + разрешённый роут → пропускаем ──────────────────────────

  it("пропускает GET /api/bookings с openclaw-ключом", async () => {
    const res = await request(app)
      .get("/api/bookings")
      .set("X-API-Key", "openclaw-test-key-abc123");
    expect(res.status).toBe(200);
  });

  it("пропускает POST /api/bookings/draft с openclaw-ключом", async () => {
    const res = await request(app)
      .post("/api/bookings/draft")
      .set("X-API-Key", "openclaw-test-key-abc123")
      .send({});
    expect(res.status).toBe(200);
  });

  it("пропускает GET /api/finance/debts с openclaw-ключом", async () => {
    const res = await request(app)
      .get("/api/finance/debts")
      .set("X-API-Key", "openclaw-test-key-abc123");
    expect(res.status).toBe(200);
  });

  it("пропускает POST /api/bookings/:id/confirm с openclaw-ключом", async () => {
    const res = await request(app)
      .post("/api/bookings/booking-id-123/confirm")
      .set("X-API-Key", "openclaw-test-key-abc123")
      .send({});
    expect(res.status).toBe(200);
  });

  // ── openclaw-ключ + запрещённый роут → 403 ─────────────────────────────────

  it("отклоняет POST /api/users с openclaw-ключом → 403", async () => {
    const res = await request(app)
      .post("/api/users")
      .set("X-API-Key", "openclaw-test-key-abc123")
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("BOT_SCOPE_FORBIDDEN");
    expect(res.body.message).toMatch(/does not have access/i);
  });

  it("отклоняет POST /api/warehouse/auth с openclaw-ключом → 403", async () => {
    const res = await request(app)
      .post("/api/warehouse/auth")
      .set("X-API-Key", "openclaw-test-key-abc123")
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("BOT_SCOPE_FORBIDDEN");
  });

  // ── Ключ с похожим, но неправильным префиксом — пропускаем ────────────────

  it("пропускает ключ с префиксом openclow- (опечатка) как обычный ключ", async () => {
    const res = await request(app)
      .delete("/api/bookings/some-id")
      .set("X-API-Key", "openclow-typo-key");
    // Не является openclaw- → пропускается
    expect(res.status).toBe(200);
  });

  // ── Bearer token формат ───────────────────────────────────────────────────

  it("применяет ограничения к openclaw-ключу в Authorization: Bearer заголовке", async () => {
    const res = await request(app)
      .delete("/api/bookings/some-id")
      .set("Authorization", "Bearer openclaw-test-key-abc123");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("BOT_SCOPE_FORBIDDEN");
  });
});
