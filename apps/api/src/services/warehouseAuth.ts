import bcrypt from "bcryptjs";
import { createHmac } from "crypto";
import { prisma } from "../prisma";

const BCRYPT_ROUNDS = 10;
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const LOCKOUT_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_FAILED_ATTEMPTS = 5;
const HMAC_HEX_LENGTH = 12;

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
    .digest("hex")
    .slice(0, HMAC_HEX_LENGTH);
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
      .digest("hex")
      .slice(0, HMAC_HEX_LENGTH);

    if (hmacProvided !== hmacExpected) return null;

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
): Promise<{ token: string } | { error: string }> {
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

  return { token: generateToken(worker.name) };
}
