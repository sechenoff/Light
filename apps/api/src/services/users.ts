import { prisma } from "../prisma";
import type { User } from "@prisma/client";

export type UpsertUserInput = {
  telegramId: bigint;
  username?: string | null;
  firstName?: string | null;
};

/**
 * Создаёт пользователя по telegramId или обновляет username/firstName если изменились.
 */
export async function upsertUser(input: UpsertUserInput): Promise<User> {
  return prisma.user.upsert({
    where: { telegramId: input.telegramId },
    create: {
      telegramId: input.telegramId,
      username: input.username ?? null,
      firstName: input.firstName ?? null,
    },
    update: {
      username: input.username ?? null,
      firstName: input.firstName ?? null,
    },
  });
}
