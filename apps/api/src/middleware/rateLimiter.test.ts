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

    // Make 101 requests to exceed the 100 req/min limit
    let lastStatus = 200;
    let rateLimitedRes: { status: number; body: { message?: string; code?: string } } | null = null;
    for (let i = 0; i < 101; i++) {
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
});
