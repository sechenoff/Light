import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";

type App = express.Express;

async function buildApp(env: Record<string, string | undefined>): Promise<App> {
  // Apply env before importing module
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  vi.resetModules();
  const { apiKeyAuth } = await import("./apiKeyAuth");
  const app = express();
  app.use(apiKeyAuth);
  app.get("/test", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("apiKeyAuth", () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    originalEnv.API_KEYS = process.env.API_KEYS;
    originalEnv.AUTH_MODE = process.env.AUTH_MODE;
  });

  afterEach(() => {
    process.env.API_KEYS = originalEnv.API_KEYS;
    process.env.AUTH_MODE = originalEnv.AUTH_MODE;
    vi.resetModules();
  });

  describe("enforce mode with valid API key", () => {
    it("allows request with valid X-API-Key header", async () => {
      const app = await buildApp({ API_KEYS: "secret123", AUTH_MODE: "enforce" });
      const res = await request(app).get("/test").set("X-API-Key", "secret123");
      expect(res.status).toBe(200);
    });

    it("allows request with valid Authorization: Bearer header", async () => {
      const app = await buildApp({ API_KEYS: "secret123", AUTH_MODE: "enforce" });
      const res = await request(app).get("/test").set("Authorization", "Bearer secret123");
      expect(res.status).toBe(200);
    });

    it("allows request when key matches one of multiple API_KEYS", async () => {
      const app = await buildApp({ API_KEYS: "key1,key2,key3", AUTH_MODE: "enforce" });
      const res = await request(app).get("/test").set("X-API-Key", "key2");
      expect(res.status).toBe(200);
    });
  });

  describe("enforce mode with invalid/missing key", () => {
    it("returns 401 with Russian message when key is missing", async () => {
      const app = await buildApp({ API_KEYS: "secret123", AUTH_MODE: "enforce" });
      const res = await request(app).get("/test");
      expect(res.status).toBe(401);
      expect(res.body.message).toBe("Неверный или отсутствующий API-ключ");
      expect(res.body.code).toBe("UNAUTHORIZED");
    });

    it("returns 401 when key is wrong in enforce mode", async () => {
      const app = await buildApp({ API_KEYS: "secret123", AUTH_MODE: "enforce" });
      const res = await request(app).get("/test").set("X-API-Key", "wrongkey");
      expect(res.status).toBe(401);
    });
  });

  describe("warn mode (default)", () => {
    it("passes request through even with no key in warn mode", async () => {
      const app = await buildApp({ API_KEYS: "secret123", AUTH_MODE: "warn" });
      const res = await request(app).get("/test");
      expect(res.status).toBe(200);
    });

    it("passes request through with wrong key in warn mode", async () => {
      const app = await buildApp({ API_KEYS: "secret123", AUTH_MODE: "warn" });
      const res = await request(app).get("/test").set("X-API-Key", "wrongkey");
      expect(res.status).toBe(200);
    });

    it("defaults to warn mode when AUTH_MODE is not set", async () => {
      const app = await buildApp({ API_KEYS: "secret123", AUTH_MODE: undefined });
      const res = await request(app).get("/test");
      expect(res.status).toBe(200);
    });
  });

  describe("empty API_KEYS", () => {
    it("passes all requests in warn mode when API_KEYS is empty", async () => {
      const app = await buildApp({ API_KEYS: undefined, AUTH_MODE: "warn" });
      const res = await request(app).get("/test");
      expect(res.status).toBe(200);
    });

    it("rejects all requests in enforce mode when API_KEYS is empty", async () => {
      const app = await buildApp({ API_KEYS: undefined, AUTH_MODE: "enforce" });
      const res = await request(app).get("/test");
      expect(res.status).toBe(401);
    });
  });

  describe("timing-safe comparison", () => {
    it("does not allow key that is a prefix of valid key", async () => {
      const app = await buildApp({ API_KEYS: "secret123", AUTH_MODE: "enforce" });
      const res = await request(app).get("/test").set("X-API-Key", "secret");
      expect(res.status).toBe(401);
    });

    it("does not allow key that has valid key as prefix", async () => {
      const app = await buildApp({ API_KEYS: "secret123", AUTH_MODE: "enforce" });
      const res = await request(app).get("/test").set("X-API-Key", "secret123extra");
      expect(res.status).toBe(401);
    });
  });
});
