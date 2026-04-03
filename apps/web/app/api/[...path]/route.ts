import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

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

function buildTargetUrl(req: NextRequest, pathSegments: string[]): string | null {
  const base = upstreamBase();
  if (!base) return null;
  const sub = pathSegments.join("/");
  const suffix = sub ? `/${sub}` : "";
  return `${base}/api${suffix}${req.nextUrl.search}`;
}

async function proxy(req: NextRequest, pathSegments: string[]): Promise<NextResponse> {
  const targetUrl = buildTargetUrl(req, pathSegments);
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
  outHeaders.set('X-API-Key', process.env.API_KEY ?? '');

  let body: ArrayBuffer | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    try {
      body = await req.arrayBuffer();
    } catch {
      body = undefined;
    }
  }

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: outHeaders,
      body: body && body.byteLength > 0 ? body : undefined,
      redirect: "manual",
      cache: "no-store",
    });

    const resHeaders = new Headers(upstream.headers);
    return new NextResponse(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: resHeaders,
    });
  } catch (err: unknown) {
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
