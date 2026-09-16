/**
 * Сторож публичной поверхности API.
 *
 * Next-прокси (`apps/web/app/api/[...path]/route.ts`) подставляет `X-API-Key`
 * каждому запросу, поэтому валидный ключ НЕ означает «пришёл свой». Единственное,
 * что отличает анонимного посетителя из интернета от сотрудника, — сессия.
 * Отсюда правило: маршрут без `rolesGuard` (или иного требования сессии)
 * публичен по факту, чем бы ни было записано в матрице прав.
 *
 * Тест обходит ВСЮ таблицу маршрутов Express и требует 401 без сессии от каждого,
 * кроме явного `PUBLIC_SURFACE`. Он ловит не конкретную дыру, а следующую:
 * новый роут, смонтированный голым, роняет этот тест в тот же день.
 *
 * Добавление строки в `PUBLIC_SURFACE` — осознанное действие, видимое в diff.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-anon-surface.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-anon-surface";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-anon-surface-xxxxxxxx";
process.env.WAREHOUSE_SECRET = "test-warehouse-anon-surface-xxxxx";
process.env.JWT_SECRET = "test-jwt-anon-surface-min16chars";
process.env.CLIENT_PORTAL_SESSION_SECRET = "test-lk-session-anon-surface-xxx";
process.env.CLIENT_PORTAL_TOKEN_SECRET = "test-lk-token-anon-surface-xxxxx";
process.env.VISION_PROVIDER = "mock";

const API_KEY = "test-key-anon-surface";

/**
 * Маршруты, которые обязаны работать БЕЗ сессии, и почему.
 * Ключ — `METHOD path` ровно в том виде, в каком путь зарегистрирован в Express.
 */
const PUBLIC_SURFACE: Record<string, string> = {
  "GET /health": "health-check; смонтирован до apiKeyAuth",
  "POST /api/auth/login": "форма входа — сессии ещё нет по определению",
  "POST /api/auth/logout": "гасит cookie; без сессии это no-op",
  "GET /api/auth/me": "вызывается до входа, чтобы узнать, есть ли сессия",
  "POST /api/lk/auth/request-login":
    "клиентский портал: magic-link по почте, без энумерации, свой rate-limit",
  "POST /api/lk/auth/verify": "клиентский портал: обмен magic-link на сессию",
  "POST /api/lk/auth/password-login": "клиентский портал: вход по паролю",
  "POST /api/lk/auth/logout": "клиентский портал: гасит cookie",
  "POST /api/warehouse/auth": "вход киоска по PIN; свой per-worker lockout",
  "GET /api/warehouse/workers/names":
    "список имён на экране входа киоска; имя по смыслу не секрет, секрет — PIN",
};

type RouteRow = { method: string; path: string };

/**
 * Собирает (method, path) по стеку Express, разворачивая вложенные роутеры.
 * Путь монтирования восстанавливается из `layer.regexp.source` — публичного API
 * для этого у Express 4 нет, поэтому форму регулярки проверяем явной ассертой
 * ниже (маршрутов должно набраться заметно больше сотни).
 */
function collectRoutes(stack: any[], prefix: string, out: RouteRow[]): void {
  for (const layer of stack) {
    if (layer.route) {
      const routePath = layer.route.path === "/" ? "" : layer.route.path;
      const full = prefix + routePath;
      for (const method of Object.keys(layer.route.methods)) {
        if (layer.route.methods[method]) {
          out.push({ method: method.toUpperCase(), path: full || "/" });
        }
      }
      continue;
    }
    if (layer.name === "router" && layer.handle?.stack) {
      collectRoutes(layer.handle.stack, prefix + mountPath(layer), out);
    }
  }
}

/** `^\/api\/equipment(?:\/([^/]+?))\/units\/?(?=\/|$)` → `/api/equipment/:equipmentId/units` */
function mountPath(layer: any): string {
  const source: string = layer.regexp?.source ?? "";
  // Роутер, смонтированный без пути (app.use(router)) — вклада в префикс не даёт.
  if (source === "^\\/?(?=\\/|$)") return "";
  let seg = source
    .replace(/^\^\\\//, "/")
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, "")
    .replace(/\\\//g, "/")
    .replace(/\(\?:\/\(\[\^\/\]\+\?\)\)/g, "/:param");
  const names: string[] = (layer.keys ?? []).map((k: any) => String(k.name));
  let i = 0;
  seg = seg.replace(/:param/g, () => `:${names[i++] ?? "param"}`);
  return seg;
}

/** Подставляет конкретные значения вместо `:param`, чтобы запрос дошёл до хендлера. */
function concreteUrl(routePath: string): string {
  return routePath.replace(/:[A-Za-z0-9_]+/g, "anon-probe-id");
}

let app: Express;
let prisma: any;
let routes: RouteRow[];

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

  app = (await import("../app")).app;
  prisma = (await import("../prisma")).prisma;

  routes = [];
  collectRoutes((app as any)._router.stack, "", routes);
});

afterAll(async () => {
  await prisma.$disconnect();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* игнор */
      }
    }
  }
});

describe("публичная поверхность API", () => {
  it("обход таблицы маршрутов находит все зарегистрированные роуты", () => {
    // Если разбор `layer.regexp` сломается после апгрейда Express, сборщик
    // тихо вернёт огрызок — и весь тест превратится в зелёный no-op.
    expect(routes.length).toBeGreaterThan(150);
    expect(routes.some((r) => r.method === "GET" && r.path === "/api/equipment")).toBe(true);
    expect(
      routes.some((r) => r.method === "GET" && r.path === "/api/equipment/:equipmentId/units"),
    ).toBe(true);
  });

  it("ни один маршрут вне PUBLIC_SURFACE не отвечает без сессии", async () => {
    const leaked: string[] = [];

    for (const route of routes) {
      const key = `${route.method} ${route.path}`;
      if (key in PUBLIC_SURFACE) continue;

      const res = await (request(app) as any)
        [route.method.toLowerCase()](concreteUrl(route.path))
        .set("X-API-Key", API_KEY)
        .send({});

      if (res.status !== 401) {
        leaked.push(`${key} → ${res.status} ${res.body?.code ?? ""}`.trim());
      }
    }

    expect(
      leaked,
      `Маршруты отвечают анонимному запросу (валидный X-API-Key без сессии).\n` +
        `Прокси подставляет ключ любому запросу из интернета, поэтому это публичный доступ.\n` +
        `Добавьте rolesGuard — либо, если маршрут публичен намеренно, внесите его в PUBLIC_SURFACE:\n  ` +
        leaked.join("\n  "),
    ).toEqual([]);
  }, 120_000);

  it("каждая запись PUBLIC_SURFACE соответствует живому маршруту", () => {
    const registered = new Set(routes.map((r) => `${r.method} ${r.path}`));
    const stale = Object.keys(PUBLIC_SURFACE).filter((key) => !registered.has(key));

    expect(
      stale,
      `PUBLIC_SURFACE протух: перечисленных маршрутов больше нет. Удалите строки:\n  ` +
        stale.join("\n  "),
    ).toEqual([]);
  });
});
