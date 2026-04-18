import jwt from "jsonwebtoken";

export type GafferSessionPayload = {
  gafferUserId: string;
  email: string;
};

/** JWT secret для gaffer_session cookie. */
function getSecret(): string {
  const secret = process.env.GAFFER_SESSION_SECRET;
  if (!secret || secret.length < 16) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("GAFFER_SESSION_SECRET обязателен в production (минимум 16 символов)");
    }
    return "gaffer-dev-secret-do-not-use-in-prod-xxxxxxxxxx";
  }
  return secret;
}

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 дней
export const GAFFER_COOKIE_NAME = "gaffer_session";

export function signGafferSession(gafferUser: { id: string; email: string }): string {
  const payload: GafferSessionPayload = { gafferUserId: gafferUser.id, email: gafferUser.email };
  return jwt.sign(payload, getSecret(), { expiresIn: SESSION_TTL_SECONDS });
}

export function verifyGafferSession(token: string): GafferSessionPayload | null {
  try {
    const decoded = jwt.verify(token, getSecret()) as GafferSessionPayload;
    if (!decoded?.gafferUserId || !decoded?.email) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function gafferCookieOptions() {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_TTL_SECONDS * 1000,
  };
}
