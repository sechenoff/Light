import { describe, it, expect } from "vitest";

import { decideProxyAuth, PUBLIC_API_ROUTES } from "../proxyAuthGate";

/** Короткая обёртка: путь + метод + заголовки → пустить или нет. */
function decide(
  method: string,
  apiPath: string,
  headers: { cookie?: string; authorization?: string } = {},
) {
  return decideProxyAuth({
    method,
    apiPath,
    cookie: headers.cookie ?? null,
    authorization: headers.authorization ?? null,
  });
}

const LR = "lr_session=eyJhbGciOi.payload.sig";
const LK = "lk_session=eyJhbGciOi.payload.sig";

describe("proxyAuthGate — публичные маршруты", () => {
  it("вход и выход админки открыты без учётных данных", () => {
    expect(decide("POST", "/api/auth/login").allow).toBe(true);
    expect(decide("POST", "/api/auth/logout").allow).toBe(true);
  });

  it("/api/auth/me открыт: его зовут ДО входа, чтобы узнать, есть ли сессия", () => {
    expect(decide("GET", "/api/auth/me").allow).toBe(true);
  });

  it("клиентский портал открыт целиком — у него своя цепочка lkAuth", () => {
    expect(decide("POST", "/api/lk/auth/request-login").allow).toBe(true);
    expect(decide("POST", "/api/lk/auth/verify").allow).toBe(true);
    // Непубличные ручки портала прокси пропускает, а отклоняет уже lkAuth.
    expect(decide("GET", "/api/lk/bookings").allow).toBe(true);
  });

  it("экран входа киоска: имена работников и проверка PIN", () => {
    expect(decide("GET", "/api/warehouse/workers/names").allow).toBe(true);
    expect(decide("POST", "/api/warehouse/auth").allow).toBe(true);
  });

  it("публичность киоска — точечная, а не на весь /api/warehouse", () => {
    expect(decide("GET", "/api/warehouse/workers").allow).toBe(false);
    expect(decide("GET", "/api/warehouse/shift").allow).toBe(false);
    expect(decide("POST", "/api/warehouse/sessions").allow).toBe(false);
  });

  it("метод учитывается: GET на ручку входа киоска не публичен", () => {
    expect(decide("GET", "/api/warehouse/auth").allow).toBe(false);
    expect(decide("POST", "/api/warehouse/workers/names").allow).toBe(false);
  });

  it("префикс не обманывается похожим именем", () => {
    expect(decide("GET", "/api/authorized-users").allow).toBe(false);
    expect(decide("GET", "/api/lkx/secret").allow).toBe(false);
  });
});

describe("proxyAuthGate — непубличные маршруты", () => {
  it("каталог без учётных данных не проходит", () => {
    const decision = decide("GET", "/api/equipment");
    expect(decision.allow).toBe(false);
  });

  it("cookie главной сессии пропускает", () => {
    expect(decide("GET", "/api/equipment", { cookie: LR }).allow).toBe(true);
  });

  it("cookie портала пропускает", () => {
    expect(decide("GET", "/api/equipment", { cookie: LK }).allow).toBe(true);
  });

  it("Bearer-токен киоска пропускает (у планшета нет cookie админки)", () => {
    expect(
      decide("POST", "/api/warehouse/sessions", { authorization: "Bearer wh.token.sig" }).allow,
    ).toBe(true);
  });

  it("посторонние cookie не считаются учётными данными", () => {
    expect(decide("GET", "/api/equipment", { cookie: "lr:theme=dark; other=1" }).allow).toBe(false);
  });

  it("имя cookie сверяется целиком, а не подстрокой", () => {
    // `xlr_session` и `lr_session_backup` — не сессия.
    expect(decide("GET", "/api/equipment", { cookie: "xlr_session=abc" }).allow).toBe(false);
    expect(decide("GET", "/api/equipment", { cookie: "lr_session_backup=abc" }).allow).toBe(false);
  });

  it("cookie в середине строки распознаётся", () => {
    expect(
      decide("GET", "/api/equipment", { cookie: `lr:theme=dark; ${LR}; foo=bar` }).allow,
    ).toBe(true);
  });

  it("пустое значение cookie сессией не считается", () => {
    expect(decide("GET", "/api/equipment", { cookie: "lr_session=" }).allow).toBe(false);
  });

  it("пустой Authorization не считается учётными данными", () => {
    expect(decide("GET", "/api/equipment", { authorization: "   " }).allow).toBe(false);
  });

  it("отказ несёт машинный код для apiFetch", () => {
    const decision = decide("GET", "/api/equipment");
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.code).toBe("UNAUTHENTICATED");
      expect(decision.status).toBe(401);
    }
  });
});

describe("proxyAuthGate — список публичных маршрутов", () => {
  it("каждая запись объясняет, почему маршрут публичен", () => {
    expect(PUBLIC_API_ROUTES.length).toBeGreaterThan(0);
    for (const entry of PUBLIC_API_ROUTES) {
      expect(entry.why.length).toBeGreaterThan(10);
    }
  });

  it("в списке нет ничего кроме auth, портала и экрана входа киоска", () => {
    const allowedPrefixes = ["/api/auth", "/api/lk", "/api/warehouse/auth", "/api/warehouse/workers/names"];
    for (const entry of PUBLIC_API_ROUTES) {
      expect(
        allowedPrefixes.some((p) => entry.path === p || entry.path.startsWith(`${p}/`)),
        `Публичный маршрут вне ожидаемых зон: ${entry.path}`,
      ).toBe(true);
    }
  });
});
