/**
 * Роутер /api/admin/clients/:id — административные действия с порталом клиента.
 *
 * Все маршруты требуют роль SUPER_ADMIN и JWT-сессию.
 * Роутер монтируется с mergeParams: true (params.id = clientId).
 *
 * POST   /portal-invite          — создать/обновить аккаунт, выдать INVITE-ссылку
 * GET    /portal-account         — получить аккаунт (или null)
 * POST   /portal-account/disable — заблокировать аккаунт
 * POST   /portal-account/reenable — разблокировать аккаунт
 * POST   /portal-account/resend  — переиздать INVITE-ссылку
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma";
import { rolesGuard } from "../middleware/rolesGuard";
import { writeAuditEntry } from "../services/audit";
import {
  issueMagicLink,
  invalidateUnusedInvites,
} from "../services/clientPortal/magicLink";
import { sendInviteEmail } from "../services/clientPortal/mailer";
import { HttpError } from "../utils/errors";

const router = Router({ mergeParams: true });

const superAdminGuard = rolesGuard(["SUPER_ADMIN"]);

/**
 * Ссылка-приглашение — та же, что уходит в письме (mailer.ts строит её так же).
 * Возвращается менеджеру в ответе, чтобы при провале SMTP он мог отправить
 * ссылку клиенту вручную (мессенджер и т.п.). Токен восстановить из БД
 * невозможно (хранится только HMAC-hash), поэтому единственная точка выдачи —
 * момент создания.
 */
function buildInviteUrl(rawToken: string): string {
  const base = process.env.PUBLIC_BASE_URL || "http://localhost:3000";
  return `${base}/lk/verify?token=${encodeURIComponent(rawToken)}`;
}

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const inviteBodySchema = z.object({
  email: z.string().email().toLowerCase().trim(),
});

// resend: опционально можно исправить адрес (опечатка при приглашении) —
// аккаунт обновляется и ссылка уходит уже на новый email.
const resendBodySchema = z.object({
  newEmail: z.string().email().toLowerCase().trim().optional(),
});

// ─── POST /portal-invite ─────────────────────────────────────────────────────

router.post("/portal-invite", superAdminGuard, async (req, res, next) => {
  try {
    const { email } = inviteBodySchema.parse(req.body);
    const clientId = req.params.id;

    // Проверяем, что клиент существует
    const client = await prisma.client.findUnique({ where: { id: clientId } });
    if (!client) throw new HttpError(404, "Клиент не найден", "CLIENT_NOT_FOUND");

    const adminUserId = req.adminUser!.userId;

    // Транзакция: upsert аккаунта + инвалидация старых INVITE + создание нового
    const { account, rawToken, expiresAt } = await prisma.$transaction(async (tx) => {
      // Upsert аккаунта (clientId уникален — один аккаунт на клиента)
      const existingByClient = await tx.clientPortalAccount.findUnique({
        where: { clientId },
      });
      const existingByEmail = email
        ? await tx.clientPortalAccount.findUnique({ where: { email } })
        : null;

      // Если email занят другим клиентом — 409
      if (existingByEmail && existingByEmail.clientId !== clientId) {
        throw new HttpError(409, "Email уже используется другим клиентом", "EMAIL_TAKEN");
      }

      let acc;
      if (existingByClient) {
        acc = await tx.clientPortalAccount.update({
          where: { id: existingByClient.id },
          data: {
            email,
            status: existingByClient.status === "DISABLED" ? "PENDING" : existingByClient.status,
            invitedAt: new Date(),
            invitedBy: adminUserId,
          },
        });
      } else {
        acc = await tx.clientPortalAccount.create({
          data: {
            clientId,
            email,
            status: "PENDING",
            invitedAt: new Date(),
            invitedBy: adminUserId,
          },
        });
      }

      // Инвалидируем неиспользованные INVITE-токены
      await invalidateUnusedInvites(tx, acc.id);

      // Создаём новый INVITE-токен
      const link = await issueMagicLink(tx, acc.id, "INVITE");

      await writeAuditEntry({
        tx,
        userId: adminUserId,
        action: "CLIENT_PORTAL_INVITE_SENT",
        entityType: "ClientPortalAccount",
        entityId: acc.id,
        before: null,
        after: { email, status: acc.status, clientId },
      });

      return { account: acc, rawToken: link.rawToken, expiresAt: link.expiresAt };
    });

    // Email — вне транзакции (сбой не должен откатывать аудит).
    // Провал НЕ глотаем молча: менеджер получает emailSent:false + inviteUrl
    // для ручной отправки ссылки клиенту.
    let emailSent = true;
    try {
      await sendInviteEmail({ email: account.email, clientName: client.name }, rawToken);
    } catch (mailErr) {
      emailSent = false;
      // eslint-disable-next-line no-console
      console.error("[LK admin] sendInviteEmail failed:", mailErr);
    }

    res.json({
      accountId: account.id,
      email: account.email,
      expiresAt,
      emailSent,
      inviteUrl: buildInviteUrl(rawToken),
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /portal-account ──────────────────────────────────────────────────────

router.get("/portal-account", superAdminGuard, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    const account = await prisma.clientPortalAccount.findUnique({ where: { clientId } });
    res.json({ account: account ?? null });
  } catch (err) {
    next(err);
  }
});

// ─── POST /portal-account/disable ────────────────────────────────────────────

router.post("/portal-account/disable", superAdminGuard, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    const adminUserId = req.adminUser!.userId;

    const existing = await prisma.clientPortalAccount.findUnique({ where: { clientId } });
    if (!existing) throw new HttpError(404, "Аккаунт портала не найден", "ACCOUNT_NOT_FOUND");

    const account = await prisma.$transaction(async (tx) => {
      const updated = await tx.clientPortalAccount.update({
        where: { id: existing.id },
        data: {
          status: "DISABLED",
          disabledAt: new Date(),
          disabledBy: adminUserId,
        },
      });

      await writeAuditEntry({
        tx,
        userId: adminUserId,
        action: "CLIENT_PORTAL_DISABLED",
        entityType: "ClientPortalAccount",
        entityId: existing.id,
        before: { status: existing.status },
        after: { status: "DISABLED", disabledBy: adminUserId },
      });

      return updated;
    });

    res.json({ account });
  } catch (err) {
    next(err);
  }
});

// ─── POST /portal-account/reenable ───────────────────────────────────────────

router.post("/portal-account/reenable", superAdminGuard, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    const adminUserId = req.adminUser!.userId;

    const existing = await prisma.clientPortalAccount.findUnique({ where: { clientId } });
    if (!existing) throw new HttpError(404, "Аккаунт портала не найден", "ACCOUNT_NOT_FOUND");

    const account = await prisma.$transaction(async (tx) => {
      const updated = await tx.clientPortalAccount.update({
        where: { id: existing.id },
        data: {
          status: "ACTIVE",
          disabledAt: null,
          disabledBy: null,
        },
      });

      await writeAuditEntry({
        tx,
        userId: adminUserId,
        action: "CLIENT_PORTAL_REENABLED",
        entityType: "ClientPortalAccount",
        entityId: existing.id,
        before: { status: existing.status },
        after: { status: "ACTIVE" },
      });

      return updated;
    });

    res.json({ account });
  } catch (err) {
    next(err);
  }
});

// ─── POST /portal-account/resend ─────────────────────────────────────────────

router.post("/portal-account/resend", superAdminGuard, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    const adminUserId = req.adminUser!.userId;
    const { newEmail } = resendBodySchema.parse(req.body ?? {});

    const existing = await prisma.clientPortalAccount.findUnique({
      where: { clientId },
      include: { client: { select: { name: true } } },
    });
    if (!existing) throw new HttpError(404, "Аккаунт портала не найден", "ACCOUNT_NOT_FOUND");
    if (existing.status === "DISABLED") {
      throw new HttpError(409, "Нельзя переслать приглашение заблокированному аккаунту", "ACCOUNT_DISABLED");
    }

    // «Отправить на другой адрес»: правим email аккаунта до пересылки ссылки.
    const emailChanged = Boolean(newEmail) && newEmail !== existing.email;

    const { rawToken, expiresAt, targetEmail } = await prisma.$transaction(async (tx) => {
      let email = existing.email;

      if (emailChanged && newEmail) {
        // Email занят другим клиентом — 409 (та же семантика, что у /portal-invite)
        const taken = await tx.clientPortalAccount.findUnique({ where: { email: newEmail } });
        if (taken && taken.clientId !== clientId) {
          throw new HttpError(409, "Email уже используется другим клиентом", "EMAIL_TAKEN");
        }
        await tx.clientPortalAccount.update({
          where: { id: existing.id },
          data: { email: newEmail },
        });
        email = newEmail;
      }

      // Инвалидируем неиспользованные INVITE-токены
      await invalidateUnusedInvites(tx, existing.id);

      // Создаём новый INVITE-токен
      const link = await issueMagicLink(tx, existing.id, "INVITE");

      await writeAuditEntry({
        tx,
        userId: adminUserId,
        action: "CLIENT_PORTAL_INVITE_RESENT",
        entityType: "ClientPortalAccount",
        entityId: existing.id,
        before: emailChanged ? { email: existing.email } : null,
        after: { email, expiresAt: link.expiresAt },
      });

      return { rawToken: link.rawToken, expiresAt: link.expiresAt, targetEmail: email };
    });

    // Email — вне транзакции. Провал не глотаем молча — см. /portal-invite.
    let emailSent = true;
    try {
      await sendInviteEmail(
        { email: targetEmail, clientName: existing.client?.name },
        rawToken,
      );
    } catch (mailErr) {
      emailSent = false;
      // eslint-disable-next-line no-console
      console.error("[LK admin] sendInviteEmail (resend) failed:", mailErr);
    }

    res.json({ email: targetEmail, expiresAt, emailSent, inviteUrl: buildInviteUrl(rawToken) });
  } catch (err) {
    next(err);
  }
});

export default router;
