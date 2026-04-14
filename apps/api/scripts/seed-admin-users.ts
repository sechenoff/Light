/**
 * Идемпотентный скрипт: создаёт начальных админ-пользователей, если их ещё нет.
 * Запуск: `npx tsx scripts/seed-admin-users.ts`
 * Вызывается автоматически в deploy.sh после `prisma db push`.
 *
 * Логины/пароли по умолчанию (меняются через UI после первого входа):
 *   super / тест  (SUPER_ADMIN)
 *   admin / тест  (RENTAL_ADMIN)
 */
import { prisma } from "../src/prisma";
import { hashPassword } from "../src/services/auth";

async function ensureUser(username: string, password: string, role: "SUPER_ADMIN" | "RENTAL_ADMIN") {
  const existing = await prisma.adminUser.findUnique({ where: { username } });
  if (existing) {
    // eslint-disable-next-line no-console
    console.log(`✓ ${role.padEnd(12)} ${username}: уже существует`);
    return;
  }
  const passwordHash = await hashPassword(password);
  await prisma.adminUser.create({
    data: { username, passwordHash, role },
  });
  // eslint-disable-next-line no-console
  console.log(`+ ${role.padEnd(12)} ${username}: создан (пароль: ${password})`);
}

async function main() {
  await ensureUser("super", "тест", "SUPER_ADMIN");
  await ensureUser("admin", "тест", "RENTAL_ADMIN");
}

main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
