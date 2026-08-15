/**
 * Тесты лимитера.
 *
 * ВАЖНО: файл НЕ трогает `process.env.RATE_LIMIT_DISABLED`. Раньше он его
 * глобально удалял, чтобы включить лимитер себе, — и пока крутились сотни
 * запросов, соседние тест-файлы в тех же воркерах vitest внезапно оказывались
 * под живым лимитером и ловили 429/таймауты. Это давало плавающие падения по
 * всему набору (до 5 упавших тестов в разных файлах от прогона к прогону).
 * Теперь режим задаётся явно через `createRateLimiter({ disabled })`,
 * счётчик у каждого инстанса свой, глобального состояния нет.
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";

import { createRateLimiter } from "./rateLimiter";

describe("rateLimiter", () => {
  it("passes requests when disabled", async () => {
    const app = express();
    app.use(createRateLimiter({ disabled: true }));
    app.get("/test", (_req, res) => res.json({ ok: true }));

    // Should pass even if called many times
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get("/test");
      expect(res.status).toBe(200);
    }
  });

  it("читает RATE_LIMIT_DISABLED из окружения, когда режим не задан явно", async () => {
    // Значение выставляет src/__tests__/setup.ts — проверяем сам контракт
    // «не передали disabled → смотрим в env», не мутируя окружение.
    expect(process.env.RATE_LIMIT_DISABLED).toBe("true");

    const app = express();
    app.use(createRateLimiter());
    app.get("/test", (_req, res) => res.json({ ok: true }));

    for (let i = 0; i < 5; i++) {
      expect((await request(app).get("/test")).status).toBe(200);
    }
  });

  it("returns 429 with Russian message after limit exceeded", async () => {
    const app = express();
    // max=3 вместо продовых 300: проверяем поведение на границе, а не выносливость
    app.use(createRateLimiter({ disabled: false, max: 3 }));
    app.get("/test", (_req, res) => res.json({ ok: true }));

    let lastStatus = 200;
    let rateLimitedRes: { status: number; body: { message?: string; code?: string } } | null = null;
    for (let i = 0; i < 4; i++) {
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
    app.use(createRateLimiter({ disabled: false, max: 3 }));
    app.get("/test", (_req, res) => res.json({ ok: true }));

    // Первая сессия выбирает лимит целиком…
    let firstLimited = false;
    for (let i = 0; i < 4; i++) {
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
    const app = express();
    app.use(createRateLimiter({ disabled: false, max: 3 }));
    app.get("/health", (_req, res) => res.json({ ok: true }));

    // Вдвое больше лимита — /health обязан остаться 200 на каждом запросе.
    for (let i = 0; i < 8; i++) {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
    }
  });

  it("IPv6-клиенты не обходят лимит сменой адреса внутри /56", async () => {
    // Регрессия ERR_ERL_KEY_GEN_IPV6: без ipKeyGenerator каждый адрес префикса
    // получал свой бакет, и лимит обходился тривиально.
    const app = express();
    app.set("trust proxy", true);
    app.use(createRateLimiter({ disabled: false, max: 3 }));
    app.get("/test", (_req, res) => res.json({ ok: true }));

    let limited = false;
    for (let i = 0; i < 6 && !limited; i++) {
      // Каждый запрос — с НОВОГО адреса, но одной и той же /56-подсети.
      const ip = `2001:db8:1111:2200::${(i + 1).toString(16)}`;
      const res = await request(app).get("/test").set("X-Forwarded-For", ip);
      if (res.status === 429) limited = true;
    }
    expect(limited).toBe(true);
  });

  it("разные /56-подсети IPv6 не делят бакет", async () => {
    const app = express();
    app.set("trust proxy", true);
    app.use(createRateLimiter({ disabled: false, max: 2 }));
    app.get("/test", (_req, res) => res.json({ ok: true }));

    // Выбираем лимит одной подсетью…
    for (let i = 0; i < 3; i++) {
      await request(app).get("/test").set("X-Forwarded-For", `2001:db8:aaaa:1100::${i + 1}`);
    }
    // …соседняя подсеть должна остаться незатронутой.
    const other = await request(app).get("/test").set("X-Forwarded-For", "2001:db8:bbbb:2200::1");
    expect(other.status).toBe(200);
  });
});
