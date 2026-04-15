import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../prisma";

/** @deprecated Используй UserRole. AdminRole оставлен для обратной совместимости с requireRole(). */
export type AdminRole = "SUPER_ADMIN" | "WAREHOUSE" | "TECHNICIAN";
export type UserRole = "SUPER_ADMIN" | "WAREHOUSE" | "TECHNICIAN";

export type SessionPayload = {
  userId: string;
  username: string;
  role: UserRole;
};

/** JWT secret. В проде задаётся через JWT_SECRET в .env; fallback даёт понятную ошибку вместо тихого молчания. */
function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 16) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("JWT_SECRET обязателен в production (минимум 16 символов)");
    }
    return "dev-secret-do-not-use-in-production-xxxxxxxxxx";
  }
  return secret;
}

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 дней
export const SESSION_COOKIE_NAME = "lr_session";

// ──────────────────────────────────────────────
// Пароли
// ──────────────────────────────────────────────

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// ──────────────────────────────────────────────
// JWT
// ──────────────────────────────────────────────

export function signSession(payload: SessionPayload): string {
  return jwt.sign(payload, getSecret(), { expiresIn: SESSION_TTL_SECONDS });
}

export function verifySession(token: string): SessionPayload | null {
  try {
    const decoded = jwt.verify(token, getSecret()) as SessionPayload;
    if (!decoded?.userId || !decoded?.role) return null;
    return decoded;
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────
// Пользователи
// ──────────────────────────────────────────────

/** Нормализация логина: trim + lowercase. Логин case-insensitive. */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export async function authenticate(username: string, password: string): Promise<SessionPayload | null> {
  const user = await prisma.adminUser.findUnique({ where: { username: normalizeUsername(username) } });
  if (!user) return null;
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) return null;
  return { userId: user.id, username: user.username, role: user.role as UserRole };
}

export function sessionCookieOptions() {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_TTL_SECONDS * 1000,
  };
}
