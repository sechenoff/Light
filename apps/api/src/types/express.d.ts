import type { UserRole } from "@prisma/client";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Сессия авторизованного администратора (заполняется sessionParser) */
      adminUser?: {
        userId: string;
        username: string;
        role: UserRole;
      };
      /** Флаг: запрос пришёл от бот-ключа openclaw-*, прошедшего botScopeGuard */
      botAccess?: boolean;
      /** Customer Portal: сессия аутентифицированного клиента (заполняется lkAuth) */
      clientPortal?: {
        accountId: string;
        clientId: string;
        email: string;
      };
    }
  }
}

export {};
