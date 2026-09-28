/**
 * Контракты клиента киоска (`api.ts` + хелперы ошибок в `types.ts`).
 *
 *  - PIN-вход переживает перезагрузку: имя кладовщика и срок токена лежат
 *    рядом с токеном в sessionStorage (P18);
 *  - черновик чек-листа сохраняется PUT'ом по ревизии и умеет `keepalive`
 *    для досылки при уходе со страницы (P6);
 *  - «Прервать» и «ушёл, ничего не сделав» — один `cancel` с опциями (P1, P25);
 *  - `complete` пробрасывает новые поля как есть (P3, P12, P14, P4);
 *  - коды 409 из таблицы 2.2 разбираются типизированно.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  authWorker,
  cancel,
  clearWarehouseToken,
  complete,
  getWarehouseAuth,
  getWarehouseToken,
  saveDraft,
  setWarehouseToken,
  scanApi,
} from "../api";
import {
  CHECKLIST_DRAFT_LIMITS,
  SCAN_ERROR,
  getScanErrorDetails,
  isChecklistDraftV1,
  isSessionClosedError,
  scanErrorCode,
} from "../types";
import type { ChecklistDraftV1, ScanApiError } from "../types";

const HOUR = 60 * 60 * 1000;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Токен в формате сервера: base64(JSON{name,exp}) + ":" + hmac. */
function serverLikeToken(name: string, exp: number): string {
  const json = JSON.stringify({ name, exp });
  const b64 = Buffer.from(json, "utf8").toString("base64");
  return `${b64}:${"a".repeat(64)}`;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.sessionStorage.clear();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function lastCall(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url: String(call[0]), init: (call[1] ?? {}) as RequestInit };
}

function lastBody(): unknown {
  const { init } = lastCall();
  return init.body === undefined ? undefined : JSON.parse(String(init.body));
}

// ── PIN-вход: имя и срок токена ─────────────────────────────────────────────

describe("PIN-вход переживает перезагрузку", () => {
  it("authWorker сохраняет токен, имя кладовщика и срок жизни токена", async () => {
    const expiresAt = new Date(Date.now() + 12 * HOUR).toISOString();
    fetchMock.mockResolvedValue(
      jsonResponse(200, { token: "t-1", name: "Иван Кладовщик", expiresAt }),
    );

    await authWorker("Иван Кладовщик", "123456");

    expect(getWarehouseToken()).toBe("t-1");
    expect(getWarehouseAuth()).toEqual({
      token: "t-1",
      workerName: "Иван Кладовщик",
      expiresAt,
    });
    // Вход публичный — без Bearer.
    const { init } = lastCall();
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("истёкший токен не считается входом и вычищается из хранилища", () => {
    setWarehouseToken("t-old", {
      name: "Пётр",
      expiresAt: new Date(Date.now() - HOUR).toISOString(),
    });

    expect(getWarehouseAuth()).toBeNull();
    expect(getWarehouseToken()).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
  });

  it("токен, сохранённый старой версией (без имени и срока), читается из самого токена", () => {
    const exp = Date.now() + 3 * HOUR;
    window.sessionStorage.setItem("warehouse_token", serverLikeToken("Анна Склад", exp));

    expect(getWarehouseAuth()).toEqual({
      token: expect.any(String),
      workerName: "Анна Склад",
      expiresAt: new Date(exp).toISOString(),
    });
  });

  it("истёкший токен старой версии тоже не пускает в киоск", () => {
    window.sessionStorage.setItem(
      "warehouse_token",
      serverLikeToken("Анна Склад", Date.now() - 1000),
    );
    expect(getWarehouseAuth()).toBeNull();
  });

  it("непрозрачный токен без срока считается живым — решит сервер (401 → вход)", () => {
    window.sessionStorage.setItem("warehouse_token", "valid-pin-token");
    expect(getWarehouseAuth()).toEqual({
      token: "valid-pin-token",
      workerName: null,
      expiresAt: null,
    });
  });

  it("clearWarehouseToken стирает токен вместе с именем и сроком", () => {
    setWarehouseToken("t-1", {
      name: "Иван",
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
    });
    clearWarehouseToken();
    expect(getWarehouseAuth()).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
  });

  it("setWarehouseToken(token) без метаданных сбрасывает имя прошлого кладовщика", () => {
    setWarehouseToken("t-1", { name: "Иван", expiresAt: new Date(Date.now() + HOUR).toISOString() });
    setWarehouseToken("t-2");
    expect(getWarehouseAuth()).toEqual({ token: "t-2", workerName: null, expiresAt: null });
  });
});

// ── Черновик чек-листа ──────────────────────────────────────────────────────

const DRAFT: ChecklistDraftV1 = {
  v: 1,
  issue: {
    rows: {
      "bi-1": { qty: 3, checked: true, equipmentId: "eq-1" },
      "bi-2": { qty: 0, checked: false, equipmentId: null, ack: true },
    },
  },
};

describe("saveDraft", () => {
  it("PUT /sessions/:id/draft с ревизией, от которой считали, и Bearer-токеном", async () => {
    setWarehouseToken("tok");
    fetchMock.mockResolvedValue(
      jsonResponse(200, { revision: 4, savedAt: "2026-09-28T10:00:00.000Z" }),
    );

    const res = await saveDraft("s-1", 3, DRAFT);

    expect(res).toEqual({ revision: 4, savedAt: "2026-09-28T10:00:00.000Z" });
    const { url, init } = lastCall();
    expect(url).toBe("/api/warehouse/sessions/s-1/draft");
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(lastBody()).toEqual({ revision: 3, draft: DRAFT });
    expect(init.keepalive).toBeFalsy();
  });

  it("при уходе со страницы шлёт keepalive-запрос", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { revision: 1, savedAt: "x" }));
    await saveDraft("s-1", 0, DRAFT, { keepalive: true });
    expect(lastCall().init.keepalive).toBe(true);
  });

  it("большой черновик уходит обычным запросом: у keepalive потолок 64 КБ", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { revision: 1, savedAt: "x" }));
    const rows: Record<string, { qty: number; checked: boolean; equipmentId: string | null }> = {};
    for (let i = 0; i < 450; i += 1) {
      rows[`bi-${i}-${"x".repeat(150)}`] = { qty: 1, checked: true, equipmentId: `eq-${i}` };
    }
    const big: ChecklistDraftV1 = { v: 1, issue: { rows } };
    expect(JSON.stringify({ revision: 0, draft: big }).length).toBeGreaterThan(64 * 1024);

    await saveDraft("s-1", 0, big, { keepalive: true });

    expect(lastCall().init.keepalive).toBeFalsy();
  });

  it("черновик больше лимита сервера не отправляется — DRAFT_TOO_LARGE сразу", async () => {
    const huge: ChecklistDraftV1 = {
      v: 1,
      return: {
        units: {},
        grids: {
          "bi-1": {
            equipmentId: null,
            slots: Array.from({ length: 200 }, () => ({
              status: "REPAIR" as const,
              repairComment: "к".repeat(1500),
              problem: { reason: null, comment: "", expectedBackDate: null },
            })),
          },
        },
      },
    };

    await expect(saveDraft("s-1", 0, huge)).rejects.toMatchObject({
      status: 413,
      code: SCAN_ERROR.DRAFT_TOO_LARGE,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(CHECKLIST_DRAFT_LIMITS.maxBytes).toBe(256 * 1024);
  });

  it("409 DRAFT_OUTDATED отдаёт свежую версию с другого устройства", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        message: "Чек-лист изменили на другом устройстве — загружена свежая версия",
        code: "DRAFT_OUTDATED",
        details: { revision: 7, draft: DRAFT, savedAt: "2026-09-28T10:05:00.000Z", savedBy: "Анна" },
      }),
    );

    const err = await saveDraft("s-1", 5, DRAFT).catch((e: unknown) => e);

    expect(scanErrorCode(err)).toBe("DRAFT_OUTDATED");
    const details = getScanErrorDetails(err, "DRAFT_OUTDATED");
    expect(details?.revision).toBe(7);
    expect(details?.savedBy).toBe("Анна");
    expect(isChecklistDraftV1(details?.draft)).toBe(true);
    // Код другого вида не подменяется.
    expect(getScanErrorDetails(err, "SESSION_STALE")).toBeNull();
  });

  it("нет сети — понятная ошибка по-русски, код NETWORK_ERROR", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(saveDraft("s-1", 0, DRAFT)).rejects.toMatchObject({
      status: 0,
      code: SCAN_ERROR.NETWORK_ERROR,
      message: expect.stringMatching(/связ/i),
    });
  });
});

// ── Отмена сессии ───────────────────────────────────────────────────────────

describe("cancel", () => {
  it("без опций — как раньше: POST без тела", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: "s-1", status: "CANCELLED", cancelled: true }));
    await cancel("s-1");
    const { url, init } = lastCall();
    expect(url).toBe("/api/warehouse/sessions/s-1/cancel");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });

  it("«Прервать выдачу» передаёт причину", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: "s-1", status: "CANCELLED", cancelled: true }));
    const res = await cancel("s-1", { reason: "KIOSK_ABORT" });
    expect(lastBody()).toEqual({ reason: "KIOSK_ABORT" });
    expect(res.cancelled).toBe(true);
  });

  it("уход без работы: onlyIfEmpty + keepalive; сервер может и не отменять", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: "s-1", status: "ACTIVE", cancelled: false }));
    const res = await cancel("s-1", { reason: "EMPTY_LEAVE", onlyIfEmpty: true, keepalive: true });
    expect(lastBody()).toEqual({ reason: "EMPTY_LEAVE", onlyIfEmpty: true });
    expect(lastCall().init.keepalive).toBe(true);
    expect(res.cancelled).toBe(false);
  });
});

// ── Завершение ──────────────────────────────────────────────────────────────

describe("complete", () => {
  it("пробрасывает force, itemsVersion, draftRevision и acknowledgedConflict как есть", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { sessionId: "s-1", bookingStatus: "ISSUED" }));
    await complete("s-1", {
      force: true,
      itemsVersion: "abcdef0123456789",
      draftRevision: 12,
      issuanceAdjustments: [{ bookingItemId: "bi-1", actualQuantity: 5, acknowledgedConflict: true }],
    });
    expect(lastBody()).toEqual({
      force: true,
      itemsVersion: "abcdef0123456789",
      draftRevision: 12,
      issuanceAdjustments: [{ bookingItemId: "bi-1", actualQuantity: 5, acknowledgedConflict: true }],
    });
  });

  it("старый вызов без новых полей не меняется", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { sessionId: "s-1" }));
    await complete("s-1", { issuanceAdjustments: [{ bookingItemId: "bi-1", actualQuantity: 2 }] });
    expect(lastBody()).toEqual({ issuanceAdjustments: [{ bookingItemId: "bi-1", actualQuantity: 2 }] });
  });
});

// ── Коды ошибок ─────────────────────────────────────────────────────────────

describe("коды ошибок киоска", () => {
  const closed = (code: string): ScanApiError => ({ status: 409, code, message: "m", details: { sessionId: "s" } });

  it("закрытая сессия — SESSION_* (кроме живых кодов)", () => {
    expect(isSessionClosedError(closed("SESSION_ALREADY_COMPLETED"))).toBe(true);
    expect(isSessionClosedError(closed("SESSION_CANCELLED"))).toBe(true);
    expect(isSessionClosedError(closed("SESSION_STALE"))).toBe(true);
    expect(isSessionClosedError({ ...closed("SESSION_NOT_FOUND"), status: 404 })).toBe(true);
    expect(isSessionClosedError(closed("CHECKLIST_OUTDATED"))).toBe(false);
    expect(isSessionClosedError(new Error("x"))).toBe(false);
    expect(isSessionClosedError(null)).toBe(false);
  });

  it("детали ADDON_OVER_STOCK из /complete указывают строку", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        message: "“Кабель 63/380”: не хватает на складе — можно добрать ещё 2",
        code: "ADDON_OVER_STOCK",
        details: { bookingItemId: "bi-9", equipmentId: "eq-9", name: "Кабель 63/380", addCap: 2, requested: 5, alreadyInBooking: 3 },
      }),
    );
    const err = await complete("s-1", {}).catch((e: unknown) => e);
    const d = getScanErrorDetails(err, SCAN_ERROR.ADDON_OVER_STOCK);
    expect(d).toMatchObject({ bookingItemId: "bi-9", addCap: 2 });
    expect((err as ScanApiError).message).toContain("можно добрать ещё 2");
  });

  it("детали без объекта не выдаются за типизированные", () => {
    const err: ScanApiError = { status: 409, code: "SESSION_STALE", message: "m", details: "html" };
    expect(getScanErrorDetails(err, "SESSION_STALE")).toBeNull();
  });

  it("isChecklistDraftV1 отсекает чужие форматы", () => {
    expect(isChecklistDraftV1({ v: 1 })).toBe(true);
    expect(isChecklistDraftV1({ v: 2 })).toBe(false);
    expect(isChecklistDraftV1(null)).toBe(false);
    expect(isChecklistDraftV1({ v: 1, issue: "x" })).toBe(false);
    expect(isChecklistDraftV1({ v: 1, issue: { rows: {} }, return: { units: {}, grids: {} } })).toBe(true);
  });
});

describe("scanApi", () => {
  it("агрегат содержит новые функции", () => {
    expect(scanApi.saveDraft).toBe(saveDraft);
    expect(scanApi.getWarehouseAuth).toBe(getWarehouseAuth);
    expect(scanApi.cancel).toBe(cancel);
  });
});
