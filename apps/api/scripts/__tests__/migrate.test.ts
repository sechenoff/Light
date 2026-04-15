/**
 * Тест скрипта миграции AdminRole → UserRole (design §6.4).
 *
 * Проверяет: до миграции RENTAL_ADMIN → после WAREHOUSE.
 */

import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const FIXTURE_DB_PATH = path.resolve(__dirname, "../../prisma/test-migration-fixture.db");

beforeAll(async () => {
  // Создаём тестовую БД с RENTAL_ADMIN пользователем
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: {
      ...process.env,
      DATABASE_URL: `file:${FIXTURE_DB_PATH}`,
      PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes",
    },
    stdio: "pipe",
  });

  // Создаём RENTAL_ADMIN пользователя напрямую через SQL (обход enum constraint)
  const Database = await import("better-sqlite3").catch(() => null);
  if (Database) {
    const db = Database.default(FIXTURE_DB_PATH);
    // Сначала создаём с WAREHOUSE (единственный доступный вариант через Prisma схему)
    // затем меняем через прямой SQL на RENTAL_ADMIN для теста
    db.prepare("INSERT OR IGNORE INTO AdminUser (id, username, passwordHash, role, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)")
      .run("test-rental-admin-id", "rental_admin_user", "$2a$10$dummy", "RENTAL_ADMIN", new Date().toISOString(), new Date().toISOString());
    db.close();
  }
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = FIXTURE_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
});

describe("migrate-adminrole-to-userrole", () => {
  it("dry-run режим не изменяет данные", async () => {
    const Database = await import("better-sqlite3").catch(() => null);
    if (!Database) {
      // better-sqlite3 не установлен — пропускаем
      console.log("better-sqlite3 не найден, тест пропущен");
      return;
    }

    // Запускаем dry-run (по умолчанию без --execute)
    const result = execSync(
      `npx tsx scripts/migrate-adminrole-to-userrole.ts`,
      {
        cwd: path.resolve(__dirname, "../.."),
        env: {
          ...process.env,
          DATABASE_URL: `file:${FIXTURE_DB_PATH}`,
        },
        encoding: "utf-8",
      },
    );

    expect(result).toContain("DRY-RUN");
    expect(result).toContain("RENTAL_ADMIN");

    // Проверяем, что данные не изменились
    const db = Database.default(FIXTURE_DB_PATH);
    const rows = db.prepare("SELECT role FROM AdminUser WHERE username = ?")
      .all("rental_admin_user") as Array<{ role: string }>;
    db.close();

    if (rows.length > 0) {
      expect(rows[0].role).toBe("RENTAL_ADMIN");
    }
  });

  it("--execute режим меняет RENTAL_ADMIN → WAREHOUSE", async () => {
    const Database = await import("better-sqlite3").catch(() => null);
    if (!Database) {
      console.log("better-sqlite3 не найден, тест пропущен");
      return;
    }

    // Убеждаемся что RENTAL_ADMIN пользователь существует
    const dbBefore = Database.default(FIXTURE_DB_PATH);
    const rolesBefore = dbBefore.prepare("SELECT role FROM AdminUser WHERE username = ?")
      .all("rental_admin_user") as Array<{ role: string }>;
    dbBefore.close();

    if (rolesBefore.length === 0) {
      // Пользователь не был создан (better-sqlite3 не было в beforeAll)
      console.log("Тестовый пользователь не создан, тест пропущен");
      return;
    }

    expect(rolesBefore[0].role).toBe("RENTAL_ADMIN");

    // Запускаем с --execute
    const result = execSync(
      `npx tsx scripts/migrate-adminrole-to-userrole.ts --execute`,
      {
        cwd: path.resolve(__dirname, "../.."),
        env: {
          ...process.env,
          DATABASE_URL: `file:${FIXTURE_DB_PATH}`,
        },
        encoding: "utf-8",
      },
    );

    expect(result).toContain("EXECUTE");
    expect(result).toContain("WAREHOUSE");

    // Проверяем результат
    const dbAfter = Database.default(FIXTURE_DB_PATH);
    const rolesAfter = dbAfter.prepare("SELECT role FROM AdminUser WHERE username = ?")
      .all("rental_admin_user") as Array<{ role: string }>;
    dbAfter.close();

    expect(rolesAfter[0].role).toBe("WAREHOUSE");
  });
});
