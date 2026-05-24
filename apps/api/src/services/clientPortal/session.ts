import jwt from "jsonwebtoken";

export type LkSessionPayload = {
  accountId: string;
  clientId: string;
  email: string;
};

/** JWT secret для lk_session cookie. */
function getSecret(): string {
  const secret = process.env.CLIENT_PORTAL_SESSION_SECRET;
  if (!secret || secret.length < 16) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("CLIENT_PORTAL_SESSION_SECRET обязателен в production");
    }
    return "lk-dev-secret-do-not-use-in-prod-xxxxxxxxx";
  }
  return secret;
}

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 дней
export const LK_COOKIE_NAME = "lk_session";

export function signLkSession(payload: LkSessionPayload): string {
  return jwt.sign(payload, getSecret(), { expiresIn: SESSION_TTL_SECONDS });
}

export function verifyLkSession(token: string): LkSessionPayload | null {
  try {
    const decoded = jwt.verify(token, getSecret(), { algorithms: ["HS256"] }) as LkSessionPayload;
    if (!decoded?.accountId || !decoded?.clientId || !decoded?.email) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function lkCookieOptions() {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_TTL_SECONDS * 1000,
  };
}
