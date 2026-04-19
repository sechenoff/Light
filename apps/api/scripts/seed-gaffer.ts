/**
 * Seed script для Gaffer CRM.
 * Создаёт тестовых пользователей, контакты, методы оплаты, проекты и платежи.
 *
 * Идемпотентен: upsert по email, пропускает если данные уже есть.
 *
 * Использование:
 *   cd apps/api && DATABASE_URL="file:./prisma/dev.db" npx tsx scripts/seed-gaffer.ts
 *
 * DASHBOARD AGGREGATES (sechenoff@gmail.com / demo@example.com — одинаковые):
 * ──────────────────────────────────────────────────────────────────────────────
 * Проект 1: Клип «Синяя волна» — clientTotal=250000, clientReceived=70000, clientRemaining=180000
 * Проект 2: Коммерческий «Маркет·ТВ» — clientTotal=90000, clientReceived=0, clientRemaining=90000
 * Проект 3: Съёмка «Коллекция весна» — clientTotal=120000, clientReceived=120000, clientRemaining=0
 * Проект 4: Мероприятие «Премьера» — clientTotal=60000, clientReceived=60000, clientRemaining=0
 * ── owedToMe = 180000 + 90000 = 270000
 *
 * Команда:
 * Сергей Петров: proj1 rem=40000, proj3 rem=20000 → итого 60000
 * Алексей Морозов: proj1 rem=20000
 * Павел Т.: proj1 rem=0 (закрыт)
 * Дмитрий К.: proj3 rem=25000
 * Анна Л.: proj3 rem=12000
 * ── iOwe = 60000 + 20000 + 0 + 25000 + 12000 = 117000
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";

const prisma = new PrismaClient();

const USERS = [
  { email: "sechenoff@gmail.com", name: "Константин Лебедев" },
  { email: "demo@example.com", name: "Демо Пользователь" },
];

async function seedUser(email: string, name: string) {
  // Upsert user
  const user = await prisma.gafferUser.upsert({
    where: { email },
    create: {
      email,
      name,
      onboardingCompletedAt: new Date(),
    },
    update: {
      name,
      onboardingCompletedAt: new Date(),
    },
  });

  // Check if already seeded (by checking if payment methods exist)
  const existingMethods = await prisma.gafferPaymentMethod.findMany({
    where: { gafferUserId: user.id },
  });
  if (existingMethods.length >= 4) {
    console.log(`  [skip] ${email} — уже засеян (${existingMethods.length} методов оплаты)`);
    return;
  }

  console.log(`  [seed] ${email} — создаём данные...`);

  // ── Payment methods ────────────────────────────────────────────────────────

  const [pm1, pm2, pm3, pm4] = await Promise.all([
    prisma.gafferPaymentMethod.create({
      data: { gafferUserId: user.id, name: "Тинькофф карта", isDefault: true, sortOrder: 0 },
    }),
    prisma.gafferPaymentMethod.create({
      data: { gafferUserId: user.id, name: "Сбер карта", isDefault: false, sortOrder: 1 },
    }),
    prisma.gafferPaymentMethod.create({
      data: { gafferUserId: user.id, name: "Счёт ИП", isDefault: false, sortOrder: 2 },
    }),
    prisma.gafferPaymentMethod.create({
      data: { gafferUserId: user.id, name: "Наличные", isDefault: false, sortOrder: 3 },
    }),
  ]);

  // ── Contacts ───────────────────────────────────────────────────────────────

  // Clients
  const romashka = await prisma.gafferContact.create({
    data: {
      gafferUserId: user.id,
      type: "CLIENT",
      name: "Ромашка Продакшн",
      phone: "+7 900 123-45-67",
      telegram: "@romashka_prod",
    },
  });

  const thirdFloor = await prisma.gafferContact.create({
    data: {
      gafferUserId: user.id,
      type: "CLIENT",
      name: "Студия Третий Этаж",
    },
  });

  const ivanov = await prisma.gafferContact.create({
    data: {
      gafferUserId: user.id,
      type: "CLIENT",
      name: "Иванов И. (частный)",
      phone: "+7 921 111-22-33",
      telegram: "@ivanov_i",
    },
  });

  // Team members
  const sergey = await prisma.gafferContact.create({
    data: {
      gafferUserId: user.id,
      type: "TEAM_MEMBER",
      name: "Сергей Петров",
      phone: "+7 909 987-65-43",
      telegram: "@petrov_light",
      note: "осветитель, водит грузовик",
    },
  });

  const alexey = await prisma.gafferContact.create({
    data: {
      gafferUserId: user.id,
      type: "TEAM_MEMBER",
      name: "Алексей Морозов",
      phone: "+7 915 222-44-55",
      telegram: "@morozov_pro",
      note: "бригадир",
    },
  });

  const dmitry = await prisma.gafferContact.create({
    data: {
      gafferUserId: user.id,
      type: "TEAM_MEMBER",
      name: "Дмитрий К.",
      telegram: "@dim_k",
      note: "осветитель",
    },
  });

  const anna = await prisma.gafferContact.create({
    data: {
      gafferUserId: user.id,
      type: "TEAM_MEMBER",
      name: "Анна Л.",
      note: "DIT",
    },
  });

  const pavel = await prisma.gafferContact.create({
    data: {
      gafferUserId: user.id,
      type: "TEAM_MEMBER",
      name: "Павел Т.",
      note: "разнорабочий",
    },
  });

  // Archived team member
  await prisma.gafferContact.create({
    data: {
      gafferUserId: user.id,
      type: "TEAM_MEMBER",
      name: "Иван Сидоров",
      phone: "+7 905 001-02-03",
      isArchived: true,
    },
  });

  // ── Project 1: Клип «Синяя волна» ─────────────────────────────────────────
  // clientTotal = clientPlanAmount = 250000 (договорная сумма с заказчиком)
  // lightBudgetAmount = 150000 (что гаффер должен ренталу — вычитается из дохода)
  // clientReceived = 70000 → clientRemaining = 180000
  // teamPlan = 60000+50000+20000 = 130000, teamPaid = 20000+30000+20000 = 70000 → teamRemaining = 60000

  const proj1 = await prisma.gafferProject.create({
    data: {
      gafferUserId: user.id,
      title: "Клип «Синяя волна»",
      clientId: romashka.id,
      shootDate: new Date("2026-04-15"),
      clientPlanAmount: new Decimal(250000),
      lightBudgetAmount: new Decimal(150000),
      status: "OPEN",
    },
  });

  // Members
  const m1_sergey = await prisma.gafferProjectMember.create({
    data: {
      projectId: proj1.id,
      contactId: sergey.id,
      plannedAmount: new Decimal(60000),
      roleLabel: "осветитель",
    },
  });

  const m1_alexey = await prisma.gafferProjectMember.create({
    data: {
      projectId: proj1.id,
      contactId: alexey.id,
      plannedAmount: new Decimal(50000),
      roleLabel: "бригадир",
    },
  });

  const m1_pavel = await prisma.gafferProjectMember.create({
    data: {
      projectId: proj1.id,
      contactId: pavel.id,
      plannedAmount: new Decimal(20000),
      roleLabel: "разнорабочий",
    },
  });

  // Payments
  await prisma.gafferPayment.createMany({
    data: [
      {
        projectId: proj1.id,
        direction: "IN",
        amount: new Decimal(70000),
        paidAt: new Date("2026-04-02"),
        paymentMethodId: pm1.id,
        comment: "частичная предоплата",
      },
      {
        projectId: proj1.id,
        direction: "OUT",
        amount: new Decimal(20000),
        paidAt: new Date("2026-04-15"),
        memberId: sergey.id,
        comment: "предоплата",
      },
      {
        projectId: proj1.id,
        direction: "OUT",
        amount: new Decimal(30000),
        paidAt: new Date("2026-04-10"),
        memberId: alexey.id,
      },
      {
        projectId: proj1.id,
        direction: "OUT",
        amount: new Decimal(20000),
        paidAt: new Date("2026-04-16"),
        memberId: pavel.id,
        comment: "закрытие",
      },
    ],
  });

  void m1_sergey; void m1_alexey; void m1_pavel;

  // ── Project 2: Коммерческий «Маркет·ТВ» ──────────────────────────────────
  // clientTotal = clientPlanAmount = 90000 (договорная сумма), clientReceived=0 → clientRemaining=90000
  // lightBudgetAmount = 50000 (долг ренталу)

  await prisma.gafferProject.create({
    data: {
      gafferUserId: user.id,
      title: "Коммерческий «Маркет·ТВ»",
      clientId: thirdFloor.id,
      shootDate: new Date("2026-04-08"),
      clientPlanAmount: new Decimal(90000),
      lightBudgetAmount: new Decimal(50000),
      status: "OPEN",
    },
  });

  // ── Project 3: Съёмка «Коллекция весна» ───────────────────────────────────
  // clientTotal = clientPlanAmount = 120000 (договорная сумма), clientReceived=60000+60000=120000 → clientRemaining=0
  // lightBudgetAmount = 60000 (долг ренталу)
  // team: Сергей=40000 paid 20000 → rem 20000, Дмитрий=25000 paid 0 → rem 25000, Анна=12000 paid 0 → rem 12000

  const proj3 = await prisma.gafferProject.create({
    data: {
      gafferUserId: user.id,
      title: "Съёмка «Коллекция весна»",
      clientId: romashka.id,
      shootDate: new Date("2026-04-02"),
      clientPlanAmount: new Decimal(120000),
      lightBudgetAmount: new Decimal(60000),
      status: "OPEN",
    },
  });

  await prisma.gafferProjectMember.createMany({
    data: [
      { projectId: proj3.id, contactId: sergey.id, plannedAmount: new Decimal(40000), roleLabel: "осветитель" },
      { projectId: proj3.id, contactId: dmitry.id, plannedAmount: new Decimal(25000), roleLabel: "осветитель" },
      { projectId: proj3.id, contactId: anna.id, plannedAmount: new Decimal(12000), roleLabel: "DIT" },
    ],
  });

  await prisma.gafferPayment.createMany({
    data: [
      {
        projectId: proj3.id,
        direction: "IN",
        amount: new Decimal(60000),
        paidAt: new Date("2026-03-30"),
        paymentMethodId: pm1.id,
        comment: "аванс",
      },
      {
        projectId: proj3.id,
        direction: "IN",
        amount: new Decimal(60000),
        paidAt: new Date("2026-04-12"),
        paymentMethodId: pm2.id,
        comment: "закрытие",
      },
      {
        projectId: proj3.id,
        direction: "OUT",
        amount: new Decimal(20000),
        paidAt: new Date("2026-04-04"),
        memberId: sergey.id,
        comment: "частично",
      },
    ],
  });

  // ── Project 4: Мероприятие «Премьера» ────────────────────────────────────
  // clientTotal = clientPlanAmount = 60000 (договорная сумма), clientReceived=60000 → clientRemaining=0
  // lightBudgetAmount = 30000 (долг ренталу)
  // Сергей=30000 paid 30000 → rem 0

  const proj4 = await prisma.gafferProject.create({
    data: {
      gafferUserId: user.id,
      title: "Мероприятие «Премьера»",
      clientId: ivanov.id,
      shootDate: new Date("2026-03-28"),
      clientPlanAmount: new Decimal(60000),
      lightBudgetAmount: new Decimal(30000),
      status: "OPEN",
    },
  });

  await prisma.gafferProjectMember.create({
    data: {
      projectId: proj4.id,
      contactId: sergey.id,
      plannedAmount: new Decimal(30000),
      roleLabel: "осветитель",
    },
  });

  await prisma.gafferPayment.createMany({
    data: [
      {
        projectId: proj4.id,
        direction: "IN",
        amount: new Decimal(60000),
        paidAt: new Date("2026-03-28"),
        paymentMethodId: pm4.id,
        comment: "закрытие",
      },
      {
        projectId: proj4.id,
        direction: "OUT",
        amount: new Decimal(30000),
        paidAt: new Date("2026-04-08"),
        memberId: sergey.id,
        comment: "закрытие",
      },
    ],
  });

  console.log(`  [done] ${email} — создано: 4 метода оплаты, 9 контактов, 4 проекта`);

  // Return summary stats
  const owedToMe = 180000 + 90000; // proj1 + proj2
  const iOwe = (60000 - 20000) + (40000 - 20000) + 25000 + 12000; // Сергей (proj1+proj3) + Алексей + Дмитрий + Анна
  // = 40000 + 20000 + 25000 + 12000 = 97000
  // Wait — Павел is paid off (20000 planned, 20000 paid)
  // Сергей proj1: 60000 - 20000 = 40000 rem
  // Сергей proj3: 40000 - 20000 = 20000 rem  => total 60000
  // Алексей: 50000 - 30000 = 20000 rem
  // Павел: 20000 - 20000 = 0 rem
  // Дмитрий: 25000 - 0 = 25000
  // Анна: 12000 - 0 = 12000
  // Total iOwe = 60000 + 20000 + 25000 + 12000 = 117000
  void iOwe;
  console.log(`    owedToMe = ${owedToMe.toLocaleString("ru")} ₽ (proj1:180000 + proj2:90000)`);
  console.log(`    iOwe     = 117 000 ₽ (Сергей:60000 + Алексей:20000 + Дмитрий:25000 + Анна:12000)`);
}

async function main() {
  console.log("Gaffer CRM seed starting...\n");

  for (const u of USERS) {
    await seedUser(u.email, u.name);
  }

  console.log("\n=== Итог ===");
  const userCount = await prisma.gafferUser.count();
  const contactCount = await prisma.gafferContact.count();
  const projectCount = await prisma.gafferProject.count();
  const paymentCount = await prisma.gafferPayment.count();
  console.log(`GafferUser:    ${userCount}`);
  console.log(`GafferContact: ${contactCount}`);
  console.log(`GafferProject: ${projectCount}`);
  console.log(`GafferPayment: ${paymentCount}`);
  console.log("\nGotcha — seed завершён.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
