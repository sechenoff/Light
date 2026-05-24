import crypto from "node:crypto";
import { Prisma, PrismaClient, ClientPortalMagicLinkPurpose } from "@prisma/client";

const TOKEN_BYTES = 32;
const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const LOGIN_TTL_MS = 15 * 60 * 1000;

function getSecret(): string {
  const s = process.env.CLIENT_PORTAL_TOKEN_SECRET;
  if (!s || s.length < 16) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("CLIENT_PORTAL_TOKEN_SECRET обязателен в production");
    }
    return "lk-token-dev-secret-xxxxxxxxxxxxxxxx";
  }
  return s;
}

export function hashToken(raw: string): string {
  return crypto.createHmac("sha256", getSecret()).update(raw).digest("base64url");
}

export function generateRawToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

export async function issueMagicLink(
  client: PrismaClient | Prisma.TransactionClient,
  accountId: string,
  purpose: ClientPortalMagicLinkPurpose,
): Promise<{ rawToken: string; expiresAt: Date }> {
  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const ttl = purpose === "INVITE" ? INVITE_TTL_MS : LOGIN_TTL_MS;
  const expiresAt = new Date(Date.now() + ttl);

  await client.clientPortalMagicLink.create({
    data: { accountId, tokenHash, purpose, expiresAt },
  });

  return { rawToken, expiresAt };
}

export type ConsumeResult = {
  accountId: string;
  purpose: ClientPortalMagicLinkPurpose;
};

export async function consumeMagicLink(
  client: PrismaClient,
  rawToken: string,
  meta: { ip: string | null; ua: string | null },
): Promise<ConsumeResult | null> {
  const tokenHash = hashToken(rawToken);

  return client.$transaction(async (tx) => {
    const link = await tx.clientPortalMagicLink.findUnique({ where: { tokenHash } });
    if (!link) return null;
    if (link.usedAt) return null;
    if (link.expiresAt.getTime() < Date.now()) return null;

    // Race-safe: only one tx wins
    const updated = await tx.clientPortalMagicLink.updateMany({
      where: { id: link.id, usedAt: null },
      data: { usedAt: new Date(), ip: meta.ip ?? undefined, ua: meta.ua ?? undefined },
    });
    if (updated.count === 0) return null;

    return { accountId: link.accountId, purpose: link.purpose };
  });
}

export async function invalidateUnusedInvites(
  tx: Prisma.TransactionClient,
  accountId: string,
): Promise<void> {
  await tx.clientPortalMagicLink.updateMany({
    where: { accountId, purpose: "INVITE", usedAt: null, expiresAt: { gt: new Date() } },
    data: { expiresAt: new Date() },
  });
}
