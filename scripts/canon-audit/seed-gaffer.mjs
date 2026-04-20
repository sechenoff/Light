/**
 * Minimal Gaffer CRM seed for canon audit.
 * Creates one user with contacts and a project.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({
  datasources: {
    db: { url: "file:/Users/sechenov/Documents/light-rental-system/apps/api/dev.db" },
  },
});

async function main() {
  // Get or create audit user
  let user = await prisma.gafferUser.findUnique({ where: { email: "audit@example.com" } });
  if (!user) {
    user = await prisma.gafferUser.create({
      data: { email: "audit@example.com", name: "Audit User" },
    });
    console.log("Created user:", user.id);
  } else {
    console.log("User exists:", user.id);
  }

  // Create a client contact (type = CLIENT)
  let client = await prisma.gafferContact.findFirst({
    where: { gafferUserId: user.id, type: "CLIENT" },
  });
  if (!client) {
    client = await prisma.gafferContact.create({
      data: {
        gafferUserId: user.id,
        type: "CLIENT",
        name: "Ромашка Продакшн",
        phone: "+7 999 000-00-01",
      },
    });
    console.log("Created client:", client.id);
  } else {
    console.log("Client exists:", client.id);
  }

  // Create a team member contact (type = TEAM)
  let teamMember = await prisma.gafferContact.findFirst({
    where: { gafferUserId: user.id, type: "TEAM_MEMBER" },
  });
  if (!teamMember) {
    teamMember = await prisma.gafferContact.create({
      data: {
        gafferUserId: user.id,
        type: "TEAM_MEMBER",
        name: "Сергей Петров",
        phone: "+7 999 000-00-02",
        telegram: "@sergei_petrov",
      },
    });
    console.log("Created team member:", teamMember.id);
  } else {
    console.log("Team member exists:", teamMember.id);
  }

  // Create a project
  let project = await prisma.gafferProject.findFirst({
    where: { gafferUserId: user.id },
  });
  if (!project) {
    project = await prisma.gafferProject.create({
      data: {
        gafferUserId: user.id,
        title: "Клип «Синяя волна»",
        clientId: client.id,
        shootDate: new Date("2026-05-15"),
        clientPlanAmount: 80000,
        lightBudgetAmount: 15000,
        status: "OPEN",
      },
    });
    console.log("Created project:", project.id);

    // Add team member to project
    await prisma.gafferProjectMember.create({
      data: {
        projectId: project.id,
        contactId: teamMember.id,
        plannedAmount: 8000,
        roleLabel: "осветитель",
      },
    });
    console.log("Added team member to project");
  } else {
    console.log("Project exists:", project.id);
  }

  console.log("\n=== IDs for audit ===");
  console.log("userId:", user.id);
  console.log("projectId:", project.id);
  console.log("clientId:", client.id);
  console.log("teamId:", teamMember.id);

  await prisma.$disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
