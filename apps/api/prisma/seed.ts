import Decimal from "decimal.js";

import { prisma } from "../src/prisma";

function nk(s: string) {
  return s.trim().replace(/\s+/g, " ").toUpperCase();
}

function importKey(
  category: string,
  name: string,
  brand?: string | null,
  model?: string | null
) {
  return [nk(category), nk(name), nk(brand ?? ""), nk(model ?? "")].join("||");
}

async function main() {
  const client1 = await prisma.client.upsert({
    where: { name: "Svetobaza (test)" },
    update: {},
    create: { name: "Svetobaza (test)" },
  });

  const equipmentCountBased = [
    {
      category: "LED",
      name: "Panel 100W (без управляющего софта)",
      brand: "Generic",
      model: "LED-100",
      totalQuantity: 6,
      rentalRatePerShift: new Decimal(3500),
      comment: "Пример для seed. Можно заменить на реальный парк.",
    },
    {
      category: "LED",
      name: "Panel 150W",
      brand: "Generic",
      model: "LED-150",
      totalQuantity: 4,
      rentalRatePerShift: new Decimal(4700),
      comment: null,
    },
    {
      category: "Оптика",
      name: "Линза 85mm",
      brand: "Generic",
      model: "LENS-85",
      totalQuantity: 10,
      rentalRatePerShift: new Decimal(1200),
      comment: null,
    },
  ] as const;

  for (const eq of equipmentCountBased) {
    await prisma.equipment.upsert({
      where: { importKey: importKey(eq.category, eq.name, eq.brand, eq.model) },
      update: {
        stockTrackingMode: "COUNT",
        category: eq.category,
        name: eq.name,
        brand: eq.brand,
        model: eq.model,
        comment: eq.comment ?? null,
        totalQuantity: eq.totalQuantity,
        rentalRatePerShift: eq.rentalRatePerShift.toFixed(2),
        rentalRateTwoShifts: null,
        rentalRatePerProject: null,
      },
      create: {
        importKey: importKey(eq.category, eq.name, eq.brand, eq.model),
        stockTrackingMode: "COUNT",
        category: eq.category,
        name: eq.name,
        brand: eq.brand,
        model: eq.model,
        comment: eq.comment ?? null,
        totalQuantity: eq.totalQuantity,
        rentalRatePerShift: eq.rentalRatePerShift.toFixed(2),
        rentalRateTwoShifts: null,
        rentalRatePerProject: null,
      },
    });
  }

  const unitEq = {
    category: "Fresnel",
    name: "Fresnel 650W",
    brand: "Generic",
    model: "FRES-650",
    unitSerials: ["FS-650-001", "FS-650-002", "FS-650-003"],
    rentalRatePerShift: new Decimal(6200),
  };

  const unitEqKey = importKey(
    unitEq.category,
    unitEq.name,
    unitEq.brand,
    unitEq.model
  );

  const unitEquipment = await prisma.equipment.upsert({
    where: { importKey: unitEqKey },
    update: {
      stockTrackingMode: "UNIT",
      category: unitEq.category,
      name: unitEq.name,
      brand: unitEq.brand,
      model: unitEq.model,
      totalQuantity: unitEq.unitSerials.length,
      rentalRatePerShift: unitEq.rentalRatePerShift.toFixed(2),
      rentalRateTwoShifts: null,
      rentalRatePerProject: null,
      comment: null,
    },
    create: {
      importKey: unitEqKey,
      stockTrackingMode: "UNIT",
      category: unitEq.category,
      name: unitEq.name,
      brand: unitEq.brand,
      model: unitEq.model,
      totalQuantity: unitEq.unitSerials.length,
      rentalRatePerShift: unitEq.rentalRatePerShift.toFixed(2),
      rentalRateTwoShifts: null,
      rentalRatePerProject: null,
      comment: null,
    },
  });

  for (const sn of unitEq.unitSerials) {
    await prisma.equipmentUnit.upsert({
      where: { serialNumber: sn },
      update: {
        equipmentId: unitEquipment.id,
        comment: "Seed unit",
      },
      create: {
        equipmentId: unitEquipment.id,
        serialNumber: sn,
        comment: "Seed unit",
      },
    });
  }

  const start = new Date(Date.UTC(2026, 2, 20, 0, 0, 0));
  const end = new Date(Date.UTC(2026, 2, 22, 0, 0, 0));

  const conflictEquipment = await prisma.equipment.findUnique({
    where: {
      importKey: importKey(
        "LED",
        "Panel 100W (без управляющего софта)",
        "Generic",
        "LED-100"
      ),
    },
    select: { id: true },
  });

  if (conflictEquipment) {
    const existingBooking = await prisma.booking.findFirst({
      where: {
        projectName: "Seed conflict booking",
        clientId: client1.id,
      },
    });

    if (!existingBooking) {
      const booking = await prisma.booking.create({
        data: {
          clientId: client1.id,
          projectName: "Seed conflict booking",
          startDate: start,
          endDate: end,
          status: "CONFIRMED",
          discountPercent: null,
          items: {
            create: [{ equipmentId: conflictEquipment.id, quantity: 2 }],
          },
        },
        include: { items: true },
      });

      await prisma.booking.update({
        where: { id: booking.id },
        data: { confirmedAt: new Date() },
      });
    }
  }
}

async function seedVehicles() {
  const vehicles = [
    {
      slug: "ford",
      name: "Ford",
      shiftPriceRub: new Decimal(20000),
      hasGeneratorOption: false,
      generatorPriceRub: null,
      displayOrder: 1,
    },
    {
      slug: "foton",
      name: "Фотон",
      shiftPriceRub: new Decimal(25000),
      hasGeneratorOption: false,
      generatorPriceRub: null,
      displayOrder: 2,
    },
    {
      slug: "iveco",
      name: "Ивеко",
      shiftPriceRub: new Decimal(24000),
      hasGeneratorOption: true,
      generatorPriceRub: new Decimal(25000),
      displayOrder: 3,
    },
  ];

  for (const v of vehicles) {
    await prisma.vehicle.upsert({
      where: { slug: v.slug },
      update: {
        name: v.name,
        shiftPriceRub: v.shiftPriceRub.toFixed(2),
        hasGeneratorOption: v.hasGeneratorOption,
        generatorPriceRub: v.generatorPriceRub?.toFixed(2) ?? null,
        displayOrder: v.displayOrder,
      },
      create: {
        slug: v.slug,
        name: v.name,
        shiftPriceRub: v.shiftPriceRub.toFixed(2),
        hasGeneratorOption: v.hasGeneratorOption,
        generatorPriceRub: v.generatorPriceRub?.toFixed(2) ?? null,
        displayOrder: v.displayOrder,
        shiftHours: 12,
        overtimePercent: new Decimal(10).toFixed(2),
      },
    });
  }
  console.log("Seeded 3 vehicles: Ford, Фотон, Ивеко");
}

main()
  .then(async () => {
    await seedVehicles();
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });

