/**
 * Интеграционный тест: applyIssuanceToMainEstimate — смета MAIN после выдачи в
 * киоске правится точечно, по снимку цен, а не пересобирается по прайсу.
 *  - строка уменьшается до выданного, цена — из снимка (прайс мог измениться)
 *  - строка, по которой не выдано ничего, удаляется; Estimate.id сохраняется
 *  - прибавка сверх сметы MAIN не трогает (её считает доп-смета)
 *  - произвольная позиция сопоставляется по названию
 *  - процент скидки не начисляется на договорные строки
 *  - идемпотентность и no-op без MAIN
 */

import path from "path";
import { execSync } from "child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../../prisma/test-main-estimate.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-main-est";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-main-est";
process.env.WAREHOUSE_SECRET = "test-warehouse-main-est-min16ch";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-main-est-min16chars0";

let prisma: any;
let bookingId: string;
let eq1Id: string;
let eq2Id: string;

async function seedFixture() {
  const client = await prisma.client.create({
    data: { name: "Main est test", phone: "+70000000888" },
  });

  const e1 = await prisma.equipment.create({
    data: {
      importKey: "main-est-eq1",
      name: "Aputure 600D",
      category: "COB",
      totalQuantity: 5,
      rentalRatePerShift: "1000",
      stockTrackingMode: "COUNT",
    },
  });
  eq1Id = e1.id;

  const e2 = await prisma.equipment.create({
    data: {
      importKey: "main-est-eq2",
      name: "Astera Titan",
      category: "LED",
      totalQuantity: 3,
      rentalRatePerShift: "500",
      stockTrackingMode: "COUNT",
    },
  });
  eq2Id = e2.id;

  const booking = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Main est project",
      startDate: new Date(Date.now() + 60 * 60 * 1000),
      endDate: new Date(Date.now() + 25 * 60 * 60 * 1000),
      status: "CONFIRMED",
      finalAmount: "0",
      amountPaid: "0",
      items: {
        create: [
          { equipmentId: eq1Id, quantity: 2 },
          { equipmentId: eq2Id, quantity: 1 },
        ],
      },
      estimates: {
        create: {
          kind: "MAIN",
          shifts: 1,
          subtotal: "2500",
          discountPercent: "10",
          discountAmount: "250",
          totalAfterDiscount: "2250",
          lines: {
            create: [
              {
                equipmentId: eq1Id,
                categorySnapshot: "COB",
                nameSnapshot: "Aputure 600D",
                quantity: 2,
                unitPrice: "1000",
                lineSum: "2000",
              },
              {
                equipmentId: eq2Id,
                categorySnapshot: "LED",
                nameSnapshot: "Astera Titan",
                quantity: 1,
                unitPrice: "500",
                lineSum: "500",
              },
            ],
          },
        },
      },
    },
  });
  bookingId = booking.id;
}

describe("applyIssuanceToMainEstimate", () => {
  beforeEach(async () => {
    execSync("npx prisma db push --skip-generate --force-reset", {
      cwd: path.resolve(__dirname, "../../.."),
      env: {
        ...process.env,
        DATABASE_URL: `file:${TEST_DB_PATH}`,
        PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes",
      },
      stdio: "pipe",
    });
    const pmod = await import("../../prisma");
    prisma = pmod.prisma;
    await seedFixture();
  });

  afterEach(async () => {
    await prisma?.$disconnect?.();
  });

  async function apply(id = bookingId) {
    const { applyIssuanceToMainEstimate } = await import("../mainEstimate");
    return prisma.$transaction((tx: any) => applyIssuanceToMainEstimate(tx, id));
  }

  async function loadMain() {
    return prisma.estimate.findFirst({
      where: { bookingId, kind: "MAIN" },
      include: { lines: true },
    });
  }

  it("уменьшает строку до выданного по цене из снимка, сохраняя скидку, смены и id сметы", async () => {
    const before = await loadMain();
    // Прайс подняли после подтверждения — клиенту это не должно стоить денег.
    await prisma.equipment.update({ where: { id: eq2Id }, data: { rentalRatePerShift: "900" } });
    await prisma.bookingItem.updateMany({ where: { bookingId, equipmentId: eq1Id }, data: { quantity: 1 } });

    const res = await apply();
    expect(res.changed).toBe(true);

    const main = await loadMain();
    expect(main.id).toBe(before.id);
    expect(main.discountPercent.toString()).toBe("10");
    expect(main.shifts).toBe(1);
    const eq1Line = main.lines.find((l: any) => l.equipmentId === eq1Id);
    expect(eq1Line.quantity).toBe(1);
    expect(eq1Line.unitPrice.toString()).toBe("1000");
    expect(eq1Line.lineSum.toString()).toBe("1000");
    // Вторая строка не переоценена по новому прайсу.
    const eq2Line = main.lines.find((l: any) => l.equipmentId === eq2Id);
    expect(eq2Line.lineSum.toString()).toBe("500");
    // subtotal = 1000 + 500 = 1500; скидка 10 % = 150; итог 1350.
    expect(main.subtotal.toString()).toBe("1500");
    expect(main.discountAmount.toString()).toBe("150");
    expect(main.totalAfterDiscount.toString()).toBe("1350");
  });

  it("строку, по которой ничего не выдано, удаляет", async () => {
    await prisma.bookingItem.updateMany({ where: { bookingId, equipmentId: eq2Id }, data: { quantity: 0 } });
    await apply();
    const main = await loadMain();
    expect(main.lines).toHaveLength(1);
    expect(main.lines[0].equipmentId).toBe(eq1Id);
    expect(main.totalAfterDiscount.toString()).toBe("1800");
  });

  it("прибавку сверх сметы не вливает в MAIN — это доп-смета", async () => {
    await prisma.bookingItem.updateMany({ where: { bookingId, equipmentId: eq1Id }, data: { quantity: 4 } });
    const res = await apply();
    expect(res.changed).toBe(false);
    const main = await loadMain();
    expect(main.lines.find((l: any) => l.equipmentId === eq1Id).quantity).toBe(2);
    expect(main.totalAfterDiscount.toString()).toBe("2250");
  });

  it("произвольную позицию сопоставляет по названию и берёт её цену из снимка", async () => {
    const main = await loadMain();
    await prisma.bookingItem.create({
      data: { bookingId, customName: "Доставка на площадку", customUnitPrice: "3000", quantity: 1 },
    });
    await prisma.estimateLine.create({
      data: {
        estimateId: main.id,
        equipmentId: null,
        categorySnapshot: "Прочее",
        nameSnapshot: "Доставка на площадку",
        quantity: 2,
        unitPrice: "3000",
        lineSum: "6000",
      },
    });
    await apply();
    const after = await loadMain();
    const custom = after.lines.find((l: any) => l.equipmentId === null);
    expect(custom.quantity).toBe(1);
    expect(custom.lineSum.toString()).toBe("3000");
  });

  it("прибавку по произвольной позиции держит сама MAIN по цене из снимка: в доп-смету она не попадает", async () => {
    const main = await loadMain();
    await prisma.bookingItem.create({
      data: { bookingId, customName: "Генераторщик", customUnitPrice: "4000", quantity: 2 },
    });
    await prisma.estimateLine.create({
      data: {
        estimateId: main.id,
        equipmentId: null,
        categorySnapshot: "Прочее",
        nameSnapshot: "Генераторщик",
        quantity: 1,
        unitPrice: "3500",
        lineSum: "3500",
      },
    });
    const res = await apply();
    expect(res.changed).toBe(true);
    const after = await loadMain();
    const custom = after.lines.find((l: any) => l.equipmentId === null);
    // Цена — из снимка сметы (3500), а не из позиции брони.
    expect(custom.quantity).toBe(2);
    expect(custom.lineSum.toString()).toBe("7000");
    // subtotal = 2000 + 500 + 7000 = 9500; скидка 10 % = 950; итог 8550.
    expect(after.subtotal.toString()).toBe("9500");
    expect(after.totalAfterDiscount.toString()).toBe("8550");
    // Каталожные строки по-прежнему только уменьшаются.
    expect(after.lines.find((l: any) => l.equipmentId === eq1Id).quantity).toBe(2);
  });

  it("процент скидки не начисляет на договорную строку", async () => {
    // eq1 — договорная (listUnitPrice задан): скидка ложится только на eq2.
    await prisma.estimateLine.updateMany({
      where: { equipmentId: eq1Id },
      data: { listUnitPrice: "1500" },
    });
    await prisma.bookingItem.updateMany({ where: { bookingId, equipmentId: eq1Id }, data: { quantity: 1 } });
    await apply();
    const main = await loadMain();
    // 1000 (договорная) + 500 − 10 % × 500 = 1450.
    expect(main.discountAmount.toString()).toBe("50");
    expect(main.totalAfterDiscount.toString()).toBe("1450");
  });

  it("идемпотентна: повтор ничего не меняет", async () => {
    await prisma.bookingItem.updateMany({ where: { bookingId, equipmentId: eq1Id }, data: { quantity: 1 } });
    await apply();
    const first = await loadMain();
    const res = await apply();
    expect(res.changed).toBe(false);
    const second = await loadMain();
    expect(second.totalAfterDiscount.toString()).toBe(first.totalAfterDiscount.toString());
    expect(second.lines.length).toBe(first.lines.length);
  });

  it("без MAIN — ничего не делает", async () => {
    const res = await apply("non-existent-id");
    expect(res).toEqual({ changed: false, totalAfterDiscount: null });
  });
});
