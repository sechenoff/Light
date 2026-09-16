import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { decideProxyAuth } from "@/lib/proxyAuthGate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
]);

function upstreamBase(): string | null {
  const fromEnv =
    process.env.API_PROXY_TARGET?.trim() ||
    process.env.API_DEV_PROXY_TARGET?.trim() ||
    process.env.NEXT_PUBLIC_API_BASE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  if (process.env.NODE_ENV === "development") return "http://127.0.0.1:4000";
  return null;
}

/**
 * Путь запроса ровно в том виде, в каком его увидит бэкенд.
 *
 * Считать его надо ОДИН раз и от него же строить адрес апстрима. Если гард
 * смотрит на одну строку, а `fetch` отправляет другую, гарда нет: WHATWG-URL
 * внутри `fetch` схлопывает `..` и декодирует `%2e`, поэтому
 * `/api/lk/%252e%252e/equipment` для наивной проверки — безобидная ветка
 * портала из публичного списка, а на бэкенд уходит `/api/equipment`.
 * Нормализуем от фиксированного origin, а не от `upstreamBase()`: база может
 * нести собственный префикс пути, и тогда сравнение с `/api/...` сломалось бы.
 */
function normalizeApiPath(pathSegments: string[]): string {
  const sub = pathSegments.join("/");
  return new URL(`/api${sub ? `/${sub}` : ""}`, "http://proxy.invalid").pathname;
}

/** Декодирует сегмент, не падая на битой escape-последовательности (`%zz`). */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Обход по сегментам: ни один клиент приложения не шлёт `.`, `..` или слэш
 * внутри сегмента — это всегда попытка показать гарду один путь, а бэкенду
 * другой. Отсекаем явно, не полагаясь на одну лишь нормализацию.
 */
function hasTraversalSegment(pathSegments: string[]): boolean {
  return pathSegments.some((segment) => {
    const decoded = decodeSegment(segment);
    return decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\");
  });
}

function buildTargetUrl(req: NextRequest, apiPath: string): string | null {
  const base = upstreamBase();
  if (!base) return null;
  return `${base}${apiPath}${req.nextUrl.search}`;
}

async function proxy(req: NextRequest, pathSegments: string[]): Promise<NextResponse> {
  if (hasTraversalSegment(pathSegments)) {
    return NextResponse.json(
      { message: "Некорректный путь запроса", code: "BAD_PROXY_PATH" },
      { status: 400 },
    );
  }

  // Ключ API подставляется ниже безусловно, поэтому анонимный запрос из интернета
  // приходил на бэкенд подписанным — и любой маршрут без rolesGuard оказывался
  // публичным. Отсекаем анонимов здесь, до сети: прокси не орган авторизации,
  // он лишь перестаёт выдавать ключ тому, у кого нет ни одного признака сессии.
  // Отказ отдаём сами, а не «просто без ключа»: без ключа исход зависел бы от
  // AUTH_MODE, и в режиме warn запрос прошёл бы дальше.
  const apiPath = normalizeApiPath(pathSegments);
  const gate = decideProxyAuth({
    method: req.method,
    apiPath,
    cookie: req.headers.get("cookie"),
    authorization: req.headers.get("authorization"),
  });
  if (!gate.allow) {
    return NextResponse.json(
      { message: gate.message, error: gate.message, code: gate.code },
      { status: gate.status },
    );
  }

  // Тот же apiPath, что проверил гард, — разойтись нечему.
  const targetUrl = buildTargetUrl(req, apiPath);
  if (!targetUrl) {
    return NextResponse.json(
      {
        message:
          "Прокси API не настроен: задайте NEXT_PUBLIC_API_BASE_URL или API_PROXY_TARGET для этого окружения.",
        code: "API_PROXY_NOT_CONFIGURED",
      },
      { status: 503 },
    );
  }

  const outHeaders = new Headers();
  req.headers.forEach((value: string, key: string) => {
    if (!HOP_HEADERS.has(key.toLowerCase())) {
      outHeaders.set(key, value);
    }
  });
  if (!process.env.API_KEY) {
    console.warn("[WARNING] API_KEY не задан в web .env.local — запросы к API будут без аутентификации.");
  }
  outHeaders.set('X-API-Key', process.env.API_KEY ?? '');

  let body: ArrayBuffer | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    try {
      body = await req.arrayBuffer();
    } catch {
      body = undefined;
    }
  }

  // Таймаут на upstream: без него зависший бэкенд (например, медленный LLM в
  // /api/bookings/parse-gaffer-review) держит запрос открытым бесконечно, а
  // клиент остаётся в спиннере «Распознаю…». AbortController даёт
  // детерминированный 504. 130s покрывает тяжёлые LLM-вызовы с запасом.
  const UPSTREAM_TIMEOUT_MS = 130_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: outHeaders,
      body: body && body.byteLength > 0 ? body : undefined,
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
    });

    const resHeaders = new Headers(upstream.headers);
    return new NextResponse(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: resHeaders,
    });
  } catch (err: unknown) {
    // Таймаут (AbortController) → 504, чтобы apiFetch выбросил ошибку и фронт
    // вышел из загрузки с понятным сообщением, а не висел вечно.
    if (err instanceof Error && err.name === "AbortError") {
      const msg = "Бэкенд не ответил вовремя (таймаут). Попробуйте ещё раз или используйте ручной режим.";
      return NextResponse.json(
        { message: msg, error: msg, code: "API_UPSTREAM_TIMEOUT" },
        { status: 504 },
      );
    }

    const cause =
      typeof err === "object" && err !== null && "cause" in err
        ? (err as { cause: { code?: string } }).cause
        : undefined;
    const code = cause?.code ?? (err as { code?: string }).code;
    const isConn =
      code === "ECONNREFUSED" ||
      code === "ENOTFOUND" ||
      (err instanceof Error && /ECONNREFUSED|ENOTFOUND|fetch failed/i.test(err.message));

    const hint = upstreamBase() ?? "(base URL не задан)";
    const msg = isConn
      ? `Бэкенд API недоступен (${hint}). Запустите API: из корня репозитория «npm run dev» или «npm run dev -w apps/api».`
      : `Не удалось обратиться к API: ${err instanceof Error ? err.message : String(err)}`;

    return NextResponse.json({ message: msg, error: msg, code: "API_UPSTREAM_UNAVAILABLE" }, { status: 503 });
  } finally {
    clearTimeout(timeout);
  }
}

type Ctx = { params: { path: string[] } };

function segments(ctx: Ctx): string[] {
  return ctx.params.path ?? [];
}

export async function GET(req: NextRequest, ctx: Ctx) {
  return proxy(req, segments(ctx));
}

export async function HEAD(req: NextRequest, ctx: Ctx) {
  return proxy(req, segments(ctx));
}

export async function POST(req: NextRequest, ctx: Ctx) {
  return proxy(req, segments(ctx));
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  return proxy(req, segments(ctx));
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  return proxy(req, segments(ctx));
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  return proxy(req, segments(ctx));
}

export async function OPTIONS(req: NextRequest, ctx: Ctx) {
  return proxy(req, segments(ctx));
}
