import path from "path";
import supertest from "supertest";

// Set env vars BEFORE any app imports — this file runs as a setupFile in vitest
// so these values are available when test files are evaluated.
const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1,test-key-2";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
// Используем mock-провайдер в тестах — gemini.ts требует нативный require(),
// который не поддерживается в vitest ESM-режиме.
process.env.VISION_PROVIDER = "mock";

// ─── supertest: ходим на [::1], а не на 127.0.0.1 ───────────────────────────
//
// Лечит нестабильность набора: примерно каждый третий-пятый полный прогон падал
// в СЛУЧАЙНОМ файле с `read ECONNRESET` либо с посторонним 4xx там, где роут
// умеет отдавать только 200.
//
// Причина. supertest на КАЖДЫЙ request() поднимает свой сервер вызовом
// `app.listen(0)` БЕЗ хоста (lib/test.js:63) — это бинд на IPv6-wildcard `::`, —
// а URL строит с жёстко зашитым `127.0.0.1` (lib/test.js:69). На BSD/macOS такой
// wildcard-бинд НЕ конфликтует с чужим слушателем на конкретном 127.0.0.1:PORT,
// поэтому ядро спокойно выдаёт нам уже занятый кем-то порт. А при соединении на
// 127.0.0.1 выигрывает более специфичный сокет — ЧУЖОЙ. Запрос уходит в чужой
// процесс (Electron/VS Code, language server, dev-серверы — всё, что слушает
// внутри эфемерного диапазона 49152-65535), оттуда и прилетают посторонние
// 401/403/404 и RST. Наше приложение такого запроса вообще не видит.
//
// Отсюда все свойства бага: падают случайные файлы (какой порт выдало ядро),
// частота растёт с числом вызовов request(), и он не лечится ни `--pool=forks`,
// ни `--maxWorkers` — конфликт идёт с процессами ВНЕ vitest, порты общесистемные.
//
// Наш `::`-сокет — единственный, кто может обслужить соединение на [::1], потому
// что IPv4-слушатели туда не достают. Один и тот же порт остаётся, меняется
// только адрес назначения.
//
// NB: подменить сам listen на `listen(0, "127.0.0.1")` НЕЛЬЗЯ — с явным хостом
// бинд становится асинхронным, `app.address()` сразу после вызова возвращает
// null, и supertest падает на lib/test.js:67.
const supertestTestProto = (supertest as unknown as {
  Test?: { prototype: { serverAddress?: (app: unknown, path: string) => string } };
}).Test?.prototype;

if (!supertestTestProto || typeof supertestTestProto.serverAddress !== "function") {
  // Громко, а не тихо: молчаливый no-op вернул бы флейк без единого следа.
  throw new Error(
    "supertest: Test.prototype.serverAddress не найден — проверь сигнатуру после апгрейда пакета",
  );
}

const originalServerAddress = supertestTestProto.serverAddress;
supertestTestProto.serverAddress = function (this: { _server?: unknown }, app: unknown, p: string) {
  const url = originalServerAddress.call(this, app, p);
  // `_server` выставляется оригиналом только когда сервер подняли МЫ. Для
  // request(server) и request("http://…") адрес чужой — не трогаем.
  if (!this._server) return url;
  // Если IPv6 на машине нет, listen(0) сядет на 0.0.0.0 (family "IPv4") — тогда
  // оставляем всё как было: без IPv6 фикс неприменим, но и хуже не делает.
  const address = (app as { address?: () => { family?: string } | null }).address?.();
  if (address?.family !== "IPv6") return url;
  return url.replace("://127.0.0.1:", "://[::1]:");
};
