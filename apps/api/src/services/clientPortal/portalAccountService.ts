import { prisma } from "../../prisma";
import { consumeMagicLinkInTx } from "./magicLink";

export type LoginMeta = { ip: string | null; ua: string | null };

export type LoginResult =
  | { ok: true; account: { id: string; clientId: string; email: string } }
  | { ok: false; reason: "INVALID_TOKEN" };

/**
 * Атомарно потребляет magic-link и активирует/обновляет аккаунт портала.
 * Возвращает облегчённый payload для подписи сессии.
 *
 * Все DISABLED-аккаунты возвращают INVALID_TOKEN, чтобы не утекать наличие аккаунта.
 */
export async function loginViaMagicLink(rawToken: string, meta: LoginMeta): Promise<LoginResult> {
  return prisma.$transaction(async (tx) => {
    const consumed = await consumeMagicLinkInTx(tx, rawToken, meta);
    if (!consumed) return { ok: false, reason: "INVALID_TOKEN" } as const;

    const account = await tx.clientPortalAccount.findUnique({ where: { id: consumed.accountId } });
    if (!account || account.status === "DISABLED") {
      return { ok: false, reason: "INVALID_TOKEN" } as const;
    }

    const now = new Date();
    await tx.clientPortalAccount.update({
      where: { id: account.id },
      data: {
        status: account.status === "PENDING" ? "ACTIVE" : account.status,
        acceptedAt: account.acceptedAt ?? now,
        lastLoginAt: now,
        lastLoginIp: meta.ip ?? undefined,
        lastLoginUa: meta.ua ?? undefined,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    return {
      ok: true,
      account: { id: account.id, clientId: account.clientId, email: account.email },
    } as const;
  });
}
