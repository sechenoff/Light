import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler } from "express";

export type AuditActor = { id: string; username: string; role: string };
const context = new AsyncLocalStorage<{ actor: AuditActor | null }>();

/** Автор берётся только из проверенной сессии, никогда из тела запроса. */
export const auditContext: RequestHandler = (req, _res, next) => {
  const user = req.adminUser;
  context.run(
    {
      actor: user
        ? { id: user.userId, username: user.username, role: user.role }
        : null,
    },
    next,
  );
};
export function currentAuditActor(): AuditActor | null {
  return context.getStore()?.actor ?? null;
}
export function financeAuditPayload(payload: Record<string, unknown> = {}) {
  return {
    ...payload,
    auditActor: currentAuditActor(),
    auditSource: currentAuditActor()
      ? "account"
      : context.getStore()
        ? "unknown"
        : "system",
  };
}
