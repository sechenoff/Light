/**
 * Интеграция гарда с самим прокси: проверяем, что решение не только считается,
 * но и применяется — анонимный запрос не уходит на бэкенд и не получает ключ.
 *
 * Чистые правила разбираются в proxyAuthGate.test.ts; здесь важна проводка.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

import { GET, POST } from "../../../app/api/[...path]/route";

const UPSTREAM = "http://127.0.0.1:4000";

function makeRequest(
  path: string,
  init: { method?: string; cookie?: string; authorization?: string } = {},
): NextRequest {
  const headers = new Headers();
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.authorization) headers.set("authorization", init.authorization);
  return new NextRequest(`http://localhost:3000${path}`, {
    method: init.method ?? "GET",
    headers,
  });
}

/**
 * Сегменты пути в том виде, в каком их отдаёт Next: он декодирует каждый
 * сегмент ОДИН раз. Именно поэтому `%252e%252e` приезжает в роут как литерал
 * `%2e%2e`, а не как `..` — на этом и держался обход из описания ниже.
 * Модель должна повторять это декодирование, иначе тест проверяет не то.
 */
function ctx(path: string) {
  const segments = path
    .replace(/^\/api\//, "")
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  return { params: { path: segments } };
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.API_PROXY_TARGET = UPSTREAM;
  process.env.API_KEY = "proxy-test-key";
  fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.API_PROXY_TARGET;
  delete process.env.API_KEY;
});

describe("прокси: анонимный запрос", () => {
  it("на каталог отвечает 401 и НЕ ходит на бэкенд", async () => {
    const res = await GET(makeRequest("/api/equipment"), ctx("/api/equipment"));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("на вход в админку проходит на бэкенд", async () => {
    const res = await POST(
      makeRequest("/api/auth/login", { method: "POST" }),
      ctx("/api/auth/login"),
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("на экран входа киоска проходит на бэкенд", async () => {
    const res = await GET(
      makeRequest("/api/warehouse/workers/names"),
      ctx("/api/warehouse/workers/names"),
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});

// Обход, найденный на ревью. Гард проверял путь, который склеивал сам, а fetch
// отправлял путь, нормализованный по правилам WHATWG-URL: `..` схлопывается,
// `%2e` декодируется. `/api/lk/%252e%252e/equipment` Next декодирует ОДИН раз —
// гард видел сегмент `%2e%2e` внутри публичной ветки портала и пропускал, а на
// бэкенд уходило `/api/equipment` с подставленным ключом API.
//
// Проверять только статус здесь мало: баг — это сам факт запроса на бэкенд,
// поэтому ассертим, что fetch не вызывался.
describe("прокси: обход через нормализацию пути", () => {
  const traversals = [
    "/api/lk/%252e%252e/equipment",
    "/api/auth/%252e%252e/equipment",
    "/api/lk/%2e%2e/equipment",
    "/api/auth/../equipment",
    "/api/lk/..%2fequipment",
  ];

  for (const path of traversals) {
    it(`${path} не уходит на бэкенд и не получает ключ`, async () => {
      const res = await GET(makeRequest(path), ctx(path));

      expect(res.status).not.toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }

  it("POST через ту же щель тоже не проходит", async () => {
    const path = "/api/lk/%252e%252e/users/upsert";
    const res = await POST(makeRequest(path, { method: "POST" }), ctx(path));

    expect(res.status).not.toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("обход с валидной сессией всё равно отклоняется — путь некорректен сам по себе", async () => {
    const path = "/api/lk/%252e%252e/equipment";
    const res = await GET(
      makeRequest(path, { cookie: "lr_session=token.value.sig" }),
      ctx(path),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: "BAD_PROXY_PATH" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("прокси: запрос с учётными данными", () => {
  it("cookie сессии — идёт на бэкенд, ключ API подставлен", async () => {
    const res = await GET(
      makeRequest("/api/equipment", { cookie: "lr_session=token.value.sig" }),
      ctx("/api/equipment"),
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${UPSTREAM}/api/equipment`);
    expect(new Headers(options.headers).get("x-api-key")).toBe("proxy-test-key");
  });

  it("Bearer киоска — идёт на бэкенд", async () => {
    const res = await GET(
      makeRequest("/api/warehouse/shift", { authorization: "Bearer wh.token.sig" }),
      ctx("/api/warehouse/shift"),
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});
