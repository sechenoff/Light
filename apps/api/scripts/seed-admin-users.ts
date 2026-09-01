/**
 * Заводит ПЕРВОГО администратора на пустой системе. Запускается вручную:
 *   ADMIN_USERNAME=ivan ADMIN_PASSWORD='...' npx tsx scripts/seed-admin-users.ts
 *
 * Почему это больше не часть деплоя. Раньше скрипт вызывался из deploy.sh и
 * заводил три учётки с паролями «test» и «тест», в том числе `super` с правами
 * руководителя. Скрипт идемпотентный, поэтому смена пароля его переживала —
 * но УДАЛЕНИЕ нет: убранная учётка возвращалась при следующем деплое с тем же
 * тривиальным паролем. Владелец удалял дыру, а она отрастала.
 *
 * Теперь: никаких паролей по умолчанию, никакого автозапуска. Пароль берётся из
 * окружения, и если его нет — скрипт отказывается работать, а не подставляет
 * что-нибудь «на первое время». Учётка создаётся ровно одна и только если
 * администраторов в системе нет вовсе.
 */
import { prisma } from "../src/prisma";
import { hashPassword, normalizeUsername } from "../src/services/auth";

const MIN_PASSWORD_LENGTH = 12;

async function main() {
  const username = process.env.ADMIN_USERNAME?.trim();
  const password = process.env.ADMIN_PASSWORD;

  if (!username || !password) {
    throw new Error(
      "Нужны ADMIN_USERNAME и ADMIN_PASSWORD в окружении.\n" +
        "Пример: ADMIN_USERNAME=ivan ADMIN_PASSWORD='...' npx tsx scripts/seed-admin-users.ts",
    );
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Пароль короче ${MIN_PASSWORD_LENGTH} символов — так первого админа не заводим.`);
  }

  // Скрипт для БУТСТРАПА. Если админы уже есть, новых заводят через интерфейс,
  // где действуют роли и пишется аудит.
  const existingAdmins = await prisma.adminUser.count();
  if (existingAdmins > 0) {
    // eslint-disable-next-line no-console
    console.log(`В системе уже ${existingAdmins} администратор(ов) — бутстрап не нужен, выхожу.`);
    return;
  }

  const normalized = normalizeUsername(username);
  await prisma.adminUser.create({
    data: { username: normalized, passwordHash: await hashPassword(password), role: "SUPER_ADMIN" },
  });
  // Пароль в вывод не печатаем: он и так у того, кто запускал.
  // eslint-disable-next-line no-console
  console.log(`Создан первый администратор: ${normalized} (роль SUPER_ADMIN).`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : err);
    await prisma.$disconnect();
    process.exit(1);
  });
