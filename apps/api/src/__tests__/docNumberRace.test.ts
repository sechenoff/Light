/**
 * Номер сметы под гонкой.
 *
 * Номер выдаётся чтением «последнего занятого», без резервирования: два
 * одновременных создания получают одинаковое значение, и вторая запись падает
 * на уникальном индексе. Для пользователя это «бронь не создалась» на ровном
 * месте — при двойном клике или когда бот и веб создают бронь одновременно.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-docnumber-race.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-docnum";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-docnum";
process.env.JWT_SECRET = "test-jwt-secret-docnum-min16chars";

let prisma: any;
let createBookingDraft: any;

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: {
      ...process.env,
      DATABASE_URL: `file:${TEST_DB_PATH}`,
      PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes",
    },
    stdio: "pipe",
  });

  const pmod = await import("../prisma");
  prisma = pmod.prisma;
  ({ createBookingDraft } = await import("../services/bookings"));
});

afterAll(async () => {
  await prisma.$disconnect();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
  }
});

async function makeClientAndEquipment(tag: string) {
  const client = await prisma.client.create({ data: { name: `Клиент ${tag}` } });
  const equipment = await prisma.equipment.create({
    data: {
      name: `Прибор ${tag}`,
      importKey: `prib-${tag}-${Date.now()}`,
      category: "COB Light",
      rentalRatePerShift: 1000,
      totalQuantity: 50,
    },
  });
  return { client, equipment };
}

function draftArgs(clientId: string, equipmentId: string, projectName: string) {
  return {
    clientId,
    projectName,
    startDate: new Date("2026-09-01T09:00:00Z"),
    endDate: new Date("2026-09-02T09:00:00Z"),
    items: [{ equipmentId, quantity: 1 }],
  };
}

describe("номер сметы под гонкой", () => {
  it("одиночное создание получает номер вида СМ-ГОД-NNNN", async () => {
    const { client, equipment } = await makeClientAndEquipment("одиночный");
    const booking = await createBookingDraft(draftArgs(client.id, equipment.id, "Одиночная"));
    expect(booking.docNumber).toMatch(/^СМ-\d{4}-\d{4}$/);
  });

  it("пять одновременных созданий дают пять броней с разными номерами", async () => {
    // До починки все пять читали один и тот же «последний занятый» номер,
    // первая запись проходила, остальные падали на уникальном индексе — и
    // до пользователя доезжал отказ вместо созданной брони.
    const { client, equipment } = await makeClientAndEquipment("гонка");

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        createBookingDraft(draftArgs(client.id, equipment.id, `Параллельная ${i + 1}`)),
      ),
    );

    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(0);

    const numbers = results
      .filter((r): r is PromiseFulfilledResult<{ docNumber: string }> => r.status === "fulfilled")
      .map((r) => r.value.docNumber);
    expect(numbers).toHaveLength(5);
    expect(new Set(numbers).size).toBe(5);
    for (const n of numbers) expect(n).toMatch(/^СМ-\d{4}-\d{4}$/);
  });

  it("архивация брони не освобождает её номер", async () => {
    // Штатное удаление в системе мягкое: строка остаётся с deletedAt, поэтому
    // максимум не откатывается и следующая бронь получает новый номер.
    //
    // ОГОВОРКА: физическое удаление (purge) номер освобождает — нумерация
    // считается от максимума существующих строк, а не от вечного счётчика.
    // Мириться с этим можно ровно потому, что purge доступен только
    // SUPER_ADMIN и запрещён, когда по броне есть счета или платежи
    // (PURGE_HAS_FINANCE) — то есть удалить можно лишь то, за что никто не
    // платил. Понадобится строгая непрерывность — нужен отдельный счётчик.
    const { client, equipment } = await makeClientAndEquipment("архив");
    const first = await createBookingDraft(draftArgs(client.id, equipment.id, "Будет в архиве"));
    await prisma.booking.update({ where: { id: first.id }, data: { deletedAt: new Date() } });
    const second = await createBookingDraft(draftArgs(client.id, equipment.id, "После архива"));
    expect(second.docNumber).not.toBe(first.docNumber);
  });
});
