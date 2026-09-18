import { it, expect } from "vitest";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

it("adds projects to an existing database without rebuilding or altering old booking/invoice rows", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "project-migration-"));
  const db = path.join(dir, "before.db");
  fs.writeFileSync(db, "");
  const schema = fs.readFileSync(
    path.resolve(__dirname, "../../prisma/schema.prisma"),
    "utf8",
  );
  const before = schema
    .slice(0, schema.indexOf("/// Проект использует"))
    .replace(
      /^  (mode String @default\("STANDARD"\)|project BookingProject\?|projectLots ProjectLot\[\]|projectAssignments ProjectLotUnit\[\]|projectPeriod ProjectBillingPeriod\?|adjustmentAmount Decimal @default\(0\)|PERIOD)\n/gm,
      "",
    );
  const oldSchema = path.join(dir, "before.prisma");
  fs.writeFileSync(oldSchema, before);
  const cli = path.resolve(
    __dirname,
    "../../../../node_modules/prisma/build/index.js",
  );
  const url = `file:${db}`;
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    execFileSync(
      process.execPath,
      [cli, "db", "push", "--skip-generate", "--schema", oldSchema],
      { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" },
    );
    await prisma.$executeRaw`INSERT INTO Client (id,name,updatedAt) VALUES ('existing-client','Existing client',CURRENT_TIMESTAMP)`;
    await prisma.$executeRaw`INSERT INTO Booking (id,clientId,projectName,startDate,endDate,updatedAt) VALUES ('existing-booking','existing-client','Existing booking',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`;
    await prisma.$executeRaw`INSERT INTO Invoice (id,bookingId,number,kind,status,total,createdBy,updatedAt) VALUES ('existing-invoice','existing-booking','OLD-001','FULL','ISSUED',12345,'operator',CURRENT_TIMESTAMP)`;
    const [oldBooking] = await prisma.$queryRaw<
      Array<Record<string, unknown>>
    >`SELECT * FROM Booking`;
    const [oldInvoice] = await prisma.$queryRaw<
      Array<Record<string, unknown>>
    >`SELECT * FROM Invoice`;
    const sql = fs.readFileSync(
      path.resolve(
        __dirname,
        "../../prisma/migrations/20260916190000_booking_projects/migration.sql",
      ),
      "utf8",
    );
    expect(sql).not.toMatch(/DROP TABLE|DELETE FROM/);
    await prisma.$transaction(async (tx) => {
      for (const statement of sql
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean))
        await tx.$executeRawUnsafe(statement);
    });
    const [booking] = await prisma.$queryRaw<
      Array<Record<string, unknown>>
    >`SELECT * FROM Booking`;
    const [invoice] = await prisma.$queryRaw<
      Array<Record<string, unknown>>
    >`SELECT * FROM Invoice`;
    expect(booking).toEqual({ ...oldBooking, mode: "STANDARD" });
    expect(Number(invoice.adjustmentAmount)).toBe(0);
    delete invoice.adjustmentAmount;
    expect(invoice).toEqual(oldInvoice);
    expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
    await prisma.$disconnect();
    execFileSync(
      process.execPath,
      [
        cli,
        "migrate",
        "diff",
        "--from-url",
        url,
        "--to-schema-datamodel",
        path.resolve(__dirname, "../../prisma/schema.prisma"),
        "--exit-code",
      ],
      { env: process.env, stdio: "pipe" },
    );
  } finally {
    await prisma.$disconnect();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
