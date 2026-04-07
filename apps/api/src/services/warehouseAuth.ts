import bcrypt from "bcryptjs";
import { createHmac, timingSafeEqual } from "crypto";
import { prisma } from "../prisma";

const BCRYPT_ROUNDS = 10;
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const LOCKOUT_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_FAILED_ATTEMPTS = 5;

function getSecret(): string {
  const secret = process.env.WAREHOUSE_SECRET;
  if (!secret) {
    throw new Error("WAREHOUSE_SECRET не настроен");
  }
  return secret;
}

export async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, BCRYPT_ROUNDS);
}

export async function verifyPin(pin: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pin, hash);
}

export function generateToken(name: string): string {
  const secret = getSecret();
  const payload = { name, exp: Date.now() + TOKEN_TTL_MS };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64");
  const hmac = createHmac("sha256", secret)
    .update(payloadB64)
    .digest("hex");
  return `${payloadB64}:${hmac}`;
}

export function verifyToken(token: string): { name: string } | null {
  try {
    const colonIdx = token.lastIndexOf(":");
    if (colonIdx === -1) return null;

    const payloadB64 = token.slice(0, colonIdx);
    const hmacProvided = token.slice(colonIdx + 1);

    const secret = getSecret();
    const hmacExpected = createHmac("sha256", secret)
      .update(payloadB64)
      .digest("hex");

    const providedBuf = Buffer.from(hmacProvided, "utf8");
    const expectedBuf = Buffer.from(hmacExpected, "utf8");
    if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) return null;

    const payload = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8"));
    if (typeof payload.name !== "string" || typeof payload.exp !== "number") return null;
    if (Date.now() > payload.exp) return null;

    return { name: payload.name };
  } catch {
    return null;
  }
}

export async function authenticateWorker(
  name: string,
  pin: string,
): Promise<{ token: string; name: string; expiresAt: string } | { error: string }> {
  const worker = await prisma.warehousePin.findUnique({ where: { name } });

  if (!worker) {
    return { error: "Неверное имя или PIN-код" };
  }

  if (!worker.isActive) {
    return { error: "Аккаунт деактивирован" };
  }

  // Check lockout
  if (
    worker.failedAttempts >= MAX_FAILED_ATTEMPTS &&
    worker.lockedUntil !== null &&
    worker.lockedUntil > new Date()
  ) {
    return { error: "Аккаунт заблокирован" };
  }

  // Reset counter if lockout period expired
  if (worker.failedAttempts >= MAX_FAILED_ATTEMPTS && (worker.lockedUntil === null || worker.lockedUntil <= new Date())) {
    await prisma.warehousePin.update({
      where: { id: worker.id },
      data: { failedAttempts: 0, lockedUntil: null },
    });
    worker.failedAttempts = 0;
  }

  const correct = await verifyPin(pin, worker.pinHash);

  if (!correct) {
    const newFailedAttempts = worker.failedAttempts + 1;
    const shouldLock = newFailedAttempts >= MAX_FAILED_ATTEMPTS;
    await prisma.warehousePin.update({
      where: { id: worker.id },
      data: {
        failedAttempts: newFailedAttempts,
        ...(shouldLock ? { lockedUntil: new Date(Date.now() + LOCKOUT_TTL_MS) } : {}),
      },
    });
    return { error: "Неверное имя или PIN-код" };
  }

  // Success: reset failed attempts and update lastLoginAt
  await prisma.warehousePin.update({
    where: { id: worker.id },
    data: {
      failedAttempts: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
    },
  });

  const token = generateToken(worker.name);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
  return { token, name: worker.name, expiresAt };
}
