import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Проверка авторизации для CRM-маршрутов.
 *
 * Публичные маршруты (без пароля):
 *   /                 — лендинг
 *   /crew-calculator  — калькулятор осветителей
 *   /login            — страница входа
 *   /api/auth/*       — login/logout/me (проверяется внутри API)
 *   /api/*            — проксируется отдельно; защита на уровне Express
 *   /_next/*, favicon.ico, публичные ассеты — пропускаются
 *
 * Защищённые маршруты (требуется cookie):
 *   всё остальное под /dashboard, /bookings, /equipment, /calendar, /admin, /finance, /warehouse, /settings
 *
 * Ролевая проверка (/finance → только SUPER_ADMIN) выполняется на странице — middleware
 * не парсит JWT, чтобы не тянуть криптографию в edge-runtime.
 */

const PUBLIC_PATHS = new Set<string>(["/", "/crew-calculator", "/login"]);

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  // API-прокси и внутренние маршруты Next пропускаем.
  if (pathname.startsWith("/api/")) return true;
  if (pathname.startsWith("/_next/")) return true;
  if (pathname === "/favicon.ico") return true;
  if (pathname.startsWith("/warehouse/scan")) return true; // PIN-авторизация внутри
  return false;
}

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();

  const token = req.cookies.get("lr_session")?.value;
  if (!token) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = `?from=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Все маршруты, кроме статики Next и ассетов.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|gif|webp|ico|woff|woff2|ttf)).*)",
  ],
};
