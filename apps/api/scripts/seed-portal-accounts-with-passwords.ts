/**
 * Создаёт ClientPortalAccount для каждого Client без аккаунта.
 * Генерирует email-like логин из имени клиента + случайный 12-char пароль.
 * Пароли НЕ сохраняются — выводятся в STDOUT в табличном виде.
 *
 * Использование:
 *   tsx apps/api/scripts/seed-portal-accounts-with-passwords.ts > ~/lk-credentials.txt
 *
 * Идемпотентность: если у клиента уже есть ClientPortalAccount — пропускается (НЕ перезаписывает пароль).
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../src/services/clientPortal/password";

const prisma = new PrismaClient();

// Кириллица → латиница (упрощённая GOST-style транслитерация)
const TR: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "sch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

function slugify(name: string): string {
  const lower = name.toLowerCase();
  let out = "";
  for (const ch of lower) {
    if (TR[ch] !== undefined) out += TR[ch];
    else if (/[a-z0-9]/.test(ch)) out += ch;
    else if (/\s|[-_.]/.test(ch)) out += "-";
  }
  return out.replace(/-+/g, "-").replace(/^-|-$/g, "") || "client";
}

function generatePassword(): string {
  // 12 char base-like (no ambiguous 0/O/1/l/I) — easy to dictate over phone
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz";
  const bytes = randomBytes(12);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

async function main() {
  const clients = await prisma.client.findMany({
    include: { portalAccount: true },
    orderBy: { name: "asc" },
  });

  const used = new Set<string>();
  const created: Array<{ clientName: string; email: string; password: string }> = [];
  const skipped: string[] = [];

  for (const client of clients) {
    if (client.portalAccount) {
      skipped.push(client.name);
      continue;
    }

    const slug = slugify(client.name);
    let candidate = `${slug}@svetobazarent.lk`;
    let n = 2;
    // Avoid collisions both with in-batch and persisted accounts
    while (
      used.has(candidate) ||
      (await prisma.clientPortalAccount.findUnique({ where: { email: candidate } }))
    ) {
      candidate = `${slug}-${n}@svetobazarent.lk`;
      n++;
    }
    used.add(candidate);

    const password = generatePassword();
    const pwHash = await hashPassword(password);

    await prisma.clientPortalAccount.create({
      data: {
        clientId: client.id,
        email: candidate,
        status: "ACTIVE",
        passwordHash: pwHash,
        acceptedAt: new Date(),
      },
    });

    created.push({ clientName: client.name, email: candidate, password });
  }

  // STDOUT — табличный формат для редиректа в файл
  console.log("# Customer Portal /lk — credentials");
  console.log(`# generated: ${new Date().toISOString()}`);
  console.log(`# url: ${process.env.PUBLIC_BASE_URL || "https://svetobazarent.ru"}/lk/login`);
  console.log("");
  console.log("Имя клиента\tЛогин (email)\tПароль");
  for (const row of created) {
    console.log(`${row.clientName}\t${row.email}\t${row.password}`);
  }
  if (skipped.length > 0) {
    console.log("");
    console.log("# Пропущено (уже есть портал-аккаунт):");
    for (const name of skipped) console.log(`# - ${name}`);
  }
  console.log(`# created=${created.length} skipped=${skipped.length}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    console.error(err);
    prisma.$disconnect();
    process.exit(1);
  });
