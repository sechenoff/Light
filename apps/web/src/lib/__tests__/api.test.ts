import { describe, it, expect, vi, afterEach } from "vitest";
import { apiFetch } from "../api";

function stubFetchJson(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

describe("apiFetch — прокидывание кода ошибки бэкенда", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("выставляет err.code из поля code в JSON ошибки (ISSUE_TOO_EARLY)", async () => {
    stubFetchJson(409, {
      message: "Аренда начинается 10.07.2026 — до начала больше суток. Проверьте бронь; если выдаёте заранее осознанно, подтвердите выдачу.",
      code: "ISSUE_TOO_EARLY",
      details: { startDate: "2026-07-10T00:00:00.000Z" },
    });

    await expect(
      apiFetch("/api/bookings/b1/status", { method: "POST", body: JSON.stringify({ action: "issue" }) }),
    ).rejects.toMatchObject({
      status: 409,
      code: "ISSUE_TOO_EARLY",
      details: { startDate: "2026-07-10T00:00:00.000Z" },
      message: expect.stringContaining("до начала больше суток"),
    });
  });

  it("err.code остаётся undefined, если бэкенд его не прислал", async () => {
    stubFetchJson(409, { message: "Недопустимый переход: RETURNED -> issue" });

    await expect(apiFetch("/api/bookings/b1/status", { method: "POST" })).rejects.toMatchObject({
      status: 409,
      code: undefined,
      message: "Недопустимый переход: RETURNED -> issue",
    });
  });

  it("не падает на не-строковом code (мусорный ответ)", async () => {
    stubFetchJson(500, { message: "Ошибка", code: 42 });

    await expect(apiFetch("/api/anything")).rejects.toMatchObject({
      status: 500,
      code: undefined,
    });
  });

  it("успешный ответ возвращает JSON как раньше", async () => {
    stubFetchJson(200, { booking: { id: "b1", status: "ISSUED" } });

    await expect(apiFetch<{ booking: { id: string } }>("/api/bookings/b1")).resolves.toEqual({
      booking: { id: "b1", status: "ISSUED" },
    });
  });
});
