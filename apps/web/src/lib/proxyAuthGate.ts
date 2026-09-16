/**
 * Кого Next-прокси подписывает ключом API, а кого — нет.
 *
 * Прокси (`app/api/[...path]/route.ts`) подставляет `X-API-Key` из своего окружения.
 * Пока он делал это КАЖДОМУ запросу, ключ работал не как гард, а как анти-гард:
 * любой маршрут Express без `rolesGuard` автоматически становился публичным для
 * всего интернета. Так наружу уходил каталог с прайсом (`GET /api/equipment`).
 *
 * Здесь — решение «это анонимный запрос из интернета или запрос с учётными данными».
 * Прокси проверяет НАЛИЧИЕ учётных данных, а не их валидность: он не орган
 * авторизации, он лишь перестаёт выдавать анониму ключ доступа. Решает по-прежнему
 * API — `rolesGuard`, `warehouseAuth`, `lkAuth`.
 *
 * Список публичного — закрытый и маленький. Всё, что в него не входит, требует
 * хотя бы одного признака сессии.
 */

/** Cookie главной админ-сессии (`SESSION_COOKIE_NAME` в apps/api/src/services/auth.ts). */
const ADMIN_SESSION_COOKIE = "lr_session";
/** Cookie клиентского портала (`LK_COOKIE_NAME` в apps/api/src/services/clientPortal/session.ts). */
const PORTAL_SESSION_COOKIE = "lk_session";

export type PublicApiRoute = {
  /** Путь API как его видит прокси: `/api/...`, без query. */
  path: string;
  /** `null` — любой метод (используется для префиксных зон со своей аутентификацией). */
  method: string | null;
  /** `true` — совпадение по префиксу (`path` и всё под ним), иначе точное. */
  prefix: boolean;
  /** Почему маршрут обязан работать без сессии. */
  why: string;
};

export const PUBLIC_API_ROUTES: PublicApiRoute[] = [
  {
    path: "/api/auth",
    method: null,
    prefix: true,
    why: "вход, выход и /me — сессии здесь ещё нет по определению; /me зовут, чтобы узнать, есть ли она",
  },
  {
    path: "/api/lk",
    method: null,
    prefix: true,
    why: "клиентский портал живёт на своей цепочке lkAuth (cookie lk_session), а не на ключе API",
  },
  {
    path: "/api/warehouse/auth",
    method: "POST",
    prefix: false,
    why: "вход в киоск склада по PIN; за перебор отвечает per-worker lockout, а не прокси",
  },
  {
    path: "/api/warehouse/workers/names",
    method: "GET",
    prefix: false,
    why: "список имён на экране входа киоска; имя по смыслу не секрет, секрет — PIN",
  },
];

export type ProxyAuthDecision =
  | { allow: true }
  | { allow: false; status: 401; code: "UNAUTHENTICATED"; message: string };

export type ProxyAuthInput = {
  method: string;
  /** Путь вида `/api/equipment` — без query-строки. */
  apiPath: string;
  cookie: string | null;
  authorization: string | null;
};

function isPublicRoute(method: string, apiPath: string): boolean {
  const upperMethod = method.toUpperCase();
  return PUBLIC_API_ROUTES.some((route) => {
    if (route.method !== null && route.method !== upperMethod) return false;
    return route.prefix
      ? apiPath === route.path || apiPath.startsWith(`${route.path}/`)
      : apiPath === route.path;
  });
}

/**
 * Есть ли в cookie непустое значение с таким именем.
 * Имя сверяется целиком: `xlr_session` и `lr_session_backup` — не сессия.
 */
function hasNonEmptyCookie(cookieHeader: string, name: string): boolean {
  return cookieHeader
    .split(";")
    .some((part) => {
      const eq = part.indexOf("=");
      if (eq === -1) return false;
      return part.slice(0, eq).trim() === name && part.slice(eq + 1).trim().length > 0;
    });
}

function hasSessionCredential(input: ProxyAuthInput): boolean {
  if (input.authorization != null && input.authorization.trim().length > 0) {
    // Bearer киоска (warehouse_token) или главной сессии — валидность проверит API.
    return true;
  }
  const cookie = input.cookie;
  if (cookie == null || cookie.length === 0) return false;
  return (
    hasNonEmptyCookie(cookie, ADMIN_SESSION_COOKIE) ||
    hasNonEmptyCookie(cookie, PORTAL_SESSION_COOKIE)
  );
}

export function decideProxyAuth(input: ProxyAuthInput): ProxyAuthDecision {
  if (isPublicRoute(input.method, input.apiPath)) return { allow: true };
  if (hasSessionCredential(input)) return { allow: true };
  return {
    allow: false,
    status: 401,
    code: "UNAUTHENTICATED",
    message: "Требуется авторизация",
  };
}
