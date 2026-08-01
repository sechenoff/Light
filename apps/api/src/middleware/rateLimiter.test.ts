import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";

describe("rateLimiter", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.RATE_LIMIT_DISABLED;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.RATE_LIMIT_DISABLED;
    } else {
      process.env.RATE_LIMIT_DISABLED = savedEnv;
    }
    vi.resetModules();
  });

  it("passes requests when RATE_LIMIT_DISABLED=true", async () => {
    process.env.RATE_LIMIT_DISABLED = "true";
    const { rateLimiter } = await import("./rateLimiter");

    const app = express();
    app.use(rateLimiter);
    app.get("/test", (_req, res) => res.json({ ok: true }));

    // Should pass even if called many times
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get("/test");
      expect(res.status).toBe(200);
    }
  });

  it("returns 429 with Russian message after limit exceeded", async () => {
    delete process.env.RATE_LIMIT_DISABLED;
    const { rateLimiter } = await import("./rateLimiter");

    const app = express();
    app.use(rateLimiter);
    app.get("/test", (_req, res) => res.json({ ok: true }));

    // Лимит теперь 300/мин на ключ (перф-аудит 2026-08-02) — превышаем его.
    let lastStatus = 200;
    let rateLimitedRes: { status: number; body: { message?: string; code?: string } } | null = null;
    for (let i = 0; i < 301; i++) {
      const res = await request(app).get("/test");
      lastStatus = res.status;
      if (res.status === 429) {
        rateLimitedRes = res;
        break;
      }
    }

    expect(lastStatus).toBe(429);
    expect(rateLimitedRes?.body.message).toBe("Слишком много запросов, попробуйте позже");
    expect(rateLimitedRes?.body.code).toBe("RATE_LIMITED");
  });

  it("разные сессии получают раздельные бакеты (не делят общий IP-лимит)", async () => {
    delete process.env.RATE_LIMIT_DISABLED;
    const { rateLimiter } = await import("./rateLimiter");

    const app = express();
    // cookieParser в проде стоит до limiter — эмулируем разобранные cookie.
    app.use((req, _res, next) => {
      const raw = req.headers.cookie ?? "";
      const m = /lr_session=([^;]+)/.exec(raw);
      (req as unknown as { cookies: Record<string, string> }).cookies = m
        ? { lr_session: m[1] }
        : {};
      next();
    });
    app.use(rateLimiter);
    app.get("/test", (_req, res) => res.json({ ok: true }));

    // Первая сессия выбирает лимит целиком…
    let firstLimited = false;
    for (let i = 0; i < 301; i++) {
      const res = await request(app).get("/test").set("Cookie", "lr_session=user-one");
      if (res.status === 429) {
        firstLimited = true;
        break;
      }
    }
    expect(firstLimited).toBe(true);

    // …а вторая сессия с того же «IP» работает как ни в чём не бывало.
    const other = await request(app).get("/test").set("Cookie", "lr_session=user-two");
    expect(other.status).toBe(200);
  });

  it("health не тратит бюджет лимитера", async () => {
    delete process.env.RATE_LIMIT_DISABLED;
    const { rateLimiter } = await import("./rateLimiter");

    const app = express();
    app.use(rateLimiter);
    app.get("/health", (_req, res) => res.json({ ok: true }));

    for (let i = 0; i < 350; i++) {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
    }
  });
});
