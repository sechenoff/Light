/**
 * Идемпотентный скрипт: создаёт начальных админ-пользователей, если их ещё нет.
 * Запуск: `npx tsx scripts/seed-admin-users.ts`
 * Вызывается автоматически в deploy.sh после `prisma db push`.
 *
 * Логины case-insensitive (хранятся lowercase). Пароли меняются через UI после входа.
 *   sechenoff / test  (SUPER_ADMIN)
 *   super     / тест  (SUPER_ADMIN)
 *   admin     / тест  (WAREHOUSE)
 */
import { prisma } from "../src/prisma";
import { hashPassword, normalizeUsername } from "../src/services/auth";

async function ensureUser(username: string, password: string, role: "SUPER_ADMIN" | "WAREHOUSE" | "TECHNICIAN") {
  const normalized = normalizeUsername(username);
  const existing = await prisma.adminUser.findUnique({ where: { username: normalized } });
  if (existing) {
    // eslint-disable-next-line no-console
    console.log(`✓ ${role.padEnd(12)} ${normalized}: уже существует`);
    return;
  }
  const passwordHash = await hashPassword(password);
  await prisma.adminUser.create({
    data: { username: normalized, passwordHash, role },
  });
  // eslint-disable-next-line no-console
  console.log(`+ ${role.padEnd(12)} ${normalized}: создан (пароль: ${password})`);
}

async function main() {
  await ensureUser("Sechenoff", "test", "SUPER_ADMIN");
  await ensureUser("super", "тест", "SUPER_ADMIN");
  await ensureUser("admin", "тест", "WAREHOUSE");
}

main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
