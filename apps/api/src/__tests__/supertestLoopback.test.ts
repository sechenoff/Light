/**
 * Сторож патча supertest из `setup.ts` (ходим на [::1], а не на 127.0.0.1).
 *
 * Зачем такой странный тест. supertest на каждый request() делает `app.listen(0)`
 * без хоста — бинд на IPv6-wildcard `::`, — а URL строит с жёстко зашитым
 * 127.0.0.1. На BSD/macOS wildcard-бинд не конфликтует с чужим слушателем на
 * конкретном 127.0.0.1:PORT, поэтому ядро выдаёт нам уже занятый порт, а
 * соединение на 127.0.0.1 достаётся более специфичному — ЧУЖОМУ — сокету.
 * Запрос уходит в посторонний процесс, и тест видит его ответ (401/403/404) или
 * RST. Так набор терял примерно каждый третий-пятый полный прогон, всегда в
 * случайном файле.
 *
 * Здесь это воспроизводится ДЕТЕРМИНИРОВАННО: поднимаем «чужой демон» на
 * конкретном 127.0.0.1:P и заставляем supertest сесть wildcard-биндом на тот же
 * P. Без патча отвечает демон, с патчем — наше приложение.
 *
 * Если кто-то уберёт патч или supertest сменит сигнатуру serverAddress — эти
 * три теста покраснеют сразу, а не «иногда, в чужом файле, раз в пять прогонов».
 */

import http from "http";
import type { AddressInfo } from "net";
import express from "express";
import request from "supertest";
import { describe, it, expect } from "vitest";

function listen(server: http.Server, port: number, host?: string): Promise<void> {
  return new Promise((resolve) => {
    if (host) server.listen(port, host, () => resolve());
    else server.listen(port, () => resolve());
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function portOf(server: http.Server): number {
  return (server.address() as AddressInfo).port;
}

/**
 * Возможно ли на этой ОС «затенение»: wildcard-бинд поверх занятого
 * конкретного 127.0.0.1:PORT. На macOS/BSD — да, это и есть корень бага.
 * На Linux такой bind обычно падает с EADDRINUSE, то есть ядро само не даёт
 * коллизии — и воспроизводить нечего.
 */
async function shadowBindPossible(): Promise<boolean> {
  const specific = http.createServer();
  await listen(specific, 0, "127.0.0.1");
  const port = portOf(specific);

  const wildcard = http.createServer();
  const possible = await new Promise<boolean>((resolve) => {
    wildcard.once("error", () => resolve(false));
    wildcard.listen(port, () => resolve(true));
  });

  if (possible) await close(wildcard);
  await close(specific);
  return possible;
}

/** Три реальных симптома, которые давал чужой демон в прогонах. */
const DECOYS = [
  {
    name: "посторонний 403",
    handler: (_req: http.IncomingMessage, res: http.ServerResponse) => {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("Invalid CSRF token");
    },
  },
  {
    name: "обрыв соединения (ECONNRESET)",
    handler: (req: http.IncomingMessage) => req.socket.destroy(),
  },
  {
    name: "посторонний 400",
    handler: (_req: http.IncomingMessage, res: http.ServerResponse) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "Некорректный JSON в теле запроса" }));
    },
  },
] as const;

describe("supertest не должен попадать в чужой процесс", () => {
  for (const decoy of DECOYS) {
    it(`отвечает наше приложение, а не чужой демон: ${decoy.name}`, async (ctx) => {
      // Проверяем внутри теста, а не top-level await: с TLA в файле vitest не
      // успевал прогнать setupFiles, и патч из setup.ts просто отсутствовал.
      if (!(await shadowBindPossible())) {
        ctx.skip("ядро этой ОС само запрещает wildcard-бинд поверх занятого 127.0.0.1 — воспроизводить нечего");
        return;
      }

      const app = express();
      app.use(express.json());
      app.post("/echo", (req, res) => res.status(200).json({ from: "OUR_APP", got: req.body }));

      const foreign = http.createServer(decoy.handler as http.RequestListener);
      await listen(foreign, 0, "127.0.0.1");
      const squattedPort = portOf(foreign);

      // supertest всегда зовёт listen(0); подменяем только этот вызов на занятый
      // порт — путь бинда остаётся тем же (wildcard), меняется лишь номер.
      const originalListen = http.Server.prototype.listen;
      http.Server.prototype.listen = function (this: http.Server, ...args: unknown[]) {
        if (args.length === 1 && args[0] === 0) {
          return (originalListen as (...a: unknown[]) => http.Server).call(this, squattedPort);
        }
        return (originalListen as (...a: unknown[]) => http.Server).apply(this, args);
      } as typeof http.Server.prototype.listen;

      try {
        const res = await request(app).post("/echo").send({ marker: "ok" });
        expect(res.status).toBe(200);
        expect(res.body.from).toBe("OUR_APP");
        expect(res.body.got).toEqual({ marker: "ok" });
      } finally {
        http.Server.prototype.listen = originalListen;
        await close(foreign);
      }
    });
  }
});
