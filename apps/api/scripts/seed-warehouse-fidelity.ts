/**
 * One-off seed script for warehouse-scan design fidelity verification.
 * Creates: WarehousePin worker, Equipment (UNIT + COUNT), Bookings (CONFIRMED + ISSUED).
 * Usage: tsx apps/api/scripts/seed-warehouse-fidelity.ts
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { hashPin } from "../src/services/warehouseAuth";
import { hashPassword } from "../src/services/auth";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding warehouse fidelity test data...");

  // 1. WarehousePin worker
  const pinHash = await hashPin("1234");
  const worker = await prisma.warehousePin.upsert({
    where: { name: "Иван Кладовщик" },
    update: { pinHash },
    create: { name: "Иван Кладовщик", pinHash },
  });
  console.log(`WarehousePin: ${worker.name} (PIN: 1234)`);

  // 2. Client
  const client = await prisma.client.upsert({
    where: { id: "fidelity-client-01" },
    update: {},
    create: {
      id: "fidelity-client-01",
      name: "ООО «Кинопроба»",
      phone: "+7 999 000 00 00",
    },
  });
  console.log(`Client: ${client.name}`);

  // 3a. UNIT-tracked equipment: Aputure 600D (3 units)
  const aputure = await prisma.equipment.upsert({
    where: { importKey: "fidelity-aputure600d" },
    update: {},
    create: {
      id: "fidelity-eq-aputure600d",
      importKey: "fidelity-aputure600d",
      name: "Aputure 600D",
      category: "Свет",
      stockTrackingMode: "UNIT",
      totalQuantity: 3,
      rentalRatePerShift: 5000,
    },
  });
  console.log(`Equipment (UNIT): ${aputure.name}`);

  const unitIds = ["fidelity-unit-01", "fidelity-unit-02", "fidelity-unit-03"];
  for (let i = 0; i < unitIds.length; i++) {
    await prisma.equipmentUnit.upsert({
      where: { id: unitIds[i] },
      update: { status: "AVAILABLE" },
      create: {
        id: unitIds[i],
        equipmentId: aputure.id,
        status: "AVAILABLE",
        barcode: `LR-APU600-00${i + 1}`,
        barcodePayload: `${unitIds[i]}:aabbccdd1122`,
      },
    });
  }
  console.log(`Equipment units (3x AVAILABLE): ${unitIds.join(", ")}`);

  // 3b. COUNT-tracked equipment: Manfrotto 1004 stands (qty 4)
  const manfrotto = await prisma.equipment.upsert({
    where: { importKey: "fidelity-manfrotto1004" },
    update: {},
    create: {
      id: "fidelity-eq-manfrotto1004",
      importKey: "fidelity-manfrotto1004",
      name: "Manfrotto 1004",
      category: "Стойки",
      stockTrackingMode: "COUNT",
      totalQuantity: 4,
      rentalRatePerShift: 300,
    },
  });
  console.log(`Equipment (COUNT): ${manfrotto.name}`);

  // 4. CONFIRMED booking (for ISSUE) — today
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  const issueBooking = await prisma.booking.upsert({
    where: { id: "fidelity-booking-issue" },
    update: { status: "CONFIRMED" },
    create: {
      id: "fidelity-booking-issue",
      projectName: "Реклама «Орбита»",
      clientId: client.id,
      status: "CONFIRMED",
      startDate: todayStart,
      endDate: todayEnd,
    },
  });
  console.log(`Booking (ISSUE/CONFIRMED): ${issueBooking.projectName}`);

  // BookingItems for ISSUE booking (no dailyRate field in BookingItem)
  const issueItem1 = await prisma.bookingItem.upsert({
    where: { bookingId_equipmentId: { bookingId: issueBooking.id, equipmentId: aputure.id } },
    update: {},
    create: {
      bookingId: issueBooking.id,
      equipmentId: aputure.id,
      quantity: 3,
    },
  });
  const issueItem2 = await prisma.bookingItem.upsert({
    where: { bookingId_equipmentId: { bookingId: issueBooking.id, equipmentId: manfrotto.id } },
    update: {},
    create: {
      bookingId: issueBooking.id,
      equipmentId: manfrotto.id,
      quantity: 4,
    },
  });

  // BookingItemUnit reservations for UNIT items (ISSUE booking)
  for (let i = 0; i < unitIds.length; i++) {
    const existingBiu = await prisma.bookingItemUnit.findFirst({
      where: { bookingItemId: issueItem1.id, equipmentUnitId: unitIds[i] },
    });
    if (!existingBiu) {
      await prisma.bookingItemUnit.create({
        data: {
          bookingItemId: issueItem1.id,
          equipmentUnitId: unitIds[i],
        },
      });
    }
  }
  console.log(`BookingItems (ISSUE): aputure x3 + manfrotto x4`);

  // 5. ISSUED booking (for RETURN) — also today
  const returnBooking = await prisma.booking.upsert({
    where: { id: "fidelity-booking-return" },
    update: { status: "ISSUED" },
    create: {
      id: "fidelity-booking-return",
      projectName: "Клип «Север»",
      clientId: client.id,
      status: "ISSUED",
      startDate: todayStart,
      endDate: todayEnd,
    },
  });
  console.log(`Booking (RETURN/ISSUED): ${returnBooking.projectName}`);

  // 3c. Additional UNIT equipment for return booking — SkyPanel S60
  const skypanel = await prisma.equipment.upsert({
    where: { importKey: "fidelity-skypanel-s60" },
    update: {},
    create: {
      id: "fidelity-eq-skypanel",
      importKey: "fidelity-skypanel-s60",
      name: "SkyPanel S60",
      category: "Свет",
      stockTrackingMode: "UNIT",
      totalQuantity: 3,
      rentalRatePerShift: 7000,
    },
  });
  console.log(`Equipment (UNIT): ${skypanel.name}`);

  const returnUnitIds = [
    "fidelity-unit-04",
    "fidelity-unit-05",
    "fidelity-unit-06",
  ];

  for (let i = 0; i < returnUnitIds.length; i++) {
    await prisma.equipmentUnit.upsert({
      where: { id: returnUnitIds[i] },
      update: { status: "ISSUED" },
      create: {
        id: returnUnitIds[i],
        equipmentId: skypanel.id,
        status: "ISSUED",
        barcode: `LR-SKY60-00${i + 1}`,
        barcodePayload: `${returnUnitIds[i]}:aabbccdd2233`,
      },
    });
  }
  console.log(`Return units (3x ISSUED): ${returnUnitIds.join(", ")}`);

  const returnItem = await prisma.bookingItem.upsert({
    where: { bookingId_equipmentId: { bookingId: returnBooking.id, equipmentId: skypanel.id } },
    update: {},
    create: {
      bookingId: returnBooking.id,
      equipmentId: skypanel.id,
      quantity: 3,
    },
  });

  for (let i = 0; i < returnUnitIds.length; i++) {
    const existingBiu = await prisma.bookingItemUnit.findFirst({
      where: { bookingItemId: returnItem.id, equipmentUnitId: returnUnitIds[i] },
    });
    if (!existingBiu) {
      await prisma.bookingItemUnit.create({
        data: {
          bookingItemId: returnItem.id,
          equipmentUnitId: returnUnitIds[i],
          returnedAt: null,
        },
      });
    } else {
      // Reset returnedAt to null — critical for RETURN checklist state query
      // which filters BookingItemUnit.returnedAt = null to find ISSUED units.
      await prisma.bookingItemUnit.update({
        where: { id: existingBiu.id },
        data: { returnedAt: null },
      });
    }
  }
  console.log(`BookingItemUnits (RETURN): skypanel x3 (returnedAt reset to null)`);

  // 6. Extra CONFIRMED booking "tomorrow" (for list grouping)
  const tomorrow = new Date(todayStart);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowEnd = new Date(todayEnd);
  tomorrowEnd.setDate(tomorrowEnd.getDate() + 1);

  const tomorrowBooking = await prisma.booking.upsert({
    where: { id: "fidelity-booking-tomorrow" },
    update: { status: "CONFIRMED" },
    create: {
      id: "fidelity-booking-tomorrow",
      projectName: "Сериал «Дом» смена 4",
      clientId: client.id,
      status: "CONFIRMED",
      startDate: tomorrow,
      endDate: tomorrowEnd,
    },
  });

  await prisma.bookingItem.upsert({
    where: { bookingId_equipmentId: { bookingId: tomorrowBooking.id, equipmentId: manfrotto.id } },
    update: {},
    create: {
      bookingId: tomorrowBooking.id,
      equipmentId: manfrotto.id,
      quantity: 2,
    },
  });
  console.log(`Tomorrow booking: Сериал «Дом»`);

  // 7. Astera Titan Tube for addon conflict test
  const astera = await prisma.equipment.upsert({
    where: { importKey: "fidelity-astera-titan" },
    update: {},
    create: {
      id: "fidelity-eq-astera",
      importKey: "fidelity-astera-titan",
      name: "Astera Titan Tube",
      category: "Свет",
      stockTrackingMode: "COUNT",
      totalQuantity: 4,
      rentalRatePerShift: 2000,
    },
  });
  console.log(`Equipment (COUNT/addon): ${astera.name}`);

  // Conflicting confirmed booking occupying ALL astera units over today+tomorrow
  const conflictBooking = await prisma.booking.upsert({
    where: { id: "fidelity-booking-conflict" },
    update: { status: "CONFIRMED" },
    create: {
      id: "fidelity-booking-conflict",
      projectName: "Клип Maxi",
      clientId: client.id,
      status: "CONFIRMED",
      startDate: todayStart,
      endDate: tomorrowEnd,
    },
  });

  await prisma.bookingItem.upsert({
    where: { bookingId_equipmentId: { bookingId: conflictBooking.id, equipmentId: astera.id } },
    update: {},
    create: {
      bookingId: conflictBooking.id,
      equipmentId: astera.id,
      quantity: 4,
    },
  });
  console.log(`Conflict booking (Клип Maxi, occupies all astera): done`);

  // 8. AdminUser for /login (SUPER_ADMIN)
  const existingAdmin = await prisma.adminUser.findFirst({
    where: { username: "admin" },
  });
  if (!existingAdmin) {
    const pwHash = await hashPassword("admin123");
    await prisma.adminUser.create({
      data: {
        username: "admin",
        passwordHash: pwHash,
        role: "SUPER_ADMIN",
      },
    });
    console.log("AdminUser created: admin / admin123 (SUPER_ADMIN)");
  } else {
    console.log("AdminUser already exists: admin");
  }

  console.log("\nAll fidelity seed data created successfully.");
  console.log("WarehousePin: Иван Кладовщик / PIN: 1234");
  console.log("AdminUser: admin / admin123");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
